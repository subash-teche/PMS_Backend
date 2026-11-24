import { FLOW_ROLES } from '../../../config/flow.js';
import { statusOf } from '../flow.rules.js';

/*
 * One-way import of the old Task Management database (Content Flow) into PMS.
 *
 *   - The Task Management database is NEVER changed or deleted from: it is read inside one READ ONLY snapshot transaction
 *     (see openSource) and only SELECT statements are allowed. It stays as it is, as the archive of the old app.
 *   - PMS only gets inserts (and nothing is deleted). Running it again imports only what is not there yet (legacy_id).
 *   - Dry run by default: everything runs in one PMS transaction that is rolled back unless `apply` is set. If the
 *     reconciliation at the end does not match, nothing is saved even with `apply`.
 *
 * What goes where:
 *   TM users          -> PMS users, matched by e-mail (or username = e-mail); the others are created (password hash copied)
 *   TM clients        -> PMS customers, matched by name; the others are created
 *   TM tasks          -> tasks (with their people in task_members); they need a project, task group and type:
 *                          client -> a "Task Management - <client>" project (or a project from the mapping file)
 *                          TM task type -> a type in the "Task Management (imported)" task group (or from the mapping file)
 *   steps, time logs (+ a PMS Timesheet row each), timer entries, plan, activity (-> the audit log), messages -> the task tables
 *   Not imported (they stay in the Task Management database): templates, sessions, login attempts.
 */

const DUBAI = 'Asia/Dubai'; // the old app counted its days in Dubai time
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: DUBAI, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = (ts) => dayFmt.format(new Date(ts));

const TABLES = ['users', 'clients', 'task_types', 'tasks', 'task_steps', 'time_logs', 'time_entries', 'plan_items', 'activity', 'posts', 'post_mentions', 'templates', 'template_steps', 'sessions', 'login_attempts'];

class DryRun extends Error {
  constructor(report) {
    super('dry run');
    this.report = report;
  }
}

/**
 * Wraps a connected pg client on the Task Management database in a READ ONLY, REPEATABLE READ transaction (a consistent
 * snapshot) and refuses anything but SELECT. Postgres itself rejects any write inside a READ ONLY transaction too.
 */
export async function openSource(client) {
  await client.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ');
  return {
    async query(sql, params) {
      if (!/^\s*select\b/i.test(sql)) throw new Error('The Task Management database is read-only: only SELECT is allowed');
      return client.query(sql, params);
    },
    close: () => client.query('ROLLBACK'),
  };
}

