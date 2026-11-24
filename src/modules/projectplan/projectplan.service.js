import { writeAudit } from '../../utils/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../utils/errors.js';
import { safeZone } from '../../utils/time.js';
import { assertGroupsRemovable } from './plan-guard.js';
import { tabAccess } from '../projects/project-access.js';

/*
 * Project Plan tab: the project's task groups planned per week, from the project start to its end.
 * Only the project owner sees and edits it. It is a plan only – no tasks or time entries are made.
 */

const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(`${s}T00:00:00Z`);
/** The Monday of the week of `s` (YYYY-MM-DD). */
const mondayOf = (s) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return iso(d);
};

const addDays = (s, n) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/**
 * Runs of neighbouring planned weeks per task group → its periods, in date order:
 * { start: Monday of the first week, end: Friday of the last week (Saturday and Sunday are not working days), weeks }.
 * rows = [{ task_group_id, week_start: 'YYYY-MM-DD' }]; the result is a Map task group id → periods.
 */
export function periodsOf(rows) {
  const byGroup = new Map();
  for (const r of rows) byGroup.set(Number(r.task_group_id), [...(byGroup.get(Number(r.task_group_id)) ?? []), r.week_start]);
  const out = new Map();
  for (const [gid, weeks] of byGroup) {
    const runs = [];
    for (const w of [...new Set(weeks)].sort()) {
      const last = runs[runs.length - 1];
      if (last && addDays(last.lastWeek, 7) === w) {
        last.lastWeek = w;
        last.weeks += 1;
      } else runs.push({ firstWeek: w, lastWeek: w, weeks: 1 });
    }
    out.set(gid, runs.map((r) => ({ start: r.firstWeek, end: addDays(r.lastWeek, 4), weeks: r.weeks })));
  }
  return out;
}

/** The saved periods of a project's plan (Map task group id → periods). */
export async function loadPeriods(db, projectId) {
  const { rows } = await db.query(`SELECT task_group_id, week_start::text AS week_start FROM project_week_plans WHERE project_id = $1`, [projectId]);
  return periodsOf(rows);
}

/** The role's access to the Plan tab (Roles → Project access): 'view' needs more than Hidden, 'edit' needs Edit. */
function needPlanTab(auth, level) {
  const a = tabAccess(auth, 'plan');
  if (a === 'hidden' || (level === 'edit' && a !== 'edit')) throw forbidden(level === 'edit' ? 'Your role can only view the Plan tab' : 'Your role cannot see the Plan tab');
}

/** The project, for its owner only. */
async function ownProject(db, auth, id) {
  const { rows } = await db.query(
    `SELECT p.id, p.owner_id, p.start_date::text AS start_date, p.end_date::text AS end_date, p.estimated_hours,
            (SELECT COALESCE(SUM(e.effort_percentage), 0) FROM project_task_group_estimates e WHERE e.project_id = p.id) AS allocated
       FROM projects p WHERE p.id = $1`,
    [id],
  );
  const p = rows[0];
  if (!p) throw notFound('Project');
  if (p.owner_id !== auth.userId) throw forbidden('Only the project owner can see and change the plan');
  return p;
}

const OPEN_WEEKS = 26; // a project without an end date (e.g. a retainer) is planned this far ahead

/** The last day to plan: the project end, or OPEN_WEEKS after the start when it has none. */
const lastDay = (p) => {
  if (p.end_date) return p.end_date;
  const d = parse(mondayOf(p.start_date));
  d.setUTCDate(d.getUTCDate() + OPEN_WEEKS * 7 - 1);
  return iso(d);
};

/**
 * The plan needs a finished estimate: estimated hours and the effort split at 100 %.
 * Returns what is missing (null when ready).
 */
function estimateGap(p) {
  if (!(Number(p.estimated_hours) > 0)) return 'Set the estimated hours on the Estimate tab first.';
  const allocated = Number(p.allocated);
  if (Math.abs(allocated - 100) > 0.01) return `The effort split is at ${Math.round(allocated * 100) / 100}% – make it 100% on the Estimate tab first.`;
  return null;
}

/** Weeks (Monday – Sunday) covering the project from its start to its end. */
function weeksOf(p) {
  if (!p.start_date || (p.end_date && p.end_date < p.start_date)) return [];
  const last = lastDay(p);
  const out = [];
  for (let d = parse(mondayOf(p.start_date)); iso(d) <= last; d.setUTCDate(d.getUTCDate() + 7)) {
    const end = new Date(d);
    end.setUTCDate(end.getUTCDate() + 6);
    out.push({ start: iso(d), end: iso(end) });
    if (out.length > 520) break; // ten years is plenty
  }
  return out;
}

