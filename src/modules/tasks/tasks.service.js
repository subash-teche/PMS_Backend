import { writeAudit } from '../../utils/audit.js';
import { badRequest, forbidden, notFound } from '../../utils/errors.js';
import { escapeLike, idList, WhereBuilder } from '../../utils/query.js';
import { dateIn, safeZone, sqlToday, sqlZone, todayIn } from '../../utils/time.js';
import { periodsOf } from '../projectplan/projectplan.service.js';
import { GRANTED } from '../taskaccess/taskaccess.service.js';

/*
 * Tasks: created by a user for themselves, or for other people when the role's data scope allows
 * (All / Team). Each task has a category; a project category needs a project.
 *
 * "My tasks" = tasks I own, am assigned to, created, or that are on a project I own.
 * "All tasks" = per the role data scope: all = everything, team = mine + my team members' tasks.
 */

const SORT_COLUMNS = {
  name: 't.name',
  plannedStart: 't.planned_start',
  plannedEnd: 't.planned_end',
  status: `array_position(ARRAY['in_progress','to_do','hold','completed']::varchar[], t.status)`,
  createdAt: 't.created_at',
};

const STATUS_LABEL = { to_do: 'To do', in_progress: 'In progress', hold: 'Hold', completed: 'Completed' };

const OVERDUE = `(t.status <> 'completed' AND t.planned_end < now())`;

const SELECT = `
  SELECT t.id, t.name, t.description, t.task_category_id, c.name AS category_name, COALESCE(c.is_project, false) AS is_project_category,
         COALESCE(c.is_private, false) AS is_private_category,
         t.project_id, p.code AS project_code, p.title AS project_title, p.owner_id AS project_owner_id,
         t.owner_id, o.name AS owner_name, h.user_id AS assigned_to, a.name AS assigned_to_name,
         t.task_group_id, tg.name AS task_group_name, t.task_type_id, tty.name AS task_type_name,
         t.estimated_minutes, t.status, t.planned_start, t.planned_end, t.completed_on,
         ${OVERDUE} AS is_overdue,
         (SELECT count(*)::int FROM timesheets x WHERE x.task_id = t.id) AS timesheet_count,
         t.actual_start, t.completed_by, cpl.name AS completed_by_name,
         t.created_by, cb.name AS created_by_name, t.created_at, t.updated_at
    FROM tasks t
    LEFT JOIN task_categories c ON c.id = t.task_category_id
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN users o ON o.id = t.owner_id
    LEFT JOIN task_holders h ON h.task_id = t.id
    LEFT JOIN users a ON a.id = h.user_id
    LEFT JOIN users cb ON cb.id = t.created_by
    LEFT JOIN users cpl ON cpl.id = t.completed_by
    LEFT JOIN task_groups tg ON tg.id = t.task_group_id
    LEFT JOIN task_types tty ON tty.id = t.task_type_id`;

/** Sees everyone's tasks (All scope) or the team's (Team scope). */
export const canSeeAll = (auth) => auth.isSuperAdmin || ['all', 'team'].includes(auth.role.dataScope);
/** May create tasks for other people (Admin, Project Manager … – roles with All / Team data scope). */
export const canAssignOthers = canSeeAll;
const isManager = (auth) => auth.isSuperAdmin || auth.role.dataScope === 'all';

const mine = (r, auth) => [r.owner_id, r.assigned_to, r.created_by].includes(auth.userId);
const canEdit = (auth, r) => isManager(auth) || mine(r, auth);
// full edit (people, dates …): owner, creator, All-scope roles. The assignee only updates the status.
const canManage = (auth, r) => isManager(auth) || r.owner_id === auth.userId || r.created_by === auth.userId;
const ASSIGNEE_FIELDS = ['status', 'completedOn'];
const canDelete = (auth, r) => isManager(auth) || r.owner_id === auth.userId || r.created_by === auth.userId;

/**
 * Personal (private category) tasks: only the people on the task (and the Super Admin) see the details;
 * anyone else who can see the person's work sees "Personal task".
 */
const isMasked = (auth, r) => r.is_private_category && !auth.isSuperAdmin && ![r.owner_id, r.assigned_to, r.created_by].includes(auth.userId);
/** SQL twin of isMasked (search must not match hidden titles). */
const maskedSql = (auth) =>
  auth.isSuperAdmin ? 'false' : `(COALESCE(c.is_private, false) AND ${Number(auth.userId)} NOT IN (t.owner_id, COALESCE(h.user_id, 0), COALESCE(t.created_by, 0)))`;