const counts = async (source) => {
  const out = {};
  for (const t of TABLES) out[t] = (await source.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  return out;
};

/** @returns the report (applied: false for a dry run). */
export async function importTm({ source, target, apply = false, mapping = {}, options = {}, log = () => {} }) {
  const { adminRole = 'EMPLOYEE', defaultRole = 'EMPLOYEE', legacyOwner } = options;
  const warnings = [];
  const warn = (m) => warnings.push(m);

  // ---- read the whole source in one consistent snapshot ---------------------------------------------------------------------
  const before = await counts(source);
  const all = async (t) => (await source.query(`SELECT * FROM ${t} ORDER BY ${t === 'post_mentions' ? 'message_id, user_id' : 'id'}`)).rows;
  const S = {};
  for (const t of ['users', 'clients', 'task_types', 'tasks', 'task_steps', 'time_logs', 'time_entries', 'plan_items', 'activity', 'posts', 'post_mentions']) S[t] = await all(t);
  log(`read ${S.tasks.length} tasks, ${S.task_steps.length} steps, ${S.time_logs.length} time logs, ${S.posts.length} messages from the Task Management database`);

  const run = async (c) => {
    const q = async (sql, params) => (await c.query(sql, params)).rows;
    const one = async (sql, params) => (await q(sql, params))[0];
    const stats = {};
    const stat = (k, created, skipped = 0) => (stats[k] = { source: created + skipped, created, alreadyThere: skipped });

    // the PMS database must have the task tables (migration 046)
    const have = await one(`SELECT to_regclass('public.task_members') AS t`);
    if (!have.t) throw new Error('The PMS database has no Task Management tables yet. Run the PMS migrations first (npm run db:migrate).');

    // ---- users ---------------------------------------------------------------------------------------------------------
    const roles = Object.fromEntries((await q(`SELECT id, code, level FROM roles`)).map((r) => [r.code, r]));
    for (const code of [defaultRole, adminRole]) if (!roles[code]) throw new Error(`Role ${code} does not exist in PMS`);
    const userMap = new Map(); // TM user id -> PMS user id
    let matched = 0;
    let createdUsers = 0;
    // a person with a different e-mail in the two systems is named in the mapping file: "users": { "<TM e-mail>": "<PMS e-mail>" }
    const emailMap = Object.fromEntries(Object.entries(mapping.users ?? {}).map(([k, v]) => [k.trim().toLowerCase(), String(v).trim().toLowerCase()]));
    for (const u of S.users) {
      const email = u.email.trim().toLowerCase();
      const look = emailMap[email] ?? email;
      const hit = await one(`SELECT id FROM users WHERE lower(email) = $1 OR lower(username) = $1 ORDER BY (lower(email) = $1) DESC, id LIMIT 1`, [look]);
      if (!hit && emailMap[email]) throw new Error(`The mapping says ${email} is ${emailMap[email]} in PMS, but there is no such PMS user`);
      if (hit) {
        userMap.set(u.id, hit.id);
        matched += 1;
        continue;
      }
      // a PMS user with the same first name and another e-mail may be the same person: say so, so no double account is made by mistake
      const alike = await one(`SELECT name, email FROM users WHERE lower(split_part(name, ' ', 1)) = lower(split_part($1::text, ' ', 1)) ORDER BY id LIMIT 1`, [u.name.trim()]);
      if (alike) warn(`${u.name} <${email}> gets a NEW PMS account, but PMS already has ${alike.name} <${alike.email}>. If that is the same person, add "users": { "${email}": "${alike.email}" } to the mapping file and run again`);
      const taken = await one(`SELECT 1 AS x FROM users WHERE lower(username) = $1`, [email]);
      const role = roles[u.role === 'admin' ? adminRole : defaultRole];
      const row = await one(
        `INSERT INTO users (username, password_hash, name, email, role_id, time_zone, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [taken ? `tm-${u.id}` : email, u.password_hash, u.name, email, role.id, DUBAI, u.active],
      );
      userMap.set(u.id, row.id);
      createdUsers += 1;
      if (u.role === 'admin' && adminRole === defaultRole) warn(`${u.name} (${email}) is an admin in Task Management; their PMS account was created as ${defaultRole} - change the role in PMS if they should be an admin`);
    }
    stats.users = { source: S.users.length, matchedExisting: matched, created: createdUsers };
    const U = (id) => userMap.get(id) ?? null;
    const noAccess = await q(
      `SELECT u.id, u.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ANY($1) AND NOT (r.level = 0 OR r.code = ANY($2))`,
      [[...userMap.values()], FLOW_ROLES],
    );
    const holders = new Set(S.task_steps.filter((s) => s.status !== 'done').map((s) => U(s.user_id)));
    for (const x of noAccess) {
      warn(`${x.name} was in Task Management but their PMS role cannot open it${holders.has(x.id) ? ' - they hold an unfinished step, so that task will wait until the role is changed' : ''}`);
    }

    // ---- customers ---------------------------------------------------------------------------------------------------
    const customerMap = new Map(); // TM client id -> PMS customer id
    let createdCustomers = 0;
    for (const cl of S.clients) {
      const hit = await one(`SELECT id FROM customers WHERE lower(name) = lower($1) ORDER BY id LIMIT 1`, [cl.name.trim()]);
      if (hit) {
        customerMap.set(cl.id, hit.id);
        continue;
      }
      const row = await one(`INSERT INTO customers (code, name, is_active) VALUES ($1, $2, $3) RETURNING id`, [`TM-${cl.id}`, cl.name.trim(), cl.active]);
      customerMap.set(cl.id, row.id);
      createdCustomers += 1;
    }
    stats.customers = { source: S.clients.length, matchedExisting: S.clients.length - createdCustomers, created: createdCustomers };

    // ---- the home for imported work: division, project type, task group, types ---------------------------------------------
    const owner = legacyOwner
      ? (await one(`SELECT id FROM users WHERE lower(username) = lower($1)`, [legacyOwner]))?.id
      : (await one(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'ADMIN' OR r.level = 0 ORDER BY r.level, u.id LIMIT 1`))?.id;
    if (!owner) throw new Error(legacyOwner ? `No PMS user "${legacyOwner}" for --legacy-owner` : 'No ADMIN / Super Admin user found to own the imported projects (use --legacy-owner)');
    const division = (await one(`SELECT id FROM project_divisions WHERE name = 'Task Management (imported)'`)) ?? (await one(`INSERT INTO project_divisions (name) VALUES ('Task Management (imported)') RETURNING id`));
    const ptype = (await one(`SELECT id FROM project_types WHERE name = 'Imported tasks' AND project_division_id = $1`, [division.id])) ?? (await one(`INSERT INTO project_types (name, project_division_id) VALUES ('Imported tasks', $1) RETURNING id`, [division.id]));
    const group = (await one(`SELECT id FROM task_groups WHERE lower(name) = lower('Task Management (imported)')`)) ?? (await one(`INSERT INTO task_groups (name) VALUES ('Task Management (imported)') RETURNING id`));
    const typeIn = async (name) =>
      (await one(`SELECT id FROM task_types WHERE task_group_id = $1 AND lower(name) = lower($2)`, [group.id, name])) ??
      (await one(`INSERT INTO task_types (name, task_group_id) VALUES ($1, $2) RETURNING id`, [name, group.id]));
    const typeMap = new Map(); // TM type id (or null) -> { groupId, typeId }
    for (const t of [...S.task_types, { id: null, name: 'Unspecified' }]) {
      const m = mapping.taskTypes?.[t.name];
      if (m) typeMap.set(t.id, { groupId: m.taskGroupId, typeId: m.taskTypeId });
      else typeMap.set(t.id, { groupId: group.id, typeId: (await typeIn(t.name)).id });
    }

    const category = (await one(`SELECT id FROM task_categories WHERE is_project ORDER BY is_active DESC, display_order, id LIMIT 1`))?.id ?? null;
    const projectCache = new Map(); // TM client id (or null) -> { id, title, customerId, legacy, isBillable }
    const projectFor = async (clientId) => {
      if (projectCache.has(clientId)) return projectCache.get(clientId);
      const client = S.clients.find((x) => x.id === clientId);
      const mappedId = clientId === null ? mapping.defaultProjectId : mapping.clients?.[client?.name];
      let p;
      if (mappedId) {
        p = await one(`SELECT id, title, customer_id, is_billable FROM projects WHERE id = $1`, [mappedId]);
        if (!p) throw new Error(`The mapping file points to project ${mappedId}, which does not exist in PMS`);
        p = { id: p.id, title: p.title, customerId: p.customer_id, isBillable: p.is_billable, legacy: false };
      } else {
        const code = clientId === null ? 'TM-GENERAL' : `TM-C${clientId}`;
        const title = clientId === null ? 'Task Management - General' : `Task Management - ${client.name.trim()}`;
        const customerId = clientId === null ? null : customerMap.get(clientId);
        let row = await one(`SELECT id, title, customer_id FROM projects WHERE code = $1`, [code]);
        if (!row) {
          const start = S.tasks.filter((t) => t.client_id === clientId).map((t) => new Date(t.created_at).getTime());
          const startDate = dayOf(start.length ? Math.min(...start) : Date.now());
          // not billable: imported time must not change PMS billing; the projects can be mapped to real ones later
          row = await one(
            `INSERT INTO projects (code, title, project_division_id, project_type_id, customer_id, owner_id, status, start_date, is_billable, detail)
             VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, false, 'Created by the Task Management import for tasks that had no project.') RETURNING id, title, customer_id`,
            [code, title, division.id, ptype.id, customerId, owner, startDate],
          );
        }
        p = { id: row.id, title: row.title, customerId: row.customer_id, isBillable: false, legacy: true };
      }
      projectCache.set(clientId, p);
      return p;
    };
    // an imported project that was created here gets its task groups in the estimate, so tasks of those groups can be added to it later
    const estimated = new Set();
    const ensureEstimate = async (project, groupId) => {
      const key = `${project.id}:${groupId}`;
      if (!project.legacy || estimated.has(key)) return;
      estimated.add(key);
      await c.query(`INSERT INTO project_effort_estimates (project_id, task_group_id, effort_percentage) SELECT $1, $2, 100 WHERE NOT EXISTS (SELECT 1 FROM project_effort_estimates WHERE project_id = $1 AND task_group_id = $2)`, [project.id, groupId]);
    };

    // ---- what is there already (re-runs only add what is missing) ---------------------------------------------------------------
    const existing = async (table) => new Map((await q(`SELECT legacy_id, id FROM ${table} WHERE legacy_id IS NOT NULL`)).map((r) => [Number(r.legacy_id), r.id]));
    const taskMap = await existing('tasks');
    const stepMap = await existing('task_members');
    const logMap = await existing('timesheets');
    const entryMap = await existing('task_timers');
    const planMap = await existing('plan_items');
    const postMap = await existing('task_messages');
    const newTasks = new Set(); // PMS ids of the tasks created by this run (their activity is imported with them)
    const taskInfo = new Map(); // TM task id -> { id, project, typeId, title }

    // ---- tasks and steps ------------------------------------------------------------------------------------------------------
    const stepsByTask = new Map();
    for (const s of S.task_steps) stepsByTask.set(s.task_id, [...(stepsByTask.get(s.task_id) ?? []), s]);
    let tCreated = 0;
    let sCreated = 0;
    const involved = new Map(); // project id -> Set of PMS user ids (to make members of imported projects)
    for (const t of S.tasks) {
      const project = await projectFor(t.client_id);
      const tm = typeMap.get(t.type_id) ?? typeMap.get(null);
      await ensureEstimate(project, tm.groupId);
      if (!project.legacy && tm.groupId === group.id && !project.warnedGroup) {
        project.warnedGroup = true;
        warn(`Project ${project.title} (from your mapping): some tasks use the "Task Management (imported)" task group because their task type is not in the mapping file ("taskTypes") - map them to the project's own task groups if you want them under those`);
      }
      const steps = stepsByTask.get(t.id) ?? [];
      const owners = [...new Set((t.owner_ids?.length ? t.owner_ids : [t.owner_id]).map(U).filter(Boolean))];
      if (!owners.length) {
        warn(`Task ${t.id} "${t.title}" has no owner that could be matched`);
        owners.push(owner);
      }
      const people = [...owners, ...steps.map((s) => U(s.user_id))].filter(Boolean);
      involved.set(project.id, new Set([...(involved.get(project.id) ?? []), ...people]));

      let newId = taskMap.get(t.id);
      if (!newId) {
        const state = statusOf(steps);
        const closed = steps.map((s) => s.closed_at).filter(Boolean).map((d) => new Date(d).getTime());
        const doneAt = closed.length ? new Date(Math.max(...closed)) : null;
        const finished = state === 'completed' ? (t.completed_at ?? doneAt ?? t.created_at) : null;
        const row = await one(
          `INSERT INTO tasks (project_id, task_category_id, task_group_id, task_type_id, name, description, notes, media, owner_id, planned_end,
                              display_order, version, status, actual_end, completed_on, legacy_id, created_by, created_at, updated_by)
           VALUES ($1, $2, $3, $4, left($5, 300), $6, $7, $8, $9, CASE WHEN $10::date IS NOT NULL THEN ($10::date + time '18:00') AT TIME ZONE 'Asia/Dubai' END,
                   $11, $12, $13, $14::timestamptz, ($14::timestamptz AT TIME ZONE 'Asia/Dubai')::date, $15, $9, $16, $9) RETURNING id`,
          [project.id, category, tm.groupId, tm.typeId, t.title, t.description, t.notes, t.media, owners[0], t.due_date, t.priority_rank, t.version, state, finished, t.id, t.created_at],
        );
        newId = row.id;
        taskMap.set(t.id, newId);
        newTasks.add(newId);
        tCreated += 1;
        for (const s of steps) {
          const sr = await one(
            `INSERT INTO task_members (task_id, user_id, position, status, accepted_at, started_at, closed_at, legacy_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [newId, U(s.user_id), s.position, s.status, s.accepted_at, s.started_at, s.closed_at, s.id],
          );
          stepMap.set(s.id, sr.id);
          sCreated += 1;
        }
        if (!steps.length) warn(`Task ${t.id} "${t.title}" has no flow (it was imported as To do with no steps)`);
      }
      taskInfo.set(t.id, { id: newId, project, typeId: tm.typeId, title: t.title });
    }
    stat('tasks', tCreated, S.tasks.length - tCreated);
    stat('steps', sCreated, S.task_steps.length - sCreated);

    // people on the projects the import created, so the "everyone in a flow is on the project" rule holds for later edits
    let membersAdded = 0;
    for (const [projectId, people] of involved) {
      const p = [...projectCache.values()].find((x) => x.id === projectId);
      if (!p?.legacy) {
        const off = await q(`SELECT u.name FROM users u WHERE u.id = ANY($2) AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = $1 AND m.user_id = u.id) AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = $1 AND p.owner_id = u.id)`, [projectId, [...people]]);
        if (off.length) warn(`Project ${p?.title ?? projectId} (from your mapping): ${off.map((x) => x.name).join(', ')} are in imported flows but are not members of it - add them in PMS so the flows can still be edited`);
        continue;
      }
      for (const uid of people) {
        const r = await c.query(`INSERT INTO project_members (project_id, user_id) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2) AND NOT EXISTS (SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2)`, [projectId, uid]);
        membersAdded += r.rowCount;
      }
    }

    // ---- time logs (a PMS Timesheet row each, marked as logged on the board) ----------------------------------------------------------------------------------
    let lCreated = 0;
    const perDay = new Map();
    for (const l of S.time_logs) {
      if (logMap.has(l.id)) continue;
      const task = taskInfo.get(l.task_id);
      if (!task || !(l.minutes > 0)) {
        warn(`Time log ${l.id} was skipped (${!task ? 'its task is missing' : 'no minutes'})`);
        continue;
      }
      const day = dayOf(l.created_at);
      const lr = await one(
        `INSERT INTO timesheets (user_id, work_date, task_id, minutes, comment, is_billable, from_board, created_by, updated_by, created_at, legacy_id)
         VALUES ($1, $2, $3, $4, $5, $6, true, $1, $1, $7, $8) RETURNING id`,
        [U(l.user_id), day, task.id, l.minutes, l.note || null, task.project.isBillable, l.created_at, l.id],
      );
      logMap.set(l.id, lr.id);
      lCreated += 1;
      const k = `${U(l.user_id)}|${day}`;
      perDay.set(k, (perDay.get(k) ?? 0) + l.minutes);
    }
    stat('timeLogs', lCreated, S.time_logs.length - lCreated);
    const heavy = [...perDay.entries()].filter(([, m]) => m > 1440);
    if (heavy.length) warn(`${heavy.length} day(s) have more than 24 hours of imported time for one person (e.g. ${heavy[0][0]}); the PMS Timesheet does not enforce its 24 h limit on imported rows`);

    // ---- timer entries, plan, history, messages -----------------------------------------------------------------------------------
    const skippedChildren = [];
    let eCreated = 0;
    for (const e of S.time_entries) {
      if (entryMap.has(e.id)) continue;
      const task = taskInfo.get(e.task_id);
      const step = stepMap.get(e.step_id);
      if (!task || !step) {
        skippedChildren.push(`timer entry ${e.id}`);
        continue;
      }
      const r = await one(
        `INSERT INTO task_timers (user_id, member_id, day, status, run_started_at, minutes, created_at, legacy_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [U(e.user_id), step, e.day, e.status, e.run_started_at, e.minutes, e.created_at, e.id],
      );
      entryMap.set(e.id, r.id);
      eCreated += 1;
    }
    stat('timerEntries', eCreated, S.time_entries.length - eCreated - skippedChildren.filter((x) => x.startsWith('timer')).length);

    let pCreated = 0;
    for (const p of S.plan_items) {
      if (planMap.has(p.id)) continue;
      const task = taskInfo.get(p.task_id);
      const step = stepMap.get(p.step_id);
      if (!task || !step) {
        skippedChildren.push(`plan item ${p.id}`);
        continue;
      }
      const r = await one(`INSERT INTO plan_items (member_id, scope, start_date, position, legacy_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [step, p.scope, p.start_date, p.position, p.id]);
      planMap.set(p.id, r.id);
      pCreated += 1;
    }
    stat('plan', pCreated, S.plan_items.length - pCreated - skippedChildren.filter((x) => x.startsWith('plan')).length);

    let aCreated = 0;
    let aSkipped = 0;
    for (const a of S.activity) {
      const task = taskInfo.get(a.task_id);
      if (!task) {
        skippedChildren.push(`activity ${a.id}`);
        continue;
      }
      if (!newTasks.has(task.id)) { aSkipped += 1; continue; } // an earlier run already brought it
      const action = a.action.slice(0, 60);
      await c.query(
        `INSERT INTO audit_logs (entity, entity_id, action, message, user_id, logged_at) VALUES ('tasks', $1, $2, $3, $4, $5)`,
        [task.id, action === 'created' ? 'create' : ['accept', 'start', 'close'].includes(action) ? 'status_change' : 'update', a.detail ? `${action}: ${a.detail}` : action, a.user_id ? U(a.user_id) : null, a.created_at],
      );
      aCreated += 1;
    }
    stat('activity', aCreated, aSkipped);

    let mCreated = 0;
    for (const p of S.posts) {
      if (postMap.has(p.id)) continue;
      const task = p.task_id ? taskInfo.get(p.task_id) : null;
      if (p.task_id && !task) {
        skippedChildren.push(`message ${p.id}`);
        continue;
      }
      const r = await one(
        `INSERT INTO task_messages (task_id, author_id, kind, body, is_private, created_at, legacy_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [task?.id ?? null, U(p.author_id), p.kind, p.body, p.is_private, p.created_at, p.id],
      );
      postMap.set(p.id, r.id);
      mCreated += 1;
    }
    stat('messages', mCreated, S.posts.length - mCreated - skippedChildren.filter((x) => x.startsWith('message')).length);
    let mentions = 0;
    for (const m of S.post_mentions) {
      const post = postMap.get(m.message_id);
      if (!post || !U(m.user_id)) continue;
      mentions += (await c.query(`INSERT INTO task_message_recipients (message_id, user_id, read_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [post, U(m.user_id), m.read_at])).rowCount;
    }
    stats.mentions = { source: S.post_mentions.length, created: mentions };
    if (skippedChildren.length) warn(`${skippedChildren.length} item(s) were skipped because the task or step they belong to is missing: ${skippedChildren.slice(0, 5).join(', ')}${skippedChildren.length > 5 ? ', ...' : ''}`);

    // ---- reconciliation: PMS must hold everything the source had (else nothing is saved) ------------------------------------------
    const check = [];
    const expect = async (label, sourceValue, sql) => {
      const got = (await one(sql)).n;
      check.push({ label, source: sourceValue, pms: got, ok: Number(got) >= Number(sourceValue) });
    };
    await expect('tasks', S.tasks.length, `SELECT count(*)::int AS n FROM tasks WHERE legacy_id = ANY(${arr(S.tasks.map((t) => t.id))})`);
    await expect('steps', S.task_steps.length, `SELECT count(*)::int AS n FROM task_members WHERE legacy_id = ANY(${arr(S.task_steps.map((t) => t.id))})`);
    const wantedLogs = S.time_logs.filter((l) => taskInfo.get(l.task_id) && l.minutes > 0);
    await expect('time logs', wantedLogs.length, `SELECT count(*)::int AS n FROM timesheets WHERE legacy_id = ANY(${arr(wantedLogs.map((t) => t.id))})`);
    await expect('minutes logged', wantedLogs.reduce((a, l) => a + l.minutes, 0), `SELECT COALESCE(sum(minutes), 0)::int AS n FROM timesheets WHERE legacy_id = ANY(${arr(wantedLogs.map((t) => t.id))})`);
    await expect('messages', S.posts.length - skippedChildren.filter((x) => x.startsWith('message')).length, `SELECT count(*)::int AS n FROM task_messages WHERE legacy_id = ANY(${arr(S.posts.map((t) => t.id))})`);
    const bad = check.filter((x) => !x.ok);
    if (bad.length) throw new Error(`Reconciliation failed, nothing was saved: ${bad.map((b) => `${b.label}: source ${b.source}, PMS ${b.pms}`).join('; ')}`);

    return {
      stats,
      check,
      warnings,
      projects: [...projectCache.entries()].map(([clientId, p]) => ({ client: S.clients.find((x) => x.id === clientId)?.name ?? '(no client)', projectId: p.id, project: p.title, createdByImport: p.legacy })),
      membersAdded,
      notImported: { templates: before.templates, templateSteps: before.template_steps, sessions: before.sessions, loginAttempts: before.login_attempts },
    };
  };

  let report;
  try {
    report = await target.tx(async (c) => {
      const r = await run(c);
      if (!apply) throw new DryRun(r);
      return r;
    });
  } catch (e) {
    if (e instanceof DryRun) report = e.report;
    else throw e;
  }

  // the Task Management database must be exactly as it was
  const after = await counts(source);
  const changed = TABLES.filter((t) => after[t] !== before[t]);
  if (changed.length) throw new Error(`The Task Management database changed during the import (${changed.join(', ')}) - this should be impossible; stop and check.`);
  return { applied: apply, source: before, sourceUnchanged: true, ...report };
}

/** An integer list as a SQL array literal (ids come from the database, never from user text). */
function arr(ids) {
  const clean = ids.map((n) => Number(n)).filter((n) => Number.isInteger(n));
  return `ARRAY[${clean.join(',') || '0'}]::bigint[]`;
}
