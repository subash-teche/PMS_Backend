import { SCREENS } from '../../config/menus.js';
import { writeAudit, diff } from '../../utils/audit.js';
import { badRequest, conflict, isReferenceError, notFound } from '../../utils/errors.js';
import { escapeLike, paginationQuerySchema, pagedResponseSchema, WhereBuilder } from '../../utils/query.js';

/*
 * Project types with their default effort split (% per task group, must total 100).
 */

const tags = ['Project Types'];
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };

const estimate = {
  type: 'object',
  required: ['taskGroupId', 'effortPercentage'],
  additionalProperties: false,
  properties: {
    taskGroupId: { type: 'integer', minimum: 1 },
    effortPercentage: { type: 'number', minimum: 0, maximum: 100 },
  },
};
const body = {
  type: 'object',
  required: ['name', 'projectDivisionId'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    projectDivisionId: { type: 'integer', minimum: 1, description: 'division the type belongs to' },
    description: { type: ['string', 'null'], maxLength: 2000 },
    isActive: { type: 'boolean', default: true },
    // the split is only changed when it is sent
    estimates: { type: 'array', items: estimate, maxItems: 50 },
  },
};
const listItem = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    projectDivisionId: { type: ['integer', 'null'] },
    divisionName: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    isActive: { type: 'boolean' },
    projectCount: { type: 'integer' },
    split: {
      type: 'array',
      items: { type: 'object', properties: { taskGroupName: { type: 'string' }, effortPercentage: { type: 'number' } } },
    },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};
const detail = {
  ...listItem,
  properties: {
    ...listItem.properties,
    estimates: {
      type: 'array',
      items: {
        type: 'object',
        properties: { taskGroupId: { type: 'integer' }, taskGroupName: { type: 'string' }, effortPercentage: { type: 'number' } },
      },
    },
  },
};

const LIST_SELECT = `
  SELECT x.id, x.name, x.project_division_id, d.name AS division_name, x.description, x.is_active, x.updated_at,
         (SELECT count(*)::int FROM projects p WHERE p.project_type_id = x.id) AS project_count,
         COALESCE((SELECT json_agg(json_build_object('taskGroupName', g.name, 'effortPercentage', e.effort_percentage)
                                   ORDER BY e.effort_percentage DESC, g.name)
<<<<<<< HEAD
                     FROM project_type_default_estimates e JOIN task_groups g ON g.id = e.task_group_id
                    WHERE e.project_type_id = x.id), '[]') AS split
=======
                     FROM project_type_effort_defaults e JOIN task_groups g ON g.id = e.task_group_id
                    WHERE e.project_type_id = x.id), '[]') AS split,
         COALESCE((SELECT json_agg(json_build_object('name', tg.name, 'count', tg.n) ORDER BY tg.n DESC, tg.name)
                     FROM (SELECT g.name, count(*)::int AS n FROM project_type_task_templates t JOIN task_groups g ON g.id = t.task_group_id
                            WHERE t.project_type_id = x.id GROUP BY g.name) tg), '[]') AS template_groups
>>>>>>> 3ea51260a802144b6537da0f3d1d9141600b4276
    FROM project_types x
    LEFT JOIN project_divisions d ON d.id = x.project_division_id`;

const toListDto = (r) => ({
  id: r.id,
  name: r.name,
  projectDivisionId: r.project_division_id,
  divisionName: r.division_name,
  description: r.description,
  isActive: r.is_active,
  projectCount: r.project_count,
  split: r.split.map((s) => ({ ...s, effortPercentage: Number(s.effortPercentage) })),
  updatedAt: r.updated_at,
});

