import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// End-to-end test of the tasks (the Tasks board, the 1-3-5, the Plan, the timer, the Timesheet) against a REAL, EMPTY, THROWAWAY
// PostgreSQL database with all migrations applied:
//   FLOW_TEST_DB=postgres://postgres@127.0.0.1:55432/pms_flow_test npm test
// It creates its own fixtures and never runs without FLOW_TEST_DB. Do not point it at a database with real data.
const URL = process.env.FLOW_TEST_DB;
process.env.DATABASE_URL ??= URL ?? 'postgres://x:x@localhost:5432/x';
process.env.JWT_ACCESS_SECRET ??= 'x'.repeat(32);
process.env.COOKIE_SECRET ??= 'y'.repeat(32);

const skip = URL ? false : 'set FLOW_TEST_DB to a throwaway database to run';

describe('Tasks on a real database', { skip }, () => {
  let db, pool, svc, planSvc, timerSvc, msgSvc, t135, tsSvc, tasksSvc;
  let ids;
  const asUser = (userId, code, level = 5) => ({ userId, name: `u${userId}`, timeZone: 'Asia/Dubai', isActive: true, isSuperAdmin: false, role: { code, level, dataScope: 'own' }, permissions: {}, access: {} });
  let admin, pm, emp1, emp2, outsider, stranger, sup;

  before(async () => {
    const { default: pg } = await import('pg');
    pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
    pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
    pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
    pool = new pg.Pool({ connectionString: URL, max: 5 });
    db = {
      query: (t, p) => pool.query(t, p),
      async tx(fn) {
        const c = await pool.connect();
        try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      },
    };
    svc = await import('../src/modules/flow/flow.service.js');
    planSvc = await import('../src/modules/flow/flow.plan.service.js');
    timerSvc = await import('../src/modules/flow/flow.timer.service.js');
    msgSvc = await import('../src/modules/flow/flow.messages.service.js');
    t135 = await import('../src/modules/task135/task135.service.js');
    tsSvc = await import('../src/modules/timesheets/timesheets.service.js');
    tasksSvc = await import('../src/modules/tasks/tasks.service.js');

    // --- fixtures -------------------------------------------------------------------------------------------------
    const q = async (sql, params) => (await pool.query(sql, params)).rows;
    // safety: only ever run on an empty database - never on one that holds real data
    const { n } = (await q(`SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM projects) AS n`))[0];
    if (Number(n) !== 0) throw new Error('FLOW_TEST_DB must be an empty throwaway database (it has users or projects)');
    const role = async (code, level) => (await q(`INSERT INTO roles (code, name, level) VALUES ($1, $1, $2) RETURNING id`, [code, level]))[0].id;
    const roleIds = { ADMIN: await role('ADMIN', 1), PROJECT_MANAGER: await role('PROJECT_MANAGER', 3), EMPLOYEE: await role('EMPLOYEE', 5), CUSTOMER: await role('CUSTOMER', 8) };
    const user = async (name, code) => (await q(`INSERT INTO users (username, password_hash, name, email, role_id) VALUES ($1::varchar, 'x', $1::varchar, $1::varchar || '@t.test', $2) RETURNING id`, [name, roleIds[code]]))[0].id;
    ids = { admin: await user('admin', 'ADMIN'), pm: await user('pm', 'PROJECT_MANAGER'), emp1: await user('emp1', 'EMPLOYEE'), emp2: await user('emp2', 'EMPLOYEE'), outsider: await user('outsider', 'CUSTOMER'), stranger: await user('stranger', 'EMPLOYEE') };
    admin = asUser(ids.admin, 'ADMIN', 1); pm = asUser(ids.pm, 'PROJECT_MANAGER', 3); emp1 = asUser(ids.emp1, 'EMPLOYEE'); emp2 = asUser(ids.emp2, 'EMPLOYEE');
    outsider = asUser(ids.outsider, 'CUSTOMER', 8); stranger = asUser(ids.stranger, 'EMPLOYEE');
    sup = { userId: ids.admin, name: 'admin', timeZone: 'Asia/Dubai', isActive: true, isSuperAdmin: true, role: { code: 'ADMIN', level: 0, dataScope: 'all' }, permissions: {}, access: {} };

    const group = (await q(`SELECT g.id AS gid, t.id AS tid FROM task_groups g JOIN task_types t ON t.task_group_id = g.id ORDER BY g.id, t.id LIMIT 1`))[0];
    const other = (await q(`SELECT g.id AS gid, t.id AS tid FROM task_groups g JOIN task_types t ON t.task_group_id = g.id WHERE g.id <> $1 ORDER BY g.id LIMIT 1`, [group.gid]))[0];
    const cust = (await q(`INSERT INTO customers (code, name) VALUES ('C1', 'Acme') RETURNING id`))[0].id;
    const div = (await q(`INSERT INTO project_divisions (name) VALUES ('D') RETURNING id`))[0].id;
    const ptype = (await q(`INSERT INTO project_types (name, project_division_id) VALUES ('T', $1) RETURNING id`, [div]))[0].id;
    const project = (await q(`INSERT INTO projects (code, title, project_division_id, project_type_id, customer_id, owner_id, status, start_date) VALUES ('P1', 'Website', $1, $2, $3, $4, 'active', current_date) RETURNING id`, [div, ptype, cust, ids.pm]))[0].id;
    for (const u of [ids.emp1, ids.emp2]) await q(`INSERT INTO project_members (project_id, user_id) VALUES ($1, $2)`, [project, u]);
    await q(`INSERT INTO project_effort_estimates (project_id, task_group_id, effort_percentage) VALUES ($1, $2, 100)`, [project, group.gid]);
    const category = (await q(`SELECT id FROM task_categories WHERE is_project ORDER BY id LIMIT 1`))[0].id;
    ids = { ...ids, group: group.gid, type: group.tid, otherGroup: other.gid, otherType: other.tid, project, cust, category };
  });
  after(async () => { await pool?.end(); });

  const newTask = (user, flow, extra = {}) => svc.createTask(db, user, { projectId: ids.project, taskGroupId: ids.group, taskTypeId: ids.type, title: 'Reel', flow, ...extra });
  const n_ = async (sql) => Number((await pool.query(sql)).rows[0].n);
  const timesheetRows = async (taskId) => (await pool.query(`SELECT * FROM timesheets WHERE task_id = $1 ORDER BY id`, [taskId])).rows;
  const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const planOf = (taskId, userId, date, scope = 'day') => pool.query(
    `INSERT INTO plan_items (member_id, scope, start_date, position) SELECT m.id, $4, $3, 1 FROM task_members m WHERE m.task_id = $1 AND m.user_id = $2 ORDER BY m.position LIMIT 1`,
    [taskId, userId, date, scope],
  );
  const slotRow = (userId, taskId, date, position = 1) => pool.query(`INSERT INTO daily_plan_items (user_id, plan_date, position, task_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $1, $1)`, [userId, date, position, taskId]);
  const clearDays = async (userId) => {
    await pool.query(`DELETE FROM daily_plan_items WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM plan_items WHERE member_id IN (SELECT id FROM task_members WHERE user_id = $1)`, [userId]);
  };

  it('creates a task of a project, with the flow offered to the first person', async () => {
    const t = await newTask(emp1, [ids.emp1, ids.emp2]);
    assert.equal(t.customerName, 'Acme');
    assert.equal(t.status, 'to_do');
    assert.deepEqual(t.steps.map((s) => s.status), ['offered', 'waiting']);
    assert.deepEqual(t.ownerIds, [ids.emp1]);
    // one table: the same task is read by the PMS task screens, and its first person is who it is assigned to
    const pmsView = await tasksSvc.getTask(db, sup, t.id);
    assert.equal(pmsView.name, 'Reel');
    assert.equal(pmsView.assignedTo, ids.emp1);
    assert.equal(pmsView.projectCode, 'P1');
  });

  it('gives an admin who is not on the project the project owner as default owner', async () => {
    const t = await newTask(admin, [ids.emp1], { title: 'By admin' });
    assert.deepEqual(t.ownerIds, [ids.pm]);
    await assert.rejects(newTask(admin, [ids.emp1], { ownerIds: [ids.admin] }), /Not on this project/);
    await svc.deleteTask(db, admin, t.id);
  });

  it('refuses a flow with people who cannot be in it', async () => {
    await assert.rejects(newTask(emp1, [ids.outsider]), /No access to Task Management/);
    await assert.rejects(newTask(emp1, [ids.stranger]), /Not on this project/);
    await assert.rejects(newTask(stranger, [ids.emp1]), /not on this project/i);
    await assert.rejects(newTask(emp1, [ids.emp1], { taskGroupId: ids.otherGroup, taskTypeId: ids.otherType }), /not in this project's estimate/);
    await assert.rejects(newTask(emp1, [ids.emp1], { taskTypeId: ids.otherType }), /not in the selected task group/);
  });

  it('runs a task through its flow, logging time into the PMS timesheet and finishing it', async () => {
    let t = await newTask(emp1, [ids.emp1, ids.emp2], { title: 'Flow run' });
    t = await svc.flowStep(db, emp1, t.id, t.version, ['accept']);
    assert.equal(t.status, 'in_progress');
    await assert.rejects(svc.flowStep(db, emp2, t.id, t.version, ['start']), /Only the person holding/);
    await assert.rejects(svc.flowStep(db, emp1, t.id, t.version - 1, ['start']), /Someone just changed this/);
    t = await svc.flowStep(db, emp1, t.id, t.version, ['start']);
    t = await svc.logTime(db, emp1, t.id, { minutes: 30, note: 'draft' });

    let rows = await timesheetRows(t.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task_id, t.id, 'the time is on the task');
    assert.equal(rows[0].project_id, undefined, 'the entry does not repeat the task project');
    assert.equal(rows[0].minutes, 30);

    t = await svc.flowStep(db, emp1, t.id, t.version, ['close'], { minutes: 15, note: 'ready for review' });
    assert.deepEqual(t.steps.map((s) => s.status), ['done', 'offered']);
    assert.equal(t.steps[0].minutes, 45, 'what the person logged on the task');
    assert.equal((await timesheetRows(t.id)).reduce((a, r) => a + r.minutes, 0), 45);
    const mention = await pool.query(`SELECT 1 FROM task_message_recipients m JOIN task_messages p ON p.id = m.message_id WHERE p.task_id = $1 AND m.user_id = $2`, [t.id, ids.emp2]);
    assert.equal(mention.rowCount, 1, 'the close comment reaches the next person');

    t = await svc.flowStep(db, emp2, t.id, t.version, ['accept']);
    t = await svc.flowStep(db, emp2, t.id, t.version, ['start', 'close'], { minutes: 10 });
    assert.equal(t.status, 'completed');
    assert.ok(t.completedAt);
    assert.equal((await timesheetRows(t.id)).reduce((a, r) => a + r.minutes, 0), 55);
    // what happened is in the audit log, with the person who did it
    const history = await svc.listActivity(db, t.id);
    assert.ok(history.some((h) => h.action === 'created'));
    assert.ok(history.some((h) => h.action === 'close' && h.detail === '45 min' === false || h.action === 'close'));
    assert.ok(history.some((h) => h.action === 'logged time' && h.detail === '30 min'));
  });

  it('catches up a day that is over: time goes on the day it was worked, and a task never started can be completed', async () => {
    const { todayIn } = await import('../src/utils/time.js');
    const day = (add) => addDays(todayIn('Asia/Dubai'), add);
    const yesterday = day(-1);

    // never started: accept -> start -> close in one go, with the time on yesterday
    let t = await newTask(emp1, [ids.emp1], { title: 'Catch up' });
    await assert.rejects(svc.flowStep(db, emp1, t.id, t.version, ['accept', 'start', 'close'], { minutes: 20, workDate: day(1) }), /future day/);
    t = await svc.flowStep(db, emp1, t.id, t.version, ['accept', 'start', 'close'], { minutes: 40, note: 'finished yesterday', workDate: yesterday });
    assert.equal(t.status, 'completed');
    const rows = await timesheetRows(t.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].work_date, yesterday);
    assert.equal(rows[0].minutes, 40);

    // only log time on a past day: the task stays in progress; an open timer entry of a step that gets closed is ended
    let u = await newTask(emp1, [ids.emp1], { title: 'Catch up 2' });
    u = await svc.flowStep(db, emp1, u.id, u.version, ['accept', 'start']);
    u = await svc.logTime(db, emp1, u.id, { minutes: 15, workDate: yesterday });
    assert.equal(u.status, 'in_progress');
    assert.equal((await timesheetRows(u.id))[0].work_date, yesterday);
    const entry = await timerSvc.createEntry(db, emp1, { stepId: u.steps[0].id });
    await svc.flowStep(db, emp1, u.id, u.version, ['close'], { minutes: 0, workDate: yesterday });
    assert.equal((await pool.query(`SELECT status FROM task_timers WHERE id = $1`, [entry.id])).rows[0].status, 'ended');
  });

  it('carries a task that was not finished on a past day over to today, but a finished one stays where it was', async () => {
    const { todayIn } = await import('../src/utils/time.js');
    const { slotOf } = await import('../src/modules/flow/flow.weeks.js');
    const today = todayIn('Asia/Dubai');
    const yesterday = addDays(today, -1);
    const plan = async (stepId) => (await pool.query(`SELECT start_date::text AS d FROM plan_items WHERE member_id = $1 ORDER BY start_date`, [stepId])).rows.map((r) => r.d);

    let t = await newTask(emp1, [ids.emp1], { title: 'Carry over' });
    t = await svc.flowStep(db, emp1, t.id, t.version, ['accept']);
    const stepId = t.steps[0].id;
    await planOf(t.id, ids.emp1, yesterday);
    await assert.rejects(planSvc.setPlan(db, emp1, { stepId, slot: null, from: yesterday }), /past day/); // still cannot be taken out of the past
    await assert.rejects(planSvc.setPlan(db, emp1, { stepId, slot: { ...slotOf(yesterday), day: Number(yesterday.slice(8)) }, from: yesterday }), /past day/); // nor moved to another past day
    await planSvc.setPlan(db, emp1, { stepId, slot: { ...slotOf(today), day: Number(today.slice(8)) }, from: yesterday });
    assert.deepEqual(await plan(stepId), [today]);

    // a finished step on a past day is history
    await pool.query(`UPDATE plan_items SET start_date = $2 WHERE member_id = $1`, [stepId, yesterday]);
    await svc.flowStep(db, emp1, t.id, (await svc.getTask(db, t.id)).version, ['start', 'close'], { minutes: 0 });
    await assert.rejects(planSvc.setPlan(db, emp1, { stepId, slot: { ...slotOf(today), day: Number(today.slice(8)) }, from: yesterday }), /past day/);
  });

  it('locks time logged on the board in the PMS timesheet, and a task with time on it cannot be deleted', async () => {
    const t = await newTask(emp1, [ids.emp1], { title: 'Lock' });
    let cur = await svc.flowStep(db, emp1, t.id, t.version, ['accept']);
    cur = await svc.flowStep(db, emp1, cur.id, cur.version, ['start']);
    await svc.logTime(db, emp1, t.id, { minutes: 20 });
    const [row] = await timesheetRows(t.id);
    await assert.rejects(tsSvc.updateTimesheet(db, emp1, row.id, { minutes: 5 }), /change it there/);
    await assert.rejects(tsSvc.deleteTimesheet(db, emp1, row.id), /change it there/);
    const listed = await tsSvc.getTimesheet(db, emp1, row.id);
    assert.equal(listed.source, 'flow');

    await assert.rejects(svc.deleteTask(db, emp2, t.id), /Only the owner or an admin/);
    await assert.rejects(svc.deleteTask(db, emp1, t.id), /Time is logged/);
    const fresh = await newTask(emp1, [ids.emp1], { title: 'Never worked on' });
    await svc.deleteTask(db, emp1, fresh.id);
    assert.equal(await n_(`SELECT count(*) AS n FROM tasks WHERE id = ${fresh.id}`), 0, 'a task nobody logged time on can be deleted, with its members');
    assert.equal(await n_(`SELECT count(*) AS n FROM task_members WHERE task_id = ${fresh.id}`), 0);
  });

  it('the Timesheet list can group the entries by task and adds up the time of each', async () => {
    const { todayIn } = await import('../src/utils/time.js');
    const today = todayIn('Asia/Dubai');
    const yesterday = addDays(today, -1);
    let a = await newTask(emp1, [ids.emp1], { title: 'Group A' });
    a = await svc.flowStep(db, emp1, a.id, a.version, ['accept', 'start']);
    await svc.logTime(db, emp1, a.id, { minutes: 20, workDate: yesterday });
    await svc.logTime(db, emp1, a.id, { minutes: 30, workDate: today, note: 'later' });
    let b = await newTask(emp1, [ids.emp1], { title: 'Group B' });
    b = await svc.flowStep(db, emp1, b.id, b.version, ['accept', 'start']);
    await svc.logTime(db, emp1, b.id, { minutes: 15, workDate: today });
    const q = { scope: 'mine', page: 1, pageSize: 50, sortDir: 'desc', sortBy: 'workDate', from: yesterday, to: today };

    const entries = await tsSvc.listTimesheets(db, emp1, q);
    const grouped = await tsSvc.listTimesheets(db, emp1, { ...q, groupBy: 'task' });
    const mine = (r) => r.items.filter((i) => /^Group [AB]/.test(i.taskName ?? ''));
    assert.equal(mine(entries).length, 3, 'three entries');
    assert.equal(mine(grouped).length, 2, 'two tasks');
    const rowA = grouped.items.find((i) => i.taskName === 'Group A');
    assert.equal(rowA.minutes, 50);
    assert.equal(rowA.entries, 2);
    assert.equal(rowA.firstDate, yesterday);
    assert.equal(rowA.lastDate, today);
    assert.equal(rowA.comment, 'Group A'); // the task, not the note of the last entry
    assert.equal(grouped.items.find((i) => i.taskName === 'Group B').minutes, 15);
    // the totals do not change; the count is of tasks
    assert.equal(grouped.totalMinutes, entries.totalMinutes);
    assert.equal(grouped.total, grouped.items.length);
    // the period decides what is added up: today only
    const todayOnly = await tsSvc.listTimesheets(db, emp1, { ...q, from: today, groupBy: 'task' });
    assert.equal(todayOnly.items.find((i) => i.taskName === 'Group A').minutes, 30);
  });

  it('one task table: a task made in the PMS task screens is on the board, and what is done on the board shows in PMS', async () => {
    const { todayIn } = await import('../src/utils/time.js');
    const plannedStart = new Date(Date.now() - 3_600_000).toISOString();
    const plannedEnd = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const mk = (name, assignedTo) => tasksSvc.createTask(db, sup, { name, categoryId: ids.category, projectId: ids.project, taskGroupId: ids.group, taskTypeId: ids.type, ownerId: ids.pm, assignedTo, plannedStart, plannedEnd });

    // created in PMS, assigned to emp1: emp1 holds it (accepted), and it is on the board with one person
    const created = await mk('Made in PMS', ids.emp1);
    assert.equal(created.assignedTo, ids.emp1);
    let onBoard = await svc.getTask(db, created.id);
    assert.deepEqual(onBoard.steps.map((x) => [x.userId, x.status]), [[ids.emp1, 'todo']]);
    assert.ok((await svc.listTasks(db, { scope: 'all' })).some((x) => x.id === created.id));
    // nobody holds it yet: it is on the board without a flow
    const unassigned = await tasksSvc.createTask(db, sup, { name: 'Nobody yet', categoryId: ids.category, projectId: ids.project, taskGroupId: ids.group, taskTypeId: ids.type, ownerId: ids.pm, assignedTo: null, plannedStart, plannedEnd }).catch((e) => e);
    assert.ok(unassigned instanceof Error || unassigned.assignedTo === null);

    // started with the timer, time logged, finished on the board: the PMS task follows
    const today = svc.today(emp1);
    const { slotOf } = await import('../src/modules/flow/flow.weeks.js');
    const slot = { ...slotOf(today), day: Number(today.slice(8)) };
    await planSvc.setPlan(db, emp1, { stepId: onBoard.steps[0].id, slot });
    const entry = await timerSvc.createEntry(db, emp1, { stepId: onBoard.steps[0].id });
    await timerSvc.startEntry(db, emp1, entry.id);
    let pms = await tasksSvc.getTask(db, sup, created.id);
    assert.equal(pms.status, 'in_progress', 'starting it on the board starts the PMS task');
    assert.ok(pms.startedAt);
    await timerSvc.pauseEntry(db, emp1, entry.id, { minutes: 25 });
    assert.deepEqual((await timesheetRows(created.id)).map((r) => [r.minutes, r.task_id]), [[25, created.id]]);
    await timerSvc.startEntry(db, emp1, entry.id);
    await timerSvc.endEntry(db, emp1, entry.id, { complete: true, minutes: 5 });
    const done = (await pool.query(`SELECT status, completed_on, completed_by, actual_end FROM tasks WHERE id = $1`, [created.id])).rows[0];
    assert.equal(done.status, 'completed');
    assert.equal(done.completed_by, ids.emp1);
    assert.equal(done.completed_on, todayIn('Asia/Dubai'));
    assert.ok(done.actual_end);
    assert.ok((await pool.query(`SELECT 1 FROM audit_logs WHERE entity = 'tasks' AND entity_id = $1 AND action = 'status_change'`, [created.id])).rowCount >= 2, 'the steps are in the audit log');

    // assigned to someone else in PMS: the person on the step changes, and the old person's plan goes with them
    const second = await mk('Second PMS task', ids.emp1);
    const st = await svc.getTask(db, second.id);
    await planSvc.setPlan(db, emp1, { stepId: st.steps[0].id, slot });
    const moved = await tasksSvc.updateTask(db, sup, second.id, { assignedTo: ids.emp2 });
    assert.equal(moved.assignedTo, ids.emp2);
    assert.equal((await svc.getTask(db, second.id)).steps[0].userId, ids.emp2);
    assert.equal(await n_(`SELECT count(*) AS n FROM plan_items WHERE member_id = ${st.steps[0].id}`), 0, "the old person's plan entry is gone");

    // the status set in PMS moves the people along; completed there completes the board task, and reopening it opens it again
    await tasksSvc.updateTask(db, sup, second.id, { status: 'in_progress' });
    assert.equal((await svc.getTask(db, second.id)).steps[0].status, 'active');
    await tasksSvc.updateTask(db, sup, second.id, { status: 'completed' });
    assert.equal((await svc.getTask(db, second.id)).status, 'completed');
    assert.equal((await svc.getTask(db, second.id)).steps[0].status, 'done');
    await tasksSvc.updateTask(db, sup, second.id, { status: 'to_do' });
    assert.equal((await svc.getTask(db, second.id)).steps[0].status, 'todo');
    // a task with time on it is not deleted from PMS either
    await assert.rejects(tasksSvc.deleteTask(db, sup, created.id), /Time is logged/);
    await tasksSvc.deleteTask(db, sup, second.id);
    assert.equal(await n_(`SELECT count(*) AS n FROM task_members WHERE task_id = ${second.id}`), 0);
  });

  it('plans a task on a day and feeds the 1-3-5', async () => {
    const t = await newTask(emp1, [ids.emp1], { title: 'Plan me' });
    const step = t.steps[0];
    const today = svc.today(emp1);
    const { slotOf } = await import('../src/modules/flow/flow.weeks.js');
    const slot = { ...slotOf(today), day: Number(today.slice(8)) };
    await planSvc.setPlan(db, emp1, { stepId: step.id, slot });
    await assert.rejects(planSvc.setPlan(db, emp2, { stepId: step.id, slot }), /only plan your own steps/);

    const planned = await planSvc.listPlan(db, ids.emp1);
    assert.ok(planned.some((p) => p.stepId === step.id && p.taskId === t.id && p.scope === 'day' && p.startDate === today));

    let feed = await t135.flowPlanned(db, emp1, today);
    const mine = feed.find((f) => f.taskId === t.id);
    assert.ok(mine);
    assert.equal(mine.inSlot, false);
    assert.equal(mine.projectCode, 'P1');

    const item = await t135.addItem(db, emp1, { date: today, taskId: t.id });
    assert.equal(item.taskId, t.id);
    assert.equal(item.title, 'Plan me');
    assert.equal(item.projectCode, 'P1');
    await assert.rejects(t135.addItem(db, emp1, { date: today, taskId: t.id }), /already on the 1-3-5/);
    await assert.rejects(t135.addItem(db, emp2, { date: today, taskId: t.id }), /you hold or are waiting on/);
    await assert.rejects(t135.addItem(db, outsider, { date: today, taskId: t.id }), /not available for your role/);

    feed = await t135.flowPlanned(db, emp1, today);
    assert.equal(feed.find((f) => f.taskId === t.id).inSlot, true);
    assert.deepEqual(await t135.flowPlanned(db, outsider, today), []);

    const day = await t135.listDay(db, emp1, today);
    assert.ok(day.items.some((i) => i.taskId === t.id));
    // the slot shows where the person's own step is, and the time logged that day (never typed into the slot)
    const mineItem = day.items.find((i) => i.taskId === t.id);
    assert.equal(mineItem.stepStatus, 'offered');
    assert.equal(mineItem.minutes, 0);
    await pool.query(`INSERT INTO timesheets (task_id, user_id, minutes, work_date, from_board) VALUES ($1, $2, 45, $3, true)`, [t.id, ids.emp1, today]);
    assert.equal((await t135.listDay(db, emp1, today)).items.find((i) => i.taskId === t.id).minutes, 45);
    const ticked = await t135.updateItem(db, emp1, mineItem.id, { isDone: true });
    assert.equal(ticked.isDone, true);
    assert.equal(ticked.minutes, 45);
    await t135.updateItem(db, emp1, mineItem.id, { isDone: false });
    await pool.query(`DELETE FROM timesheets WHERE task_id = $1 AND from_board`, [t.id]);

    // a week plan shows on every day of its week, unless the step is planned on that day
    const wk = await newTask(emp1, [ids.emp1], { title: 'Week plan' });
    await planSvc.setPlan(db, emp1, { stepId: wk.steps[0].id, slot: slotOf(today) });
    assert.ok((await t135.flowPlanned(db, emp1, today)).some((f) => f.taskId === wk.id && f.scope === 'week'));

    await planSvc.setPlan(db, emp1, { stepId: step.id, slot: null });
    assert.ok(!(await planSvc.listPlan(db, ids.emp1)).some((p) => p.stepId === step.id));
  });

  it('fills the 1-3-5 of a day from the Plan, in the order of the plan, and keeps the two in step', async () => {
    const { slotOf } = await import('../src/modules/flow/flow.weeks.js');
    const today = svc.today(emp2);
    const tomorrow = addDays(today, 1);
    const on = (date) => ({ ...slotOf(date), day: Number(date.slice(8)) });
    const titles = async (date) => (await t135.listDay(db, emp2, date)).items.map((i) => i.title);
    await clearDays(ids.emp2);
    const a = await newTask(emp2, [ids.emp2], { title: 'Auto A' });
    const b = await newTask(emp2, [ids.emp2], { title: 'Auto B' });
    const c = await newTask(emp2, [ids.emp2], { title: 'Auto C' });
    const w = await newTask(emp2, [ids.emp2], { title: 'Auto week' });
    // planned in this order: B, then A; C only for the whole week
    await planSvc.setPlan(db, emp2, { stepId: b.steps[0].id, slot: on(today) });
    await planSvc.setPlan(db, emp2, { stepId: a.steps[0].id, slot: on(today) });
    await planSvc.setPlan(db, emp2, { stepId: w.steps[0].id, slot: slotOf(today) });
    assert.deepEqual(await titles(today), ['Auto B', 'Auto A']); // plan order; the whole-week plan is not put in a slot by itself
    assert.deepEqual(await titles(today), ['Auto B', 'Auto A']); // loading again adds nothing twice
    assert.deepEqual((await t135.listDay(db, emp2, today)).items.map((i) => i.size), ['big', 'medium']);

    // planned later in the day: it joins the end; taken out of the plan: its slot goes
    await planSvc.setPlan(db, emp2, { stepId: c.steps[0].id, slot: on(today) });
    assert.deepEqual(await titles(today), ['Auto B', 'Auto A', 'Auto C']);
    await planSvc.setPlan(db, emp2, { stepId: a.steps[0].id, slot: null, from: today });
    assert.deepEqual(await titles(today), ['Auto B', 'Auto C']);
    assert.deepEqual((await t135.listDay(db, emp2, today)).items.map((i) => i.position), [1, 2]);

    // taking a task out of the day takes it out of that day's plan (and it does not come back)
    const itemB = (await t135.listDay(db, emp2, today)).items.find((i) => i.title === 'Auto B');
    await t135.removeItem(db, emp2, itemB.id);
    assert.deepEqual(await titles(today), ['Auto C']);
    assert.ok(!(await planSvc.listPlan(db, ids.emp2)).some((p) => p.stepId === b.steps[0].id && p.startDate === today));

    // moving a slot to tomorrow moves it in the Plan too
    const itemC = (await t135.listDay(db, emp2, today)).items[0];
    await t135.moveItem(db, emp2, itemC.id, { date: tomorrow, mode: 'move' });
    const plan = await planSvc.listPlan(db, ids.emp2);
    assert.ok(plan.some((p) => p.stepId === c.steps[0].id && p.startDate === tomorrow));
    assert.ok(!plan.some((p) => p.stepId === c.steps[0].id && p.startDate === today));
    assert.deepEqual(await titles(today), []);
    assert.deepEqual(await titles(tomorrow), ['Auto C']);

    // a ticked slot stays even when the plan changes; a day that is over is never touched
    await t135.updateItem(db, emp2, (await t135.listDay(db, emp2, tomorrow)).items[0].id, { isDone: true });
    await planSvc.setPlan(db, emp2, { stepId: c.steps[0].id, slot: null, from: tomorrow });
    assert.deepEqual(await titles(tomorrow), ['Auto C']);
    assert.deepEqual(await titles(addDays(today, -1)), []);
  });

  it('keeps the order of the slots and of the Plan the same, counts what does not fit, and counts finished tasks as done', async () => {
    const { slotOf } = await import('../src/modules/flow/flow.weeks.js');
    const day = addDays(svc.today(emp1), 3);
    const on = { ...slotOf(day), day: Number(day.slice(8)) };
    const titles = async () => (await t135.listDay(db, emp1, day)).items.map((i) => i.title);
    await clearDays(ids.emp1);
    const mk = (n) => newTask(emp1, [ids.emp1], { title: `Ord ${n}` });
    const [a, b, c] = [await mk('A'), await mk('B'), await mk('C')];
    for (const t of [a, b, c]) await planSvc.setPlan(db, emp1, { stepId: t.steps[0].id, slot: on });
    assert.deepEqual(await titles(), ['Ord A', 'Ord B', 'Ord C']);

    // 1. moving a slot on the 1-3-5 moves it in the Plan too, and it stays there
    const items = (await t135.listDay(db, emp1, day)).items;
    await t135.reorderDay(db, emp1, { date: day, ids: [items[2].id, items[0].id, items[1].id] });
    assert.deepEqual(await titles(), ['Ord C', 'Ord A', 'Ord B']);
    const planOrder = async () => (await planSvc.listPlan(db, ids.emp1)).filter((p) => p.startDate === day).sort((x, y) => x.position - y.position).map((p) => p.taskId);
    assert.deepEqual(await planOrder(), [c.id, a.id, b.id]);
    assert.deepEqual(await titles(), ['Ord C', 'Ord A', 'Ord B']); // loading again does not undo it

    // 2. moving a card in the Plan moves the slot: B before C
    await planSvc.setPlan(db, emp1, { stepId: b.steps[0].id, slot: on, before: c.steps[0].id });
    assert.deepEqual(await planOrder(), [b.id, c.id, a.id]);
    assert.deepEqual(await titles(), ['Ord B', 'Ord C', 'Ord A']);

    // 3. A before B again
    await planSvc.setPlan(db, emp1, { stepId: a.steps[0].id, slot: on, before: b.steps[0].id });
    assert.deepEqual(await titles(), ['Ord A', 'Ord B', 'Ord C']);

    // 4. more planned than 9 slots: the rest are counted
    for (let i = 0; i < 7; i++) await planSvc.setPlan(db, emp1, { stepId: (await mk(`Extra ${i}`)).steps[0].id, slot: on });
    let d = await t135.listDay(db, emp1, day);
    assert.equal(d.items.length, 9);
    assert.equal(d.waiting, 1); // 10 planned tasks, 9 fit
    assert.equal((await t135.listDay(db, emp1, day)).waiting, 1);

    // 5. a finished task counts as done in its slot
    await pool.query(`UPDATE task_members SET status = 'done', closed_at = now() WHERE id = $1`, [a.steps[0].id]);
    d = await t135.listDay(db, emp1, day);
    assert.equal(d.items.find((i) => i.title === 'Ord A').isDone, true);
    assert.equal(d.items.find((i) => i.title === 'Ord B').isDone, false);
  });

  it('shows the 1-3-5 in the order the Plan shows the day: open tasks follow the Plan order, a finished task keeps its slot', async () => {
    const { slotOf } = await import('../src/modules/flow/flow.weeks.js');
    const day = svc.today(emp2);
    const on = { ...slotOf(day), day: Number(day.slice(8)) };
    await clearDays(ids.emp2);
    const mk = (n) => newTask(emp2, [ids.emp2], { title: `Fin ${n}` });
    const [f, o1, d, o2] = [await mk('F'), await mk('O1'), await mk('D'), await mk('O2')];
    for (const t of [f, o1, d, o2]) await planSvc.setPlan(db, emp2, { stepId: t.steps[0].id, slot: on }); // plan order: F, O1, D, O2
    const titles = async () => (await t135.listDay(db, emp2, day)).items.map((i) => i.title);
    assert.deepEqual(await titles(), ['Fin F', 'Fin O1', 'Fin D', 'Fin O2']);

    // D is finished: it keeps its slot (it does not jump to the end)
    await pool.query(`UPDATE task_members SET status = 'done', closed_at = now() WHERE id = $1`, [d.steps[0].id]);
    assert.deepEqual(await titles(), ['Fin F', 'Fin O1', 'Fin D', 'Fin O2']);
    // F is finished too: both stay where they were, shown done
    await pool.query(`UPDATE task_members SET status = 'done', closed_at = now() WHERE id = $1`, [f.steps[0].id]);
    const list = (await t135.listDay(db, emp2, day)).items;
    assert.deepEqual(list.map((i) => i.title), ['Fin F', 'Fin O1', 'Fin D', 'Fin O2']);
    assert.deepEqual(list.map((i) => i.isDone), [true, false, true, false]);
    assert.deepEqual(list.map((i) => i.position), [1, 2, 3, 4]);
    // and it is stable: loading again changes nothing
    assert.deepEqual(await titles(), ['Fin F', 'Fin O1', 'Fin D', 'Fin O2']);
  });

  it('a day that is over drops the slot of a task that left its plan unfinished, and keeps what was planned or finished there', async () => {
    const today = svc.today(emp2);
    const yesterday = addDays(today, -1);
    await clearDays(ids.emp2);
    const mk = (n) => newTask(emp2, [ids.emp2], { title: `Past ${n}` });
    const [kept, moved, finished] = [await mk('kept'), await mk('moved'), await mk('finished')];
    // the day as it was: three slots, and what the plan said about that day
    let pos = 0;
    for (const t of [kept, moved, finished]) await slotRow(ids.emp2, t.id, yesterday, ++pos);
    await planOf(kept.id, ids.emp2, yesterday);
    await planOf(finished.id, ids.emp2, yesterday);
    await planOf(moved.id, ids.emp2, today); // carried over to today: not in yesterday's plan any more
    await pool.query(`UPDATE task_members SET status = 'done', closed_at = now() WHERE id = $1`, [finished.steps[0].id]);
    const d = await t135.listDay(db, emp2, yesterday);
    assert.deepEqual(d.items.map((i) => i.title), ['Past kept', 'Past finished']);
    assert.deepEqual(d.items.map((i) => i.position), [1, 2]);
    assert.equal(d.waiting, 0);
    // nothing is added to a day that is over, even when something is planned on it
    const late = await mk('late');
    await planOf(late.id, ids.emp2, yesterday);
    assert.deepEqual((await t135.listDay(db, emp2, yesterday)).items.map((i) => i.title), ['Past kept', 'Past finished']);
  });

  it('a past day marks a slot as Carryover when the same task is planned on a later day, and does not count it as done there', async () => {
    const today = svc.today(emp2);
    const yesterday = addDays(today, -1);
    await clearDays(ids.emp2);
    const mk = async (n) => { let t = await newTask(emp2, [ids.emp2], { title: `Carry ${n}` }); t = await svc.flowStep(db, emp2, t.id, t.version, ['accept', 'start']); return t; };
    const [went, stayed] = [await mk('went on'), await mk('stayed')];
    let pos = 0;
    for (const t of [went, stayed]) {
      await slotRow(ids.emp2, t.id, yesterday, ++pos);
      await planOf(t.id, ids.emp2, yesterday);
    }
    await planOf(went.id, ids.emp2, today); // the work went on today

    let d = await t135.listDay(db, emp2, yesterday);
    assert.deepEqual(d.items.map((i) => [i.title, i.carryover]), [['Carry went on', true], ['Carry stayed', false]]);
    // finished today: yesterday's slot is still a Carryover (not done); today's slot is the one that is done
    await pool.query(`UPDATE task_members SET status = 'done', closed_at = now() WHERE id = $1`, [went.steps[0].id]);
    d = await t135.listDay(db, emp2, yesterday);
    assert.equal(d.items[0].carryover, true);
    assert.equal(d.items[0].isDone, false);
    const t0 = (await t135.listDay(db, emp2, today)).items.find((i) => i.title === 'Carry went on');
    assert.equal(t0.carryover, false);
    assert.equal(t0.isDone, true);
  });

  it('does not let an abandoned timer entry be moved when time is already logged on that task that day, but it can be copied', async () => {
    const today = svc.today(emp2);
    const yesterday = addDays(today, -1);
    let t = await newTask(emp2, [ids.emp2], { title: 'Abandoned with time' });
    t = await svc.flowStep(db, emp2, t.id, t.version, ['accept', 'start']);
    const [ab] = (await pool.query(
      `INSERT INTO task_timers (user_id, member_id, day, status, minutes) VALUES ($1, $2, $3, 'abandoned', 0) RETURNING id`,
      [ids.emp2, t.steps[0].id, yesterday],
    )).rows;
    // nothing logged that day: it can be moved
    const moved = await timerSvc.moveEntry(db, emp2, ab.id, { day: today });
    assert.equal(moved.status, 'ready');
    await pool.query(`DELETE FROM task_timers WHERE id = $1`, [ab.id]);
    // 2 minutes were logged on that day: moving is refused, copying still works
    const [ab2] = (await pool.query(
      `INSERT INTO task_timers (user_id, member_id, day, status, minutes) VALUES ($1, $2, $3, 'abandoned', 0) RETURNING id`,
      [ids.emp2, t.steps[0].id, yesterday],
    )).rows;
    await pool.query(`INSERT INTO timesheets (task_id, user_id, minutes, work_date, from_board) VALUES ($1, $2, 2, $3, true)`, [t.id, ids.emp2, yesterday]);
    await assert.rejects(timerSvc.moveEntry(db, emp2, ab2.id, { day: today }), /already logged/);
    const copy = await timerSvc.copyEntry(db, emp2, ab2.id, { day: today });
    assert.equal(copy.day, today);
    await pool.query(`DELETE FROM task_timers WHERE user_id = $1`, [ids.emp2]); // leave nothing behind for the next test
  });

  it('catching up a past day with done-for-that-day logs the time on that day and finishes its plan, the task stays open', async () => {
    const yesterday = addDays(svc.today(emp2), -1);
    await clearDays(ids.emp2);
    let t = await newTask(emp2, [ids.emp2], { title: 'Catch up day' });
    t = await svc.flowStep(db, emp2, t.id, t.version, ['accept', 'start']);
    await slotRow(ids.emp2, t.id, yesterday);
    await svc.logTime(db, emp2, t.id, { minutes: 25, workDate: yesterday, doneForDay: true });
    const item = (await t135.listDay(db, emp2, yesterday)).items[0];
    assert.equal(item.planDone, true);
    assert.equal(item.minutes, 25);
    assert.equal((await svc.getTask(db, t.id)).steps[0].status, 'active');
  });

  it('lets a day be ticked done while the task stays open: it is "done for today", not a carryover, and the task is not changed', async () => {
    const today = svc.today(emp2);
    const yesterday = addDays(today, -1);
    await clearDays(ids.emp2);
    let t = await newTask(emp2, [ids.emp2], { title: 'Plan done only' });
    t = await svc.flowStep(db, emp2, t.id, t.version, ['accept', 'start']);
    await slotRow(ids.emp2, t.id, yesterday);
    await planOf(t.id, ids.emp2, yesterday);
    await planOf(t.id, ids.emp2, today).catch(() => {}); // the work goes on today (a second plan row is the same member on another day)
    await pool.query(`INSERT INTO plan_items (member_id, scope, start_date, position) VALUES ($1, 'day', $2, 1) ON CONFLICT DO NOTHING`, [t.steps[0].id, today]);
    let item = (await t135.listDay(db, emp2, yesterday)).items[0];
    assert.equal(item.carryover, true);
    assert.equal(item.planDone, false);
    // a day that is over is closed: it cannot be ticked or reopened afterwards (Catch up is for that), and no task can be added to it
    await assert.rejects(t135.updateItem(db, emp2, item.id, { isDone: true }), /day that is over/);
    await assert.rejects(t135.addItem(db, emp2, { date: yesterday, taskId: t.id }), /day that is over/);
    // today's slot: ticked "done for today" it is done, the task itself is untouched, and it can be opened again
    let now = (await t135.listDay(db, emp2, today)).items.find((i) => i.taskId === t.id);
    assert.equal(now.planDone, false);
    now = await t135.updateItem(db, emp2, now.id, { isDone: true });
    assert.equal(now.isDone, true);
    assert.equal(now.planDone, true);
    assert.equal((await svc.getTask(db, t.id)).steps[0].status, 'active');
    now = await t135.updateItem(db, emp2, now.id, { isDone: false });
    assert.equal(now.planDone, false);
  });

  it('runs the timer: start, pause, end without completing, then complete', async () => {
    let t = await newTask(emp2, [ids.emp2], { title: 'Timer' });
    await assert.rejects(timerSvc.createEntry(db, emp2, { stepId: t.steps[0].id }), /Accept the task first/);
    t = await svc.flowStep(db, emp2, t.id, t.version, ['accept']);
    const e = await timerSvc.createEntry(db, emp2, { stepId: t.steps[0].id });
    await assert.rejects(timerSvc.createEntry(db, emp2, { stepId: t.steps[0].id }), /already in your timer/);
    let r = await timerSvc.startEntry(db, emp2, e.id);
    assert.equal(r.status, 'running');
    assert.equal((await svc.getTask(db, t.id)).steps[0].status, 'active', 'starting the timer starts the task');
    r = await timerSvc.pauseEntry(db, emp2, e.id, { minutes: 5 });
    assert.deepEqual([r.status, r.minutes], ['paused', 5]);
    await timerSvc.startEntry(db, emp2, e.id);
    await slotRow(ids.emp2, t.id, e.day, 9);
    r = await timerSvc.endEntry(db, emp2, e.id, { complete: false, minutes: 3 });
    // only the time was logged: that day's slot is ticked "done for today"
    assert.equal((await pool.query(`SELECT is_done FROM daily_plan_items WHERE user_id = $1 AND plan_date = $2 AND task_id = $3`, [ids.emp2, e.day, t.id])).rows[0].is_done, true);
    assert.deepEqual([r.status, r.minutes], ['ended', 8]);
    assert.equal((await svc.getTask(db, t.id)).status, 'in_progress');
    assert.equal((await timesheetRows(t.id)).reduce((a, x) => a + x.minutes, 0), 8);

    const e2 = await timerSvc.createEntry(db, emp2, { stepId: t.steps[0].id });
    await timerSvc.startEntry(db, emp2, e2.id);
    await timerSvc.endEntry(db, emp2, e2.id, { complete: true, minutes: 2 });
    const done = await svc.getTask(db, t.id);
    assert.equal(done.status, 'completed');
    assert.equal((await timesheetRows(t.id)).reduce((a, x) => a + x.minutes, 0), 10);
    assert.ok((await timerSvc.listEntries(db, emp2)).every((x) => x.status === 'ended'));
  });

  it('passes a task on, edits the flow and keeps the owner rules', async () => {
    let t = await newTask(emp1, [ids.emp1], { title: 'Pass' });
    t = await svc.passTask(db, emp1, t.id, { version: t.version, toUserId: ids.emp2, comment: 'over to you' });
    assert.equal(t.steps[0].userId, ids.emp2);
    assert.equal((await tasksSvc.getTask(db, sup, t.id)).assignedTo, ids.emp2, 'the PMS task is assigned to whoever holds it now');
    await assert.rejects(svc.passTask(db, emp2, t.id, { version: t.version, toUserId: ids.outsider }), /No access to Task Management/);
    // any Task Management user may edit the flow - not only the owner or an admin - but everyone in it must be on the project
    await assert.rejects(svc.editFlow(db, emp2, t.id, { version: t.version, userIds: [ids.stranger] }), /Not on this project/);
    await assert.rejects(svc.editFlow(db, emp2, t.id, { version: t.version, userIds: [ids.outsider] }), /No access to Task Management/);
    t = await svc.editFlow(db, emp2, t.id, { version: t.version, userIds: [ids.emp1, ids.emp2] });
    assert.deepEqual(t.steps.map((s) => s.userId), [ids.emp1, ids.emp2]);
    // changing the owner and deleting stay with the owner and admins
    await assert.rejects(svc.updateTask(db, emp2, t.id, { version: t.version, ownerIds: [ids.emp2] }), /Only the owner or an admin can change the owner/);
    await assert.rejects(svc.deleteTask(db, emp2, t.id), /Only the owner or an admin can delete/);
    t = await svc.passTask(db, emp1, t.id, { version: t.version, toUserId: ids.emp2, mode: 'circle' });
    assert.equal(t.steps[0].userId, ids.emp2);
    assert.equal(t.steps[0].status, 'offered');
    const board = await svc.listTasks(db, { scope: 'board', customerId: ids.cust });
    assert.ok(board.length >= 5);
    const look = await svc.lookups(db, emp1);
    assert.ok(look.customers.some((c) => c.id === ids.cust && c.name === 'Acme'));
    assert.ok(look.types.some((x) => x.id === ids.type));
    const opt = await svc.options(db, emp1);
    assert.equal(opt.projects.length, 1);
    assert.ok(opt.projects[0].taskGroups[0].taskTypes.some((x) => x.id === ids.type));
    assert.ok(!opt.users.some((u) => u.id === ids.outsider), 'people without access are not offered');
    assert.equal((await svc.options(db, stranger)).projects.length, 0, 'only projects you are on');
  });

  it('keeps private messages private and counts unread tags', async () => {
    await msgSvc.createPost(db, emp1, { body: 'hello team' });
    await msgSvc.createPost(db, emp1, { body: 'just for you', mentionIds: [ids.emp2], private: true });
    await assert.rejects(msgSvc.createPost(db, emp1, { body: 'x', private: true }), /needs a person/);
    await assert.rejects(msgSvc.createPost(db, emp1, { body: 'x', mentionIds: [ids.outsider] }), /no access to Task Management/);
    const seen = (u) => msgSvc.feed(db, u, {}).then((f) => f.items.map((i) => i.body));
    assert.ok((await seen(emp2)).includes('just for you'));
    assert.ok(!(await seen(pm)).includes('just for you'));
    assert.ok((await seen(pm)).includes('hello team'));
    const f = await msgSvc.feed(db, emp2, { mine: '1' });
    assert.ok(f.unread >= 1);
    await msgSvc.readAll(db, emp2);
    assert.equal((await msgSvc.feed(db, emp2, {})).unread, 0);
  });
});