export async function getPlan(db, auth, id) {
  needPlanTab(auth, 'view');
  const p = await ownProject(db, auth, id);
  const [groups, items, progress, tasks] = await Promise.all([
    // the task groups with a share of the project estimate (largest share first)
    db.query(
      `SELECT g.id, g.name, e.effort_percentage FROM project_task_group_estimates e JOIN task_groups g ON g.id = e.task_group_id
        WHERE e.project_id = $1 AND e.effort_percentage > 0 ORDER BY e.effort_percentage DESC, g.name`,
      [id],
    ),
    db.query(`SELECT id, task_group_id, week_start::text AS week_start FROM project_week_plans WHERE project_id = $1 ORDER BY week_start, id`, [id]),
    // the work done per task group: tasks by status, when it started (first status change or first time logged) and when the last task was completed
    db.query(
      `SELECT t.task_group_id,
              count(*)::int AS total,
              count(*) FILTER (WHERE t.status = 'completed')::int AS completed,
              count(*) FILTER (WHERE t.status = 'in_progress')::int AS in_progress,
              count(*) FILTER (WHERE t.status = 'hold')::int AS hold,
              count(*) FILTER (WHERE t.status = 'to_do')::int AS to_do,
              count(*) FILTER (WHERE t.status <> 'completed' AND NOT t.is_continuous AND t.planned_end < now())::int AS overdue,
              COALESCE(sum(t.estimated_minutes), 0)::int AS estimated_minutes,
              LEAST(min((t.actual_start AT TIME ZONE $2)::date),
                    (SELECT min(x.work_date) FROM timesheets x JOIN tasks tt ON tt.id = x.task_id WHERE tt.project_id = $1 AND tt.task_group_id = t.task_group_id AND tt.is_active))::text AS started,
              (max(t.actual_end) FILTER (WHERE t.status = 'completed') AT TIME ZONE $2)::date::text AS finished,
              (SELECT COALESCE(sum(x.minutes), 0)::int FROM timesheets x JOIN tasks tt ON tt.id = x.task_id WHERE tt.project_id = $1 AND tt.task_group_id = t.task_group_id AND tt.is_active) AS logged_minutes
         FROM tasks t
        WHERE t.project_id = $1 AND t.is_active AND t.task_group_id IS NOT NULL
        GROUP BY t.task_group_id`,
      [id, safeZone(auth.timeZone)],
    ),
    // each task of the groups: its planned dates, when it started and when it was completed
    db.query(
      `SELECT t.id, t.task_group_id, t.task_type_id, tty.name AS task_type_name, t.name, t.status, t.is_continuous, u.name AS assigned_to_name,
              (t.planned_start AT TIME ZONE $2)::date::text AS planned_start,
              (t.planned_end AT TIME ZONE $2)::date::text AS planned_end,
              LEAST((t.actual_start AT TIME ZONE $2)::date, (SELECT min(x.work_date) FROM timesheets x WHERE x.task_id = t.id))::text AS started,
              CASE WHEN t.status = 'completed' THEN COALESCE((t.actual_end AT TIME ZONE $2)::date, t.completed_on)::text END AS finished,
              COALESCE(t.estimated_minutes, 0)::int AS estimated_minutes,
              (SELECT COALESCE(sum(x.minutes), 0)::int FROM timesheets x WHERE x.task_id = t.id) AS logged_minutes,
              (SELECT count(*)::int FROM task_subtasks s WHERE s.task_id = t.id) AS subtask_total,
              (SELECT count(*)::int FROM task_subtasks s WHERE s.task_id = t.id AND s.is_done) AS subtask_done,
              COALESCE((SELECT json_agg(json_build_object('date', q.d::text, 'minutes', q.m) ORDER BY q.d)
                          FROM (SELECT x.work_date AS d, sum(x.minutes)::int AS m FROM timesheets x WHERE x.task_id = t.id GROUP BY x.work_date) q), '[]'::json) AS logs
         FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN task_types tty ON tty.id = t.task_type_id
        WHERE t.project_id = $1 AND t.is_active AND t.task_group_id IS NOT NULL
        ORDER BY t.task_group_id, t.display_order NULLS LAST, t.id`,
      [id, safeZone(auth.timeZone)],
    ),
  ]);
  return {
    startDate: p.start_date,
    endDate: p.end_date,
    openEnded: Boolean(p.start_date && !p.end_date), // no end date: OPEN_WEEKS weeks shown
    estimateGap: estimateGap(p), // set → planning is locked until the estimate is finished
    weeks: weeksOf(p),
    groups: groups.rows.map((g) => ({ id: g.id, name: g.name, effortPercentage: Number(g.effort_percentage) })),
    items: items.rows.map((r) => ({ id: r.id, taskGroupId: r.task_group_id, weekStart: r.week_start })),
    progress: progress.rows.map((r) => ({
      taskGroupId: Number(r.task_group_id),
      total: r.total,
      completed: r.completed,
      inProgress: r.in_progress,
      hold: r.hold,
      toDo: r.to_do,
      overdue: r.overdue,
      estimatedMinutes: r.estimated_minutes,
      loggedMinutes: r.logged_minutes,
      started: r.started,
      finished: r.finished,
    })),
    tasks: tasks.rows.map((r) => ({
      id: r.id,
      taskGroupId: Number(r.task_group_id),
      taskTypeId: r.task_type_id == null ? null : Number(r.task_type_id),
      taskTypeName: r.task_type_name ?? null,
      name: r.name,
      status: r.status,
      isContinuous: r.is_continuous,
      assignedToName: r.assigned_to_name,
      plannedStart: r.planned_start,
      plannedEnd: r.planned_end,
      started: r.started,
      finished: r.finished,
      estimatedMinutes: r.estimated_minutes,
      loggedMinutes: r.logged_minutes,
      subtaskTotal: r.subtask_total,
      subtaskDone: r.subtask_done,
      logs: r.logs,
    })),
  };
}

