import { FLOW_ROLES, isFlowAdmin } from '../../config/flow.js';
import { AppError, badRequest, forbidden, notFound } from '../../utils/errors.js';
import { WhereBuilder } from '../../utils/query.js';
import { todayIn } from '../../utils/time.js';
import { addTime } from './flow.time.js';
import { writeAudit } from '../../utils/audit.js';
import { canEditFlow, currentStep, ownersOf, repeatedSteps, statusOf, transition } from './flow.rules.js';

/*
 * Task Management on the one task table. A task belongs to a project, a task group (through its type) and has an owner. The people who
 * work on it, in order, are its members (task_members): each accepts, starts and closes their step and the task is offered to the
 * next person. The members are the source of truth; tasks.status is derived from them after every change.
 */

const err = (status, message) => new AppError(status, status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'CONFLICT', message);

/** The company's day: due dates are saved as 18:00 of the day in this zone. */
const ZONE = 'Asia/Dubai';
const dueAt = (date) => (date ? new Date(`${date}T14:00:00Z`).toISOString() : null); // 18:00 in Dubai

// --- reading ---------------------------------------------------------------------------------------------------

const SELECT = `
  SELECT t.id, t.project_id, p.code AS project_code, p.title AS project_title, p.customer_id, cu.name AS customer_name,
         t.task_group_id, g.name AS task_group_name, t.task_type_id, tt.name AS task_type_name,
         to_char(COALESCE(t.planned_end, t.created_at) AT TIME ZONE '${ZONE}', 'YYYY-MM') AS month,
         t.name AS title, COALESCE(t.description, '') AS description, t.notes, t.owner_id,
         (t.planned_end AT TIME ZONE '${ZONE}')::date AS due_date, t.media, t.display_order AS priority_rank, t.version, t.status,
         t.created_at, CASE WHEN t.status = 'completed' THEN t.actual_end END AS completed_at
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN customers cu ON cu.id = p.customer_id
    LEFT JOIN task_groups g ON g.id = t.task_group_id
    LEFT JOIN task_types tt ON tt.id = t.task_type_id`;

const stepDto = (s) => ({
  id: s.id,
  userId: s.user_id,
  position: s.position,
  status: s.status,
  acceptedAt: s.accepted_at,
  startedAt: s.started_at,
  closedAt: s.closed_at,
  minutes: s.minutes,
});

const logDto = (l) => ({ id: l.id, stepId: l.member_id, userId: l.user_id, minutes: l.minutes, note: l.comment ?? '', workDate: l.work_date, createdAt: l.created_at });

const toDto = (r, steps, logs) => ({
  id: r.id,
  projectId: r.project_id,
  projectCode: r.project_code,
  projectTitle: r.project_title,
  customerId: r.customer_id,
  customerName: r.customer_name,
  taskGroupId: r.task_group_id,
  taskGroupName: r.task_group_name,
  taskTypeId: r.task_type_id,
  taskTypeName: r.task_type_name,
  month: r.month,
  title: r.title,
  description: r.description,
  notes: r.notes,
  ownerId: r.owner_id,
  ownerIds: ownersOf(r),
  dueDate: r.due_date,
  media: r.media,
  priorityRank: r.priority_rank,
  version: r.version,
  status: r.status,
  createdAt: r.created_at,
  completedAt: r.completed_at,
  steps: steps.filter((s) => s.task_id === r.id).map(stepDto),
  timeLogs: logs.filter((l) => l.task_id === r.id).map(logDto),
});

/** Tasks (with their members and time logs) for a WHERE built with WhereBuilder. */
async function loadTasks(db, where = new WhereBuilder()) {
  const { rows } = await db.query(`${SELECT} ${where.toSql()} ORDER BY t.display_order, t.id`, where.params);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [steps, logs] = await Promise.all([
    // the time a member logged is the time that person logged on the task
    db.query(
      `SELECT m.*, (SELECT NULLIF(sum(l.minutes), 0)::int FROM timesheets l WHERE l.task_id = m.task_id AND l.user_id = m.user_id AND l.from_board) AS minutes
         FROM task_members m WHERE m.task_id = ANY($1) ORDER BY m.position`,
      [ids],
    ),
    db.query(
      `SELECT l.*, (SELECT m.id FROM task_members m WHERE m.task_id = l.task_id AND m.user_id = l.user_id ORDER BY m.position LIMIT 1) AS member_id
         FROM timesheets l WHERE l.from_board AND l.task_id = ANY($1) ORDER BY l.created_at, l.id`,
      [ids],
    ),
  ]);
  return rows.map((r) => toDto(r, steps.rows, logs.rows));
}