async function getOne(db, id) {
  const { rows } = await db.query(`SELECT * FROM (${LIST_SELECT}) s WHERE s.id = $1`, [id]);
  if (!rows[0]) throw notFound('Project type');
<<<<<<< HEAD
  const [estimates] = await Promise.all([
=======
  const [templates, estimates] = await Promise.all([
    db.query(
      `SELECT t.task_group_id, g.name AS group_name, t.task_type_id, tt.name AS type_name, t.task_title,
              t.description, t.effort_percentage, t.manager_approval, t.client_approval,
              COALESCE((SELECT json_agg(json_build_object('id', l.id, 'name', l.name) ORDER BY l.display_order, l.name)
                          FROM project_type_task_template_roles r JOIN parameter_values l ON l.id = r.role_id
                         WHERE r.task_template_id = t.id), '[]') AS roles
         FROM project_type_task_templates t
         JOIN task_groups g ON g.id = t.task_group_id JOIN task_types tt ON tt.id = t.task_type_id
        WHERE t.project_type_id = $1 ORDER BY t.sort_order, t.id`,
      [id],
    ),
>>>>>>> 3ea51260a802144b6537da0f3d1d9141600b4276
    db.query(
      `SELECT e.task_group_id, g.name, e.effort_percentage FROM project_type_effort_defaults e
         JOIN task_groups g ON g.id = e.task_group_id WHERE e.project_type_id = $1 ORDER BY e.effort_percentage DESC, g.name`,
      [id],
    ),
  ]);
  return {
    ...toListDto(rows[0]),
    estimates: estimates.rows.map((e) => ({ taskGroupId: e.task_group_id, taskGroupName: e.name, effortPercentage: e.effort_percentage })),
  };
}

/** The effort split must total 100 (when given) and use each group once. */
async function validate(db, b) {
  const { rows: div } = await db.query(`SELECT is_active FROM project_divisions WHERE id = $1`, [b.projectDivisionId]);
  if (!div[0]) throw badRequest('Select a project division', [{ field: 'projectDivisionId', message: 'does not exist' }]);
  const groups = (b.estimates ?? []).map((e) => e.taskGroupId);
  if (new Set(groups).size !== groups.length) throw badRequest('Each task group can appear only once in the effort split');
  if (b.estimates?.length) {
    const total = b.estimates.reduce((s, e) => s + e.effortPercentage, 0);
    if (Math.abs(total - 100) > 0.001) {
      throw badRequest(`The default effort split must total 100% (now ${Math.round(total * 100) / 100}%)`, [{ field: 'estimates', message: 'must total 100%' }]);
    }
  }
<<<<<<< HEAD
}

async function saveChildren(client, id, b, userId) {
  if (b.estimates) await client.query(`DELETE FROM project_type_default_estimates WHERE project_type_id = $1`, [id]);
=======
  if (b.templates?.length) {
    const { rows } = await db.query(`SELECT id, task_group_id FROM task_types WHERE id = ANY($1)`, [b.templates.map((t) => t.taskTypeId)]);
    const groupOf = new Map(rows.map((r) => [r.id, r.task_group_id]));
    b.templates.forEach((t, i) => {
      if (groupOf.get(t.taskTypeId) !== t.taskGroupId) {
        throw badRequest(`Task row ${i + 1}: the task type does not belong to the selected task group`, [{ field: `templates.${i}.taskTypeId`, message: 'does not belong to the task group' }]);
      }
    });
    const roleIds = [...new Set(b.templates.flatMap((t) => t.roleIds ?? []))];
    if (roleIds.length) {
      const { rows: roles } = await db.query(`SELECT id FROM parameter_values WHERE id = ANY($1) AND type = 'SKILL'`, [roleIds]);
      if (roles.length !== roleIds.length) throw badRequest('One of the selected skills does not exist (Parameters → SKILL)');
    }
  }
}

async function saveChildren(client, id, b, userId) {
  if (b.templates) await client.query(`DELETE FROM project_type_task_templates WHERE project_type_id = $1`, [id]);
  if (b.estimates) await client.query(`DELETE FROM project_type_effort_defaults WHERE project_type_id = $1`, [id]);
  if (b.templates?.length) {
    const T = b.templates;
    const { rows } = await client.query(
      `INSERT INTO project_type_task_templates
              (project_type_id, task_group_id, task_type_id, task_title, description, manager_approval, client_approval, effort_percentage, sort_order, created_by, updated_by)
       SELECT $1, g, t, title, descr, mgr, cli, eff, ord, $8, $8
         FROM unnest($2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::bool[], $7::bool[], $9::numeric[]) WITH ORDINALITY AS u(g, t, title, descr, mgr, cli, eff, ord)
       RETURNING id, sort_order`,
      [
        id,
        T.map((t) => t.taskGroupId),
        T.map((t) => t.taskTypeId),
        T.map((t) => t.taskTitle.trim()),
        T.map((t) => t.description?.trim() || null),
        T.map((t) => !!t.managerApproval),
        T.map((t) => !!t.clientApproval),
        userId,
        T.map((t) => t.effortPercentage ?? null),
      ],
    );
    // sort_order is the 1-based row position, so it links each new row back to its roles
    const pairs = rows.flatMap((r) => (T[r.sort_order - 1].roleIds ?? []).map((roleId) => [r.id, roleId]));
    if (pairs.length) {
      await client.query(
        `INSERT INTO project_type_task_template_roles (task_template_id, role_id) SELECT * FROM unnest($1::bigint[], $2::bigint[])`,
        [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
      );
    }
  }
>>>>>>> 3ea51260a802144b6537da0f3d1d9141600b4276
  if (b.estimates?.length) {
    await client.query(
      `INSERT INTO project_type_effort_defaults (project_type_id, task_group_id, effort_percentage, created_by, updated_by)
       SELECT $1, g, pct, $4, $4 FROM unnest($2::bigint[], $3::numeric[]) AS u(g, pct)`,
      [id, b.estimates.map((e) => e.taskGroupId), b.estimates.map((e) => e.effortPercentage), userId],
    );
  }
}

const unique = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err.code === '23505') throw conflict('A project type with this name already exists');
    throw err;
  }
};

