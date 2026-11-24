// Feeds the master data from PMS-data-to-feed.xlsx: task groups, task types, task roles, project
// divisions, project types and the Website Development task template.
//
//   npm run db:import-pms              → imports (one transaction – all or nothing)
//   npm run db:import-pms -- --dry-run → shows what would change, then rolls back
//
// Safe to run more than once. Merge rules (agreed on 21 Oct 2026):
//   - everything in the sheet is added or updated; existing rows are kept
//   - the old group "Analysis" is renamed "Analysis & Design" (so its timesheets stay linked)
//   - task types / project types that are not in the sheet are switched off (inactive), not deleted
//   - group names in the sheet's task-type list are mapped to the 12 task groups (see GROUP_ALIAS);
//     the "Not Billable" types get their own new group
//   - task roles use the names of the template (Analyst, Visual Designer …)
//   - Sheet2 is the Website Development template ("(NEW)" removed from the names); it replaces
//     that type's template. The other project types get no template yet.
import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------- task groups (Sheet1 "Task Group" rows)
const TASK_GROUPS = [
  'Analysis & Design', 'UX/UI', 'Development', 'Quality Assurance', 'Deployment & Training', 'Bug Fixing',
  'Post Live Support', 'Content Creation', 'Operations', 'Project Management', 'Maintenance', 'Installation',
  'Not Billable', // new: breaks, social events, unaccounted time …
];
const RENAME_GROUPS = { Analysis: 'Analysis & Design' };
// group names used in the sheet's task-type list → the task group
const GROUP_ALIAS = {
  Content: 'Content Creation',
  Deployment: 'Deployment & Training',
  Fixing: 'Bug Fixing',
  'Tech Support': 'Maintenance',
  'Not Billable': 'Not Billable',
};
const group = (name) => GROUP_ALIAS[name] ?? name;

// ---------------------------------------------------------------- task types (Sheet1 "Task Type" list)
const TASK_TYPE_LIST = [
  ['Analysis & Design', 'Analysis & Design'], ['Project Research', 'Analysis & Design'], ['User Requirements Study', 'Analysis & Design'],
  ['Content Writing', 'Content'], ['Copy Writing', 'Content'], ['Video-Photo Shoot', 'Content'],
  ['Documentation', 'Deployment'], ['Launching', 'Deployment'], ['User Training', 'Deployment'],
  ['Coding', 'Development'], ['Content Population', 'Development'], ['Production', 'Development'],
  ['Enhancements', 'Fixing'], ['Fixing', 'Bug Fixing'], ['Rework', 'Bug Fixing'],
  ['Azure Support', 'Tech Support'], ['Breakdown Maintenance', 'Tech Support'], ['Content Support', 'Content'],
  ['Data Support', 'Tech Support'], ['Preventive Maintenance', 'Tech Support'], ['Query Support', 'Tech Support'],
  ['Authorized Break', 'Not Billable'], ['Accounted Time', 'Not Billable'], ['Social Events', 'Not Billable'],
  ['Office Administration', 'Operations'], ['Training & Research', 'Not Billable'], ['Unaccounted Time', 'Not Billable'],
  ['Client Interaction', 'Project Management'], ['Planning', 'Project Management'], ['Reporting', 'Project Management'],
  ['Project Review', 'Project Management'], ['Test planning', 'Quality Assurance'], ['Testing', 'Quality Assurance'],
  ['Database Development', 'Analysis & Design'], ['Schematic Design', 'Analysis & Design'], ['System Specifications', 'Analysis & Design'],
  ['Graphics Creation', 'UX/UI'], ['Visual-UX-Mockup', 'UX/UI'],
].map(([name, g]) => [name, group(g)]);

// ---------------------------------------------------------------- roles (Parameters → SKILL)
const TASK_ROLES = [
  'Project Manager', 'Analyst', 'Content Developer', 'UX/UI Designer', 'Visual Designer', 'Content Writer', 'Developer',
  'Architect', 'Quality Assurance', 'Deployment', 'Documentation', 'Training', 'Video Editor', 'System Design',
];