async function loadOne(db, id) {
  const w = new WhereBuilder().add('t.id = $?', id);
  const [task] = await loadTasks(db, w);
  if (!task) throw notFound('Task');
  return task;
}

export const getTask = loadOne;

export async function listTasks(db, q) {
  // the board shows the tasks of projects; a personal task or an activity is not on it
  const w = new WhereBuilder().add('t.is_active').add('t.project_id IS NOT NULL');
  if (q.owner) w.add('t.owner_id = $?', q.owner);
  if (q.customerId) w.add('p.customer_id = $?', q.customerId);
  if (q.projectId) w.add('t.project_id = $?', q.projectId);
  if (q.taskGroupId) w.add('t.task_group_id = $?', q.taskGroupId);
  if (q.taskTypeId) w.add('t.task_type_id = $?', q.taskTypeId);
  // the board only shows a completed task for 7 days
  if (q.scope === 'board') w.add(`(t.status <> 'completed' OR t.actual_end IS NULL OR t.actual_end > now() - interval '7 days')`);
  return loadTasks(db, w);
}

/** What the audit log writes for each thing the board does (the original word goes in front of the detail). */
const AUDIT_ACTION = { created: 'create', accept: 'status_change', start: 'status_change', close: 'status_change' };
const FLOW_ACTIONS = new Set(['created', 'edited', 'accept', 'start', 'close', 'logged time', 'passed', 'circled back', 'flow edited', 'comment']);

export async function listActivity(db, id) {
  const { rows } = await db.query(
    `SELECT id, user_id, action, message, logged_at FROM audit_logs WHERE entity = 'tasks' AND entity_id = $1 ORDER BY logged_at DESC, id DESC`,
    [id],
  );
  return rows.map((r) => {
    const cut = (r.message ?? '').indexOf(': ');
    const head = cut >= 0 ? r.message.slice(0, cut) : r.message ?? '';
    const flow = FLOW_ACTIONS.has(head) || FLOW_ACTIONS.has(r.message);
    return {
      id: r.id,
      userId: r.user_id,
      action: flow ? (cut >= 0 ? head : r.message) : r.action,
      detail: flow ? (cut >= 0 ? r.message.slice(cut + 2) : '') : r.message ?? '',
      createdAt: r.logged_at,
    };
  });
}

// --- options for the create dialog ---------------------------------------------------------------------------------

/**
 * Everything the New task dialog needs: the projects the user may create tasks in (their own and the ones they are a member
 * of; all of them for an admin) with their task groups and types, and the people who can be in a flow.
 */
export async function options(db, auth) {
  const all = isFlowAdmin(auth);
  const { rows: projects } = await db.query(
    `SELECT p.id, p.code, p.title, p.customer_id, cu.name AS customer_name, p.owner_id,
            ARRAY(SELECT pm.user_id FROM project_members pm WHERE pm.project_id = p.id)::bigint[] AS member_ids
       FROM projects p LEFT JOIN customers cu ON cu.id = p.customer_id
      WHERE p.status <> 'cancelled'
        AND ($2::boolean OR p.owner_id = $1 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1))
      ORDER BY p.title`,
    [auth.userId, all],
  );
  const ids = projects.map((p) => p.id);
  const [groups, types, users] = await Promise.all([
    ids.length
      ? db.query(
          `SELECT e.project_id, g.id, g.name FROM project_effort_estimates e JOIN task_groups g ON g.id = e.task_group_id
            WHERE e.project_id = ANY($1) AND e.effort_percentage > 0 ORDER BY g.name`,
          [ids],
        )
      : { rows: [] },
    db.query(`SELECT id, name, task_group_id FROM task_types WHERE is_active ORDER BY name`),
    db.query(
      `SELECT u.id, u.name, u.employee_code FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.is_active AND r.is_active AND (r.level = 0 OR r.code = ANY($1)) ORDER BY u.name`,
      [FLOW_ROLES],
    ),
  ]);
  return {
    projects: projects.map((p) => ({
      id: p.id,
      code: p.code,
      title: p.title,
      customerId: p.customer_id,
      customerName: p.customer_name,
      ownerId: p.owner_id,
      memberIds: p.member_ids.map(Number), // bigint[] comes back as strings
      taskGroups: groups.rows
        .filter((g) => g.project_id === p.id)
        .map((g) => ({ id: g.id, name: g.name, taskTypes: types.rows.filter((t) => t.task_group_id === g.id).map((t) => ({ id: t.id, name: t.name })) })),
    })),
    users: users.rows.map((u) => ({ id: u.id, name: u.name, empCode: u.employee_code })),
  };
}