const toDto = (auth) => (r) => ({
  id: r.id,
  name: isMasked(auth, r) ? 'Personal task' : r.name,
  description: isMasked(auth, r) ? null : r.description,
  isMasked: isMasked(auth, r),
  categoryId: r.task_category_id,
  categoryName: r.category_name,
  isProjectCategory: r.is_project_category,
  projectId: r.project_id,
  projectCode: r.project_code,
  projectTitle: r.project_title,
  projectOwnerId: r.project_owner_id,
  inToday135: Boolean(r.in_today_135), // on the assignee's 1-3-5 today
  taskGroupId: r.task_group_id,
  taskGroupName: r.task_group_name,
  taskTypeId: r.task_type_id,
  taskTypeName: r.task_type_name,
  ownerId: r.owner_id,
  ownerName: r.owner_name,
  assignedTo: r.assigned_to,
  assignedToName: r.assigned_to_name,
  estimatedMinutes: r.estimated_minutes,
  status: r.status,
  plannedStart: r.planned_start,
  plannedEnd: r.planned_end,
  completedOn: r.completed_on,
  isOverdue: r.is_overdue,
  timesheetCount: r.timesheet_count,
  createdBy: r.created_by,
  createdByName: r.created_by_name,
  startedAt: r.actual_start,
  completedByName: r.completed_by_name,
  canEdit: canEdit(auth, r),
  canManage: canManage(auth, r),
  canDelete: canDelete(auth, r),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const MINE_SQL = `(t.owner_id = $? OR h.user_id = $? OR t.created_by = $?
                   OR EXISTS (SELECT 1 FROM projects op WHERE op.id = t.project_id AND op.owner_id = $?))`; // tasks of my projects

// Task Master: tasks owned by / assigned to people the user was given (view only)
const GRANTED_SQL = `(${GRANTED('h.user_id', '$?')} OR ${GRANTED('t.owner_id', '$?')})`;

// My tasks: the work assigned to me
const ASSIGNED_SQL = `h.user_id = $?`;

/**
 * mine = assigned to me; all = everything I can see: my own / created / my projects' tasks,
 * the role data scope, and the people given in Task Master.
 */
function applyScope(where, auth, scope) {
  const me = auth.userId;
  if (scope !== 'all') {
    where.add(ASSIGNED_SQL, me);
    return;
  }
  if (isManager(auth)) return;
  if (!canSeeAll(auth)) {
    where.add(`(${MINE_SQL} OR ${GRANTED_SQL})`, me, me, me, me, me, me);
    return;
  }
  // team scope: mine + tasks owned by / assigned to people in my teams + Task Master
  where.add(
    `(${MINE_SQL} OR h.user_id IN (SELECT other.user_id FROM user_teams mine JOIN user_teams other ON other.team_id = mine.team_id WHERE mine.user_id = $?)
                  OR t.owner_id IN (SELECT other.user_id FROM user_teams mine JOIN user_teams other ON other.team_id = mine.team_id WHERE mine.user_id = $?)
                  OR ${GRANTED_SQL})`,
    me,
    me,
    me,
    me,
    me,
    me,
    me,
    me,
    me,
  );
}

/** The Employee filter: those people's tasks (owned or assigned), from everything the user can see. */
function applyPeople(where, auth, q) {
  const people = idList(q.employeeId);
  applyScope(where, auth, people.length ? 'all' : q.scope);
  if (people.length) where.add('(h.user_id = ANY($?) OR t.owner_id = ANY($?))', people, people);
}

const csv = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);

/** Tasks nobody is assigned to yet are listed for the Super Admin only. */
function hideUnassigned(where, auth) {
  if (!auth.isSuperAdmin) where.add('h.user_id IS NOT NULL');
}

function buildFilters(auth, q) {
  const where = new WhereBuilder();
  where.add('t.is_active');
  applyPeople(where, auth, q);
  hideUnassigned(where, auth);
  if (q.search) {
    const s = `%${escapeLike(q.search.trim())}%`;
    where.add(`(((t.name ILIKE $? OR t.description ILIKE $?) AND NOT ${maskedSql(auth)}) OR p.title ILIKE $? OR p.code ILIKE $?)`, s, s, s, s);
  }
  const status = csv(q.status);
  if (status.length) where.add('t.status = ANY($?)', status);
  const categoryIds = idList(q.categoryId);
  if (categoryIds.length) where.add('t.task_category_id = ANY($?)', categoryIds);
  const projectIds = idList(q.projectId);
  if (projectIds.length) where.add('t.project_id = ANY($?)', projectIds);
  const assignees = idList(q.assignedTo);
  if (assignees.length) where.add('h.user_id = ANY($?)', assignees);
  if (q.overdue) where.add(OVERDUE);
  return where;
}

/** Adds in_today_135 to the task rows: the task is on its assignee's 1-3-5 today (the user's today). */
async function addPlanFlags(db, auth, rows) {
  if (!rows.length) return;
  const { rows: planned } = await db.query(
    `SELECT i.task_id FROM daily_plan_items i JOIN task_holders h ON h.task_id = i.task_id AND h.user_id = i.user_id
      WHERE i.task_id = ANY($1) AND i.plan_date = $2`,
    [rows.map((r) => r.id), todayIn(auth.timeZone)],
  );
  for (const r of rows) {
    r.in_today_135 = planned.some((x) => x.task_id === r.id);
  }
}

export async function listTasks(db, auth, q) {
  const where = buildFilters(auth, q);
  const sort = SORT_COLUMNS[q.sortBy] ?? SORT_COLUMNS.plannedEnd;
  const dir = q.sortDir === 'desc' ? 'DESC' : 'ASC';
  const limit = where.param(q.pageSize);
  const offset = where.param((q.page - 1) * q.pageSize);
  const { rows } = await db.query(
    // open work first; tasks without dates after the dated ones
    `${SELECT} ${where.toSql()}
      ORDER BY (t.status = 'completed'), ${sort} ${dir} NULLS LAST, t.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    where.params,
  );
  const countWhere = buildFilters(auth, q);
  const { rows: totals } = await db.query(
    `SELECT count(*)::int AS total FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN task_categories c ON c.id = t.task_category_id LEFT JOIN task_holders h ON h.task_id = t.id ${countWhere.toSql()}`,
    countWhere.params,
  );
  await addPlanFlags(db, auth, rows);
  return { items: rows.map(toDto(auth)), total: totals[0].total, page: q.page, pageSize: q.pageSize };
}

export async function taskSummary(db, auth, q) {
  const today = sqlToday(auth); // the user's today and zone
  const zone = sqlZone(auth);
  const where = new WhereBuilder();
  where.add('t.is_active');
  applyPeople(where, auth, q);
  hideUnassigned(where, auth);
  const { rows } = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE t.status = 'to_do')::int AS to_do,
            count(*) FILTER (WHERE t.status = 'in_progress')::int AS in_progress,
            count(*) FILTER (WHERE t.status = 'hold')::int AS hold,
            count(*) FILTER (WHERE t.status = 'completed')::int AS completed,
            count(*) FILTER (WHERE t.status = 'completed' AND t.completed_on >= date_trunc('week', ${today})::date)::int AS completed_week,
            count(*) FILTER (WHERE ${OVERDUE})::int AS overdue,
            count(*) FILTER (WHERE t.status <> 'completed' AND (t.planned_end AT TIME ZONE ${zone})::date = ${today})::int AS due_today
       FROM tasks t LEFT JOIN task_holders h ON h.task_id = t.id ${where.toSql()}`,
    where.params,
  );
  const r = rows[0];
  return {
    total: r.total,
    toDo: r.to_do,
    inProgress: r.in_progress,
    hold: r.hold,
    completed: r.completed,
    completedThisWeek: r.completed_week,
    overdue: r.overdue,
    dueToday: r.due_today,
  };
}

/** Projects the user may put a task on: all for All scope, otherwise the ones they own or are a member of. */
const PROJECTS_SQL = (auth) =>
  isManager(auth)
    ? { sql: `SELECT id, code, title AS name FROM projects WHERE status <> 'cancelled' ORDER BY title`, params: [] }
    : {
        sql: `SELECT p.id, p.code, p.title AS name FROM projects p
               WHERE p.status <> 'cancelled'
                 AND (p.owner_id = $1 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1))
               ORDER BY p.title`,
        params: [auth.userId],
      };

/**
 * The people of projects: their owner and members (project Users tab). A project task is assigned to
 * one of them; the owner is the default task owner.  → Map projectId → { ownerId, peopleIds }
 */
async function projectPeople(db, projectIds) {
  if (!projectIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT p.id, p.owner_id, COALESCE(array_agg(pm.user_id) FILTER (WHERE pm.user_id IS NOT NULL), '{}') AS member_ids
       FROM projects p LEFT JOIN project_members pm ON pm.project_id = p.id
      WHERE p.id = ANY($1) GROUP BY p.id`,
    [projectIds],
  );
  return new Map(rows.map((r) => [r.id, { ownerId: r.owner_id, peopleIds: [...new Set([r.owner_id, ...r.member_ids.map(Number)])].filter(Boolean) }]));
}

/** The task groups of projects (their Estimate tab, with a share of the effort): a project task is made in one of them. → Map projectId → [task group id]; none = the estimate is not set */
async function projectGroups(db, projectIds) {
  if (!projectIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT project_id, array_agg(DISTINCT task_group_id ORDER BY task_group_id)::int[] AS ids FROM project_effort_estimates WHERE project_id = ANY($1) AND effort_percentage > 0 GROUP BY project_id`,
    [projectIds],
  );
  return new Map(rows.map((r) => [r.project_id, r.ids]));
}

export async function taskOptions(db, auth) {
  const projects = PROJECTS_SQL(auth);
  const [categories, projectRows, users] = await Promise.all([
    db.query(
      `SELECT c.id, c.name, c.is_project AS "isProject",
              ARRAY(SELECT l.task_group_id FROM task_category_groups l WHERE l.task_category_id = c.id ORDER BY l.task_group_id)::int[] AS "taskGroupIds"
         FROM task_categories c WHERE c.is_active ORDER BY c.display_order, c.name`,
    ),
    db.query(projects.sql, projects.params),
    canAssignOthers(auth)
      ? db.query(
          `SELECT u.id, u.name, u.employee_code AS code FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.is_active AND r.role_type = 'internal' ORDER BY u.name`,
        )
      : db.query(`SELECT id, name, employee_code AS code FROM users WHERE id = $1`, [auth.userId]),
  ]);
  const people = await projectPeople(db, projectRows.rows.map((p) => p.id));
  const groups = await projectGroups(db, projectRows.rows.map((p) => p.id));
  return {
    categories: categories.rows,
    projects: projectRows.rows.map((p) => ({ ...p, ...(people.get(p.id) ?? { ownerId: null, peopleIds: [] }), taskGroupIds: groups.get(p.id) ?? [] })),
    users: users.rows,
    canAssignOthers: canAssignOthers(auth),
    canSeeAll: canSeeAll(auth),
  };
}

async function loadTask(db, auth, id) {
  const where = new WhereBuilder();
  where.add('t.id = $?', id);
  where.add('t.is_active');
  applyScope(where, auth, 'all');
  const { rows } = await db.query(`${SELECT} ${where.toSql()}`, where.params);
  if (!rows[0]) throw notFound('Task');
  return rows[0];
}

export async function getTask(db, auth, id) {
  const row = await loadTask(db, auth, id);
  await addPlanFlags(db, auth, [row]);
  return toDto(auth)(row);
}


/**
 * Checks the merged task (before + changes) and returns the values to store:
 * category / project, people, dates, completed date.
 */
async function validate(db, auth, v, before = null) {
  const { rows: cat } = await db.query(`SELECT id, is_project, is_active FROM task_categories WHERE id = $1`, [v.categoryId]);
  if (!cat[0] || (!cat[0].is_active && before?.task_category_id !== v.categoryId)) {
    throw badRequest('Select an active task category', [{ field: 'categoryId', message: 'does not exist or is inactive' }]);
  }
  if (cat[0].is_project) {
    if (!v.projectId) throw badRequest('Select the project', [{ field: 'projectId', message: 'is required for this category' }]);
    if (v.projectId !== before?.project_id) {
      const projects = PROJECTS_SQL(auth);
      const { rows } = await db.query(`SELECT 1 FROM (${projects.sql}) x WHERE x.id = $${projects.params.length + 1}`, [...projects.params, v.projectId]);
      if (!rows[0]) throw badRequest('You can only add tasks to projects you are on', [{ field: 'projectId', message: 'not one of your projects' }]);
    }
    // a project task is done by someone on the project – its owner or a member (checked when either changes)
    if (v.projectId !== before?.project_id || v.assignedTo !== before?.assigned_to) {
      const onProject = (await projectPeople(db, [v.projectId])).get(v.projectId)?.peopleIds ?? [];
      if (!onProject.includes(v.assignedTo)) {
        throw badRequest('Assign the task to someone on the project – its owner or a member (project Users tab)', [{ field: 'assignedTo', message: 'is not on the project' }]);
      }
    }
  } else {
    // Personal / Activity: the owner's own task (the creator on a new one), done by them; ongoing or with dates, as chosen
    v.projectId = null;
    v.ownerId = before?.owner_id ?? auth.userId;
    v.assignedTo = v.ownerId;
  }

  // task group / type (optional): the type must be in the group; a type alone sets its group
  if (v.taskTypeId) {
    const { rows: tt } = await db.query(`SELECT task_group_id, is_active FROM task_types WHERE id = $1`, [v.taskTypeId]);
    if (!tt[0] || (!tt[0].is_active && before?.task_type_id !== v.taskTypeId)) {
      throw badRequest('Select an active task type', [{ field: 'taskTypeId', message: 'does not exist or is inactive' }]);
    }
    if (v.taskGroupId && tt[0].task_group_id !== v.taskGroupId) {
      throw badRequest('The task type is not in the selected task group', [{ field: 'taskTypeId', message: 'not in the task group' }]);
    }
    v.taskGroupId = tt[0].task_group_id;
  } else if (v.taskGroupId && v.taskGroupId !== before?.task_group_id) {
    const { rowCount } = await db.query(`SELECT 1 FROM task_groups WHERE id = $1`, [v.taskGroupId]);
    if (!rowCount) throw badRequest('Select a task group', [{ field: 'taskGroupId', message: 'does not exist' }]);
  }

  // a project task's group must be one of the project's task groups (its Estimate tab)
  if (cat[0].is_project && v.taskGroupId && (v.taskGroupId !== before?.task_group_id || v.projectId !== before?.project_id)) {
    const ids = (await projectGroups(db, [v.projectId])).get(v.projectId) ?? [];
    if (!ids.includes(v.taskGroupId)) {
      throw badRequest(ids.length ? "Select one of the project's task groups" : 'The project plan and estimate are not set', [{ field: 'taskGroupId', message: ids.length ? 'not a task group of the project' : 'the project estimate is not set' }]);
    }
  }

  // the group must be one of the category's task groups (a category without groups takes any)
  if (v.taskGroupId && v.taskGroupId !== before?.task_group_id) {
    const [{ rows: allowed }, { rows: links }] = await Promise.all([
      db.query(`SELECT task_group_id FROM task_category_groups WHERE task_category_id = $1`, [v.categoryId]),
      db.query(`SELECT 1 FROM task_category_groups WHERE task_group_id = $1 LIMIT 1`, [v.taskGroupId]),
    ]);
    // a group that no category has claimed yet is open to every category
    if (allowed.length && links.length && !allowed.some((r) => Number(r.task_group_id) === v.taskGroupId)) {
      throw badRequest('This task group is not set up for the task category', [{ field: 'taskGroupId', message: 'not a group of the category' }]);
    }
  }

  // people: without "assign to others", a task is the user's own
  if (!canAssignOthers(auth)) {
    for (const [field, label, old] of [['assignedTo', 'assign the task', before?.assigned_to], ['ownerId', 'set the owner', before?.owner_id]]) {
      if (v[field] !== auth.userId && v[field] !== old) throw forbidden(`You can only ${label} to yourself`);
    }
  }
  const people = [...new Set([v.ownerId, v.assignedTo])];
  const { rows: active } = await db.query(`SELECT id FROM users WHERE id = ANY($1) AND is_active`, [people]);
  const ok = new Set(active.map((r) => r.id));
  if (!ok.has(v.ownerId)) throw badRequest('Select an active task owner', [{ field: 'ownerId', message: 'is not an active user' }]);
  if (!ok.has(v.assignedTo)) throw badRequest('Select an active user to assign', [{ field: 'assignedTo', message: 'is not an active user' }]);

  if (!v.plannedStart) throw badRequest('Enter the earliest start', [{ field: 'plannedStart', message: 'is required' }]);
  if (!v.plannedEnd) throw badRequest('Enter the end before date', [{ field: 'plannedEnd', message: 'is required' }]);
  if (new Date(v.plannedEnd) <= new Date(v.plannedStart)) {
    throw badRequest('End before must be after the earliest start', [{ field: 'plannedEnd', message: 'must be after the earliest start' }]);
  }

  if (v.status === 'completed') v.completedOn = v.completedOn || todayIn(auth.timeZone); // the user's today
  else v.completedOn = null;
  return v;
}

// The person a task is assigned to is its member (task_members): the one who holds the current step. These keep the members in line with
// what the PMS task screens say (who it is assigned to, what its status is).
const MEMBER_STATUS = { completed: 'done', in_progress: 'active' };

/** The first (and only) member of a task that had nobody. */
async function addHolder(client, taskId, userId, status) {
  if (userId === null || userId === undefined) return;
  const m = MEMBER_STATUS[status] ?? 'todo';
  await client.query(
    `INSERT INTO task_members (task_id, user_id, position, status, accepted_at, started_at, closed_at)
     VALUES ($1, $2, 1, $3::varchar, now(), CASE WHEN $3::varchar IN ('active', 'done') THEN now() END, CASE WHEN $3::varchar = 'done' THEN now() END)`,
    [taskId, userId, m],
  );
}

/** Someone else holds the task now: the person on its current step is replaced (their plan and open timer go with them). */
async function reassign(client, taskId, userId, status) {
  const { rows } = await client.query(`SELECT id, user_id, status FROM task_members WHERE task_id = $1 AND status <> 'done' ORDER BY position LIMIT 1`, [taskId]);
  const cur = rows[0];
  if (!cur) {
    const { rows: all } = await client.query(`SELECT count(*)::int AS n FROM task_members WHERE task_id = $1`, [taskId]);
    if (!all[0].n) await addHolder(client, taskId, userId, status);
    return;
  }
  if (cur.user_id === userId) return;
  await client.query(`UPDATE task_members SET user_id = $2, status = CASE WHEN status = 'active' THEN 'todo' ELSE status END, started_at = NULL WHERE id = $1`, [cur.id, userId]);
  await client.query(`DELETE FROM plan_items WHERE member_id = $1`, [cur.id]);
  await client.query(`UPDATE task_timers SET status = 'ended', run_started_at = NULL WHERE member_id = $1 AND status IN ('ready', 'running', 'paused')`, [cur.id]);
}

/** The members follow a status set on the PMS task: completed closes every step, in progress starts the current one, to do / hold put it back to accepted. */
async function followStatus(client, taskId, status) {
  const { rows: ms } = await client.query(`SELECT id, status FROM task_members WHERE task_id = $1 ORDER BY position`, [taskId]);
  if (!ms.length) return;
  if (status === 'completed') {
    await client.query(
      `UPDATE task_members SET status = 'done', accepted_at = COALESCE(accepted_at, now()), started_at = COALESCE(started_at, now()), closed_at = COALESCE(closed_at, now())
        WHERE task_id = $1 AND status <> 'done'`,
      [taskId],
    );
    return;
  }
  // reopened: the last person has it again
  let cur = ms.find((m) => m.status !== 'done');
  if (!cur) {
    cur = ms[ms.length - 1];
    await client.query(`UPDATE task_members SET status = 'todo', closed_at = NULL WHERE id = $1`, [cur.id]);
  }
  if (status === 'in_progress') {
    await client.query(`UPDATE task_members SET status = 'active', accepted_at = COALESCE(accepted_at, now()), started_at = COALESCE(started_at, now()) WHERE id = $1`, [cur.id]);
  } else if (cur.status === 'active') {
    await client.query(`UPDATE task_members SET status = 'todo', started_at = NULL WHERE id = $1`, [cur.id]);
  }
}

/** Inserts a validated task (+ audit) and returns its id. */
async function insertTask(client, auth, v, auditMessage) {
  const { rows } = await client.query(
    `INSERT INTO tasks (task_category_id, project_id, task_group_id, task_type_id, name, description, owner_id, estimated_minutes,
                        status, planned_start, planned_end, completed_on, actual_end, completed_by, created_by, updated_by, from_plan)
     VALUES ($1, $2, $12, $13, $3, $4, $5, $6, $7, $8, $9, $10,
             CASE WHEN $7::varchar = 'completed' THEN now() END, CASE WHEN $7::varchar = 'completed' THEN $11::bigint END, $11, $11, $14)
     RETURNING id`,
    [v.categoryId, v.projectId, v.name, v.description, v.ownerId, v.estimatedMinutes, v.status, v.plannedStart, v.plannedEnd, v.completedOn, auth.userId, v.taskGroupId ?? null, v.taskTypeId ?? null, v.fromPlan === true],
  );
  await addHolder(client, rows[0].id, v.assignedTo, v.status);
  await writeAudit(client, { entity: 'tasks', entityId: rows[0].id, action: 'create', userId: auth.userId, message: auditMessage ?? `Task "${v.name}" created` });
  return rows[0].id;
}

export async function createTask(db, auth, body) {
  const v = await validate(db, auth, {
    name: body.name.trim(),
    description: body.description?.trim() || null,
    categoryId: body.categoryId,
    projectId: body.projectId ?? null,
    taskGroupId: body.taskGroupId ?? null,
    taskTypeId: body.taskTypeId ?? null,
    ownerId: body.ownerId ?? auth.userId,
    assignedTo: body.assignedTo ?? auth.userId,
    estimatedMinutes: body.estimatedMinutes ?? null,
    status: body.status ?? 'to_do',
    plannedStart: body.plannedStart ?? null,
    plannedEnd: body.plannedEnd ?? null,
    completedOn: body.completedOn ?? null,
  });
  const id = await db.tx((client) => insertTask(client, auth, v));
  return getTask(db, auth, id);
}

export async function updateTask(db, auth, id, body) {
  const before = await loadTask(db, auth, id);
  if (!canEdit(auth, before)) throw forbidden('You can only change tasks you own, are assigned to or created');
  if (!canManage(auth, before) && Object.keys(body).some((k) => !ASSIGNEE_FIELDS.includes(k))) {
    throw forbidden('As the assignee you can update the status – ask the task owner to change the rest');
  }
  const pick = (k, col) => (body[k] !== undefined ? body[k] : before[col]);
  const v = await validate(
    db,
    auth,
    {
      name: (body.name ?? before.name).trim(),
      description: body.description !== undefined ? body.description?.trim() || null : before.description,
      categoryId: pick('categoryId', 'task_category_id'),
      projectId: pick('projectId', 'project_id'),
      taskGroupId: pick('taskGroupId', 'task_group_id'),
      taskTypeId: pick('taskTypeId', 'task_type_id'),
      ownerId: pick('ownerId', 'owner_id'),
      assignedTo: pick('assignedTo', 'assigned_to'),
      estimatedMinutes: pick('estimatedMinutes', 'estimated_minutes'),
      status: pick('status', 'status'),
      plannedStart: pick('plannedStart', 'planned_start'),
      plannedEnd: pick('plannedEnd', 'planned_end'),
      // a completed task keeps its date unless a new one is sent
      completedOn: body.completedOn !== undefined ? body.completedOn : before.completed_on,
    },
    before,
  );
  await db.tx(async (client) => {
    await client.query(
      `UPDATE tasks SET task_category_id = $2, project_id = $3,
              name = $4, description = $5, owner_id = $6, estimated_minutes = $7, status = $8,
              planned_start = $9, planned_end = $10, completed_on = $11,
              task_group_id = $13, task_type_id = $14,
              actual_end = CASE WHEN $8::varchar = 'completed' THEN COALESCE(actual_end, now()) END,
              completed_by = CASE WHEN $8::varchar <> 'completed' THEN NULL WHEN status = 'completed' THEN completed_by ELSE $12::bigint END,
              actual_start = CASE WHEN $8::varchar <> 'to_do' THEN COALESCE(actual_start, now()) ELSE actual_start END,
              version = version + 1,
              updated_by = $12
        WHERE id = $1`,
      [id, v.categoryId, v.projectId, v.name, v.description, v.ownerId, v.estimatedMinutes, v.status, v.plannedStart, v.plannedEnd, v.completedOn, auth.userId, v.taskGroupId ?? null, v.taskTypeId ?? null],
    );
    if (v.assignedTo !== before.assigned_to) await reassign(client, id, v.assignedTo, v.status);
    if (v.status !== before.status) await followStatus(client, id, v.status);
    await writeAudit(client, {
      entity: 'tasks',
      entityId: id,
      action: 'update',
      userId: auth.userId,
      message: before.status !== v.status ? `Status: ${STATUS_LABEL[before.status] ?? before.status} → ${STATUS_LABEL[v.status]}` : 'Task details updated',
    });
  });
  return getTask(db, auth, id);
}

// ---------------------------------------------------------------- add tasks from a project's template

/** Projects the user may add template tasks to: the ongoing projects they own (Super Admin: all), not completed / cancelled. */
export async function templateProjects(db, auth) {
  const { rows } = await db.query(
    `SELECT p.id, p.code, p.title, p.status, pt.name AS project_type_name, c.name AS customer_name,
            (SELECT count(*)::int FROM project_type_task_templates tt WHERE tt.project_type_id = p.project_type_id) AS template_count
       FROM projects p
       LEFT JOIN project_types pt ON pt.id = p.project_type_id
       LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.status NOT IN ('completed', 'cancelled')
        AND ($1::boolean OR p.owner_id = $2) -- only the project owner adds template tasks
      ORDER BY p.title`,
    [auth.isSuperAdmin, auth.userId],
  );
  const people = await projectPeople(db, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    title: r.title,
    status: r.status,
    ownerId: people.get(r.id)?.ownerId ?? null,
    peopleIds: people.get(r.id)?.peopleIds ?? [],
    projectTypeName: r.project_type_name,
    customerName: r.customer_name,
    templateCount: r.template_count,
  }));
}

