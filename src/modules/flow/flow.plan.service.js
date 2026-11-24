import { AppError, badRequest, notFound } from '../../utils/errors.js';
import { todayIn } from '../../utils/time.js';
import { slotOf, startOfWeek, weekDays, weeksIn } from './flow.weeks.js';

/*
 * The Plan: each person plans their own steps by week of the month (a whole week, or a day in it).
 * Everyone can read anyone's plan (the Board shows it); only the owner changes it. A day that is over is closed.
 */

const conflict = (message) => new AppError(409, 'CONFLICT', message);
const forbidden = (message) => new AppError(403, 'FORBIDDEN', message);

/** A plan: steps not done yet, plus the ones closed in the last 45 days so a finished item stays visible, ticked off, in its month. */
export async function listPlan(db, userId) {
  const { rows } = await db.query(
    `SELECT pi.id, s.task_id, pi.member_id, pi.scope, pi.start_date, pi.position
       FROM plan_items pi JOIN task_members s ON s.id = pi.member_id
      WHERE s.user_id = $1 AND (s.status <> 'done' OR s.closed_at > now() - interval '45 days')
      ORDER BY pi.start_date, pi.position, pi.id`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, taskId: r.task_id, stepId: r.member_id, scope: r.scope, startDate: r.start_date, position: r.position }));
}

/**
 * Put a step in a week of a month (or on a day of it), or take it out of the plan (slot null).
 * body: { stepId, slot: { month, week, day? } | null, before?, from?, copy?, dropTime? }
 */
export async function setPlan(db, auth, body) {
  const { stepId, slot, before, from, copy, dropTime } = body;
  const me = auth.userId;
  const today = todayIn(auth.timeZone);

  return db.tx(async (c) => {
    const { rows: stepRows } = await c.query(`SELECT * FROM task_members WHERE id = $1`, [stepId]);
    const step = stepRows[0];
    if (!step) throw notFound('That step');
    if (step.user_id !== me) throw forbidden('You can only plan your own steps');
    // A day that is over is closed - except that a task that was not finished there can be carried over to another day.
    if (from && from < today && !(slot && step.status !== 'done')) throw conflict('A past day cannot be changed');

    if (slot === null || slot === undefined) {
      await c.query(`DELETE FROM plan_items WHERE member_id = $1 AND ($2::date IS NULL OR start_date = $2::date)`, [stepId, from ?? null]);
      if (dropTime && from) {
        // also take back the time logged on the board on that day
        await c.query(`DELETE FROM timesheets WHERE task_id = $1 AND user_id = $2 AND work_date = $3 AND from_board`, [step.task_id, me, from]);
        await c.query(`DELETE FROM task_timers WHERE member_id = $1 AND user_id = $2 AND day = $3`, [stepId, me, from]);
      }
      return { ok: true };
    }

    if (slot.week > weeksIn(slot.month)) throw badRequest(`${slot.month} has no week ${slot.week}`);
    const range = weekDays(slot);
    if (slot.day !== undefined && (slot.day < range.from || slot.day > range.to)) throw badRequest('That day is not in that week');
    const startDate = startOfWeek(slot);
    if (slot.day !== undefined && startDate < today) throw conflict('A past day cannot be changed');
    const scope = slot.day === undefined ? 'week' : 'day';

    const { rows: nextRows } = await c.query(`SELECT COALESCE(max(pi.position), 0) + 1 AS next FROM plan_items pi JOIN task_members s ON s.id = pi.member_id WHERE s.user_id = $1`, [me]);
    const next = nextRows[0].next;
    const { rows } = await c.query(`SELECT * FROM plan_items WHERE member_id = $1`, [stepId]);
    const src = from ? rows.find((r) => r.start_date === from) : copy ? undefined : rows[0];
    const dst = rows.find((r) => r.start_date === startDate);
    const insert = () =>
      c.query(`INSERT INTO plan_items (member_id, scope, start_date, position) VALUES ($1, $2, $3, $4)`, [stepId, scope, startDate, next]);

    if (copy) {
      if (!dst) await insert();
    } else if (src && dst && src.id !== dst.id) {
      await c.query(`DELETE FROM plan_items WHERE id = $1`, [src.id]); // it was already planned on that day: the two become one
    } else if (src && !dst) {
      await c.query(`UPDATE plan_items SET scope = $2, start_date = $3, position = $4 WHERE id = $1`, [src.id, scope, startDate, next]);
    } else if (dst) {
      await c.query(`UPDATE plan_items SET scope = $2, position = $3 WHERE id = $1`, [dst.id, scope, next]);
    } else {
      await insert();
    }

    if (before !== undefined) {
      // number the day's tasks again with this one in its new place
      const { rows: day } = await c.query(
        `SELECT pi.id, pi.member_id FROM plan_items pi JOIN task_members s ON s.id = pi.member_id WHERE s.user_id = $1 AND pi.start_date = $2 ORDER BY pi.position, pi.id`,
        [me, startDate],
      );
      const moved = day.find((r) => r.member_id === stepId);
      const others = day.filter((r) => r.member_id !== stepId);
      const at = before === null ? others.length : others.findIndex((r) => r.member_id === before);
      if (moved) others.splice(at < 0 ? others.length : at, 0, moved);
      for (const [i, r] of others.entries()) await c.query(`UPDATE plan_items SET position = $2 WHERE id = $1`, [r.id, i + 1]);
    }
    return { ok: true };
  });
}

/**
 * What the user planned in Task Management for a day, for the 1-3-5 page: the steps they hold that are planned on that day
 * (a day plan), plus the ones planned for the whole week that includes it. `inSlot` marks those already on their 1-3-5 that day.
 */
export async function planForDay(db, auth, date, { includeDone = false } = {}) {
  const weekStart = startOfWeek(slotOf(date)); // a whole-week plan is stored on the first day of its week
  const { rows } = await db.query(
    `SELECT pi.id, pi.scope, pi.start_date, pi.position, t.id AS task_id, t.name AS title, t.status AS task_status,
            (t.planned_end AT TIME ZONE 'Asia/Dubai')::date AS due_date,
            s.status AS step_status, p.id AS project_id, p.code AS project_code, p.title AS project_title,
            (SELECT i.id FROM daily_plan_items i WHERE i.user_id = s.user_id AND i.plan_date = $2::date AND i.task_id = t.id) AS item_id
       FROM plan_items pi
       JOIN task_members s ON s.id = pi.member_id
       JOIN tasks t ON t.id = s.task_id
       JOIN projects p ON p.id = t.project_id
      WHERE s.user_id = $1 AND (s.status <> 'done' OR ($4::boolean AND pi.scope = 'day')) -- includeDone: finished tasks of that day too
        AND ((pi.scope = 'day' AND pi.start_date = $2::date)
          OR (pi.scope = 'week' AND pi.start_date = $3::date AND NOT EXISTS (
                SELECT 1 FROM plan_items d WHERE d.member_id = pi.member_id AND d.scope = 'day' AND d.start_date = $2::date)))
      ORDER BY (s.status = 'done'), (pi.scope = 'day') DESC, pi.position, pi.id`, // open tasks first, finished ones after: the Plan shows them the same way
    [auth.userId, date, weekStart, includeDone],
  );
  return rows.map((r) => ({
    taskId: r.task_id,
    title: r.title,
    scope: r.scope,
    stepStatus: r.step_status,
    taskStatus: r.task_status,
    dueDate: r.due_date,
    projectId: r.project_id,
    projectCode: r.project_code,
    projectTitle: r.project_title,
    inSlot: Boolean(r.item_id),
  }));
}
