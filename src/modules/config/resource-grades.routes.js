import { SCREENS } from '../../config/menus.js';
import { writeAudit } from '../../utils/audit.js';
import { badRequest, conflict, isReferenceError, notFound } from '../../utils/errors.js';
import { exact } from '../../utils/number.js';
import { escapeLike, paginationQuerySchema, pagedResponseSchema, WhereBuilder } from '../../utils/query.js';

/*
 * Resource grades (one per grade = lookup type GRADE) with their cost-per-hour history.
 * Users point at a resource grade; the user form pre-fills the hourly rate from the current cost.
 *
 * Cost periods, per currency: they follow each other without a gap or overlap (next from = previous
 * to + 1 day) and the latest one is always open-ended ("still running"), so there is always a current price.
 * The cost in USD uses the currency's USD rate (Parameters → CURRENCY).
 */

const tags = ['Resource Grades'];
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const date = { type: 'string', format: 'date' };

const cost = {
  type: 'object',
  required: ['costPerHour', 'currency', 'fromDate'],
  additionalProperties: false,
  properties: {
    costPerHour: { type: 'number', minimum: 0, maximum: 9999999 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    fromDate: date,
    toDate: { anyOf: [date, { type: 'null' }] },
  },
};
const body = {
  type: 'object',
  required: ['gradeId'],
  additionalProperties: false,
  properties: {
    gradeId: { type: 'integer', minimum: 1 },
    costs: { type: 'array', items: cost, default: [], maxItems: 100 },
  },
};
const item = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    gradeId: { type: 'integer' },
    gradeName: { type: 'string' },
    userCount: { type: 'integer' },
    currentCost: { type: ['number', 'null'] },
    currentCurrency: { type: ['string', 'null'] },
    currentCostUsd: { type: ['number', 'null'], description: 'current cost per hour in USD' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};
const detail = {
  ...item,
  properties: {
    ...item.properties,
    costs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          costPerHour: { type: 'number' },
          currency: { type: 'string' },
          fromDate: { type: 'string' },
          toDate: { type: ['string', 'null'] },
          costPerHourUsd: { type: ['number', 'null'] },
        },
      },
    },
  },
};

// current cost = the period covering today, else the latest one
export const CURRENT_COST = `
  LEFT JOIN LATERAL (
    SELECT c.cost_per_hour, c.currency FROM resource_grade_costs c
     WHERE c.resource_grade_id = x.id
     ORDER BY (c.from_date <= current_date AND (c.to_date IS NULL OR c.to_date >= current_date)) DESC, c.from_date DESC
     LIMIT 1) cc ON true`;

const SELECT = `
  SELECT x.id, x.grade_id, g.name AS grade_name, g.display_order, x.updated_at,
         (SELECT count(*)::int FROM users u WHERE u.resource_grade_id = x.id) AS user_count,
         cc.cost_per_hour AS current_cost, trim(cc.currency) AS current_currency,
         (SELECT r.usd_rate FROM v_currency_usd_rates r WHERE r.code = trim(cc.currency) LIMIT 1) AS current_usd_rate
    FROM resource_grades x
    JOIN parameter_values g ON g.id = x.grade_id
    ${CURRENT_COST}`;

const toDto = (r) => ({
  id: r.id,
  gradeId: r.grade_id,
  gradeName: r.grade_name,
  userCount: r.user_count,
  currentCost: r.current_cost,
  currentCurrency: r.current_currency,
  currentCostUsd: r.current_usd_rate == null || r.current_cost == null ? null : exact(r.current_cost * r.current_usd_rate),
  updatedAt: r.updated_at,
});

async function getOne(db, id) {
  const { rows } = await db.query(`SELECT * FROM (${SELECT}) s WHERE s.id = $1`, [id]);
  if (!rows[0]) throw notFound('Resource grade');
  const costs = await db.query(
    `SELECT c.cost_per_hour, trim(c.currency) AS currency, c.from_date, c.to_date,
            (SELECT r.usd_rate FROM v_currency_usd_rates r WHERE r.code = trim(c.currency) LIMIT 1) AS usd_rate
       FROM resource_grade_costs c
      WHERE resource_grade_id = $1 ORDER BY from_date DESC`,
    [id],
  );
  return {
    ...toDto(rows[0]),
    costs: costs.rows.map((c) => ({
      costPerHour: c.cost_per_hour,
      currency: c.currency,
      fromDate: c.from_date,
      toDate: c.to_date,
      costPerHourUsd: c.usd_rate == null ? null : exact(c.cost_per_hour * c.usd_rate),
    })),
  };
}

const nextDay = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Grade must be a GRADE lookup used once; per currency the cost periods must follow each other without gaps. */
async function validate(db, b, id) {
  const { rows } = await db.query(`SELECT 1 FROM parameter_values WHERE id = $1 AND type = 'GRADE'`, [b.gradeId]);
  if (!rows.length) throw badRequest('Select a grade (Parameters → GRADE)', [{ field: 'gradeId', message: 'is not a grade' }]);
  const dup = await db.query(`SELECT 1 FROM resource_grades WHERE grade_id = $1 AND id IS DISTINCT FROM $2`, [b.gradeId, id]);
  if (dup.rowCount) throw conflict('This grade already exists – edit its cost history instead');

  const byCurrency = new Map();
  for (const c of b.costs) byCurrency.set(c.currency, [...(byCurrency.get(c.currency) ?? []), c]);
  for (const c of b.costs) {
  }
  for (const [currency, list] of byCurrency) {
    const periods = [...list].sort((a, c) => a.fromDate.localeCompare(c.fromDate));
    periods.forEach((p, i) => {
      if (p.toDate && p.toDate < p.fromDate) throw badRequest(`${currency} cost from ${p.fromDate}: the end date is before the start date`);
      const next = periods[i + 1];
      // there must always be a current price: the latest period of a currency never ends
      if (!next) {
        if (p.toDate) throw badRequest(`${currency}: the latest cost (from ${p.fromDate}) must be still running – add a new period to change the price`);
        return;
      }
      if (!p.toDate) throw badRequest(`${currency}: only the latest cost period can be still running (from ${p.fromDate})`);
      if (next.fromDate !== nextDay(p.toDate)) {
        throw badRequest(`${currency}: the cost from ${next.fromDate} must start on ${nextDay(p.toDate)}, the day after the previous period ends – no gaps or overlaps`);
      }
    });
  }
}

