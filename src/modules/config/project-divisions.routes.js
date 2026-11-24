import { SCREENS } from '../../config/menus.js';
import { writeAudit } from '../../utils/audit.js';
import { badRequest, conflict, isReferenceError, notFound } from '../../utils/errors.js';
import { escapeLike, paginationQuerySchema, pagedResponseSchema, WhereBuilder } from '../../utils/query.js';

/*
 * Business Division: a project division with its project types, edited on one form and saved
 * together. A project type used by projects cannot be removed – make it inactive instead.
 * Quote rates: the division's rate per hour in each currency; a project's estimated hours =
 * estimate amount / the rate in the project's currency.
 */

const tags = ['Business Division'];
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };

const typeIn = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    id: { type: ['integer', 'null'], minimum: 1, description: 'existing project type; empty for a new one' },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: ['string', 'null'], maxLength: 2000 },
    isActive: { type: 'boolean', default: true },
  },
};
const rateIn = {
  type: 'object',
  required: ['currency', 'ratePerHour'],
  additionalProperties: false,
  properties: {
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    ratePerHour: { type: 'number', exclusiveMinimum: 0, maximum: 9999999999 },
  },
};
const body = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: ['string', 'null'], maxLength: 2000 },
    isActive: { type: 'boolean', default: true },
    // project types are maintained on their own tab – only changed when sent
    projectTypes: { type: 'array', items: typeIn, maxItems: 200 },
    quoteRates: { type: 'array', items: rateIn, default: [], maxItems: 50 },
  },
};
const typeOut = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    isActive: { type: 'boolean' },
    projectCount: { type: 'integer' },
  },
};
const item = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    isActive: { type: 'boolean' },
    projectCount: { type: 'integer' },
    projectTypes: { type: 'array', items: typeOut },
    quoteRates: { type: 'array', items: { type: 'object', properties: { currency: { type: 'string' }, ratePerHour: { type: 'number' } } } },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const SELECT = `
  SELECT d.id, d.name, d.description, d.is_active, d.created_at, d.updated_at,
         (SELECT count(*)::int FROM projects p WHERE p.project_division_id = d.id) AS project_count,
         COALESCE((SELECT json_agg(json_build_object(
                     'id', t.id, 'name', t.name, 'description', t.description, 'isActive', t.is_active,
                     'projectCount', (SELECT count(*) FROM projects p WHERE p.project_type_id = t.id))
                   ORDER BY t.is_active DESC, t.name)
                     FROM project_types t WHERE t.project_division_id = d.id), '[]') AS project_types,
         COALESCE((SELECT json_agg(json_build_object('currency', trim(q.currency), 'ratePerHour', q.rate_per_hour) ORDER BY q.currency)
                     FROM division_quote_rates q WHERE q.project_division_id = d.id), '[]') AS quote_rates
    FROM project_divisions d`;

const toDto = (r) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  isActive: r.is_active,
  projectCount: r.project_count,
  projectTypes: r.project_types,
  quoteRates: r.quote_rates.map((q) => ({ currency: q.currency, ratePerHour: Number(q.ratePerHour) })),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

async function getOne(db, id) {
  const { rows } = await db.query(`${SELECT} WHERE d.id = $1`, [id]);
  if (!rows[0]) throw notFound('Division');
  return toDto(rows[0]);
}