async function ongoingProject(db, auth, projectId) {
  const list = await templateProjects(db, auth);
  const p = list.find((x) => x.id === projectId);
  if (!p) throw badRequest('Pick one of your ongoing projects', [{ field: 'projectId', message: 'not an ongoing project of yours' }]);
  return p;
}

/** The template tasks of the project's type, with the estimate for this project and how often each is already a task. */
export async function projectTemplates(db, auth, projectId) {
  await ongoingProject(db, auth, projectId);
  const { rows } = await db.query(
    `SELECT tt.id, tt.task_title, tt.description, tt.effort_percentage, tt.task_group_id, g.name AS task_group_name,
            tt.task_type_id, ty.name AS task_type_name,
            CASE WHEN p.estimated_hours > 0 AND tt.effort_percentage > 0
                 THEN ROUND(p.estimated_hours * 60 * tt.effort_percentage / 100)::int END AS estimated_minutes,
            COALESCE((SELECT array_agg(l.name ORDER BY l.display_order, l.name) FROM project_type_task_template_roles r
                        JOIN parameter_values l ON l.id = r.role_id WHERE r.task_template_id = tt.id), '{}') AS skills,
            COALESCE((SELECT array_agg(r.role_id) FROM project_type_task_template_roles r WHERE r.task_template_id = tt.id), '{}') AS skill_ids,
            (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.is_active AND lower(t.name) = lower(tt.task_title)) AS existing
       FROM projects p
       JOIN project_type_task_templates tt ON tt.project_type_id = p.project_type_id
       JOIN task_groups g ON g.id = tt.task_group_id
       JOIN task_types ty ON ty.id = tt.task_type_id
      WHERE p.id = $1
      ORDER BY g.name, tt.sort_order, tt.task_title`,
    [projectId],
  );
  // project people (owner + members, active) and their skills (Users → Skills)
  const { rows: people } = await db.query(
    `SELECT u.id, u.name,
            COALESCE(json_agg(json_build_object('id', l.id, 'name', l.name)) FILTER (WHERE l.id IS NOT NULL), '[]') AS skills
       FROM users u
       LEFT JOIN user_skills us ON us.user_id = u.id
       LEFT JOIN parameter_values l ON l.id = us.skill_id
      WHERE u.is_active
        AND (u.id = (SELECT owner_id FROM projects WHERE id = $1)
             OR u.id IN (SELECT pm.user_id FROM project_members pm WHERE pm.project_id = $1))
      GROUP BY u.id, u.name ORDER BY u.name`,
    [projectId],
  );
  // people who have one of the task's skills – most matching skills first
  const matchesFor = (skillIds) =>
    people
      .map((p) => {
        const need = skillIds.map(Number);
        const shared = p.skills.filter((sk) => need.includes(Number(sk.id)));
        return { userId: p.id, name: p.name, skills: shared.map((sk) => sk.name), count: shared.length };
      })
      .filter((m) => m.count > 0)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .map(({ userId, name, skills }) => ({ userId, name, skills }));
  return rows.map((r) => ({
    id: r.id,
    title: r.task_title,
    description: r.description,
    effortPercentage: r.effort_percentage,
    taskGroupId: r.task_group_id,
    taskGroupName: r.task_group_name,
    taskTypeId: r.task_type_id,
    taskTypeName: r.task_type_name,
    estimatedMinutes: r.estimated_minutes,
    skills: r.skills,
    existing: r.existing,
    matches: matchesFor(r.skill_ids),
  }));
}

