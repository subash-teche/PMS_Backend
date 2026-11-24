// Removes the old master data that the sheet import (import-pms-data.js) switched off, and every
// record that depends on it:
//   - inactive project divisions and inactive project types (+ the types of an inactive division)
//   - inactive task types, and task groups that are not in the sheet
//   - task roles (Parameters → SKILL) that are not in the sheet
//   - projects of a removed division / project type, with all their details (members, reviews,
//     estimate, commercial, tasks, timesheets, plans, installation requests)
//   - tasks, timesheet entries, plan items and template rows that use a removed task type / group
//
//   npm run db:cleanup-masters              → dry run: shows what would be deleted, saves nothing
//   npm run db:cleanup-masters -- --apply   → deletes (one transaction – all or nothing)
import pg from 'pg';

const APPLY = process.argv.includes('--apply');

// kept – the same lists as the sheet import
const KEEP_GROUPS = [
  'Analysis & Design', 'UX/UI', 'Development', 'Quality Assurance', 'Deployment & Training', 'Bug Fixing',
  'Post Live Support', 'Content Creation', 'Operations', 'Project Management', 'Maintenance', 'Installation', 'Not Billable',
];
const KEEP_ROLES = [
  'Project Manager', 'Analyst', 'Content Developer', 'UX/UI Designer', 'Visual Designer', 'Content Writer', 'Developer',
  'Architect', 'Quality Assurance', 'Deployment', 'Documentation', 'Training', 'Video Editor', 'System Design',
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const q = (sql, params) => client.query(sql, params);
const counts = [];
const del = async (label, sql, params) => {
  const r = await q(sql, params);
  if (r.rowCount) counts.push([label, r.rowCount]);
  return r;
};
const ids = async (sql, params) => (await q(sql, params)).rows.map((r) => Number(r.id));
const names = async (sql, params) => (await q(sql, params)).rows.map((r) => r.name);

/** Deletes tasks (with their sub-tasks), their timesheets and the links to them. */
async function deleteTasks(taskIds, why) {
  if (!taskIds.length) return;
  const all = taskIds;
  await del(`timesheet entries of those tasks (${why})`, `DELETE FROM timesheets WHERE task_id = ANY($1)`, [all]);
  await del(`tasks (${why})`, `DELETE FROM tasks WHERE id = ANY($1)`, [all]);
}

async function run() {
  // only after the sheet import – otherwise groups like "Analysis" would be seen as old and removed
  const imported = await q(`SELECT 1 FROM task_groups WHERE name = 'Not Billable'`);
  if (!imported.rowCount) throw new Error('Run the sheet import first: npm run db:import-pms');

  // ---------------------------------------------------------------- what goes
  const divisionIds = await ids(`SELECT id FROM project_divisions WHERE NOT is_active`);
  const projectTypeIds = await ids(`SELECT id FROM project_types WHERE NOT is_active OR project_division_id = ANY($1)`, [divisionIds]);
  const projectIds = await ids(`SELECT id FROM projects WHERE project_type_id = ANY($1) OR project_division_id = ANY($2)`, [projectTypeIds, divisionIds]);
  const groupIds = await ids(`SELECT id FROM task_groups WHERE NOT (name = ANY($1))`, [KEEP_GROUPS]);
  const taskTypeIds = await ids(`SELECT id FROM task_types WHERE NOT is_active OR task_group_id = ANY($1)`, [groupIds]);
  const roleIds = await ids(`SELECT id FROM parameter_values WHERE type = 'SKILL' AND NOT (name = ANY($1))`, [KEEP_ROLES]);

  const list = async (title, sql, params) => {
    const n = await names(sql, params);
    if (n.length) console.log(`\n${title} (${n.length}):\n  ${n.join('\n  ')}`);
  };
  await list('Project divisions to delete', `SELECT name FROM project_divisions WHERE id = ANY($1) ORDER BY name`, [divisionIds]);
  await list('Project types to delete', `SELECT name FROM project_types WHERE id = ANY($1) ORDER BY name`, [projectTypeIds]);
  await list('Projects to delete (with all their details)', `SELECT code || ' – ' || title AS name FROM projects WHERE id = ANY($1) ORDER BY code`, [projectIds]);
  await list('Task groups to delete', `SELECT name FROM task_groups WHERE id = ANY($1) ORDER BY name`, [groupIds]);
  await list('Task types to delete', `SELECT t.name || ' (' || g.name || ')' AS name FROM task_types t JOIN task_groups g ON g.id = t.task_group_id WHERE t.id = ANY($1) ORDER BY g.name, t.name`, [taskTypeIds]);
  await list('Task roles to delete', `SELECT name FROM parameter_values WHERE id = ANY($1) ORDER BY name`, [roleIds]);

  // ---------------------------------------------------------------- 1. projects and all their details
  if (projectIds.length) {
    await deleteTasks(await ids(`SELECT id FROM tasks WHERE project_id = ANY($1)`, [projectIds]), 'deleted projects');
    // members, reviews, estimate and commercial go with the project (ON DELETE CASCADE)
    await del('projects', `DELETE FROM projects WHERE id = ANY($1)`, [projectIds]);
  }

  // ---------------------------------------------------------------- 2. task types / task groups and what uses them
  if (taskTypeIds.length || groupIds.length) {
    await deleteTasks(await ids(`SELECT id FROM tasks WHERE task_type_id = ANY($1) OR task_group_id = ANY($2)`, [taskTypeIds, groupIds]), 'removed task types / groups');
    await del('review progress rows of removed task groups', `DELETE FROM project_progress_update_groups WHERE task_group_id = ANY($1)`, [groupIds]);
    await del('project estimate rows of removed task groups', `DELETE FROM project_effort_estimates WHERE task_group_id = ANY($1)`, [groupIds]);
    await del('default split rows of removed task groups', `DELETE FROM project_type_effort_defaults WHERE task_group_id = ANY($1)`, [groupIds]);
    await del('task types', `DELETE FROM task_types WHERE id = ANY($1)`, [taskTypeIds]);
    await del('task groups', `DELETE FROM task_groups WHERE id = ANY($1)`, [groupIds]);
  }

  // ---------------------------------------------------------------- 3. project types, divisions, roles
  await del('project types', `DELETE FROM project_types WHERE id = ANY($1)`, [projectTypeIds]);
  await del('project divisions (with their quote rates)', `DELETE FROM project_divisions WHERE id = ANY($1)`, [divisionIds]);
  if (roleIds.length) {
    await del('task roles', `DELETE FROM parameter_values WHERE id = ANY($1)`, [roleIds]);
  }
}

try {
  await client.connect();
  await q('BEGIN');
  await run();
  await q(APPLY ? 'COMMIT' : 'ROLLBACK');
  console.log(`\nRows ${APPLY ? 'deleted' : 'that would be deleted'}:`);
  if (!counts.length) console.log('  nothing – the data is already clean');
  for (const [label, n] of counts) console.log(`  ${String(n).padStart(5)}  ${label}`);
  console.log(APPLY ? '\nCleanup completed.' : '\nDry run – nothing was deleted. Run again with -- --apply to delete.');
} catch (err) {
  await q('ROLLBACK').catch(() => {});
  console.error('\nCleanup failed – nothing was deleted:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
