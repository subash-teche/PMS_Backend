import { writeAudit } from '../../utils/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors.js';
import { exact } from '../../utils/number.js';
import { escapeLike, idList, WhereBuilder } from '../../utils/query.js';
import { sqlToday } from '../../utils/time.js';
import { GRANTED } from '../taskaccess/taskaccess.service.js';

/*
 * Timesheet: every entry is time on a task the person works on. An entry stores only who, when, how long, what was done and which
 * task: the project, the task type and the category are read from the task.
 */

const SORT_COLUMNS = { workDate: 't.work_date', minutes: 't.minutes', project: 'p.title', createdAt: 't.created_at' };
const DAY_LIMIT = 24 * 60;
// a user works on a task when they are one of its members – only they log time on it
const WORKS_ON = (t, user) => `EXISTS (SELECT 1 FROM task_members wm WHERE wm.task_id = ${t}.id AND wm.user_id = ${user})`;

/** Time on a task: only by the person it is assigned to. A link an edited entry already has stays. */
async function assertWorksOn(db, userId, taskId, keepTaskId) {
  if (!taskId || taskId === keepTaskId) return;
  const { rows } = await db.query(`SELECT 1 FROM tasks t WHERE t.id = $1 AND ${WORKS_ON('t', '$2')}`, [taskId, userId]);
  if (!rows[0]) throw badRequest('Only the person the task is assigned to can log time on it', [{ field: 'taskId', message: 'not assigned to you' }]);
}

const SELECT = `
  SELECT t.id, t.user_id, u.name AS user_name, t.work_date, tk.project_id, p.code AS project_code, p.title AS project_title,
         tk.task_category_id, c.name AS category_name, COALESCE(c.is_project, true) AS is_project_category,
         COALESCE(c.is_private, false) AS is_private_category,
         tk.task_type_id, tt.name AS task_type_name, tt.task_group_id, g.name AS task_group_name,
         t.task_id, tk.name AS task_name, t.minutes, t.comment, t.is_billable, t.from_board, t.created_at, t.updated_at
    FROM timesheets t
    JOIN users u ON u.id = t.user_id
    JOIN tasks tk ON tk.id = t.task_id
    LEFT JOIN projects p ON p.id = tk.project_id
    LEFT JOIN task_categories c ON c.id = tk.task_category_id
    LEFT JOIN task_types tt ON tt.id = tk.task_type_id
    LEFT JOIN task_groups g ON g.id = tt.task_group_id`;