/**
 * Creates tasks on the project from the picked template tasks. Common values (owner, dates)
 * apply to all; each picked task can have its own assignee. All or nothing.
 */
export async function createFromTemplate(db, auth, body) {
  await ongoingProject(db, auth, body.projectId);
  const { rows: cat } = await db.query(`SELECT id FROM task_categories WHERE is_project AND is_active ORDER BY display_order, id LIMIT 1`);
  if (!cat[0]) throw badRequest('Add an active task category that needs a project (Task → Task Category) first');
  const templates = await projectTemplates(db, auth, body.projectId);
  const values = [];
  for (const [i, item] of body.items.entries()) {
    const tpl = templates.find((t) => t.id === item.templateId);
    if (!tpl) throw badRequest(`Task ${i + 1} is not in this project's template`, [{ field: `items.${i}.templateId`, message: 'not in the template' }]);
    // each picked task has its own people / plan; anything not sent falls back to the common value
    const own = (k, fallback) => (item[k] !== undefined ? item[k] : body[k] !== undefined ? body[k] : fallback);
    try {
      values.push(
        await validate(db, auth, {
          name: tpl.title,
          description: tpl.description,
          categoryId: cat[0].id,
          projectId: body.projectId,
          taskGroupId: tpl.taskGroupId,
          taskTypeId: tpl.taskTypeId,
          ownerId: own('ownerId', auth.userId),
          assignedTo: own('assignedTo', auth.userId),
          estimatedMinutes: item.estimatedMinutes !== undefined ? item.estimatedMinutes : tpl.estimatedMinutes,
          status: 'to_do',
          plannedStart: own('plannedStart', null),
          plannedEnd: own('plannedEnd', null),
          completedOn: null,
        }),
      );
    } catch (err) {
      // say which picked task is wrong
      if (err.statusCode === 400 || err.statusCode === 403) {
        err.message = `${tpl.title}: ${err.message}`;
        err.details = (err.details ?? []).map((d) => ({ ...d, field: `items.${i}.${d.field}` }));
      }
      throw err;
    }
  }
  const ids = await db.tx(async (client) => {
    const out = [];
    for (const v of values) out.push(await insertTask(client, auth, v, `Task "${v.name}" created from the project template`));
    return out;
  });
  return { created: ids.length, ids };
}