/**
 * Names for the filters and labels of the Board / Tracker: the customers and task types that tasks use, plus the
 * customers of the projects the user may create tasks in (so a task created a moment ago is labelled too).
 */
export async function lookups(db, auth) {
  const all = isFlowAdmin(auth);
  const [customers, types] = await Promise.all([
    db.query(
      `SELECT c.id, c.name FROM customers c
        WHERE c.id IN (SELECT p.customer_id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.customer_id IS NOT NULL)
           OR c.id IN (SELECT p.customer_id FROM projects p WHERE p.customer_id IS NOT NULL AND p.status <> 'cancelled'
                         AND ($2::boolean OR p.owner_id = $1 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1)))
        ORDER BY c.name`,
      [auth.userId, all],
    ),
    db.query(`SELECT t.id, t.name FROM task_types t WHERE t.id IN (SELECT task_type_id FROM tasks WHERE task_type_id IS NOT NULL) OR t.is_active ORDER BY t.name`),
  ]);
  return { customers: customers.rows, types: types.rows };
}

// --- helpers for changes -----------------------------------------------------------------------------------------

/** Writes what happened to the task in the audit log (action = the board's word for it). */
export const log = (c, taskId, userId, action, detail = '') =>
  writeAudit(c, { entity: 'tasks', entityId: taskId, action: AUDIT_ACTION[action] ?? 'update', userId, message: detail ? `${action}: ${detail}` : action });

/** A handover / close comment goes on the task's history and, when someone receives the task, in their inbox. */
async function addComment(c, taskId, from, to, kind, body) {
  if (!body) return;
  await log(c, taskId, from, 'comment', body);
  const { rows } = await c.query(`INSERT INTO task_messages (task_id, author_id, kind, body) VALUES ($1, $2, $3, $4) RETURNING id`, [taskId, from, kind, body]);
  if (to !== null && to !== undefined) await c.query(`INSERT INTO task_message_recipients (message_id, user_id) VALUES ($1, $2)`, [rows[0].id, to]);
}

/**
 * Recomputes the task status (and when it started / was completed) from its members. Call after any change to the members.
 * A task nobody works on keeps the status it has; a task on hold stays on hold until someone starts it.
 */
export async function syncStatus(c, id, auth) {
  const { rows: steps } = await c.query(`SELECT status FROM task_members WHERE task_id = $1 ORDER BY position`, [id]);
  if (!steps.length) return;
  const { rows: before } = await c.query(`SELECT status FROM tasks WHERE id = $1`, [id]);
  let status = statusOf(steps);
  if (before[0]?.status === 'hold' && status === 'to_do') status = 'hold';
  await c.query(
    `UPDATE tasks SET status = $2::varchar,
            actual_start = CASE WHEN $2::varchar IN ('in_progress', 'completed') THEN COALESCE(actual_start, now()) ELSE actual_start END,
            actual_end = CASE WHEN $2::varchar = 'completed' THEN COALESCE(actual_end, now()) END,
            completed_on = CASE WHEN $2::varchar = 'completed' THEN COALESCE(completed_on, $3::date) END,
            completed_by = CASE WHEN $2::varchar = 'completed' THEN COALESCE(completed_by, $4::bigint) END
      WHERE id = $1`,
    [id, status, todayIn(auth?.timeZone ?? ZONE), auth?.userId ?? null],
  );
}

/**
 * Everyone in a flow (or an owner) must be a real, active person with access to Task Management, and on the project
 * (owner or member) - the same rule the PMS Timesheet applies, so their time can be logged against it.
 */