const toDto = (r) => ({
  id: r.id,
  userId: r.user_id,
  userName: r.user_name,
  workDate: r.work_date,
  projectId: r.project_id,
  projectCode: r.project_code,
  projectTitle: r.project_title,
  categoryId: r.task_category_id,
  categoryName: r.category_name,
  isProjectCategory: r.is_project_category,
  taskGroupId: r.task_group_id,
  taskGroupName: r.task_group_name,
  taskTypeId: r.task_type_id,
  taskTypeName: r.task_type_name,
  taskId: r.task_id,
  taskName: r.task_name,
  minutes: r.minutes,
  hours: exact(r.minutes / 60),
  comment: r.comment ?? r.task_name, // time logged on the board without a note shows the task
  isBillable: r.is_billable,
  source: r.from_board ? 'flow' : 'manual', // 'flow' = logged in Task Management, read-only here
  flowTaskId: r.from_board ? r.task_id : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const hrs = (minutes) => exact(Number(minutes) / 60);

/** Someone else's Personal (private category) time: only that there was personal time, not what. */
const isMasked = (auth, r) => r.is_private_category && r.user_id !== auth.userId && !auth.isSuperAdmin;
const maskedSql = (auth) => (auth.isSuperAdmin ? 'false' : `(COALESCE(c.is_private, false) AND t.user_id <> ${Number(auth.userId)})`);
const toListDto = (auth) => (r) =>
  isMasked(auth, r)
    ? { ...toDto(r), comment: 'Personal', taskId: null, taskName: null, taskGroupId: null, taskGroupName: null, taskTypeId: null, taskTypeName: null, isMasked: true }
    : { ...toDto(r), isMasked: false };

/** The Team tab is for Project Managers and the Super Admin only. */
export const canSeeTeam = (auth) => auth.isSuperAdmin || auth.role.code === 'PROJECT_MANAGER';

/**
 * Entries the user may see on the Team tab:
 *   - all time logged on projects they manage (owner, or member with "Can edit" access)
 *   - plus the role's data scope: all = everyone, team = people in their teams, others = own only
 */
function applyScope(where, auth, scope, people = []) {
  if (scope === 'team' && !canSeeTeam(auth)) throw forbidden('Only project managers can see the team timesheet');
  // My timesheet: my own entries – unless the Employee filter picks people (then everything the user can see)
  if (scope !== 'team' && !people.length) {
    where.add('t.user_id = $?', auth.userId);
    return;
  }
  if (auth.isSuperAdmin || auth.role.dataScope === 'all') return;
  // without the team view: mine + the people given in Task Master
  if (!canSeeTeam(auth)) {
    where.add(`(t.user_id = $? OR ${GRANTED('t.user_id', '$?')})`, auth.userId, auth.userId);
    return;
  }
  // projects the user manages = the projects they own
  const managed = `tk.project_id IN (SELECT p2.id FROM projects p2 WHERE p2.owner_id = $?)`;
  if (auth.role.dataScope === 'team') {
    where.add(
      `(t.user_id = $? OR ${managed}
         OR t.user_id IN (SELECT other.user_id FROM user_teams mine JOIN user_teams other ON other.team_id = mine.team_id WHERE mine.user_id = $?)
         OR ${GRANTED('t.user_id', '$?')})`,
      auth.userId,
      auth.userId,
      auth.userId,
      auth.userId,
    );
    return;
  }
  where.add(`(t.user_id = $? OR ${managed} OR ${GRANTED('t.user_id', '$?')})`, auth.userId, auth.userId, auth.userId);
}

function buildFilters(auth, q) {
  const where = new WhereBuilder();
  applyScope(where, auth, q.scope, idList(q.userId));
  if (q.search) {
    const s = `%${escapeLike(q.search.trim())}%`;
    where.add(`(p.title ILIKE $? OR p.code ILIKE $? OR ((t.comment ILIKE $? OR tt.name ILIKE $?) AND NOT ${maskedSql(auth)}) OR c.name ILIKE $?)`, s, s, s, s, s);
  }
  const projectIds = idList(q.projectId);
  if (projectIds.length) where.add('tk.project_id = ANY($?)', projectIds);
  const userIds = idList(q.userId);
  if (userIds.length) where.add('t.user_id = ANY($?)', userIds);
  const categoryIds = idList(q.categoryId);
  if (categoryIds.length) where.add('tk.task_category_id = ANY($?)', categoryIds);
  const groupIds = idList(q.taskGroupId);
  if (groupIds.length) where.add('tt.task_group_id = ANY($?)', groupIds);
  if (q.isBillable !== undefined) where.add('t.is_billable = $?', q.isBillable);
  if (q.from) where.add('t.work_date >= $?', q.from);
  if (q.to) where.add('t.work_date <= $?', q.to);
  return where;
}

/**
 * One row per task instead of one per entry, with the time collected on it in the chosen period (the filters decide which entries count).
 * One row per task.
 * Per person (on the team view each person has their own row). Someone else's Personal time is one row, details hidden.
 */
const groupKey = (auth) =>
  `CASE WHEN ${maskedSql(auth)} THEN 'p'
        ELSE 't' || t.task_id END`;
const GROUP_JOINS = `FROM timesheets t JOIN tasks tk ON tk.id = t.task_id LEFT JOIN projects p ON p.id = tk.project_id LEFT JOIN task_categories c ON c.id = tk.task_category_id LEFT JOIN task_types tt ON tt.id = tk.task_type_id`;

async function listByTask(db, auth, q) {
  const key = groupKey(auth);
  const where = buildFilters(auth, q);
  const limit = where.param(q.pageSize);
  const offset = where.param((q.page - 1) * q.pageSize);
  const { rows } = await db.query(
    `WITH g AS (
       SELECT t.user_id, ${key} AS gkey, sum(t.minutes)::int AS group_minutes, count(*)::int AS entries, min(t.work_date) AS first_date, max(t.work_date) AS last_date,
              bool_and(t.is_billable) AS all_billable, (array_agg(t.id ORDER BY t.work_date DESC, t.id DESC))[1] AS last_id
         ${GROUP_JOINS} ${where.toSql()}
        GROUP BY t.user_id, ${key}
     )
     SELECT g.group_minutes, g.entries, g.first_date, g.last_date, g.all_billable, x.*
       FROM g JOIN (${SELECT}) x ON x.id = g.last_id 
      ORDER BY g.last_date DESC, g.last_id DESC LIMIT ${limit} OFFSET ${offset}`,
    where.params,
  );
  const w2 = buildFilters(auth, q);
  const { rows: totals } = await db.query(
    `SELECT count(*)::int AS total, COALESCE(sum(s.m), 0)::int AS minutes
       FROM (SELECT sum(t.minutes) AS m ${GROUP_JOINS} ${w2.toSql()} GROUP BY t.user_id, ${key}) s`,
    w2.params,
  );
  const items = rows.map((r) => {
    const dto = toListDto(auth)({ ...r, minutes: r.group_minutes });
    const taskTitle = dto.taskName;
    return {
      ...dto,
      workDate: r.last_date,
      entries: r.entries,
      firstDate: r.first_date,
      lastDate: r.last_date,
      isBillable: r.all_billable,
      ...(dto.isMasked ? {} : { taskName: taskTitle, comment: r.from_board ? dto.taskName : dto.comment }),
    };
  });
  return { items, total: totals[0].total, totalMinutes: totals[0].minutes, totalHours: hrs(totals[0].minutes), page: q.page, pageSize: q.pageSize };
}

export async function listTimesheets(db, auth, q) {
  if (q.groupBy === 'task') return listByTask(db, auth, q);
  const where = buildFilters(auth, q);
  const sort = SORT_COLUMNS[q.sortBy] ?? SORT_COLUMNS.workDate;
  const dir = q.sortDir === 'asc' ? 'ASC' : 'DESC';
  const limit = where.param(q.pageSize);
  const offset = where.param((q.page - 1) * q.pageSize);
  const { rows } = await db.query(`${SELECT} ${where.toSql()} ORDER BY ${sort} ${dir}, t.id DESC LIMIT ${limit} OFFSET ${offset}`, where.params);

  const countWhere = buildFilters(auth, q);
  const { rows: totals } = await db.query(
    `SELECT count(*)::int AS total, COALESCE(SUM(t.minutes), 0)::int AS minutes
       ${GROUP_JOINS} ${countWhere.toSql()}`,
    countWhere.params,
  );
  return { items: rows.map(toListDto(auth)), total: totals[0].total, totalMinutes: totals[0].minutes, totalHours: hrs(totals[0].minutes), page: q.page, pageSize: q.pageSize };
}

/** Summary cards: this week (Mon–Sun) for the user, or the team scope. "Today" is the user's today (their time zone). */
export async function timesheetSummary(db, auth, q) {
  const today = sqlToday(auth);
  const where = new WhereBuilder();
  applyScope(where, auth, q.scope);
  where.add(`t.work_date BETWEEN date_trunc('week', ${today})::date AND (date_trunc('week', ${today}) + interval '6 days')::date`);
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(t.minutes), 0)::int AS total,
            COALESCE(SUM(t.minutes) FILTER (WHERE t.is_billable), 0)::int AS billable,
            COALESCE(SUM(t.minutes) FILTER (WHERE t.work_date = ${today}), 0)::int AS today,
            count(DISTINCT tk.project_id)::int AS projects,
            count(DISTINCT tk.project_id) FILTER (WHERE p.customer_id IS NOT NULL)::int AS client_projects,
            count(DISTINCT t.work_date)::int AS days
       FROM timesheets t JOIN tasks tk ON tk.id = t.task_id LEFT JOIN projects p ON p.id = tk.project_id ${where.toSql()}`,
    where.params,
  );
  const r = rows[0];
  return {
    weekHours: hrs(r.total),
    billableHours: hrs(r.billable),
    nonBillableHours: hrs(r.total - r.billable),
    todayHours: hrs(r.today),
    projects: r.projects,
    clientProjects: r.client_projects,
    internalProjects: r.projects - r.client_projects,
    daysLogged: r.days,
  };
}

/** What the Log time form offers: the tasks the person works on (a member of), with their project and category. */
export async function timesheetOptions(db, auth) {
  const { rows } = await db.query(
    `SELECT t.id, t.name, t.status, t.project_id, p.code AS project_code, p.title AS project_title, t.task_category_id, c.name AS category_name
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN task_categories c ON c.id = t.task_category_id
      WHERE t.is_active AND ${WORKS_ON('t', '$1')} AND (p.id IS NULL OR p.status <> 'cancelled')
      ORDER BY (t.status = 'completed'), p.title NULLS LAST, t.display_order, t.name`,
    [auth.userId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    projectId: r.project_id,
    projectCode: r.project_code,
    projectTitle: r.project_title,
    categoryId: r.task_category_id,
    categoryName: r.category_name,
  }));
}

/** Categories for the list filter. */
export async function timesheetCategories(db) {
  const { rows } = await db.query(`SELECT id, name FROM task_categories WHERE is_active ORDER BY display_order, name`);
  return rows;
}

/** Projects for the list filter: every project for the Super Admin, otherwise the ones the user is on. */
export async function filterProjects(db, auth) {
  const { rows } = auth.isSuperAdmin
    ? await db.query(`SELECT id, code, title FROM projects ORDER BY title`)
    : await db.query(
        `SELECT p.id, p.code, p.title FROM projects p
          WHERE p.owner_id = $1 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1)
          ORDER BY p.title`,
        [auth.userId],
      );
  return rows;
}

/**
 * Checks the task (one the person works on, on a project that is not cancelled) and the daily limit.
 * Sets body.isBillable: time on a project task follows the project, other time is not billable.
 */
async function validateEntry(db, auth, userId, body, excludeId = null) {
  if (!body.taskId) throw badRequest('Select the task', [{ field: 'taskId', message: 'is required' }]);
  const { rows: task } = await db.query(`SELECT t.id, t.project_id, p.status, p.is_billable FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = $1`, [body.taskId]);
  if (!task[0]) throw badRequest('Task does not exist', [{ field: 'taskId', message: 'does not exist' }]);
  await assertWorksOn(db, userId, body.taskId, body.keepTaskId);
  if (task[0].status === 'cancelled') throw badRequest('This project is cancelled', [{ field: 'taskId', message: 'the project is cancelled' }]);
  body.isBillable = task[0].project_id ? (body.isBillable ?? task[0].is_billable) : false;

  const { rows: day } = await db.query(
    `SELECT COALESCE(SUM(minutes), 0)::int AS minutes FROM timesheets WHERE user_id = $1 AND work_date = $2 AND id IS DISTINCT FROM $3`,
    [userId, body.workDate, excludeId],
  );
  const minutes = body.minutes;
  if (day[0].minutes + minutes > DAY_LIMIT) {
    throw badRequest(`That makes more than 24 hours (1440 mins) on this day – ${day[0].minutes} mins already logged`, [{ field: 'minutes', message: 'over 24 hours a day' }]);
  }
  return minutes;
}

async function loadOwn(db, auth, id) {
  const { rows } = await db.query(`${SELECT} WHERE t.id = $1`, [id]);
  if (!rows[0]) throw notFound('Time entry');
  if (rows[0].user_id !== auth.userId && !auth.isSuperAdmin) throw forbidden('You can only change your own time entries');
  return rows[0];
}

/** Time logged in Task Management is changed there, so the Timesheet and the flow task never disagree. */
const assertEditable = (row) => {
  if (row.from_board) throw conflict('This time was logged in Task Management - change it there');
};

export async function getTimesheet(db, auth, id) {
  return toDto(await loadOwn(db, auth, id));
}

export async function createTimesheet(db, auth, body) {
  const minutes = await validateEntry(db, auth, auth.userId, body);
  const id = await db.tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO timesheets (user_id, work_date, task_id, minutes, comment, is_billable, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $1, $1) RETURNING id`,
      [auth.userId, body.workDate, body.taskId, minutes, body.comment.trim(), body.isBillable],
    );
    await writeAudit(client, { entity: 'timesheets', entityId: rows[0].id, action: 'create', userId: auth.userId, message: `${minutes} mins logged` });
    return rows[0].id;
  });
  return getTimesheet(db, auth, id);
}