/**
 * The project's planned task groups, for "add tasks from the plan": each group's periods and the tasks it gets –
 * the project type's template tasks of that group (or one task named after the group when it has none).
 * A task that already exists on the project (same name) is marked `existing`.
 */
export async function planTasks(db, auth, projectId) {
  await ongoingProject(db, auth, projectId);
  const [project, groups, weeks, templates, names] = await Promise.all([
    db.query(`SELECT estimated_hours FROM projects WHERE id = $1`, [projectId]),
    db.query(
      `SELECT g.id, g.name, e.effort_percentage FROM project_effort_estimates e JOIN task_groups g ON g.id = e.task_group_id
        WHERE e.project_id = $1 AND e.effort_percentage > 0 ORDER BY e.effort_percentage DESC, g.name`,
      [projectId],
    ),
    db.query(`SELECT task_group_id, week_start::text AS week_start FROM project_plan_weeks WHERE project_id = $1`, [projectId]),
    db.query(
      `SELECT tt.id, tt.task_title, tt.description, tt.task_group_id, tt.task_type_id, ty.name AS task_type_name, tt.effort_percentage
         FROM projects p
         JOIN project_type_task_templates tt ON tt.project_type_id = p.project_type_id
         JOIN task_types ty ON ty.id = tt.task_type_id
        WHERE p.id = $1 ORDER BY tt.sort_order, tt.task_title`,
      [projectId],
    ),
    db.query(`SELECT lower(name) AS name FROM tasks WHERE project_id = $1 AND is_active`, [projectId]),
  ]);
  const periods = periodsOf(weeks.rows);
  const hours = Number(project.rows[0]?.estimated_hours) || 0;
  const have = new Set(names.rows.map((r) => r.name));
  const minutes = (pct) => (hours && Number(pct) > 0 ? Math.round((hours * 60 * Number(pct)) / 100) : null);
  return {
    groups: groups.rows.map((g) => {
      const own = templates.rows.filter((t) => Number(t.task_group_id) === g.id);
      const groupMinutes = minutes(g.effort_percentage);
      // a template task with its own effort % uses it; the rest of the group's hours is shared evenly by the others
      const fixed = own.reduce((n, t) => n + (minutes(t.effort_percentage) ?? 0), 0);
      const open = own.filter((t) => minutes(t.effort_percentage) === null).length;
      const share = groupMinutes && open ? Math.max(0, Math.round((groupMinutes - fixed) / open)) || null : null;
      const tasks = own.length
        ? own.map((t) => ({
            templateId: t.id,
            title: t.task_title,
            description: t.description,
            taskTypeId: t.task_type_id,
            taskTypeName: t.task_type_name,
            estimatedMinutes: minutes(t.effort_percentage) ?? share,
            existing: have.has(t.task_title.toLowerCase()),
          }))
        : [{ templateId: null, title: g.name, description: null, taskTypeId: null, taskTypeName: null, estimatedMinutes: groupMinutes, existing: have.has(g.name.toLowerCase()) }];
      return {
        taskGroupId: g.id,
        name: g.name,
        effortPercentage: Number(g.effort_percentage),
        estimatedMinutes: groupMinutes,
        periods: periods.get(g.id) ?? [],
        tasks,
      };
    }),
  };
}

