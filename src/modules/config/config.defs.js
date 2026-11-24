import { SCREENS } from '../../config/menus.js';
import { badRequest, conflict } from '../../utils/errors.js';

// Field schemas reused below
const name = (max = 100) => ({ col: 'name', schema: { type: 'string', minLength: 1, maxLength: max } });
const description = { col: 'description', schema: { type: ['string', 'null'], maxLength: 2000 } };
const isActive = { col: 'is_active', schema: { type: 'boolean' } };

const activeFilter = {
  isActive: { schema: { type: 'boolean' }, sql: (w, v) => w.add('s.is_active = $?', v) },
};


/**
 * A skill (Parameters → SKILL) in use by a user cannot be deleted: change or remove
 * it there first. (Project tasks only keep a copy – their link goes with the skill.)
 */
async function assertSkillUnused(db, id, action) {
  const { rows } = await db.query(
    `SELECT (SELECT string_agg(u.name, ', ' ORDER BY u.name) FROM user_skills us JOIN users u ON u.id = us.user_id WHERE us.skill_id = $1) AS users,
            0 AS unused`,
    [id],
  );
  const u = rows[0];
  if (!u.users) return;
  const where = [
    u.users && `the user(s) ${u.users} (Users → Skills)`,
  ].filter(Boolean);
  throw conflict(`This skill is used by ${where.join(' and ')}. Change or remove it there first, then it can be ${action}.`);
}