// ---------------------------------------------------------------- divisions + project types (Sheet1 top)
const PROJECT_TYPES = [
  // project type, division (sheet "Project Group")
  ['Website Development', 'Web'],
  ['Website Support', 'Software'],
  ['Software Development', 'Software'],
  ['Solutions Implementation', 'Software'],
  ['Digital Marketing', 'Web'],
];

// ---------------------------------------------------------------- Website Development template (Sheet2)
// [task group, task type, approvals (Mgr / Client / Mgr/Client), title, description, roles]
const TEMPLATE_TYPE = 'Website Development';
const TEMPLATE = [
  ['Analysis & Design', 'Site Architecture', 'Mgr/Client', 'Create a site architecture', 'Build the site map and content architecture for the project', 'Project Manager;Analyst;Content Developer'],
  ['Analysis & Design', 'Information Architecture', 'Client', 'Define IA and navigation', 'Decide the navigation structure and taxonomy for the site', 'Analyst;UX/UI Designer;Project Manager'],
  ['Analysis & Design', 'SEO & Keyword Research', 'Client', 'Define SEO and keyword strategy', 'Research keywords and define on-page SEO approach for the site', 'Analyst;Content Writer'],
  ['Analysis & Design', 'Schematic Design', 'Client', 'Create site schematics', 'Produce schematic layouts and wireframes for key page templates', 'Analyst;UX/UI Designer'],
  ['Analysis & Design', 'User Requirements Study', 'Client', 'Conduct user requirements study', 'Capture and document user needs goals and functional requirements', 'Analyst;Project Manager'],
  ['UX/UI', 'Home Page Design', 'Client', 'Design the home page', 'Create mock screens for the home page aligned to approved architecture', 'UX/UI Designer;Visual Designer'],
  ['UX/UI', 'Inner Page Design', 'Client', 'Design inner pages', 'Create mock screens for inner page templates', 'UX/UI Designer;Visual Designer'],
  ['UX/UI', 'Responsive Design', 'Mgr', 'Design responsive breakpoints', 'Adapt designs for mobile tablet and desktop breakpoints', 'UX/UI Designer;Visual Designer'],
  ['UX/UI', 'Design System & Assets', 'Mgr', 'Define design system and assets', 'Establish typography color iconography and produce supporting graphics', 'Visual Designer;UX/UI Designer'],
  ['UX/UI', 'Visual-UX-Mockup', 'Client', 'Prepare visual UX mockups', 'Produce high-fidelity mockups for stakeholder review and sign-off', 'UX/UI Designer;Visual Designer'],
  ['Development', 'Template Development', 'Mgr', 'Develop page templates', 'Build reusable page templates from approved mockups', 'Developer;Architect'],
  ['Development', 'Plugin Integration', 'Mgr', 'Integrate plugins', 'Install and configure plugins or modules required by the site', 'Developer'],
  ['Development', 'Animation', 'Mgr', 'Implement animations', 'Build interactive and motion elements per the design spec', 'Developer;Visual Designer'],
  ['Content Creation', 'Content Writing', 'Client', 'Write site content', 'Draft on-brand copy and long-form content for all pages', 'Content Writer;Content Developer'],
  ['Content Creation', 'SEO Metadata', 'Client', 'Write page titles and meta descriptions', 'Prepare SEO metadata for all pages', 'Content Writer'],
  ['Development', 'Content Population', 'Mgr', 'Populate content', 'Load approved copy images and media into the CMS', 'Content Developer'],
  ['Content Creation', 'Legal & Privacy Pages', 'Client', 'Draft legal and privacy pages', 'Prepare privacy policy terms cookie notice and related pages', 'Content Writer;Project Manager'],
  ['Quality Assurance', 'Unit Testing', 'Mgr', 'Run unit and functional testing', 'Test individual components and templates for correctness', 'Quality Assurance;Developer'],
  ['Quality Assurance', 'Client UAT', 'Client', 'Coordinate client UAT', 'Facilitate client user acceptance testing and log feedback', 'Quality Assurance;Project Manager'],
  ['Quality Assurance', 'Accessibility Pass', 'Mgr', 'Run accessibility audit and fixes', 'Audit and fix WCAG compliance issues', 'Quality Assurance;Developer'],
  ['Deployment & Training', 'Go-Live', 'Mgr/Client', 'Launch the site', 'Confirm readiness and deploy the site to production', 'Deployment;Project Manager;Developer'],
  ['Deployment & Training', 'Analytics & Tag Setup', 'Mgr', 'Configure analytics and tags', 'Set up GA4 consent banner and tracking tags', 'Developer'],
  ['Deployment & Training', 'Redirects & 301 Mapping', 'Mgr', 'Map and implement redirects', 'Map old URLs and implement 301 redirects (conditional on migration)', 'Developer'],
  ['Quality Assurance', 'Performance Check', 'Mgr', 'Validate Core Web Vitals', 'Test and optimise page speed and Core Web Vitals', 'Developer;Quality Assurance'],
  ['Deployment & Training', 'Project Handover Document', 'Mgr', 'Prepare handover document', 'Compile technical CMS and operational documentation', 'Documentation;Project Manager'],
  ['Deployment & Training', 'CMS Training', 'Client', 'Conduct CMS training', 'Train client staff on CMS usage and site administration', 'Training;Content Developer'],
  ['Deployment & Training', 'CMS Editor Guide', 'Mgr', 'Prepare CMS editor guide', 'Create a short client-facing guide for editing pages', 'Documentation;Content Developer'],
  ['Post Live Support', 'Post-Launch Fixes & Tweaks', 'Mgr', 'Fix post-launch bugs and tweaks', 'Resolve defects and apply approved tweaks after go-live', 'Developer;Quality Assurance'],
];