/** A finished estimate, a week of the project (its Monday) and a group with a share of the estimate. */
async function check(db, p, taskGroupId, weekStart) {
  const gap = estimateGap(p);
  if (gap) throw badRequest(gap);
  if (!weeksOf(p).some((w) => w.start === weekStart)) throw badRequest('Pick a week within the project dates', [{ field: 'weekStart', message: 'not a week of the project' }]);
  const { rowCount } = await db.query(`SELECT 1 FROM project_task_group_estimates WHERE project_id = $1 AND task_group_id = $2 AND effort_percentage > 0`, [p.id, taskGroupId]);
  if (!rowCount) throw badRequest('The task group is not in the project estimate', [{ field: 'taskGroupId', message: 'not in the estimate' }]);
}

export async function addItem(db, auth, id, body) {
  needPlanTab(auth, 'edit');
  const p = await ownProject(db, auth, id);
  await check(db, p, body.taskGroupId, body.weekStart);
  const { rows } = await db.query(
    `INSERT INTO project_week_plans (project_id, task_group_id, week_start, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, task_group_id, week_start) DO NOTHING RETURNING id`,
    [id, body.taskGroupId, body.weekStart, auth.userId],
  );
  if (!rows[0]) throw conflict('This task group is already planned in that week');
  return getPlan(db, auth, id);
}

export async function moveItem(db, auth, id, itemId, body) {
  needPlanTab(auth, 'edit');
  const p = await ownProject(db, auth, id);
  const { rows } = await db.query(`SELECT task_group_id FROM project_week_plans WHERE id = $1 AND project_id = $2`, [itemId, id]);
  if (!rows[0]) throw notFound('Plan item');
  await check(db, p, rows[0].task_group_id, body.weekStart);
  const { rows: clash } = await db.query(
    `SELECT 1 FROM project_week_plans WHERE project_id = $1 AND task_group_id = $2 AND week_start = $3 AND id <> $4`,
    [id, rows[0].task_group_id, body.weekStart, itemId],
  );
  if (clash[0]) throw conflict('This task group is already planned in that week');
  await db.query(`UPDATE project_week_plans SET week_start = $2 WHERE id = $1`, [itemId, body.weekStart]);
  return getPlan(db, auth, id);
}