/**
 * Creates every task of the picked planned task groups – the group's template tasks (type included), or one task
 * named after the group when it has none – with the dates of the group's first planned period
 * (09:00 on its first day to 18:00 on its last). Tasks that already exist on the project are skipped. All or nothing.
 */
export async function createFromPlan(db, auth, body) {
  const project = await ongoingProject(db, auth, body.projectId);
  const { rows: cat } = await db.query(`SELECT id FROM task_categories WHERE is_project AND is_active ORDER BY display_order, id LIMIT 1`);
  if (!cat[0]) throw badRequest('Add an active task category that needs a project (Task → Task Category) first');
  const plan = await planTasks(db, auth, body.projectId);
  const zone = safeZone(auth.timeZone);
  const values = [];
  let skipped = 0;
  for (const [i, item] of body.items.entries()) {
    const g = plan.groups.find((x) => x.taskGroupId === item.taskGroupId);
    const field = (m) => [{ field: `items.${i}.taskGroupId`, message: m }];
    if (!g) throw badRequest('A task group is not in the project estimate', field('not in the estimate'));
    if (!g.periods.length) throw badRequest(`${g.name} is not planned yet – place it in the Plan tab first`, field('not planned'));
    const todo = g.tasks.filter((t) => !t.existing);
    skipped += g.tasks.length - todo.length;
    if (!todo.length) throw badRequest(`All the tasks of ${g.name} already exist on this project`, field('already made'));
    const period = g.periods[0];
    const { rows } = await db.query(`SELECT (($1::date + time '09:00') AT TIME ZONE $3) AS s, (($2::date + time '18:00') AT TIME ZONE $3) AS e`, [period.start, period.end, zone]);
    const ownerId = item.ownerId ?? body.ownerId ?? project.ownerId ?? auth.userId;
    // some tasks of the group can go to someone else
    const other = new Map((item.assignees ?? []).map((a) => [a.title.toLowerCase(), a.assignedTo]));
    for (const t of todo) {
      values.push(
        await validate(db, auth, {
          name: t.title,
          description: t.description ?? null,
          categoryId: cat[0].id,
          projectId: body.projectId,
          taskGroupId: g.taskGroupId,
          taskTypeId: t.taskTypeId ?? null,
          ownerId,
          assignedTo: other.get(t.title.toLowerCase()) ?? item.assignedTo ?? body.assignedTo ?? ownerId,
          estimatedMinutes: t.estimatedMinutes,
          status: 'to_do',
          plannedStart: rows[0].s.toISOString(),
          plannedEnd: rows[0].e.toISOString(),
          completedOn: null,
          fromPlan: true,
        }),
      );
    }
  }
  const ids = await db.tx(async (client) => {
    const out = [];
    for (const v of values) out.push(await insertTask(client, auth, v, `Task "${v.name}" created from the project plan`));
    return out;
  });
  return { created: ids.length, skipped, ids };
}