/** Unique division name; project type names are unique across all divisions; one quote rate per currency. */
async function validate(db, b, id) {
  const { rowCount } = await db.query(`SELECT 1 FROM project_divisions WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2`, [b.name.trim(), id]);
  if (rowCount) throw badRequest('A division with this name already exists', [{ field: 'name', message: 'already exists' }]);
  const currencies = new Set();
  for (const q of b.quoteRates) {
    if (currencies.has(q.currency)) throw badRequest(`The quote rate for ${q.currency} is listed twice`, [{ field: 'quoteRates', message: 'duplicate currency' }]);
    currencies.add(q.currency);
  }
  const seen = new Set();
  for (const t of b.projectTypes ?? []) {
    const key = t.name.trim().toLowerCase();
    if (seen.has(key)) throw badRequest(`Project type "${t.name.trim()}" is listed twice`, [{ field: 'projectTypes', message: 'duplicate name' }]);
    seen.add(key);
    const { rows } = await db.query(
      `SELECT t.name, d.name AS division FROM project_types t LEFT JOIN project_divisions d ON d.id = t.project_division_id
        WHERE lower(t.name) = $1 AND t.id IS DISTINCT FROM $2`,
      [key, t.id ?? null],
    );
    if (rows[0]) throw badRequest(`A project type "${rows[0].name}" already exists in ${rows[0].division ?? 'another division'}`, [{ field: 'projectTypes', message: 'already exists' }]);
  }
}

/** Updates kept types, adds new ones, removes the rest (refused for types used by projects). */
async function saveTypes(client, divisionId, types, userId) {
  const { rows: existing } = await client.query(
    `SELECT t.id, t.name, EXISTS (SELECT 1 FROM projects p WHERE p.project_type_id = t.id) AS in_use FROM project_types t WHERE t.project_division_id = $1`,
    [divisionId],
  );
  const foreign = types.find((t) => t.id && !existing.some((e) => e.id === t.id));
  if (foreign) throw badRequest('A project type in the list belongs to another division', [{ field: 'projectTypes', message: 'not in this division' }]);
  const keep = new Set(types.filter((t) => t.id).map((t) => t.id));
  const removed = existing.filter((e) => !keep.has(e.id));
  const used = removed.find((e) => e.in_use);
  if (used) throw conflict(`"${used.name}" is used by projects – make it inactive instead of removing it`);
  if (removed.length) await client.query(`DELETE FROM project_types WHERE id = ANY($1)`, [removed.map((e) => e.id)]); // its split goes with it

  for (const t of types.filter((x) => x.id)) {
    await client.query(`UPDATE project_types SET name = name || ' ~' || id WHERE id = $1`, [t.id]); // allow swapping names
  }
  for (const t of types) {
    if (t.id) {
      await client.query(`UPDATE project_types SET name = $2, description = $3, is_active = $4, updated_by = $5 WHERE id = $1`, [
        t.id,
        t.name.trim(),
        t.description?.trim() || null,
        t.isActive ?? true,
        userId,
      ]);
    } else {
      await client.query(
        `INSERT INTO project_types (name, project_division_id, description, is_active, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)`,
        [t.name.trim(), divisionId, t.description?.trim() || null, t.isActive ?? true, userId],
      );
    }
  }
}

/** Replaces the division's quote rates (one per currency). */
async function saveRates(client, divisionId, rates, userId) {
  await client.query(`DELETE FROM division_quote_rates WHERE project_division_id = $1`, [divisionId]);
  if (!rates.length) return;
  await client.query(
    `INSERT INTO division_quote_rates (project_division_id, currency, rate_per_hour, created_by, updated_by)
     SELECT $1, c, r, $4, $4 FROM unnest($2::text[], $3::numeric[]) AS u(c, r)`,
    [divisionId, rates.map((q) => q.currency), rates.map((q) => q.ratePerHour), userId],
  );
}

