// Seeds the data needed to sign in and create projects. Safe to run more than once:
// existing rows (matched by their natural key) are left as they are.
import bcrypt from 'bcryptjs';
import pg from 'pg';

const ADMIN_USERNAME = process.env.SEED_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin@123';

// ---------------------------------------------------------------- RBAC
const ROLES = [
  // code, name, level, role_type, data_scope, is_system
  ['SUPER_ADMIN', 'Super Admin', 0, 'internal', 'all', true],
  ['ADMIN', 'Admin', 1, 'internal', 'all', true],
  ['PROJECT_MANAGER', 'Project Manager', 2, 'internal', 'team', false],
  ['EMPLOYEE', 'Employee', 5, 'internal', 'own', true],
  ['CUSTOMER', 'Customer', 8, 'external', 'customer', false],
];

// Modules (parent menus) and their screens. url = React route = RBAC screen key.
const MENUS = [
  {
    name: 'Administration', icon: 'settings-2', order: 10,
    children: [
      { name: 'Users', url: '/administration/users', order: 1 },
      { name: 'Roles & Permissions', url: '/administration/roles', order: 2 },
      { name: 'Teams', url: '/administration/teams', order: 3 },
      { name: 'Parameters', url: '/administration/parameters', order: 4 },
      { name: 'Site Master', url: '/administration/sites', order: 5 },
      { name: 'Resource Grade & Cost', url: '/administration/resource-grades', order: 8 },
      { name: 'Task Groups & Types', url: '/administration/task-groups', order: 9 }, // tabs: groups, task types and task categories
      { name: 'Task Master', url: '/administration/task-master', order: 10, actions: ['view', 'edit'] }, // who can see whose tasks / timesheets
      { name: 'Business Division', url: '/administration/project-divisions', order: 11 },
      { name: 'Project Stages', url: '/administration/project-stages', order: 13 },
    ],
  },
  {
    name: 'Customers', icon: 'building-2', order: 15,
    children: [{ name: 'Customers', url: '/customers', order: 1 }],
  },
  {
    name: 'Projects', icon: 'folder-kanban', order: 20,
    children: [{ name: 'Project List', url: '/projects', order: 1 }],
  },
  {
    name: 'Task', icon: 'clipboard-list', order: 25,
    children: [
      { name: 'Task', url: '/tasks', order: 2 },
      { name: '1-3-5', url: '/task-135', order: 3, hidden: true }, // daily planner (1 big, 3 medium, 5 small) – a tab on the Task page, not in the sidebar
    ],
  },
  {
    name: 'Timesheet', icon: 'clock-3', order: 30,
    children: [{ name: 'Timesheet', url: '/timesheet', order: 1 }],
  },
];

const ALL = { view: true, create: true, edit: true, delete: true, approve: true, export: true };
const CONFIG_SCREENS = [
  '/administration/teams', '/administration/parameters', '/administration/sites', '/administration/resource-grades',
  '/administration/task-groups',
  '/administration/project-divisions', '/administration/project-stages', '/customers',
];
// role code -> screen url -> actions (Super Admin needs none: level 0 can do everything).
// Rows that already exist are not changed, so edits made on the Roles screen are kept.
const PERMISSIONS = {
  ADMIN: {
    '/administration/users': ALL,
    '/administration/roles': ALL,
    '/administration/task-master': ALL, // only view / edit apply (menu actions)
    '/projects': ALL,
    '/tasks': ALL,
    '/task-135': ALL,
    '/timesheet': ALL,
    ...Object.fromEntries(CONFIG_SCREENS.map((u) => [u, ALL])),
  },
  PROJECT_MANAGER: {
    '/administration/users': { view: true },
    '/projects': { view: true, create: true, edit: true, export: true },
    '/customers': { view: true, create: true, edit: true, export: true },
    '/administration/project-divisions': { view: true },
    '/administration/project-stages': { view: true },
    '/tasks': { view: true, create: true, edit: true, delete: true, export: true },
    '/task-135': { view: true, create: true, edit: true, delete: true },
    '/timesheet': { view: true, create: true, edit: true, delete: true, export: true },
  },
  // everyone logs their own time
  EMPLOYEE: { '/projects': { view: true }, '/tasks': { view: true, create: true, edit: true, delete: true }, '/task-135': { view: true, create: true, edit: true, delete: true }, '/timesheet': { view: true, create: true, edit: true, delete: true } },
  CUSTOMER: { '/projects': { view: true } },
};

