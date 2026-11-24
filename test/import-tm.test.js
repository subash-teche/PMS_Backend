import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests the Task Management -> PMS import on two THROWAWAY databases:
//   FLOW_TEST_DB  an EMPTY PMS database with all migrations applied (the target)
//   TM_TEST_DB    an EMPTY database; the test builds the Task Management schema in it from TaskManagement/drizzle/*.sql
//                 (the files are only read) and fills it with made-up data (the source)
// Both must be on 127.0.0.1:55432. The test never touches a real Task Management database.
const TARGET = process.env.FLOW_TEST_DB;
const SOURCE = process.env.TM_TEST_DB;
const skip = TARGET && SOURCE ? false : 'set FLOW_TEST_DB and TM_TEST_DB to throwaway databases to run';
const local = (u) => /@127\.0\.0\.1:55432\//.test(u ?? '');
const here = path.dirname(fileURLToPath(import.meta.url));
const DRIZZLE = process.env.TM_DRIZZLE_DIR ?? path.resolve(here, '../../../TaskManagement/drizzle');

describe('Task Management import', { skip }, () => {
  let pool, srcPool, importTm, openSource, srcClient, source;
  const target = () => ({
    async tx(fn) {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    },
  });
  const t = async (sql, p) => (await pool.query(sql, p)).rows;
  const s = async (sql, p) => (await srcPool.query(sql, p)).rows;
  const n = async (sql) => Number((await t(sql))[0].n);
  const SRC_TABLES = ['users', 'clients', 'task_types', 'tasks', 'task_steps', 'time_logs', 'time_entries', 'plan_items', 'activity', 'posts', 'post_mentions', 'templates', 'template_steps', 'sessions', 'login_attempts'];
  /** A fingerprint of every row of the source: if anything were changed or deleted it would differ. */
  const fingerprint = async () => {
    const h = createHash('sha256');
    for (const tb of SRC_TABLES) h.update(JSON.stringify((await s(`SELECT * FROM ${tb} ORDER BY 1, 2`)).map((r) => r)));
    return h.digest('hex');
  };
  let ids = {};

  before(async () => {
    if (!local(TARGET) || !local(SOURCE)) throw new Error('FLOW_TEST_DB and TM_TEST_DB must both be on 127.0.0.1:55432');
    const { default: pg } = await import('pg');
    pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
    pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
    pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
    pool = new pg.Pool({ connectionString: TARGET, max: 4 });
    srcPool = new pg.Pool({ connectionString: SOURCE, max: 2 });
    ({ importTm, openSource } = await import('../src/modules/flow/import/tm-import.js'));

    // --- the PMS target: empty, with a few things the import should find -------------------------------------------------------
    const { n: busy } = (await t(`SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM projects) AS n`))[0];
    if (Number(busy) !== 0) throw new Error('FLOW_TEST_DB must be an empty throwaway database');
    const role = async (code, level) => (await t(`INSERT INTO roles (code, name, level) VALUES ($1, $1, $2) RETURNING id`, [code, level]))[0].id;
    const r = { ADMIN: await role('ADMIN', 1), PM: await role('PROJECT_MANAGER', 3), EMP: await role('EMPLOYEE', 5), CUST: await role('CUSTOMER', 8) };
    const user = async (name, email, rid) => (await t(`INSERT INTO users (username, password_hash, name, email, role_id) VALUES ($1::varchar, 'pms-hash', $2, $3, $4) RETURNING id`, [name, name, email, rid]))[0].id;
    ids.pmsAdmin = await user('root', 'root@pms.test', r.ADMIN);
    ids.alice = await user('alice', 'Alice@TM.test', r.EMP); // matches the Task Management user alice@tm.test, whatever the case
    ids.vendor = await user('cust', 'cust@pms.test', r.CUST); // a PMS role that cannot open Task Management
    ids.vendorTm = null;
    const cust = (await t(`INSERT INTO customers (code, name) VALUES ('ACME', 'acme foods') RETURNING id`))[0].id;
    const div = (await t(`INSERT INTO project_divisions (name) VALUES ('Real division') RETURNING id`))[0].id;
    const pt = (await t(`INSERT INTO project_types (name, project_division_id) VALUES ('Real type', $1) RETURNING id`, [div]))[0].id;
    ids.realProject = (await t(`INSERT INTO projects (code, title, project_division_id, project_type_id, customer_id, owner_id, status, start_date) VALUES ('REAL-1', 'Acme real project', $1, $2, $3, $4, 'active', current_date) RETURNING id`, [div, pt, cust, ids.pmsAdmin]))[0].id;
    await t(`INSERT INTO project_members (project_id, user_id) VALUES ($1, $2)`, [ids.realProject, ids.alice]);
    const g = (await t(`INSERT INTO task_groups (name) VALUES ('Real content') RETURNING id`))[0].id;
    ids.realGroup = g;
    ids.realType = (await t(`INSERT INTO task_types (name, task_group_id) VALUES ('Real reel', $1) RETURNING id`, [g]))[0].id;
    await t(`INSERT INTO project_effort_estimates (project_id, task_group_id, effort_percentage) VALUES ($1, $2, 100)`, [ids.realProject, g]);

    // --- the fake Task Management source ----------------------------------------------------------------------------------------
    const has = (await s(`SELECT to_regclass('public.tasks') AS x`))[0].x;
    if (has) throw new Error('TM_TEST_DB must be an empty throwaway database');
    for (const f of (await readdir(DRIZZLE)).filter((x) => x.endsWith('.sql')).sort()) await srcPool.query(await readFile(path.join(DRIZZLE, f), 'utf8'));
    const ins = async (sql, p) => (await s(sql, p))[0]?.id;
    const u = (name, email, role, active = true) => ins(`INSERT INTO users (name, email, password_hash, initials, colour, role, active) VALUES ($1, $2, 'tm-hash-' || $1, 'XX', '#000', $3, $4) RETURNING id`, [name, email, role, active]);
    ids.tmAdmin = await u('Mohammed', 'mohammed@tm.test', 'admin');
    ids.tmAlice = await u('Alice', 'alice@tm.test', 'member');
    ids.tmBob = await u('Bob', 'bob@tm.test', 'member');
    ids.tmOld = await u('Old Hand', 'old@tm.test', 'member', false);
    ids.tmVendor = await u('Cust Person', 'cust@pms.test', 'member'); // same e-mail as a PMS user whose role cannot open Task Management
    const acme = await ins(`INSERT INTO clients (name) VALUES ('ACME Foods') RETURNING id`);
    const beta = await ins(`INSERT INTO clients (name) VALUES ('Beta Retail') RETURNING id`);
    const reel = await ins(`INSERT INTO task_types (name) VALUES ('Reel') RETURNING id`);
    const post = await ins(`INSERT INTO task_types (name) VALUES ('Post') RETURNING id`);
    const task = (client, type, title, owner, extra = {}) => ins(
      `INSERT INTO tasks (month, client_id, type_id, title, description, owner_id, owner_ids, due_date, priority_rank, version, completed_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() - interval '20 days') RETURNING id`,
      [extra.month ?? '2026-10', client, type, title, extra.description ?? '', owner, `{${owner}}`, extra.due ?? null, extra.rank ?? 10, extra.version ?? 3, extra.completedAt ?? null]);
    const step = (taskId, userId, pos, status, minutes = null) => ins(`INSERT INTO task_steps (task_id, user_id, position, status, accepted_at, started_at, closed_at, minutes) VALUES ($1, $2, $3, $4::step_status, now() - interval '5 days', now() - interval '5 days', CASE WHEN $4::text = 'done' THEN now() - interval '4 days' END, $5) RETURNING id`, [taskId, userId, pos, status, minutes]);
    ids.t1 = await task(acme, reel, 'Diwali reel', ids.tmAlice, { due: '2026-10-30', rank: 20, version: 5, description: 'Script approved' });
    ids.t1s1 = await step(ids.t1, ids.tmAlice, 1, 'done', 30);
    ids.t1s2 = await step(ids.t1, ids.tmBob, 2, 'active', 20);
    ids.t2 = await task(beta, post, 'Sale post', ids.tmBob, { rank: 30, completedAt: '2026-10-25T10:00:00Z' });
    ids.t2s1 = await step(ids.t2, ids.tmBob, 1, 'done', 45);
    ids.t2s2 = await step(ids.t2, ids.tmAlice, 2, 'done', 10);
    ids.t3 = await task(null, null, 'Loose task', ids.tmBob, { rank: 40 });
    ids.t4 = await task(beta, post, 'Held by a user without TM access', ids.tmBob, { rank: 50 });
    await step(ids.t4, ids.tmVendor, 1, 'offered');
    const log = (taskId, stepId, userId, minutes, note, at) => ins(`INSERT INTO time_logs (task_id, step_id, user_id, minutes, note, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [taskId, stepId, userId, minutes, note, at]);
    await log(ids.t1, ids.t1s1, ids.tmAlice, 30, 'draft', '2026-10-20T08:00:00Z');
    await log(ids.t1, ids.t1s2, ids.tmBob, 20, '', '2026-10-21T20:30:00Z'); // 00:30 the next day in Dubai
    await log(ids.t2, ids.t2s1, ids.tmBob, 45, 'copy', '2026-10-22T09:00:00Z');
    await log(ids.t2, ids.t2s2, ids.tmAlice, 10, '', '2026-10-23T09:00:00Z');
    await ins(`INSERT INTO time_entries (user_id, task_id, step_id, day, status, minutes) VALUES ($1, $2, $3, '2026-10-21', 'ended', 20) RETURNING id`, [ids.tmBob, ids.t1, ids.t1s2]);
    await ins(`INSERT INTO plan_items (user_id, task_id, step_id, scope, start_date, position) VALUES ($1, $2, $3, 'day', '2026-10-28', 1) RETURNING id`, [ids.tmBob, ids.t1, ids.t1s2]);
    await ins(`INSERT INTO activity (task_id, user_id, action, detail) VALUES ($1, $2, 'created', '') RETURNING id`, [ids.t1, ids.tmAlice]);
    await ins(`INSERT INTO activity (task_id, user_id, action, detail) VALUES ($1, NULL, 'system note', 'x') RETURNING id`, [ids.t2]);
    const p1 = await ins(`INSERT INTO posts (task_id, author_id, kind, body, is_private) VALUES ($1, $2, 'close', 'Ready for review', false) RETURNING id`, [ids.t1, ids.tmAlice]);
    const p2 = await ins(`INSERT INTO posts (task_id, author_id, kind, body, is_private) VALUES (NULL, $1, 'note', 'Just between us', true) RETURNING id`, [ids.tmAdmin]);
    await s(`INSERT INTO post_mentions (message_id, user_id) VALUES ($1, $2), ($3, $4)`, [p1, ids.tmBob, p2, ids.tmAlice]);
    await ins(`INSERT INTO templates (name) VALUES ('Reel flow') RETURNING id`);
    await s(`INSERT INTO template_steps (template_id, user_id, position) SELECT id, ${ids.tmAlice}, 1 FROM templates`);
    await s(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('abc', $1, now() + interval '1 day')`, [ids.tmAlice]);
  });

  after(async () => {
    await srcClient?.end().catch(() => {});
    await pool?.end();
    await srcPool?.end();
  });

  const withSource = async (fn) => {
    const { default: pg } = await import('pg');
    srcClient = new pg.Client({ connectionString: SOURCE });
    await srcClient.connect();
    source = await openSource(srcClient);
    try { return await fn(source); } finally { await source.close(); await srcClient.end(); srcClient = null; }
  };
  const run = (opts = {}) => withSource((src) => importTm({ source: src, target: target(), ...opts }));
  const targetCounts = async () => ({
    users: await n(`SELECT count(*) AS n FROM users`), customers: await n(`SELECT count(*) AS n FROM customers`), projects: await n(`SELECT count(*) AS n FROM projects`),
    tasks: await n(`SELECT count(*) AS n FROM tasks`), steps: await n(`SELECT count(*) AS n FROM task_members`),
    timesheets: await n(`SELECT count(*) AS n FROM timesheets`), logs: await n(`SELECT count(*) AS n FROM timesheets WHERE from_board`),
  });

  it('the source guard refuses anything but SELECT, and Postgres itself refuses writes', async () => {
    await withSource(async (src) => {
      await assert.rejects(src.query('DELETE FROM tasks'), /read-only/);
      await assert.rejects(src.query('  update tasks set title = 1'), /read-only/);
      assert.equal((await src.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n, 4);
      await assert.rejects(srcClient.query('DELETE FROM tasks'), /read-only transaction/); // bypassing the wrapper: the database says no
    });
  });

  it('a dry run reports everything and saves nothing', async () => {
    const before = await targetCounts();
    const fp = await fingerprint();
    const rep = await run({ apply: false });
    assert.equal(rep.applied, false);
    assert.equal(rep.stats.tasks.created, 4);
    assert.deepEqual(await targetCounts(), before, 'the PMS database is unchanged');
    assert.equal(await fingerprint(), fp, 'the source is unchanged');
  });

  it('a failure part-way saves nothing in PMS and leaves the source alone', async () => {
    // a mapping that points to a project PMS does not have: the import stops after it already created users and customers
    const before = await targetCounts();
    const fp = await fingerprint();
    await assert.rejects(run({ apply: true, mapping: { clients: { 'ACME Foods': 999999 } } }), /does not exist in PMS/);
    assert.deepEqual(await targetCounts(), before, 'not even the users or customers it had created were kept');
    assert.equal(await fingerprint(), fp);
  });

  it('warns about a possible double account, and a "users" mapping ties the person to the PMS user', async () => {
    const empRole = (await t(`SELECT id FROM roles WHERE code = 'EMPLOYEE'`))[0].id;
    const bobId = (await t(`INSERT INTO users (username, password_hash, name, email, role_id) VALUES ('bobpms', 'x', 'Bob Pms', 'bob@pms.test', $1) RETURNING id`, [empRole]))[0].id;
    try {
      const dry = await run({ apply: false });
      assert.ok(dry.warnings.some((w) => /bob@tm\.test/.test(w) && /NEW PMS account/.test(w) && /bob@pms\.test/.test(w)), dry.warnings.join(' | '));
      const mapped = await run({ apply: false, mapping: { users: { 'BOB@tm.test': 'bob@pms.test' } } });
      assert.ok(!mapped.warnings.some((w) => /bob@tm\.test/.test(w)), 'mapped: no warning and no new account for Bob');
      assert.equal(mapped.stats.users.created, dry.stats.users.created - 1);
      await assert.rejects(run({ apply: false, mapping: { users: { 'bob@tm.test': 'nobody@pms.test' } } }), /no such PMS user/);
    } finally {
      await t(`DELETE FROM users WHERE id = $1`, [bobId]);
    }
  });

  it('imports with a mapping file, matching what exists and creating the rest', async () => {
    const fp = await fingerprint();
    const rep = await run({
      apply: true,
      mapping: { clients: { 'ACME Foods': ids.realProject }, taskTypes: { Reel: { taskGroupId: ids.realGroup, taskTypeId: ids.realType } } },
    });
    assert.equal(rep.applied, true);
    assert.equal(rep.sourceUnchanged, true);
    assert.equal(await fingerprint(), fp, 'every row of the Task Management database is exactly as it was');
    assert.deepEqual(rep.check.filter((c) => !c.ok), []);

    // users: matched by e-mail (any case) or created with the old password hash
    assert.equal(rep.stats.users.matchedExisting, 2); // alice, and the one with the cust@pms.test e-mail
    const bob = (await t(`SELECT u.*, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = 'bob@tm.test'`))[0];
    assert.equal(bob.password_hash, 'tm-hash-Bob');
    assert.equal(bob.role, 'EMPLOYEE');
    const mohammed = (await t(`SELECT r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = 'mohammed@tm.test'`))[0];
    assert.equal(mohammed.role, 'EMPLOYEE', 'a TM admin is not made a PMS admin unless asked');
    assert.ok(rep.warnings.some((w) => /Mohammed.*admin in Task Management/.test(w)));
    assert.equal((await t(`SELECT is_active FROM users WHERE email = 'old@tm.test'`))[0].is_active, false);
    assert.equal((await t(`SELECT password_hash FROM users WHERE id = $1`, [ids.alice]))[0].password_hash, 'pms-hash', 'a matched PMS user keeps their PMS password');
    assert.ok(rep.warnings.some((w) => /Cust Person|cust/.test(w) && /cannot open it/.test(w) && /hold an unfinished step/.test(w)));

    // customers: ACME Foods matched the PMS customer "acme foods"; Beta Retail created
    assert.equal(rep.stats.customers.created, 1);
    assert.equal(await n(`SELECT count(*) AS n FROM customers WHERE lower(name) = 'acme foods'`), 1);

    // tasks: with the mapping, ACME goes to the real project and the Reel type to the real group
    const t1 = (await t(`SELECT *, (planned_end AT TIME ZONE 'Asia/Dubai')::date::text AS due FROM tasks WHERE legacy_id = $1`, [ids.t1]))[0];
    assert.equal(t1.project_id, ids.realProject);
    assert.equal(t1.task_group_id, ids.realGroup);
    assert.equal(t1.task_type_id, ids.realType);
    assert.equal(t1.status, 'in_progress');
    assert.equal(t1.version, 5);
    assert.equal(t1.display_order, 20);
    assert.equal(t1.due, '2026-10-30');
    assert.equal(t1.description, 'Script approved');
    assert.equal(t1.owner_id, ids.alice);
    assert.equal(await n(`SELECT count(*) AS n FROM projects WHERE code = 'TM-C${(await s(`SELECT id FROM clients WHERE name = 'ACME Foods'`))[0].id}'`), 0, 'no project was created for the mapped client');
    const t2 = (await t(`SELECT f.*, p.code, p.is_billable FROM tasks f JOIN projects p ON p.id = f.project_id WHERE f.legacy_id = $1`, [ids.t2]))[0];
    assert.equal(t2.status, 'completed');
    assert.ok(t2.actual_end);
    assert.match(t2.code, /^TM-C\d+$/, 'a client without a mapping gets its own "Task Management - <client>" project');
    assert.equal(t2.is_billable, false, 'imported projects are not billable');
    const t3 = (await t(`SELECT f.status, p.code FROM tasks f JOIN projects p ON p.id = f.project_id WHERE f.legacy_id = $1`, [ids.t3]))[0];
    assert.deepEqual(t3, { status: 'to_do', code: 'TM-GENERAL' });
    assert.ok(rep.warnings.some((w) => /Loose task/.test(w) && /no flow/.test(w)));

    // steps keep their order, status and times
    const steps = await t(`SELECT s.position, s.status, u.email FROM task_members s JOIN users u ON u.id = s.user_id WHERE s.task_id = $1 ORDER BY s.position`, [t1.id]);
    assert.deepEqual(steps.map((x) => [x.position, x.status, x.email.toLowerCase()]), [[1, 'done', 'alice@tm.test'], [2, 'active', 'bob@tm.test']]);

    // time: kept, and written to the PMS Timesheet as read-only "flow" rows on the right Dubai day
    assert.equal(await n(`SELECT COALESCE(sum(minutes), 0) AS n FROM timesheets WHERE from_board`), 105);
    const sheet = await t(`SELECT t.work_date, t.minutes, t.is_billable, t.task_id, k.project_id FROM timesheets t JOIN tasks k ON k.id = t.task_id WHERE t.from_board ORDER BY t.id`);
    assert.equal(sheet.length, 4);
    assert.ok(sheet.filter((r) => r.project_id !== ids.realProject).every((r) => r.is_billable === false), 'time on imported projects is not billable');
    assert.ok(sheet.filter((r) => r.project_id === ids.realProject).every((r) => r.is_billable === true), 'time on a mapped real project follows that project');
    assert.equal(sheet.reduce((a, r) => a + r.minutes, 0), 105);
    const bobsLate = (await t(`SELECT work_date FROM timesheets WHERE comment IS NULL AND from_board AND minutes = 20`))[0].work_date;
    assert.equal(bobsLate, '2026-10-22', '20:30 UTC is 00:30 the next day in Dubai');
    assert.equal(sheet[0].task_id, t1.id, 'the time is on the task');

    // the rest of the history
    assert.equal(rep.stats.timerEntries.created, 1);
    assert.equal(rep.stats.plan.created, 1);
    assert.equal(rep.stats.activity.created, 2);
    assert.equal(rep.stats.messages.created, 2);
    assert.equal(rep.stats.mentions.created, 2);
    assert.equal((await t(`SELECT is_private FROM task_messages WHERE body = 'Just between us'`))[0].is_private, true);
    assert.equal((await t(`SELECT user_id FROM audit_logs WHERE entity = 'tasks' AND message LIKE 'system note%'`))[0].user_id, null);

    // people of the projects the import created are members, so flows stay editable; the real project is only warned about
    assert.ok(rep.membersAdded > 0);
    assert.ok(rep.warnings.some((w) => /Acme real project/.test(w) && /not members/.test(w) && /Bob/.test(w)));

    // what was not imported stays in the old database and is reported
    assert.deepEqual(rep.notImported, { templates: 1, templateSteps: 1, sessions: 1, loginAttempts: 0 });
  });

  it('running it again adds nothing and duplicates nothing', async () => {
    const before = await targetCounts();
    const fp = await fingerprint();
    const rep = await run({ apply: true, mapping: { clients: { 'ACME Foods': ids.realProject }, taskTypes: { Reel: { taskGroupId: ids.realGroup, taskTypeId: ids.realType } } } });
    assert.deepEqual(await targetCounts(), before);
    assert.equal(rep.stats.tasks.created, 0);
    assert.equal(rep.stats.tasks.alreadyThere, 4);
    assert.equal(rep.stats.timeLogs.created, 0);
    assert.equal(rep.stats.users.created, 0);
    assert.equal(await fingerprint(), fp);
  });

  it('a task that the PMS side calls a duplicate is never deleted: the source still has every row', async () => {
    assert.deepEqual(await s(`SELECT (SELECT count(*)::int FROM tasks) AS tasks, (SELECT count(*)::int FROM task_steps) AS steps, (SELECT count(*)::int FROM time_logs) AS logs, (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM templates) AS templates`),
      [{ tasks: 4, steps: 5, logs: 4, users: 5, templates: 1 }]);
  });
});