async function saveCosts(client, id, costs, userId) {
  await client.query(`DELETE FROM resource_grade_costs WHERE resource_grade_id = $1`, [id]);
  if (!costs.length) return;
  await client.query(
    `INSERT INTO resource_grade_costs (resource_grade_id, cost_per_hour, currency, from_date, to_date, created_by, updated_by)
     SELECT $1, c, cur, f, t, $6, $6 FROM unnest($2::numeric[], $3::text[], $4::date[], $5::date[]) AS u(c, cur, f, t)`,
    [id, costs.map((c) => c.costPerHour), costs.map((c) => c.currency), costs.map((c) => c.fromDate), costs.map((c) => c.toDate ?? null), userId],
  );
}

export default async function resourceGradesRoutes(fastify) {
  const { db, authorize } = fastify;
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get(
    '/',
    {
      schema: {
        tags,
        summary: 'List resource grades',
        querystring: { type: 'object', properties: { ...paginationQuerySchema } },
        response: { 200: pagedResponseSchema(item) },
      },
      preHandler: authorize(SCREENS.RESOURCE_GRADES, 'view'),
    },
    async (req) => {
      const q = req.query;
      const where = new WhereBuilder();
      if (q.search) where.add(`s.grade_name ILIKE $?`, `%${escapeLike(q.search)}%`);
      const limit = where.param(q.pageSize);
      const offset = where.param((q.page - 1) * q.pageSize);
      const { rows } = await db.query(
        `SELECT s.*, count(*) OVER()::int AS total FROM (${SELECT}) s ${where.toSql()}
          ORDER BY s.display_order, s.grade_name LIMIT ${limit} OFFSET ${offset}`,
        where.params,
      );
      return { items: rows.map(toDto), total: rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize };
    },
  );

  fastify.get('/:id', { schema: { tags, summary: 'Get a resource grade with its cost history', params: idParams, response: { 200: detail } }, preHandler: authorize(SCREENS.RESOURCE_GRADES, 'view') }, (req) =>
    getOne(db, req.params.id),
  );

  fastify.post(
    '/',
    { schema: { tags, summary: 'Create a resource grade', body, response: { 201: detail } }, preHandler: authorize(SCREENS.RESOURCE_GRADES, 'create') },
    async (req, reply) => {
      const b = req.body;
      await validate(db, b, null);
      const id = await db.tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO resource_grades (grade_id, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`,
          [b.gradeId, req.auth.userId],
        );
        await saveCosts(client, rows[0].id, b.costs, req.auth.userId);
        await writeAudit(client, { entity: 'resource_grades', entityId: rows[0].id, action: 'create', userId: req.auth.userId });
        return rows[0].id;
      });
      return reply.status(201).send(await getOne(db, id));
    },
  );

  fastify.put(
    '/:id',
    { schema: { tags, summary: 'Update a resource grade and its costs', params: idParams, body, response: { 200: detail } }, preHandler: authorize(SCREENS.RESOURCE_GRADES, 'edit') },
    async (req) => {
      const { id } = req.params;
      const b = req.body;
      const { rowCount } = await db.query(`SELECT 1 FROM resource_grades WHERE id = $1`, [id]);
      if (!rowCount) throw notFound('Resource grade');
      await validate(db, b, id);
      await db.tx(async (client) => {
        await client.query(`UPDATE resource_grades SET grade_id = $2, updated_by = $3 WHERE id = $1`, [id, b.gradeId, req.auth.userId]);
        await saveCosts(client, id, b.costs, req.auth.userId);
        await writeAudit(client, { entity: 'resource_grades', entityId: id, action: 'update', userId: req.auth.userId, message: 'Grade and cost history saved' });
      });
      return getOne(db, id);
    },
  );

  fastify.delete(
    '/:id',
    { schema: { tags, summary: 'Delete a resource grade (no users on it)', params: idParams, response: { 204: { type: 'null' } } }, preHandler: authorize(SCREENS.RESOURCE_GRADES, 'delete') },
    async (req, reply) => {
      try {
        const res = await db.tx(async (client) => {
          const r = await client.query(`DELETE FROM resource_grades WHERE id = $1`, [req.params.id]);
          if (r.rowCount) await writeAudit(client, { entity: 'resource_grades', entityId: req.params.id, action: 'delete', userId: req.auth.userId });
          return r;
        });
        if (!res.rowCount) throw notFound('Resource grade');
      } catch (err) {
        if (isReferenceError(err)) throw conflict('Users are on this grade – move them to another grade first');
        throw err;
      }
      return reply.status(204).send();
    },
  );
}