export default async function projectDivisionsRoutes(fastify) {
  const { db, authorize } = fastify;
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get(
    '/',
    {
      schema: {
        tags,
        summary: 'Divisions with their project types',
        querystring: { type: 'object', properties: { ...paginationQuerySchema, isActive: { type: 'boolean' } } },
        response: { 200: pagedResponseSchema(item) },
      },
      preHandler: authorize(SCREENS.PROJECT_DIVISIONS, 'view'),
    },
    async (req) => {
      const q = req.query;
      const where = new WhereBuilder();
      if (q.search) {
        const s = `%${escapeLike(q.search)}%`;
        where.add(`(d.name ILIKE $? OR d.description ILIKE $? OR EXISTS (SELECT 1 FROM project_types t WHERE t.project_division_id = d.id AND t.name ILIKE $?))`, s, s, s);
      }
      if (q.isActive !== undefined) where.add('d.is_active = $?', q.isActive);
      const limit = where.param(q.pageSize);
      const offset = where.param((q.page - 1) * q.pageSize);
      const { rows } = await db.query(
        `SELECT s.*, count(*) OVER()::int AS total FROM (${SELECT} ${where.toSql()}) s ORDER BY s.name ${q.sortDir === 'desc' ? 'DESC' : 'ASC'} LIMIT ${limit} OFFSET ${offset}`,
        where.params,
      );
      return { items: rows.map(toDto), total: rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize };
    },
  );

  fastify.get('/:id', { schema: { tags, summary: 'A division with its project types', params: idParams, response: { 200: item } }, preHandler: authorize(SCREENS.PROJECT_DIVISIONS, 'view') }, (req) =>
    getOne(db, req.params.id),
  );

  fastify.post(
    '/',
    { schema: { tags, summary: 'Create a division with its project types', body, response: { 201: item } }, preHandler: authorize(SCREENS.PROJECT_DIVISIONS, 'create') },
    async (req, reply) => {
      const b = req.body;
      await validate(db, b, null);
      const id = await db.tx(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO project_divisions (name, description, is_active, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
          [b.name.trim(), b.description?.trim() || null, b.isActive, req.auth.userId],
        );
        if (b.projectTypes?.length) await saveTypes(client, rows[0].id, b.projectTypes.map((t) => ({ ...t, id: null })), req.auth.userId);
        await saveRates(client, rows[0].id, b.quoteRates, req.auth.userId);
        await writeAudit(client, { entity: 'project_divisions', entityId: rows[0].id, action: 'create', userId: req.auth.userId, message: `${b.projectTypes?.length ?? 0} project type(s)` });
        return rows[0].id;
      });
      return reply.status(201).send(await getOne(db, id));
    },
  );

  fastify.put(
    '/:id',
    { schema: { tags, summary: 'Update a division and its project types', params: idParams, body, response: { 200: item } }, preHandler: authorize(SCREENS.PROJECT_DIVISIONS, 'edit') },
    async (req) => {
      const { id } = req.params;
      const b = req.body;
      await getOne(db, id);
      await validate(db, b, id);
      await db.tx(async (client) => {
        await client.query(`UPDATE project_divisions SET name = $2, description = $3, is_active = $4, updated_by = $5 WHERE id = $1`, [
          id,
          b.name.trim(),
          b.description?.trim() || null,
          b.isActive,
          req.auth.userId,
        ]);
        if (b.projectTypes) await saveTypes(client, id, b.projectTypes, req.auth.userId);
        await saveRates(client, id, b.quoteRates, req.auth.userId);
        await writeAudit(client, { entity: 'project_divisions', entityId: id, action: 'update', userId: req.auth.userId, message: 'Division, project types and quote rates saved' });
      });
      return getOne(db, id);
    },
  );

  fastify.delete(
    '/:id',
    { schema: { tags, summary: 'Delete a division and its unused project types', params: idParams, response: { 204: { type: 'null' } } }, preHandler: authorize(SCREENS.PROJECT_DIVISIONS, 'delete') },
    async (req, reply) => {
      const { id } = req.params;
      await getOne(db, id);
      try {
        await db.tx(async (client) => {
          await client.query(`DELETE FROM project_types WHERE project_division_id = $1`, [id]);
          await client.query(`DELETE FROM project_divisions WHERE id = $1`, [id]);
          await writeAudit(client, { entity: 'project_divisions', entityId: id, action: 'delete', userId: req.auth.userId });
        });
      } catch (err) {
        if (isReferenceError(err)) throw conflict('This division or its project types are used by projects – make them inactive instead');
        throw err;
      }
      return reply.status(204).send();
    },
  );
}
