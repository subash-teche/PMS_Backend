import { SCREENS } from '../../config/menus.js';
import { writeAudit } from '../../utils/audit.js';
import { badRequest, conflict, forbidden, isReferenceError, notFound } from '../../utils/errors.js';
import { escapeLike, paginationQuerySchema, pagedResponseSchema, WhereBuilder } from '../../utils/query.js';
import { can } from '../auth/auth-context.js';

/*
 * Task groups. A group is saved on its own; its task types live on the Task Types screen
 * (one menu, one screen each). The optional `taskTypes` array is kept for callers that still
 * save a group with its types in one transaction – it needs the Task Types permission.
 * A task type that is used (timesheets, project tasks) cannot be removed –
 * make it inactive instead.
 */

const tags = ['Task Groups'];
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };

const typeIn = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    id: { type: ['integer', 'null'], minimum: 1, description: 'existing task type; empty for a new one' },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    description: { type: ['string', 'null'], maxLength: 5000 },
    isActive: { type: 'boolean', default: true },
  },
};
const body = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    // optional: when it is left out the group's task types are not touched
    taskTypes: { type: 'array', items: typeIn, maxItems: 200 },
  },
};
const typeOut = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    isActive: { type: 'boolean' },
    inUse: { type: 'boolean' },
  },
};
const item = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    taskTypeCount: { type: 'integer' },
    activeTypeCount: { type: 'integer' },
    taskTypes: { type: 'array', items: typeOut },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

// a task type is "in use" when timesheets or project tasks point at it
const IN_USE = (alias) => `(EXISTS (SELECT 1 FROM timesheets ts WHERE ts.task_type_id = ${alias}.id)
                       OR EXISTS (SELECT 1 FROM tasks tk WHERE tk.task_type_id = ${alias}.id))`;

const SELECT = `
  SELECT g.id, g.name, g.updated_at,
         COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'description', t.description,
                                                     'isActive', t.is_active, 'inUse', ${IN_USE('t')})
                                   ORDER BY t.is_active DESC, t.name)
                     FROM task_types t WHERE t.task_group_id = g.id), '[]') AS task_types
    FROM task_groups g`;

const toDto = (r) => ({
  id: r.id,
  name: r.name,
  taskTypes: r.task_types,
  taskTypeCount: r.task_types.length,
  activeTypeCount: r.task_types.filter((t) => t.isActive).length,
  updatedAt: r.updated_at,
});

async function getOne(db, id) {
  const { rows } = await db.query(`${SELECT} WHERE g.id = $1`, [id]);
  if (!rows[0]) throw notFound('Task group');
  return toDto(rows[0]);
}

/** Unique group name; type names unique within the group. */
async function validate(db, b, id) {
  const { rowCount } = await db.query(`SELECT 1 FROM task_groups WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2`, [b.name.trim(), id]);
  if (rowCount) throw badRequest('A task group with this name already exists', [{ field: 'name', message: 'already exists' }]);
  const seen = new Set();
  for (const t of b.taskTypes ?? []) {
    const key = t.name.trim().toLowerCase();
    if (seen.has(key)) throw badRequest(`Task type "${t.name.trim()}" is listed twice`, [{ field: 'taskTypes', message: 'duplicate name' }]);
    seen.add(key);
  }
}

/** Updates kept types, adds new ones, removes the rest (refused for types in use). */
async function saveTypes(client, groupId, types, userId) {
  const { rows: existing } = await client.query(`SELECT t.id, t.name, ${IN_USE('t')} AS in_use FROM task_types t WHERE t.task_group_id = $1`, [groupId]);
  const keep = new Set(types.filter((t) => t.id).map((t) => t.id));
  const foreign = types.find((t) => t.id && !existing.some((e) => e.id === t.id));
  if (foreign) throw badRequest('A task type in the list belongs to another task group', [{ field: 'taskTypes', message: 'not in this group' }]);

  const removed = existing.filter((e) => !keep.has(e.id));
  const used = removed.find((e) => e.in_use);
  if (used) throw conflict(`"${used.name}" is used by timesheets or tasks – make it inactive instead of removing it`);
  if (removed.length) await client.query(`DELETE FROM task_types WHERE id = ANY($1)`, [removed.map((e) => e.id)]);

  // free the names of renamed types first so a swap of two names doesn't hit the unique key
  for (const t of types.filter((x) => x.id)) {
    await client.query(`UPDATE task_types SET name = name || ' ~' || id WHERE id = $1`, [t.id]);
  }
  for (const t of types) {
    if (t.id) {
      await client.query(`UPDATE task_types SET name = $2, description = $3, is_active = $4, updated_by = $5 WHERE id = $1`, [
        t.id,
        t.name.trim(),
        t.description?.trim() || null,
        t.isActive ?? true,
        userId,
      ]);
    } else {
      await client.query(
        `INSERT INTO task_types (task_group_id, name, description, is_active, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)`,
        [groupId, t.name.trim(), t.description?.trim() || null, t.isActive ?? true, userId],
      );
    }
  }
}