// ---------------------------------------------------------------- Masters
const USER_TYPES = ['Employee', 'Contractor', 'Customer user'];
const COUNTRIES = [['India', 'IN'], ['United Arab Emirates', 'AE'], ['United Kingdom', 'GB'], ['United States', 'US']];
// teams [name, country code] and grade levels (lookups GRADE); one resource grade per level
const TEAMS = [['Web India', 'IN'], ['SW India', 'IN'], ['SW UAE', 'AE']];
const GRADES = ['Level A', 'Level B', 'Level C', 'Level D', 'Level E'];
// job roles for task templates (AssignedRoles column of the task-template sheet)
const TASK_ROLES = ['Project Manager', 'Analyst', 'UX/UI Designer', 'Visual Designer', 'Content Writer', 'Developer', 'QA Engineer', 'SEO Specialist'];
const CURRENCIES = [['Indian Rupee', 'INR'], ['US Dollar', 'USD'], ['UAE Dirham', 'AED'], ['Pound Sterling', 'GBP'], ['Euro', 'EUR']];
// sites and their shifts: [shift title, start, end, late after (mins), half day below (mins)]
const SITES = {
  'Emqube DXB': [['General Shift', '09:00', '18:00', 15, 240]],
  'Emqube Mumbai': [['General Shift', '10:00', '19:00', 15, 240]],
};
const TASK_GROUPS = {
  Analysis: ['Requirement Analysis', 'Scope Document'],
  'UX/UI': ['Wireframes', 'UI Design'],
  Development: ['Front-end Development', 'Back-end Development', 'CMS Integration'],
  'Quality Assurance': ['Functional Testing', 'UAT Support'],
  'Deployment & Training': ['Deployment', 'User Training'],
  'Post Live Support': ['Post Live Support', 'Bug Fixing'],
  'Content Creation': ['Content Writing', 'Image & Video Content'],
  'Project Management': ['Project Management', 'Client Meetings'],
};
// groups of the non-project categories: category -> group -> types (they stay out of project estimates)
const CATEGORY_TASK_GROUPS = {
  Personal: {
    'Personal Work': ['Personal Task', 'Learning & Self-study', 'Planning & Organising'],
  },
  Activity: {
    'Meetings & Training': ['Internal Meeting', 'Training / Workshop', 'Interview'],
    'Office Activities': ['Administration', 'Team Event', 'Support to Colleagues'],
  },
};
const DIVISIONS = [['Web', 'Websites, portals and digital marketing'], ['Software', 'Custom software and apps']];
const PROJECT_TYPES = [
  'Website Development', 'Website Tech Support', 'Website Content Support', 'Website Tech & Content',
  'Digital Marketing Full', 'Social Media Full', 'Search Engine', 'Google Ads', 'SEO & Google Ads',
  'Corporate Video', 'Social Media Content',
];
// project type -> task group -> default effort % (each type totals 100)
const DEFAULT_ESTIMATES = {
  'Website Development': {
    Analysis: 15, 'UX/UI': 20, Development: 35, 'Quality Assurance': 10,
    'Deployment & Training': 5, 'Post Live Support': 5, 'Content Creation': 5, 'Project Management': 5,
  },
  'Website Tech Support': { Development: 50, 'Quality Assurance': 15, 'Post Live Support': 25, 'Project Management': 10 },
  'Website Content Support': { 'Content Creation': 80, 'Quality Assurance': 10, 'Project Management': 10 },
  'Website Tech & Content': { Development: 40, 'Content Creation': 35, 'Quality Assurance': 15, 'Project Management': 10 },
};
const CUSTOMERS = [
  ['CUS-001', 'Acme Retail Pvt Ltd'], ['CUS-002', 'Zen Foods'], ['CUS-003', 'Swan Solutions'],
  ['CUS-004', 'BlueOcean Logistics'], ['CUS-005', 'Nova Healthcare'], ['CUS-006', 'Metro Builders'],
  ['CUS-007', 'Greenleaf Organics'], ['CUS-008', 'Orbit Telecom'],
];