/** Saves the whole plan at once: the planned (task group, week) pairs replace what was saved. */
export async function savePlan(db, auth, id, body) {
  needPlanTab(auth, 'edit');
  const p = await ownProject(db, auth, id);
  const gap = estimateGap(p);
  if (gap) throw badRequest(gap);
  const weeks = new Set(weeksOf(p).map((w) => w.start));
  const { rows } = await db.query(`SELECT task_group_id FROM project_task_group_estimates WHERE project_id = $1 AND effort_percentage > 0`, [id]);
  const groups = new Set(rows.map((r) => Number(r.task_group_id)));
  const { rows: planned } = await db.query(`SELECT DISTINCT task_group_id FROM project_week_plans WHERE project_id = $1`, [id]);
  const seen = new Set();
  const items = [];
  for (const it of body.items) {
    if (!weeks.has(it.weekStart)) throw badRequest('Pick weeks within the project dates', [{ field: 'items', message: 'a week is not a week of the project' }]);
    if (!groups.has(it.taskGroupId)) throw badRequest('A task group is not in the project estimate', [{ field: 'items', message: 'a task group is not in the estimate' }]);
    const k = `${it.taskGroupId}|${it.weekStart}`;
    if (!seen.has(k)) {
      seen.add(k);
      items.push(it);
    }
  }
  // a task group with tasks made from the plan cannot leave the plan while they are open
  const staying = new Set(items.map((i) => i.taskGroupId));
  await assertGroupsRemovable(
    db,
    id,
    planned.map((r) => Number(r.task_group_id)).filter((g) => !staying.has(g)),
    body.confirmRemove === true,
    'items',
  );
  await db.tx(async (client) => {
    await client.query(`DELETE FROM project_week_plans WHERE project_id = $1`, [id]);
    if (items.length) {
      await client.query(
        `INSERT INTO project_week_plans (project_id, task_group_id, week_start, created_by)
         SELECT $1, t.g, t.w::date, $4 FROM unnest($2::bigint[], $3::text[]) AS t(g, w)`,
        [id, items.map((i) => i.taskGroupId), items.map((i) => i.weekStart), auth.userId],
      );
    }
  });
  return { ...(await getPlan(db, auth, id)), applyCandidates: await applyCandidates(db, auth, id) };
}

/**
 * Task groups whose open plan tasks do not sit in the group's (first) planned period any more –
 * the owner is asked whether to apply the new period to them.
 */
async function applyCandidates(db, auth, id) {
  const periods = await loadPeriods(db, id);
  const { rows } = await db.query(
    `SELECT t.task_group_id, g.name,
            (t.planned_start AT TIME ZONE $2)::date::text AS s, (t.planned_end AT TIME ZONE $2)::date::text AS e
       FROM tasks t JOIN task_groups g ON g.id = t.task_group_id
      WHERE t.project_id = $1 AND t.from_plan AND t.is_active AND t.status <> 'completed'`,
    [id, safeZone(auth.timeZone)],
  );
  const out = new Map();
  for (const r of rows) {
    const period = periods.get(Number(r.task_group_id))?.[0];
    if (!period || (r.s === period.start && r.e === period.end)) continue;
    const c = out.get(Number(r.task_group_id)) ?? { taskGroupId: Number(r.task_group_id), name: r.name, tasks: 0, start: period.start, end: period.end };
    c.tasks += 1;
    out.set(c.taskGroupId, c);
  }
  return [...out.values()];
}

/** Applies the (first) planned period of the task groups to their open plan tasks. */
export async function applyPlan(db, auth, id, body) {
  needPlanTab(auth, 'edit');
  await ownProject(db, auth, id);
  const periods = await loadPeriods(db, id);
  const zone = safeZone(auth.timeZone);
  let updated = 0;
  await db.tx(async (client) => {
    for (const gid of body.taskGroupIds) {
      const period = periods.get(gid)?.[0];
      if (!period) continue;
      const res = await client.query(
        `UPDATE tasks SET planned_start = ($3::date + time '09:00') AT TIME ZONE $5, planned_end = ($4::date + time '18:00') AT TIME ZONE $5,
                is_continuous = false, updated_by = $6
          WHERE project_id = $1 AND task_group_id = $2 AND from_plan AND is_active AND status <> 'completed'`,
        [id, gid, period.start, period.end, zone, auth.userId],
      );
      updated += res.rowCount;
    }
    if (updated) await writeAudit(client, { entity: 'projects', entityId: id, action: 'update', userId: auth.userId, message: `Plan period applied to ${updated} task(s)` });
  });
  return { updated };
}

export async function removeItem(db, auth, id, itemId) {
  needPlanTab(auth, 'edit');
  await ownProject(db, auth, id);
  await db.query(`DELETE FROM project_week_plans WHERE id = $1 AND project_id = $2`, [itemId, id]);
  return getPlan(db, auth, id);
}