export async function assertPeople(c, projectId, userIds, what = 'The flow') {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  const { rows } = await c.query(
    `SELECT u.id, u.name, u.is_active, r.is_active AS role_active, (r.level = 0 OR r.code = ANY($3)) AS flow_ok,
            (r.level = 0 OR p.owner_id = u.id OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = u.id)) AS on_project
       FROM users u JOIN roles r ON r.id = u.role_id CROSS JOIN projects p
      WHERE u.id = ANY($1) AND p.id = $2`,
    [ids, projectId, FLOW_ROLES],
  );
  if (rows.length !== ids.length) throw badRequest(`${what} contains an unknown person`);
  const bad = (pred) => rows.filter(pred).map((u) => u.name).join(', ');
  const inactive = bad((u) => !u.is_active || !u.role_active);
  if (inactive) throw badRequest(`${what} contains an inactive person: ${inactive}`);
  const noAccess = bad((u) => !u.flow_ok);
  if (noAccess) throw badRequest(`No access to Task Management: ${noAccess}`);
  const off = bad((u) => !u.on_project);
  if (off) throw badRequest(`Not on this project (add them to the project first): ${off}`);
}

/** Runs a change under the task's version number; if someone else changed it since the caller loaded it, nothing is written. */
async function mutate(db, auth, id, version, fn, patch = {}) {
  await db.tx(async (c) => {
    const cols = Object.keys(patch);
    const sets = [...cols.map((k, i) => `${k} = $${i + 3}`), 'version = version + 1', `updated_by = $${cols.length + 3}`];
    const { rows } = await c.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1 AND version = $2 RETURNING *`, [
      id,
      version,
      ...cols.map((k) => patch[k]),
      auth.userId,
    ]);
    if (!rows[0]) {
      const { rows: exists } = await c.query(`SELECT 1 FROM tasks WHERE id = $1`, [id]);
      throw exists[0] ? err(409, 'Someone just changed this. The board has been refreshed.') : notFound('Task');
    }
    const { rows: steps } = await c.query(`SELECT * FROM task_members WHERE task_id = $1 ORDER BY position`, [id]);
    await fn(c, rows[0], steps);
    await syncStatus(c, id, auth);
  });
  return loadOne(db, id);
}

// --- create / edit -----------------------------------------------------------------------------------------------

/** Project, task group (a share of the project estimate) and task type must fit together. */
async function assertClassification(c, { projectId, taskGroupId, taskTypeId }) {
  const { rows } = await c.query(
    `SELECT p.status, tt.task_group_id, g.name AS group_name,
            (SELECT e.effort_percentage FROM project_effort_estimates e WHERE e.project_id = p.id AND e.task_group_id = $2) AS effort
       FROM projects p, task_types tt JOIN task_groups g ON g.id = tt.task_group_id
      WHERE p.id = $1 AND tt.id = $3`,
    [projectId, taskGroupId, taskTypeId],
  );
  const r = rows[0];
  if (!r) throw badRequest('Project or task type does not exist');
  if (r.status === 'cancelled') throw badRequest('This project is cancelled', [{ field: 'projectId', message: 'is cancelled' }]);
  if (r.task_group_id !== taskGroupId) throw badRequest('The task type is not in the selected task group', [{ field: 'taskTypeId', message: 'not in the task group' }]);
  if (!(Number(r.effort) > 0)) throw badRequest(`"${r.group_name}" is not in this project's estimate - pick a task group of the project`, [{ field: 'taskGroupId', message: 'not in the project estimate' }]);
}

export async function createTask(db, auth, input) {
  const id = await db.tx(async (c) => {
    await assertClassification(c, input);
    const { rows: mine } = await c.query(
      `SELECT p.owner_id, (p.owner_id = $2 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2)) AS on_project
         FROM projects p WHERE p.id = $1`,
      [input.projectId, auth.userId],
    );
    if (!mine[0] || !(mine[0].on_project || isFlowAdmin(auth))) throw forbidden('You are not on this project');

    // The task has one owner. An admin may pick anyone; everybody else owns what they create. An admin who is not on the
    // project (they can create tasks anywhere) gets the project's owner by default, as the owner must be on the project.
    const asked = input.ownerIds ?? [];
    const self = mine[0].on_project ? auth.userId : mine[0].owner_id;
    const owner = isFlowAdmin(auth) ? (asked[0] ?? self) : auth.userId;
    const flow = input.flow ?? [];
    await assertPeople(c, input.projectId, [...flow, owner]);

    const { rows: top } = await c.query(`SELECT COALESCE(max(display_order), 0) AS top FROM tasks`);
    const { rows } = await c.query(
      `INSERT INTO tasks (project_id, task_category_id, task_group_id, task_type_id, name, description, notes, media, owner_id,
                          planned_end, display_order, created_by, updated_by)
       VALUES ($1, (SELECT c.id FROM task_categories c WHERE c.is_project ORDER BY c.is_active DESC, c.display_order, c.id LIMIT 1),
               $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING id`,
      [input.projectId, input.taskGroupId, input.taskTypeId, input.title.trim(), input.description ?? '', input.notes ?? '', input.media ?? '', owner,
        dueAt(input.dueDate), Number(top[0].top) + 10, auth.userId],
    );
    const taskId = rows[0].id;
    for (const [i, userId] of flow.entries()) {
      await c.query(`INSERT INTO task_members (task_id, user_id, position, status) VALUES ($1, $2, $3, $4)`, [taskId, userId, i + 1, i === 0 ? 'offered' : 'waiting']);
    }
    await syncStatus(c, taskId, auth);
    await log(c, taskId, auth.userId, 'created');
    return taskId;
  });
  return loadOne(db, id);
}

const FIELD_COLUMN = { title: 'name', description: 'description', notes: 'notes', media: 'media', taskTypeId: 'task_type_id' };

export async function updateTask(db, auth, id, body) {
  const { version, ownerIds, ...fields } = body;
  const patch = {};
  for (const [k, col] of Object.entries(FIELD_COLUMN)) if (fields[k] !== undefined) patch[col] = k === 'title' ? fields[k].trim() : fields[k];
  if (fields.dueDate !== undefined) patch.planned_end = dueAt(fields.dueDate);
  const owner = ownerIds?.[0];
  if (owner) patch.owner_id = owner;
  // Who may do what is decided on the owner as it is NOW - mutate() applies the patch first, so the row it hands
  // back already has the new owner (a participant must not be able to make themselves owner and then pass the check).
  const { rows: before } = await db.query(`SELECT owner_id FROM tasks WHERE id = $1`, [id]);
  if (!before[0]) throw notFound('Task');
  const isOwner = isFlowAdmin(auth) || canEditFlow(false, auth.userId, before[0]);
  return mutate(db, auth, id, version, async (c, task, steps) => {
    if (!(isOwner || steps.some((s) => s.user_id === auth.userId))) throw forbidden('You are not part of this task');
    if (owner && !isOwner) throw forbidden('Only the owner or an admin can change the owner');
    if (owner) await assertPeople(c, task.project_id, [owner], 'The owner');
    if (fields.taskTypeId !== undefined) await assertClassification(c, { projectId: task.project_id, taskGroupId: task.task_group_id, taskTypeId: fields.taskTypeId });
    await log(c, id, auth.userId, 'edited', Object.keys(fields).concat(owner ? ['owner'] : []).join(', '));
  }, patch);
}

export async function deleteTask(db, auth, id) {
  const { rows } = await db.query(`SELECT owner_id, (SELECT count(*)::int FROM timesheets WHERE task_id = $1) AS entries FROM tasks WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound('Task');
  if (!canEditFlow(isFlowAdmin(auth), auth.userId, rows[0])) throw forbidden('Only the owner or an admin can delete a task');
  if (rows[0].entries) throw badRequest(`Time is logged on this task (${rows[0].entries} entr${rows[0].entries === 1 ? 'y' : 'ies'}) - it cannot be deleted`);
  await db.query(`DELETE FROM tasks WHERE id = $1`, [id]); // its members, plan, timers, messages and slots go with it
}

// --- flow actions ------------------------------------------------------------------------------------------------

/**
 * Accept, start or close the step a person holds, in one go (a chain), adding the closing time. Shared by the flow routes
 * and the timer.
 */
export async function flowStep(db, auth, id, version, chain, { minutes, note, workDate } = {}) {
  return mutate(db, auth, id, version, async (c, task, steps) => {
    const now = new Date();
    const live = steps.map((s) => ({ ...s }));
    const mine = currentStep(live);
    let nextId;
    for (const a of chain) {
      const result = transition(live, a, auth.userId);
      if (!result.ok) throw err(result.status, result.error);
      for (const u of result.updates) {
        if (u.stamp) await c.query(`UPDATE task_members SET status = $2, ${u.stamp} = $3 WHERE id = $1`, [u.id, u.status, now]);
        else await c.query(`UPDATE task_members SET status = $2 WHERE id = $1`, [u.id, u.status]);
        const s = live.find((x) => x.id === u.id);
        s.status = u.status;
        if (u.stamp) s[u.stamp] = now;
      }
      if (a === 'close') nextId = result.updates.find((u) => u.status === 'offered')?.id;
    }

    // Closing adds the last stretch of time: what the person confirmed, or the time since they last logged time (or started).
    let spent;
    if (chain.includes('close') && mine) {
      const { rows: last } = await c.query(`SELECT max(created_at) AS at FROM timesheets WHERE from_board AND task_id = $1 AND user_id = $2`, [id, mine.user_id]);
      const since = last[0].at ?? live.find((s) => s.id === mine.id)?.started_at ?? now;
      const explicit = minutes !== undefined;
      spent = explicit ? minutes : Math.max(0, Math.round((now.getTime() - new Date(since).getTime()) / 60_000));
      spent = await addTime(c, { userId: auth.userId, timeZone: auth.timeZone, task, minutes: spent, note, workDate, clamp: !explicit });
      // a timer entry still open for this step (e.g. paused yesterday) is over now that the step is closed
      await c.query(`UPDATE task_timers SET status = 'ended', run_started_at = NULL WHERE member_id = $1 AND status IN ('ready', 'running', 'paused')`, [mine.id]);
    }
    for (const a of chain) await log(c, id, auth.userId, a, a === 'close' && spent !== undefined ? `${spent} min` : '');
    if (chain.includes('close')) {
      // the note goes to whoever receives the task next, or to the owner when the last step is closed
      const next = steps.find((s) => s.id === nextId);
      await addComment(c, id, auth.userId, next ? next.user_id : task.owner_id, 'close', note);
    }
  });
}

/** Log some time part-way through a step, without closing it. */
export async function logTime(db, auth, id, { minutes, note, workDate, doneForDay = false }) {
  await db.tx(async (c) => {
    const { rows } = await c.query(`SELECT * FROM tasks WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) throw notFound('Task');
    const { rows: steps } = await c.query(`SELECT * FROM task_members WHERE task_id = $1`, [id]);
    const current = currentStep(steps);
    if (!current) throw err(409, 'This task is already complete');
    if (current.user_id !== auth.userId) throw err(403, 'Only the person holding this task can log time');
    if (current.status !== 'active') throw err(409, 'Start the task before logging time');
    await addTime(c, { userId: auth.userId, timeZone: auth.timeZone, task: rows[0], minutes, note, workDate });
    // "Done for that day": the day's plan is finished, the task itself stays open
    if (doneForDay) {
      await c.query(
        `UPDATE daily_plan_items SET is_done = true, updated_by = $1
          WHERE user_id = $1 AND plan_date = $2 AND task_id = $3 AND NOT is_done`,
        [auth.userId, workDate ?? todayIn(auth.timeZone), id],
      );
    }
  });
  return loadOne(db, id);
}