// ---------------------------------------------------------------- helpers
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const q = (sql, params) => client.query(sql, params);
const one = async (sql, params) => (await q(sql, params)).rows[0];

/** Inserts when no row matches `where`; returns the id either way. */
async function ensure(table, where, values) {
  const wKeys = Object.keys(where);
  const found = await one(
    `SELECT id FROM ${table} WHERE ${wKeys.map((k, i) => `${k} IS NOT DISTINCT FROM $${i + 1}`).join(' AND ')}`,
    Object.values(where),
  );
  if (found) return found.id;
  const all = { ...where, ...values };
  const keys = Object.keys(all);
  const row = await one(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(all),
  );
  return row.id;
}

// ---------------------------------------------------------------- run
try {
  await client.connect();
  await q('BEGIN');

  const roleIds = {};
  for (const [code, name, level, roleType, dataScope, isSystem] of ROLES) {
    roleIds[code] = await ensure('roles', { code }, { name, level, role_type: roleType, data_scope: dataScope, is_system: isSystem });
  }

  const menuIds = {};
  for (const mod of MENUS) {
    const parentId = await ensure('menus', { name: mod.name, parent_id: null }, { icon: mod.icon, display_order: mod.order });
    for (const s of mod.children) {
      // actions: only list 'approve' for screens with an approval step; the column default covers the rest
      menuIds[s.url] = await ensure('menus', { url: s.url }, { name: s.name, parent_id: parentId, display_order: s.order, ...(s.actions ? { actions: s.actions } : {}), ...(s.hidden ? { is_visible: false } : {}) });
    }
  }

  for (const [roleCode, screens] of Object.entries(PERMISSIONS)) {
    for (const [url, a] of Object.entries(screens)) {
      // only actions the screen supports (menus.actions) are stored
      await q(
        `INSERT INTO role_permissions (role_id, menu_id, can_view, can_create, can_edit, can_delete, can_approve, can_export)
         SELECT $1, m.id, $3 AND 'view' = ANY (m.actions), $4 AND 'create' = ANY (m.actions), $5 AND 'edit' = ANY (m.actions),
                $6 AND 'delete' = ANY (m.actions), $7 AND 'approve' = ANY (m.actions), $8 AND 'export' = ANY (m.actions)
           FROM menus m WHERE m.id = $2
         ON CONFLICT (role_id, menu_id) DO NOTHING`,
        [roleIds[roleCode], menuIds[url], !!a.view, !!a.create, !!a.edit, !!a.delete, !!a.approve, !!a.export],
      );
    }
  }

  for (const [i, name] of USER_TYPES.entries()) {
    await q(`INSERT INTO parameter_values (type, name, display_order) VALUES ('USER_TYPE', $1, $2) ON CONFLICT (type, name) DO NOTHING`, [name, i + 1]);
  }
  const gradeIds = {};
  for (const [i, name] of GRADES.entries()) {
    ({ id: gradeIds[name] } = await one(
      `INSERT INTO parameter_values (type, name, display_order) VALUES ('GRADE', $1, $2)
       ON CONFLICT (type, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [name, i + 1],
    ));
  }
  for (const [i, name] of TASK_ROLES.entries()) {
    await q(`INSERT INTO parameter_values (type, name, display_order) VALUES ('SKILL', $1, $2) ON CONFLICT (type, name) DO NOTHING`, [name, i + 1]);
  }
  for (const [type, list] of [['COUNTRY', COUNTRIES], ['CURRENCY', CURRENCIES]]) {
    for (const [i, [name, value]] of list.entries()) {
      await q(`INSERT INTO parameter_values (type, name, value, display_order) VALUES ($1, $2, $3, $4) ON CONFLICT (type, name) DO NOTHING`, [type, name, value, i + 1]);
    }
  }
  // USD rates are entered on Parameters → USD Rates (currency_usd_rates); USD itself is always 1
  const siteIds = {};
  const shiftIds = {};
  for (const [name, shifts] of Object.entries(SITES)) {
    siteIds[name] = await ensure('sites', { name }, {});
    for (const [i, [shift, start, end, late, half]] of shifts.entries()) {
      shiftIds[`${name}/${shift}`] = await ensure(
        'site_shifts',
        { site_id: siteIds[name], name: shift },
        { start_time: start, end_time: end, late_after_minutes: late, half_day_minutes: half, display_order: i + 1 },
      );
    }
  }

  const groupIds = {};
  const typeIds = {};
  for (const [group, types] of Object.entries(TASK_GROUPS)) {
    groupIds[group] = await ensure('task_groups', { name: group }, {});
    for (const t of types) typeIds[`${group}/${t}`] = await ensure('task_types', { task_group_id: groupIds[group], name: t }, {});
  }

  for (const [category, groups] of Object.entries(CATEGORY_TASK_GROUPS)) {
    for (const [group, types] of Object.entries(groups)) {
      groupIds[group] = await ensure('task_groups', { name: group }, {});
      for (const t of types) await ensure('task_types', { task_group_id: groupIds[group], name: t }, {});
      await q(`INSERT INTO task_category_groups (task_category_id, task_group_id) SELECT c.id, $2 FROM task_categories c WHERE lower(c.name) = lower($1) ON CONFLICT DO NOTHING`, [category, groupIds[group]]);
    }
  }
  // the first seeded groups are project work: link them to the project categories
  await q(`INSERT INTO task_category_groups (task_category_id, task_group_id) SELECT c.id, g.id FROM task_categories c CROSS JOIN task_groups g WHERE c.is_project AND g.name = ANY($1) ON CONFLICT DO NOTHING`, [Object.keys(TASK_GROUPS)]);

  for (const [name, description] of DIVISIONS) await ensure('project_divisions', { name }, { description });
  const projectTypeIds = {};
  // the seeded project types are web / marketing work → division "Web"
  const webDivision = await one(`SELECT id FROM project_divisions WHERE name = 'Web'`);
  for (const name of PROJECT_TYPES) projectTypeIds[name] = await ensure('project_types', { name }, { project_division_id: webDivision.id });

  for (const [type, groups] of Object.entries(DEFAULT_ESTIMATES)) {
    for (const [group, pct] of Object.entries(groups)) {
      await ensure('project_type_effort_defaults', { project_type_id: projectTypeIds[type], task_group_id: groupIds[group] }, { effort_percentage: pct });
    }
  }
  for (const [code, name] of CUSTOMERS) {
    await q(`INSERT INTO customers (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING`, [code, name]);
  }

  for (const [name, country] of TEAMS) {
    const c = await one(`SELECT id FROM parameter_values WHERE type = 'COUNTRY' AND value = $1`, [country]);
    await ensure('teams', { name }, { country_id: c?.id ?? null });
  }
  // one resource grade per grade level (cost history is added on the Resource Grade & Cost screen)
  for (const level of GRADES) await ensure('resource_grades', { grade_id: gradeIds[level] }, {});

  const existingAdmin = await one(`SELECT id FROM users WHERE username = $1`, [ADMIN_USERNAME]);
  if (!existingAdmin) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    await q(
      `INSERT INTO users (employee_code, username, password_hash, name, email, role_id, site_id, site_shift_id)
       VALUES ('001', $1, $2, 'System Administrator', 'admin@emqube.com', $3, $4, $5)`,
      [ADMIN_USERNAME, hash, roleIds.SUPER_ADMIN, siteIds['Emqube Mumbai'], shiftIds['Emqube Mumbai/General Shift']],
    );
    console.log(`Super Admin created → username: ${ADMIN_USERNAME}  password: ${ADMIN_PASSWORD}  (change it after first login)`);
  } else {
    console.log(`Super Admin "${ADMIN_USERNAME}" already exists (password unchanged)`);
  }

  await q('COMMIT');
  console.log('Seed completed');
} catch (err) {
  await q('ROLLBACK').catch(() => {});
  console.error(`Seed failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