/** Activity tab: the task's history (created, status changes, edits), newest first. */
export async function taskActivity(db, auth, id) {
  const task = await loadTask(db, auth, id); // existence + scope
  if (isMasked(auth, task)) return []; // a personal task: no history
  const { rows } = await db.query(
    `SELECT a.id, a.action, a.message, a.logged_at, u.name AS user_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity = 'tasks' AND a.entity_id = $1
      ORDER BY a.logged_at DESC, a.id DESC LIMIT 100`,
    [id],
  );
  return rows.map((r) => ({ id: r.id, action: r.action, message: r.message, userName: r.user_name, at: r.logged_at }));
}

/**
 * Efforts: the time people logged in the timesheet against this task.
 * The task owner / creator, the project owner and managers see everyone's; others only their own.
 */
export async function taskEfforts(db, auth, id) {
  const task = await loadTask(db, auth, id);
  const seesAll = canManage(auth, task) || task.project_owner_id === auth.userId;
  const { rows } = await db.query(
    `SELECT t.id, t.work_date, t.minutes, t.comment, t.user_id, u.name AS user_name
       FROM timesheets t
       JOIN users u ON u.id = t.user_id
      WHERE t.task_id = $1 AND ($2::boolean OR t.user_id = $3)
      ORDER BY t.work_date DESC, u.name, t.id DESC`,
    [id, seesAll, auth.userId],
  );
  const people = new Map();
  for (const r of rows) {
    const p = people.get(r.user_id) ?? { userId: r.user_id, name: r.user_name, minutes: 0, days: new Set(), lastDate: r.work_date };
    p.minutes += r.minutes;
    p.days.add(r.work_date);
    people.set(r.user_id, p);
  }
  return {
    seesAll,
    estimatedMinutes: task.estimated_minutes,
    totalMinutes: rows.reduce((n, r) => n + r.minutes, 0),
    taskMinutes: rows.reduce((n, r) => n + r.minutes, 0),
    people: [...people.values()].map((p) => ({ ...p, days: p.days.size })).sort((a, b) => b.minutes - a.minutes),
    entries: rows.map((r) => ({ id: r.id, date: r.work_date, userId: r.user_id, userName: r.user_name, comment: r.comment, minutes: r.minutes })),
  };
}

export async function deleteTask(db, auth, id) {
  const before = await loadTask(db, auth, id);
  if (!canDelete(auth, before)) throw forbidden('Only the task owner or the person who created it can delete it');
  const { rows } = await db.query(
    `SELECT (SELECT count(*)::int FROM timesheets WHERE task_id = $1) AS entries`,
    [id],
  );
  if (rows[0].entries) throw badRequest(`Time is logged on this task (${rows[0].entries} entr${rows[0].entries === 1 ? 'y' : 'ies'}) – it cannot be deleted`);
  await db.tx(async (client) => {
    await client.query(`DELETE FROM tasks WHERE id = $1`, [id]);
    await writeAudit(client, { entity: 'tasks', entityId: id, action: 'delete', userId: auth.userId, message: `Task "${before.name}" deleted` });
  });
}