export const CONFIG_DEFS = [
  // Parameters tab: the parameters (lists) themselves – their values are the "parameters" records below
  {
    name: 'parameter-types',
    label: 'Parameters',
    table: 'parameter_types',
    screen: SCREENS.PARAMETERS,
    fields: {
      // stored in upper case (COUNTRY, LEAD_SOURCE …)
      code: { col: 'code', schema: { type: 'string', minLength: 1, maxLength: 50, pattern: '^[A-Za-z][A-Za-z0-9_]*$' } },
      name: name(100),
      description,
      displayOrder: { col: 'display_order', schema: { type: 'integer', minimum: 0, maximum: 9999 } },
    },
    required: ['code', 'name'],
    computed: { isSystem: { type: 'boolean' }, valueCount: { type: 'integer' } },
    // project stages have their own screen
    select: `SELECT x.id, x.code, x.name, x.description, x.display_order, x.is_system, x.created_at, x.updated_at,
                    (SELECT count(*)::int FROM parameter_values l WHERE l.type = x.code) AS value_count
               FROM parameter_types x WHERE x.code <> 'PROJECT_STAGE'`,
    beforeSave: async (db, body, id) => {
      if (body.code !== undefined) body.code = body.code.trim().toUpperCase();
      if (!id) return;
      const { rows } = await db.query(`SELECT code, is_system FROM parameter_types WHERE id = $1`, [id]);
      if (rows[0]?.is_system && body.code !== undefined && body.code !== rows[0].code) {
        throw badRequest('The code of a built-in parameter cannot change', [{ field: 'code', message: 'is fixed for a built-in parameter' }]);
      }
    },
    beforeDelete: async (db, id) => {
      const { rows } = await db.query(`SELECT is_system, (SELECT count(*)::int FROM parameter_values l WHERE l.type = p.code) AS n FROM parameter_types p WHERE id = $1`, [id]);
      if (rows[0]?.is_system) throw conflict('This parameter is used by the application and cannot be deleted');
      if (rows[0]?.n) throw conflict(`This parameter has ${rows[0].n} value(s) – delete them on the Parameter Values tab first`);
    },
    search: ['code', 'name', 'description'],
    sort: { name: 's.name', code: 's.code', displayOrder: 's.display_order' },
    defaultSort: 's.display_order, s.name',
    uniqueMessage: 'A parameter with this code already exists',
  },
  // Parameter Values tab
  {
    name: 'parameters',
    label: 'Parameter Values',
    table: 'parameter_values',
    screen: SCREENS.PARAMETERS,
    fields: {
      // PROJECT_STAGE values are managed on the Project Stages screen
      type: { col: 'type', schema: { type: 'string', minLength: 1, maxLength: 50, pattern: '^[A-Z][A-Z0-9_]*$', not: { const: 'PROJECT_STAGE' } } },
      name: name(150),
      value: { col: 'value', schema: { type: ['string', 'null'], maxLength: 150 } },
      displayOrder: { col: 'display_order', schema: { type: 'integer', minimum: 0, maximum: 9999 } },
      isVisible: { col: 'is_visible', schema: { type: 'boolean' } },
    },
    required: ['type', 'name'],
    // project stages have their own screen
    computed: { typeName: { type: ['string', 'null'] } },
    select: `SELECT x.id, x.type, t.name AS type_name, x.name, x.value, x.display_order, x.is_visible, x.created_at, x.updated_at
               FROM parameter_values x LEFT JOIN parameter_types t ON t.code = x.type WHERE x.type <> 'PROJECT_STAGE'`,
    beforeSave: async (db, body, id) => {
      const before = id ? (await db.query(`SELECT type, value FROM parameter_values WHERE id = $1`, [id])).rows[0] : null;
      // the type must be one of the parameters (Parameters tab)
      if (body.type !== undefined) {
        const { rowCount } = await db.query(`SELECT 1 FROM parameter_types WHERE code = $1`, [body.type]);
        if (!rowCount) throw badRequest('Select a parameter from the Parameters tab', [{ field: 'type', message: 'is not a parameter' }]);
      }
      // a skill that users use cannot become another type
      if (before?.type === 'SKILL' && body.type && body.type !== 'SKILL') await assertSkillUnused(db, id, 'changed to another type');
      // currencies are matched by their ISO code (value) – keep it upper case
      if ((body.type ?? before?.type) === 'CURRENCY' && body.value) body.value = body.value.trim().toUpperCase();
    },
    search: ['name', 'value', 'type', 'type_name'],
    filters: {
      type: { schema: { type: 'string' }, sql: (w, v) => w.add('s.type = ANY($?)', String(v).split(',')) },
      isVisible: { schema: { type: 'boolean' }, sql: (w, v) => w.add('s.is_visible = $?', v) },
    },
    sort: { name: 's.name', type: 's.type', displayOrder: 's.display_order' },
    defaultSort: 's.type, s.display_order, s.name',
    uniqueMessage: 'This parameter already exists for the selected type',
    beforeDelete: async (db, id) => {
      const { rows } = await db.query(`SELECT type FROM parameter_values WHERE id = $1`, [id]);
      if (rows[0]?.type === 'SKILL') await assertSkillUnused(db, id, 'deleted');
    },
  },
  {
    name: 'teams',
    label: 'Teams',
    table: 'teams',
    screen: SCREENS.TEAMS,
    fields: {
      name: name(),
      countryId: { col: 'country_id', schema: { type: ['integer', 'null'], minimum: 1 } },
    },
    required: ['name'],
    computed: { countryName: { type: ['string', 'null'] }, userCount: { type: 'integer' } },
    select: `SELECT x.id, x.name, x.country_id, c.name AS country_name, x.created_at, x.updated_at,
                    (SELECT count(*)::int FROM user_teams ut WHERE ut.team_id = x.id) AS user_count
               FROM teams x LEFT JOIN parameter_values c ON c.id = x.country_id`,
    search: ['name', 'country_name'],
    filters: { countryId: { schema: { type: 'string' }, sql: (w, v, ids) => w.add('s.country_id = ANY($?)', ids(v)) } },
    sort: { name: 's.name' },
    uniqueMessage: 'A team with this name already exists',
    inUseMessage: 'This team has users – remove them first',
  },
  {
    name: 'project-stages',
    label: 'Project Stages',
    table: 'parameter_values',
    screen: SCREENS.PROJECT_STAGES,
    fixed: { type: 'PROJECT_STAGE' },
    fields: {
      name: name(150),
      value: { col: 'value', schema: { type: 'string', enum: ['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled'] } },
      displayOrder: { col: 'display_order', schema: { type: 'integer', minimum: 0, maximum: 9999 } },
      isVisible: { col: 'is_visible', schema: { type: 'boolean' } },
    },
    required: ['name', 'value'],
    computed: { projectCount: { type: 'integer' } },
    select: `SELECT x.id, x.name, x.value, x.display_order, x.is_visible, x.created_at, x.updated_at,
                    (SELECT count(*)::int FROM projects p WHERE p.stage_id = x.id) AS project_count
               FROM parameter_values x WHERE x.type = 'PROJECT_STAGE'`,
    search: ['name'],
    filters: { value: { schema: { type: 'string' }, sql: (w, v) => w.add('s.value = ANY($?)', String(v).split(',')) } },
    sort: { name: 's.name', displayOrder: 's.display_order' },
    defaultSort: 's.display_order, s.name',
    uniqueMessage: 'A stage with this name already exists',
    inUseMessage: 'Projects are in this stage – move them or hide the stage instead',
  },
  {
    name: 'task-types',
    label: 'Task Types',
    table: 'task_types',
    screen: SCREENS.TASK_TYPES,
    fields: {
      name: name(100),
      taskGroupId: { col: 'task_group_id', schema: { type: 'integer', minimum: 1 } },
      description: { col: 'description', schema: { type: ['string', 'null'], maxLength: 5000 } },
      isActive,
    },
    required: ['name', 'taskGroupId'],
    computed: { taskGroupName: { type: ['string', 'null'] }, inUse: { type: 'boolean' } },
    select: `SELECT x.id, x.name, x.description, x.task_group_id, g.name AS task_group_name,
                    x.is_active, x.created_at, x.updated_at,
<<<<<<< HEAD
                    (EXISTS (SELECT 1 FROM timesheets ts WHERE ts.task_type_id = x.id)
                     OR EXISTS (SELECT 1 FROM tasks tk WHERE tk.task_type_id = x.id)) AS in_use
=======
                    (EXISTS (SELECT 1 FROM tasks tk WHERE tk.task_type_id = x.id)
                     OR EXISTS (SELECT 1 FROM project_type_task_templates tt WHERE tt.task_type_id = x.id)) AS in_use
>>>>>>> 3ea51260a802144b6537da0f3d1d9141600b4276
               FROM task_types x
               JOIN task_groups g ON g.id = x.task_group_id`,
    beforeSave: async (db, body, id) => {
      const before = id ? (await db.query(`SELECT task_group_id, name FROM task_types WHERE id = $1`, [id])).rows[0] : null;
      const gid = body.taskGroupId ?? before?.task_group_id;
      const tname = body.name !== undefined ? body.name?.trim() : before?.name;
      if (gid && tname) {
        const { rowCount } = await db.query(
          `SELECT 1 FROM task_types WHERE task_group_id = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3`,
          [gid, tname, id ?? null],
        );
        if (rowCount) {
          throw badRequest('A task type with this name already exists in the selected task group', [
            { field: 'name', message: 'already exists in this task group' },
          ]);
        }
      }
    },
    search: ['name', 'task_group_name', 'description'],
    filters: {
      ...activeFilter,
      taskGroupId: { schema: { type: 'string' }, sql: (w, v, ids) => w.add('s.task_group_id = ANY($?)', ids(v)) },
    },
    sort: { name: 's.name', taskGroupName: 's.task_group_name' },
    defaultSort: 's.task_group_name, s.name',
    uniqueMessage: 'A task type with this name already exists in the selected group',
    inUseMessage: 'This task type is used in timesheets or tasks – switch it inactive instead',
  },
  {
    name: 'task-categories',
    label: 'Task Categories',
    table: 'task_categories',
    screen: SCREENS.TASK_CATEGORIES,
    fields: {
      name: name(100),
      description,
      isProject: { col: 'is_project', schema: { type: 'boolean' } },
      displayOrder: { col: 'display_order', schema: { type: 'integer', minimum: 0, maximum: 9999 } },
      isActive,
    },
    required: ['name'],
    // the task groups the category can use (none = any group)
    links: {
      taskGroupIds: { table: 'task_category_groups', owner: 'task_category_id', other: 'task_group_id', schema: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 200 } },
    },
    computed: {
      taskCount: { type: 'integer' },
      taskGroupIds: { type: 'array', items: { type: 'integer' } },
      taskGroupNames: { type: 'array', items: { type: 'string' } },
    },
    select: `SELECT x.id, x.name, x.description, x.is_project, x.display_order, x.is_active, x.created_at, x.updated_at,
                    (SELECT count(*)::int FROM tasks t WHERE t.task_category_id = x.id) AS task_count,
                    ARRAY(SELECT l.task_group_id FROM task_category_groups l WHERE l.task_category_id = x.id ORDER BY l.task_group_id)::int[] AS task_group_ids,
                    ARRAY(SELECT g.name FROM task_category_groups l JOIN task_groups g ON g.id = l.task_group_id WHERE l.task_category_id = x.id ORDER BY g.name) AS task_group_names
               FROM task_categories x`,
    search: ['name', 'description'],
    filters: activeFilter,
    sort: { name: 's.name', displayOrder: 's.display_order', taskCount: 's.task_count' },
    defaultSort: 's.display_order, s.name',
    uniqueMessage: 'A task category with this name already exists',
    inUseMessage: 'Tasks use this category – switch it inactive instead',
  },
  {
    name: 'customers',
    label: 'Customers',
    table: 'customers',
    screen: SCREENS.CUSTOMERS,
    fields: {
      code: { col: 'code', schema: { type: 'string', minLength: 1, maxLength: 30 } },
      name: name(200),
      countryId: { col: 'country_id', schema: { type: ['integer', 'null'], minimum: 1 } },
      contactPerson: { col: 'contact_person', schema: { type: ['string', 'null'], maxLength: 150 } },
      // optional "+", digits with spaces / dashes / brackets; max 15 characters, at least 7 digits
      contactNumber: {
        col: 'contact_number',
        schema: { anyOf: [{ type: 'string', maxLength: 15, pattern: '^(?=(?:\\D*\\d){7,15}\\D*$)\\+?[0-9 ()-]+$' }, { type: 'string', maxLength: 0 }, { type: 'null' }] },
      },
      email: { col: 'email', schema: { anyOf: [{ type: 'string', format: 'email', maxLength: 150 }, { type: 'string', maxLength: 0 }, { type: 'null' }] } },
      isActive,
    },
    required: ['code', 'name'],
    computed: { countryName: { type: ['string', 'null'] }, projectCount: { type: 'integer' }, email: { type: ['string', 'null'] } },
    select: `SELECT x.id, x.code, x.name, x.country_id, c.name AS country_name, x.contact_person, x.contact_number, x.email,
                    x.is_active, x.created_at, x.updated_at,
                    (SELECT count(*)::int FROM projects p WHERE p.customer_id = x.id) AS project_count
               FROM customers x LEFT JOIN parameter_values c ON c.id = x.country_id`,
    search: ['name', 'code', 'contact_person', 'email'],
    filters: {
      ...activeFilter,
      countryId: { schema: { type: 'string' }, sql: (w, v, ids) => w.add('s.country_id = ANY($?)', ids(v)) },
    },
    sort: { name: 's.name', code: 's.code', projectCount: 's.project_count' },
    uniqueMessage: 'A customer with this code already exists',
  },
];