/** mode 'handover': the step moves to that person. mode 'circle': that person gets a new step in front of mine, and I come back after them. */
export async function passTask(db, auth, id, { version, toUserId, comment, mode = 'handover' }) {
  return mutate(db, auth, id, version, async (c, task, steps) => {
    const current = currentStep(steps);
    if (!current) throw err(409, 'This task is already complete');
    if (current.user_id === toUserId) throw badRequest('It is already with that person');
    await assertPeople(c, task.project_id, [toUserId], 'The person');
    if (mode === 'circle') {
      // make room at this position for the new person; this step and everything after it moves down one
      await c.query(`UPDATE task_members SET position = position + 1 WHERE task_id = $1 AND position >= $2`, [id, current.position]);
      await c.query(`INSERT INTO task_members (task_id, user_id, position, status) VALUES ($1, $2, $3, 'offered')`, [id, toUserId, current.position]);
      // the holder waits their turn again; the time they already logged stays on the task
      await c.query(`UPDATE task_members SET status = 'waiting', accepted_at = NULL, started_at = NULL WHERE id = $1`, [current.id]);
    } else {
      await c.query(`UPDATE task_members SET user_id = $2, status = 'offered', accepted_at = NULL, started_at = NULL WHERE id = $1`, [current.id, toUserId]);
    }
    const { rows: after } = await c.query(`SELECT * FROM task_members WHERE task_id = $1`, [id]);
    const drop = repeatedSteps(after);
    if (drop.length) await c.query(`DELETE FROM task_members WHERE id = ANY($1)`, [drop]);
    // it is no longer in their plan, and a timer they left open for it is over
    await c.query(`DELETE FROM plan_items WHERE member_id = $1`, [current.id]);
    await c.query(`UPDATE task_timers SET status = 'ended', run_started_at = NULL WHERE member_id = $1 AND status IN ('ready', 'running', 'paused')`, [current.id]);
    await log(c, id, auth.userId, mode === 'circle' ? 'circled back' : 'passed', `to user ${toUserId}`);
    await addComment(c, id, auth.userId, toUserId, 'handover', comment);
  });
}