export async function updateTimesheet(db, auth, id, body) {
  const before = await loadOwn(db, auth, id);
  assertEditable(before);
  const merged = {
    workDate: body.workDate ?? before.work_date,
    taskId: body.taskId === undefined ? before.task_id : body.taskId,
    keepTaskId: before.task_id, // an edit may keep a task link it already has
    minutes: body.minutes ?? before.minutes,
    comment: body.comment ?? before.comment ?? '',
    isBillable: body.isBillable ?? before.is_billable,
  };
  const minutes = await validateEntry(db, auth, before.user_id, merged, id);
  await db.tx(async (client) => {
    await client.query(
      `UPDATE timesheets SET work_date = $2, task_id = $3, minutes = $4, comment = $5, is_billable = $6, updated_by = $7 WHERE id = $1`,
      [id, merged.workDate, merged.taskId, minutes, merged.comment.trim(), merged.isBillable, auth.userId],
    );
    await writeAudit(client, { entity: 'timesheets', entityId: id, action: 'update', userId: auth.userId });
  });
  return getTimesheet(db, auth, id);
}

export async function deleteTimesheet(db, auth, id) {
  assertEditable(await loadOwn(db, auth, id));
  await db.tx(async (client) => {
    await client.query(`DELETE FROM timesheets WHERE id = $1`, [id]);
    await writeAudit(client, { entity: 'timesheets', entityId: id, action: 'delete', userId: auth.userId });
  });
}