export default async function taskGroupsRoutes(fastify) {
  const { db, authorize } = fastify;
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get(
    '/',
    {
      schema: { tags, summary: 'Task groups with their task types', querystring: { type: 'object', properties: { ...paginationQuerySchema } }, response: { 200: pagedResponseSchema(item) } },
      preHandler: authorize(SCREENS.TASK_GROUPS, 'view'),
    },
    async (req) => {
      const q = req.query;
      const where = new WhereBuilder();
      if (q.search) {
        const s = `%${escapeLike(q.search)}%`;
        where.add(`(g.name ILIKE $? OR EXISTS (SELECT 1 FROM task_types t WHERE t.task_group_id = g.id AND t.name ILIKE $?))`, s, s);
      }
      const limit = where.param(q.pageSize);
      const offset = where.param((q.page - 1) * q.pageSize);
      const { rows } = await db.query(
        `SELECT s.*, count(*) OVER()::int AS total FROM (${SELECT} ${where.toSql()}) s ORDER BY s.name ${q.sortDir === 'desc' ? 'DESC' : 'ASC'} LIMIT ${limit} OFFSET ${offset}`,
        where.params,
      );
      return { items: rows.map(toDto), total: rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize };
    },
  );

  fastify.get('/:id', { schema: { tags, summary: 'A task group with its task types', params: idParams, response: { 200: item } }, preHandler: authorize(SCREENS.TASK_GROUPS, 'view') }, (req) =>
    getOne(db, req.params.id),
  );

  fastify.post(
    '/',
    { schema: { tags, summary: 'Create a task group', body, response: { 201: item } }, preHandler: authorize(SCREENS.TASK_GROUPS, 'create') },
    async (req, reply) => {
      const b = req.body;
      const types = b.taskTypes ?? [];
      if (types.length && !can(req.auth, SCREENS.TASK_TYPES, 'create')) {
        throw forbidden('You do not have permission to add task types');
      }
      await validate(db, b, null);
      const id = await db.tx(async (client) => {
        const { rows } = await client.query(`INSERT INTO task_groups (name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`, [b.name.trim(), req.auth.userId]);
        if (types.length) await saveTypes(client, rows[0].id, types.map((t) => ({ ...t, id: null })), req.auth.userId);
        await writeAudit(client, { entity: 'task_groups', entityId: rows[0].id, action: 'create', userId: req.auth.userId, message: `${types.length} task type(s)` });
        return rows[0].id;
      });
      return reply.status(201).send(await getOne(db, id));
    },
  );

  fastify.put(
    '/:id',
    { schema: { tags, summary: 'Update a task group', params: idParams, body, response: { 200: item } }, preHandler: authorize(SCREENS.TASK_GROUPS, 'edit') },
    async (req) => {
      const { id } = req.params;
      const b = req.body;
      // the task types are only saved when they are sent; otherwise they are left alone
      const types = Array.isArray(b.taskTypes) ? b.taskTypes : null;
      if (types && !can(req.auth, SCREENS.TASK_TYPES, 'edit')) {
        throw forbidden('You do not have permission to change task types');
      }
      await getOne(db, id);
      await validate(db, b, id);
      await db.tx(async (client) => {
        await client.query(`UPDATE task_groups SET name = $2, updated_by = $3 WHERE id = $1`, [id, b.name.trim(), req.auth.userId]);
        if (types) await saveTypes(client, id, types, req.auth.userId);
        await writeAudit(client, { entity: 'task_groups', entityId: id, action: 'update', userId: req.auth.userId, message: 'Task group saved' });
      });
      return getOne(db, id);
    },
  );

  fastify.delete(
    '/:id',
    { schema: { tags, summary: 'Delete a task group and its unused task types', params: idParams, response: { 204: { type: 'null' } } }, preHandler: authorize(SCREENS.TASK_GROUPS, 'delete') },
    async (req, reply) => {
      const { id } = req.params;
      await getOne(db, id);
      try {
        await db.tx(async (client) => {
          await client.query(`DELETE FROM task_types WHERE task_group_id = $1`, [id]);
          await client.query(`DELETE FROM task_groups WHERE id = $1`, [id]);
          await writeAudit(client, { entity: 'task_groups', entityId: id, action: 'delete', userId: req.auth.userId });
        });
      } catch (err) {
        if (isReferenceError(err)) throw conflict('This task group or its task types are used by projects, tasks or timesheets – make the types inactive instead');
        throw err;
      }
      return reply.status(204).send();
    },
  );
}
