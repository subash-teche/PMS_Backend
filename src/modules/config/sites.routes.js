import { SCREENS } from '../../config/menus.js';
import { writeAudit } from '../../utils/audit.js';
import { badRequest, conflict, isReferenceError, notFound } from '../../utils/errors.js';
import { escapeLike, paginationQuerySchema, pagedResponseSchema, WhereBuilder } from '../../utils/query.js';

/*
 * Site Master: a site with its shifts ("Morning Shift" 09:00–18:00 …), saved together.
 * A site needs at least one shift; a shift that users use cannot be removed – make it inactive instead.
 */

const tags = ['Sites'];
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const time = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?$' };
const mins = { type: ['integer', 'null'], minimum: 0, maximum: 1440 };

const shiftIn = {
  type: 'object',
  required: ['name', 'startTime', 'endTime'],
  additionalProperties: false,
  properties: {
    id: { type: ['integer', 'null'], minimum: 1, description: 'existing shift; empty for a new one' },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    startTime: time,
    endTime: time,
    lateAfterMinutes: mins,
    halfDayMinutes: mins,
    isActive: { type: 'boolean', default: true },
  },
};
const body = {
  type: 'object',
  required: ['name', 'shifts'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    isActive: { type: 'boolean', default: true },
    shifts: { type: 'array', items: shiftIn, minItems: 1, maxItems: 50 },
  },
};
const shiftOut = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    startTime: { type: 'string' },
    endTime: { type: 'string' },
    lateAfterMinutes: { type: ['integer', 'null'] },
    halfDayMinutes: { type: ['integer', 'null'] },
    isActive: { type: 'boolean' },
    userCount: { type: 'integer' },
    inUse: { type: 'boolean' },
  },
};
const item = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    isActive: { type: 'boolean' },
    userCount: { type: 'integer' },
    shifts: { type: 'array', items: shiftOut },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const IN_USE = (a) => `EXISTS (SELECT 1 FROM users u WHERE u.site_shift_id = ${a}.id)`;

const SELECT = `
  SELECT s.id, s.name, s.is_active, s.created_at, s.updated_at,
         (SELECT count(*)::int FROM users u WHERE u.site_id = s.id) AS user_count,
         COALESCE((SELECT json_agg(json_build_object(
                     'id', ss.id, 'name', ss.name,
                     'startTime', to_char(ss.start_time, 'HH24:MI'), 'endTime', to_char(ss.end_time, 'HH24:MI'),
                     'lateAfterMinutes', ss.late_after_minutes, 'halfDayMinutes', ss.half_day_minutes,
                     'isActive', ss.is_active,
                     'userCount', (SELECT count(*) FROM users u WHERE u.site_shift_id = ss.id),
                     'inUse', ${IN_USE('ss')})
                   ORDER BY ss.display_order, ss.start_time, ss.name)
                     FROM site_shifts ss WHERE ss.site_id = s.id), '[]') AS shifts
    FROM sites s`;