/**
 * Replace the people who have not finished yet. Finished steps stay; the same person still first in line keeps their progress and plan.
 * Any Task Management user may edit a flow (the route already requires access); everyone in it must be on the project.
 */
export async function editFlow(db, auth, id, { version, userIds }) {
  return mutate(db, auth, id, version, async (c, task, steps) => {
    await assertPeople(c, task.project_id, userIds);

    const done = steps.filter((s) => s.status === 'done');
    const oldCurrent = currentStep(steps);
    const { rows: oldPlan } = oldCurrent ? await c.query(`SELECT * FROM plan_items WHERE member_id = $1 LIMIT 1`, [oldCurrent.id]) : { rows: [] };
    await c.query(`DELETE FROM task_members WHERE task_id = $1 AND status <> 'done'`, [id]);

    const base = done.length ? Math.max(...done.map((s) => s.position)) : 0;
    for (const [i, userId] of userIds.entries()) {
      const keep = i === 0 && oldCurrent?.user_id === userId; // keep progress if the same person is still first in line
      const { rows } = await c.query(
        `INSERT INTO task_members (task_id, user_id, position, status, accepted_at, started_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [id, userId, base + i + 1, i === 0 ? (keep ? oldCurrent.status : 'offered') : 'waiting', keep ? oldCurrent.accepted_at : null, keep ? oldCurrent.started_at : null],
      );
      if (keep && oldPlan[0]) {
        await c.query(`INSERT INTO plan_items (member_id, scope, start_date, position) VALUES ($1, $2, $3, $4)`, [rows[0].id, oldPlan[0].scope, oldPlan[0].start_date, oldPlan[0].position]);
      }
    }
    await log(c, id, auth.userId, 'flow edited');
  });
}

/** Hands the existing display orders back out in the new order so other columns are untouched. */
export async function reorder(db, auth, taskIds) {
  await db.tx(async (c) => {
    const { rows } = await c.query(`SELECT t.id, t.owner_id, t.display_order AS priority_rank FROM tasks t WHERE t.id = ANY($1)`, [taskIds]);
    if (rows.length !== taskIds.length) throw notFound('Task');
    const { rows: holders } = await c.query(
      `SELECT DISTINCT ON (task_id) task_id, user_id FROM task_members WHERE task_id = ANY($1) AND status <> 'done' ORDER BY task_id, position`,
      [taskIds],
    );
    for (const t of rows) {
      const holder = holders.find((h) => h.task_id === t.id)?.user_id;
      if (!canEditFlow(isFlowAdmin(auth), auth.userId, t) && holder !== auth.userId) throw forbidden('You can only reorder your own tasks');
    }
    const ranks = rows.map((t) => t.priority_rank).sort((a, b) => a - b);
    const useRanks = new Set(ranks).size === ranks.length ? ranks : taskIds.map((_, i) => (i + 1) * 10);
    for (const [i, id] of taskIds.entries()) await c.query(`UPDATE tasks SET display_order = $2 WHERE id = $1`, [id, useRanks[i]]);
  });
}

export const today = (auth) => todayIn(auth.timeZone);