export default async function projectTypesRoutes(fastify) {
  const { db, authorize } = fastify;
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get(
    '/',
    {
      schema: {
        tags,
        summary: 'List project types',
        querystring: {
          type: 'object',
          properties: {
            ...paginationQuerySchema,
            sortBy: { type: 'string', enum: ['name', 'projectCount'] },
            isActive: { type: 'boolean' },
            divisionId: { type: 'string', description: 'comma-separated division ids' },
          },
        },
        response: { 200: pagedResponseSchema(listItem) },
      },
      preHandler: authorize(SCREENS.PROJECT_DIVISIONS, 'view'),
    },
    async (req) => {
      const q = req.query;
      const where = new WhereBuilder();
      if (q.search) {
        const t = `%${escapeLike(q.search)}%`;
        where.add(`(s.name ILIKE $? OR s.description ILIKE $? OR s.division_name ILIKE $?)`, t, t, t);
      }
      const divisionIds = String(q.divisionId ?? '').split(',').map(Number).filter((n) => n > 0);
      if (divisionIds.length) where.add(`s.project_division_id = ANY($?)`, divisionIds);
      if (q.isActive !== undefined) where.add(`s.is_active = $?`, q.isActive);
      const sort = { name: 's.name', projectCount: 's.project_count' }[q.sortBy] ?? 's.name';
      const limit = where.param(q.pageSize);
      const offset = where.param((q.page - 1) * q.pageSize);
      const { rows } = await db.query(
        `SELECT s.*, count(*) OVER()::int AS total FROM (${LIST_SELECT}) s ${where.toSql()}
          ORDER BY ${sort} ${q.sortDir === 'desc' ? 'DESC' : 'ASC'}, s.id LIMIT ${limit} OFFSET ${offset}`,
        where.params,
      );
      return { items: rows.map(toListDto), total: rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize };
    },
  );

  fastify.get('/:id', { schema: { tags, summary: 'Get a project type with its split', params: idParams, response: { 200: detail } }, preHandler: authorize(SCREENS.PROJECT_DIVISIONS, 'view') }, (req) =>
    getOne(db, req.params.id),
  );

  fastify.post(
    '/',
    { schema: { tags, summary: 'Create a project type', body, response: { 201: detail } }, preHandler: authorize(SCREENS.PROJECT_DIVISIONS, 'create') },
    async (req, reply) => {
      const b = req.body;
      await validate(db, b);
      const id = await unique(() =>
        db.tx(async (client) => {
          const { rows } = await client.query(
            `INSERT INTO project_types (name, project_division_id, description, is_active, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
            [b.name.trim(), b.projectDivisionId, b.description?.trim() || null, b.isActive, req.auth.userId],
          );
          await saveChildren(client, rows[0].id, b, req.auth.userId);
          await writeAudit(client, { entity: 'project_types', entityId: rows[0].id, action: 'create', userId: req.auth.userId });
          return rows[0].id;
        }),
      );
      return reply.status(201).send(await getOne(db, id));
    },
  );

  fastify.put(
    '/:id',
    { schema: { tags, summary: 'Update a project type and its split', params: idParams, body, response: { 200: detail } }, preHandler: authorize(SCREENS.PROJECT_DIVISIONS, 'edit') },
    async (req) => {
      const { id } = req.params;
      const b = req.body;
      const { rows } = await db.query(`SELECT * FROM project_types WHERE id = $1`, [id]);
      if (!rows[0]) throw notFound('Project type');
      await validate(db, b);
      await unique(() =>
        db.tx(async (client) => {
          const { rows: after } = await client.query(
            `UPDATE project_types SET name = $2, project_division_id = $3, description = $4, is_active = $5, updated_by = $6 WHERE id = $1 RETURNING *`,
            [id, b.name.trim(), b.projectDivisionId, b.description?.trim() || null, b.isActive, req.auth.userId],
          );
          await saveChildren(client, id, b, req.auth.userId);
          await writeAudit(client, {
            entity: 'project_types',
            entityId: id,
            action: 'update',
            userId: req.auth.userId,
            message: 'Project type saved',
            changes: diff(rows[0], after[0], ['name', 'project_division_id', 'description', 'is_active']),
          });
        }),
      );
      return getOne(db, id);
    },
  );

  fastify.delete(
    '/:id',
    { schema: { tags, summary: 'Delete a project type (not used by projects)', params: idParams, response: { 204: { type: 'null' } } }, preHandler: authorize(SCREENS.PROJECT_DIVISIONS, 'delete') },
    async (req, reply) => {
      try {
        const res = await db.tx(async (client) => {
          const r = await client.query(`DELETE FROM project_types WHERE id = $1`, [req.params.id]);
          if (r.rowCount) await writeAudit(client, { entity: 'project_types', entityId: req.params.id, action: 'delete', userId: req.auth.userId });
          return r;
        });
        if (!res.rowCount) throw notFound('Project type');
      } catch (err) {
        if (isReferenceError(err)) throw conflict('Projects use this project type – deactivate it instead');
        throw err;
      }
      return reply.status(204).send();
    },
  );
}