const toDto = (r) => ({
  id: r.id,
  name: r.name,
  isActive: r.is_active,
  userCount: r.user_count,
  shifts: r.shifts,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

async function getOne(db, id) {
  const { rows } = await db.query(`${SELECT} WHERE s.id = $1`, [id]);
  if (!rows[0]) throw notFound('Site');
  return toDto(rows[0]);
}

async function validate(db, b, id) {
  const { rowCount } = await db.query(`SELECT 1 FROM sites WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2`, [b.name.trim(), id]);
  if (rowCount) throw badRequest('A site with this name already exists', [{ field: 'name', message: 'already exists' }]);
  const seen = new Set();
  for (const sh of b.shifts) {
    const key = sh.name.trim().toLowerCase();
    if (seen.has(key)) throw badRequest(`Shift "${sh.name.trim()}" is listed twice`, [{ field: 'shifts', message: 'duplicate name' }]);
    seen.add(key);
    if (sh.startTime.slice(0, 5) === sh.endTime.slice(0, 5)) throw badRequest(`${sh.name.trim()}: the start and end time are the same`, [{ field: 'shifts', message: 'empty shift' }]);
  }
}

/** Updates kept shifts, adds new ones, removes the rest (refused for shifts in use). */
async function saveShifts(client, siteId, shifts, userId) {
  const { rows: existing } = await client.query(`SELECT ss.id, ss.name, ${IN_USE('ss')} AS in_use FROM site_shifts ss WHERE ss.site_id = $1`, [siteId]);
  const foreign = shifts.find((s) => s.id && !existing.some((e) => e.id === s.id));
  if (foreign) throw badRequest('A shift in the list belongs to another site', [{ field: 'shifts', message: 'not in this site' }]);
  const keep = new Set(shifts.filter((s) => s.id).map((s) => s.id));
  const removed = existing.filter((e) => !keep.has(e.id));
  const used = removed.find((e) => e.in_use);
  if (used) throw conflict(`"${used.name}" is assigned to users – make it inactive instead of removing it`);
  if (removed.length) await client.query(`DELETE FROM site_shifts WHERE id = ANY($1)`, [removed.map((e) => e.id)]);

  for (const s of shifts.filter((x) => x.id)) {
    await client.query(`UPDATE site_shifts SET name = name || ' ~' || id WHERE id = $1`, [s.id]); // allow swapping names
  }
  for (const [i, s] of shifts.entries()) {
    const vals = [s.name.trim(), s.startTime, s.endTime, s.lateAfterMinutes ?? null, s.halfDayMinutes ?? null, i + 1, s.isActive ?? true, userId];
    if (s.id) {
      await client.query(
        `UPDATE site_shifts SET name = $2, start_time = $3, end_time = $4, late_after_minutes = $5, half_day_minutes = $6,
                display_order = $7, is_active = $8, updated_by = $9 WHERE id = $1`,
        [s.id, ...vals],
      );
    } else {
      await client.query(
        `INSERT INTO site_shifts (site_id, name, start_time, end_time, late_after_minutes, half_day_minutes, display_order, is_active, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [siteId, ...vals],
      );
    }
  }
}

export default async function sitesRoutes(fastify) {
  const { db, authorize } = fastify;
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get(
    '/',
    {
      schema: {
        tags,
        summary: 'Sites with their shifts',
        querystring: { type: 'object', properties: { ...paginationQuerySchema, isActive: { type: 'boolean' } } },
        response: { 200: pagedResponseSchema(item) },
      },
      preHandler: authorize(SCREENS.SITES, 'view'),
    },
    async (req) => {
      const q = req.query;
      const where = new WhereBuilder();
      if (q.search) {
        const t = `%${escapeLike(q.search)}%`;
        where.add(`(s.name ILIKE $? OR EXISTS (SELECT 1 FROM site_shifts ss WHERE ss.site_id = s.id AND ss.name ILIKE $?))`, t, t);
      }
      if (q.isActive !== undefined) where.add('s.is_active = $?', q.isActive);
      const limit = where.param(q.pageSize);
      const offset = where.param((q.page - 1) * q.pageSize);
      const { rows } = await db.query(
        `SELECT x.*, count(*) OVER()::int AS total FROM (${SELECT} ${where.toSql()}) x ORDER BY x.name ${q.sortDir === 'desc' ? 'DESC' : 'ASC'} LIMIT ${limit} OFFSET ${offset}`,
        where.params,
      );
      return { items: rows.map(toDto), total: rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize };
    },
  );

  fastify.get('/:id', { schema: { tags, summary: 'A site with its shifts', params: idParams, response: { 200: item } }, preHandler: authorize(SCREENS.SITES, 'view') }, (req) =>
    getOne(db, req.params.id),
  );

  fastify.post(
    '/',
    { schema: { tags, summary: 'Create a site with its shifts', body, response: { 201: item } }, preHandler: authorize(SCREENS.SITES, 'create') },
    async (req, reply) => {
      const b = req.body;
      await validate(db, b, null);
      const id = await db.tx(async (client) => {
        const { rows } = await client.query(`INSERT INTO sites (name, is_active, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id`, [
          b.name.trim(),
          b.isActive,
          req.auth.userId,
        ]);
        await saveShifts(client, rows[0].id, b.shifts.map((s) => ({ ...s, id: null })), req.auth.userId);
        await writeAudit(client, { entity: 'sites', entityId: rows[0].id, action: 'create', userId: req.auth.userId, message: `${b.shifts.length} shift(s)` });
        return rows[0].id;
      });
      return reply.status(201).send(await getOne(db, id));
    },
  );

  fastify.put(
    '/:id',
    { schema: { tags, summary: 'Update a site and its shifts', params: idParams, body, response: { 200: item } }, preHandler: authorize(SCREENS.SITES, 'edit') },
    async (req) => {
      const { id } = req.params;
      const b = req.body;
      await getOne(db, id);
      await validate(db, b, id);
      await db.tx(async (client) => {
        await client.query(`UPDATE sites SET name = $2, is_active = $3, updated_by = $4 WHERE id = $1`, [id, b.name.trim(), b.isActive, req.auth.userId]);
        await saveShifts(client, id, b.shifts, req.auth.userId);
        await writeAudit(client, { entity: 'sites', entityId: id, action: 'update', userId: req.auth.userId, message: 'Site and shifts saved' });
      });
      return getOne(db, id);
    },
  );

  fastify.delete(
    '/:id',
    { schema: { tags, summary: 'Delete a site (no users on it)', params: idParams, response: { 204: { type: 'null' } } }, preHandler: authorize(SCREENS.SITES, 'delete') },
    async (req, reply) => {
      const { id } = req.params;
      await getOne(db, id);
      try {
        await db.tx(async (client) => {
          await client.query(`DELETE FROM sites WHERE id = $1`, [id]); // shifts go with it (CASCADE) unless used
          await writeAudit(client, { entity: 'sites', entityId: id, action: 'delete', userId: req.auth.userId });
        });
      } catch (err) {
        if (isReferenceError(err)) throw conflict('Users are on this site – move them or make the site inactive');
        throw err;
      }
      return reply.status(204).send();
    },
  );
}
