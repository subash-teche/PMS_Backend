import { SCREENS } from '../../config/menus.js';
import { writeAudit } from '../../utils/audit.js';
import { badRequest, notFound } from '../../utils/errors.js';
import { escapeLike, paginationQuerySchema, pagedResponseSchema, WhereBuilder } from '../../utils/query.js';

/*
 * Parameters → USD Rates: one current USD rate per currency (Parameters → CURRENCY values),
 * kept in currency_usd_rates. 1 unit of the currency = usd_rate USD; USD itself is always 1.
 * The Commercial / Analysis tabs and grade costs convert with these rates (v_currency_usd_rates).
 */

const tags = ['USD Rates'];
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1, description: 'currency (lookups) id' } } };
const item = {
  type: 'object',
  properties: {
    id: { type: 'integer', description: 'currency id' },
    name: { type: 'string' },
    code: { type: ['string', 'null'] },
    usdRate: { type: ['number', 'null'] },
    isFixed: { type: 'boolean', description: 'USD – always 1' },
    isVisible: { type: 'boolean' },
    updatedByName: { type: ['string', 'null'] },
    updatedAt: { type: ['string', 'null'], format: 'date-time' },
  },
};

const SELECT = `
  SELECT l.id, l.name, upper(trim(l.value)) AS code, l.is_visible, l.display_order,
         CASE WHEN upper(trim(l.value)) = 'USD' THEN 1 ELSE r.usd_rate END AS usd_rate,
         upper(trim(l.value)) = 'USD' AS is_fixed,
         u.name AS updated_by_name, r.updated_at
    FROM parameter_values l
    LEFT JOIN currency_usd_rates r ON r.currency_id = l.id
    LEFT JOIN users u ON u.id = r.updated_by
   WHERE l.type = 'CURRENCY'`;

const toDto = (r) => ({
  id: r.id,
  name: r.name,
  code: r.code,
  usdRate: r.usd_rate == null ? null : Number(r.usd_rate),
  isFixed: r.is_fixed,
  isVisible: r.is_visible,
  updatedByName: r.updated_by_name,
  updatedAt: r.updated_at,
});

async function getOne(db, id) {
  const { rows } = await db.query(`${SELECT} AND l.id = $1`, [id]);
  if (!rows[0]) throw notFound('Currency');
  return toDto(rows[0]);
}

export default async function usdRatesRoutes(fastify) {
  const { db, authorize } = fastify;
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get(
    '/',
    {
      schema: {
        tags,
        summary: 'Currencies with their USD rate (missing rates come first)',
        querystring: { type: 'object', properties: { ...paginationQuerySchema, missing: { type: 'boolean', description: 'only currencies without a rate' } } },
        response: { 200: pagedResponseSchema(item) },
      },
      preHandler: authorize(SCREENS.PARAMETERS, 'view'),
    },
    async (req) => {
      const q = req.query;
      const where = new WhereBuilder();
      if (q.search) {
        const t = `%${escapeLike(q.search)}%`;
        where.add('(s.name ILIKE $? OR s.code ILIKE $?)', t, t);
      }
      if (q.missing !== undefined) where.add(q.missing ? 's.usd_rate IS NULL' : 's.usd_rate IS NOT NULL');
      const limit = where.param(q.pageSize);
      const offset = where.param((q.page - 1) * q.pageSize);
      const { rows } = await db.query(
        `SELECT s.*, count(*) OVER()::int AS total FROM (${SELECT}) s ${where.toSql()}
          ORDER BY (s.usd_rate IS NULL) DESC, s.display_order, s.name LIMIT ${limit} OFFSET ${offset}`,
        where.params,
      );
      return { items: rows.map(toDto), total: rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize };
    },
  );

  fastify.get('/:id', { schema: { tags, summary: 'A currency and its USD rate', params: idParams, response: { 200: item } }, preHandler: authorize(SCREENS.PARAMETERS, 'view') }, (req) =>
    getOne(db, req.params.id),
  );

  fastify.put(
    '/:id',
    {
      schema: {
        tags,
        summary: 'Set the USD rate of a currency (1 unit of it = usdRate USD)',
        params: idParams,
        body: { type: 'object', required: ['usdRate'], additionalProperties: false, properties: { usdRate: { type: 'number', exclusiveMinimum: 0, maximum: 99999999 } } },
        response: { 200: item },
      },
      preHandler: authorize(SCREENS.PARAMETERS, 'edit'),
    },
    async (req) => {
      const cur = await getOne(db, req.params.id);
      if (cur.isFixed) throw badRequest('USD is always 1', [{ field: 'usdRate', message: 'is fixed for USD' }]);
      await db.tx(async (client) => {
        await client.query(
          `INSERT INTO currency_usd_rates (currency_id, usd_rate, created_by, updated_by) VALUES ($1, $2, $3, $3)
           ON CONFLICT (currency_id) DO UPDATE SET usd_rate = EXCLUDED.usd_rate, updated_by = EXCLUDED.updated_by`,
          [cur.id, req.body.usdRate, req.auth.userId],
        );
        await writeAudit(client, {
          entity: 'currency_usd_rates',
          entityId: cur.id,
          action: 'update',
          userId: req.auth.userId,
          message: `1 ${cur.code} = ${req.body.usdRate} USD`,
          changes: { usdRate: { old: cur.usdRate, new: req.body.usdRate } },
        });
      });
      return getOne(db, req.params.id);
    },
  );
}