// ---------------------------------------------------------------- run
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const q = (sql, params) => client.query(sql, params);
const one = async (sql, params) => (await q(sql, params)).rows[0];
const log = { added: [], updated: [], deactivated: [], warnings: [] };

async function run() {
  // task groups (rename first, so "Analysis" keeps its timesheets as "Analysis & Design")
  for (const [from, to] of Object.entries(RENAME_GROUPS)) {
    const exists = await one(`SELECT id FROM task_groups WHERE name = $1`, [to]);
    const old = await one(`SELECT id FROM task_groups WHERE name = $1`, [from]);
    if (old && !exists) {
      await q(`UPDATE task_groups SET name = $2 WHERE id = $1`, [old.id, to]);
      log.updated.push(`task group "${from}" → "${to}"`);
    }
  }
  const groupIds = {};
  for (const name of TASK_GROUPS) {
    let row = await one(`SELECT id FROM task_groups WHERE name = $1`, [name]);
    if (!row) {
      row = await one(`INSERT INTO task_groups (name) VALUES ($1) RETURNING id`, [name]);
      log.added.push(`task group "${name}"`);
    }
    groupIds[name] = row.id;
  }

  // task types: the list + every type the template uses
  const wanted = new Map(); // "group|type" → [group, type]
  for (const [name, g] of TASK_TYPE_LIST) wanted.set(`${g}|${name}`, [g, name]);
  for (const [g, name] of TEMPLATE) wanted.set(`${g}|${name}`, [g, name]);
  const typeIds = {};
  for (const [key, [g, name]] of wanted) {
    if (!groupIds[g]) throw new Error(`Unknown task group "${g}" for task type "${name}"`);
    let row = await one(`SELECT id, is_active FROM task_types WHERE task_group_id = $1 AND name = $2`, [groupIds[g], name]);
    if (!row) {
      row = await one(`INSERT INTO task_types (task_group_id, name) VALUES ($1, $2) RETURNING id, is_active`, [groupIds[g], name]);
      log.added.push(`task type "${name}" (${g})`);
    } else if (!row.is_active) {
      await q(`UPDATE task_types SET is_active = true WHERE id = $1`, [row.id]);
      log.updated.push(`task type "${name}" (${g}) switched on`);
    }
    typeIds[key] = row.id;
  }
  // task types not in the sheet: switched off (kept for old timesheets)
  const off = await q(
    `UPDATE task_types SET is_active = false WHERE is_active AND NOT (id = ANY($1)) RETURNING name`,
    [Object.values(typeIds)],
  );
  off.rows.forEach((r) => log.deactivated.push(`task type "${r.name}"`));

  // task roles
  const roleIds = {};
  for (const [i, name] of TASK_ROLES.entries()) {
    let row = await one(`SELECT id FROM lookups WHERE type = 'SKILL' AND lower(name) = lower($1)`, [name]);
    if (!row) {
      row = await one(`INSERT INTO lookups (type, name, display_order) VALUES ('SKILL', $1, $2) RETURNING id`, [name, i + 1]);
      log.added.push(`task role "${name}"`);
    }
    roleIds[name] = row.id;
  }

  // divisions + project types
  const divisionIds = {};
  for (const name of new Set(PROJECT_TYPES.map(([, d]) => d))) {
    let row = await one(`SELECT id FROM project_divisions WHERE lower(name) = lower($1)`, [name]);
    if (!row) {
      row = await one(`INSERT INTO project_divisions (name) VALUES ($1) RETURNING id`, [name]);
      log.added.push(`division "${name}"`);
    }
    divisionIds[name] = row.id;
  }
  const projectTypeIds = {};
  for (const [name, division] of PROJECT_TYPES) {
    const divId = divisionIds[division];
    let row = await one(`SELECT id, project_division_id, is_active FROM project_types WHERE lower(name) = lower($1)`, [name]);
    if (!row) {
      row = await one(`INSERT INTO project_types (name, project_division_id) VALUES ($1, $2) RETURNING id`, [name, divId]);
      log.added.push(`project type "${name}" (${division})`);
    } else {
      if (row.project_division_id !== divId) {
        // projects carry their own division – don't move a type that existing projects use under another division
        const used = await one(`SELECT count(*)::int AS n FROM projects WHERE project_type_id = $1 AND project_division_id <> $2`, [row.id, divId]);
        if (used.n) log.warnings.push(`project type "${name}" kept in its current division – ${used.n} project(s) use it there (sheet says ${division})`);
        else {
          await q(`UPDATE project_types SET project_division_id = $2 WHERE id = $1`, [row.id, divId]);
          log.updated.push(`project type "${name}" moved to ${division}`);
        }
      }
      if (!row.is_active) {
        await q(`UPDATE project_types SET is_active = true WHERE id = $1`, [row.id]);
        log.updated.push(`project type "${name}" switched on`);
      }
    }
    projectTypeIds[name] = row.id;
  }
  const offTypes = await q(`UPDATE project_types SET is_active = false WHERE is_active AND NOT (id = ANY($1)) RETURNING name`, [Object.values(projectTypeIds)]);
  offTypes.rows.forEach((r) => log.deactivated.push(`project type "${r.name}"`));

}

try {
  await client.connect();
  await q('BEGIN');
  await run();
  await q(DRY_RUN ? 'ROLLBACK' : 'COMMIT');
  const show = (title, list) => list.length && console.log(`\n${title} (${list.length}):\n  ${list.join('\n  ')}`);
  show('Added', log.added);
  show('Updated', log.updated);
  show('Switched off (not in the sheet)', log.deactivated);
  show('Warnings', log.warnings);
  console.log(DRY_RUN ? '\nDry run – nothing was saved.' : '\nImport completed.');
} catch (err) {
  await q('ROLLBACK').catch(() => {});
  console.error('Import failed – nothing was saved:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
