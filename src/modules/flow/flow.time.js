import { badRequest, conflict } from '../../utils/errors.js';
import { writeAudit } from '../../utils/audit.js';
import { todayIn } from '../../utils/time.js';

// Time logged on a task is a PMS Timesheet row marked from_board (locked there), so project hours and costs include it.

const DAY_LIMIT = 24 * 60; // same limit as the PMS Timesheet

/** Minutes the user can still log on a day. */
export async function roomOnDay(client, userId, date) {
  const { rows } = await client.query(`SELECT COALESCE(sum(minutes), 0)::int AS m FROM timesheets WHERE user_id = $1 AND work_date = $2`, [userId, date]);
  return Math.max(0, DAY_LIMIT - rows[0].m);
}

/**
 * Logs `minutes` on a task for a person. `task` is the tasks row, `clamp` limits an automatic value (e.g. time since the
 * step started) to what is left of the day instead of failing; an explicit value over the daily limit is rejected.
 * Returns the minutes logged (0 when nothing was).
 */
export async function addTime(client, { userId, timeZone, task, minutes, note = '', workDate, clamp = false }) {
  const date = workDate ?? todayIn(timeZone);
  if (!(minutes > 0)) {
    // no time to add, but the note still belongs in the Timesheet: it goes on the latest board entry of that task and day
    if (note) {
      await client.query(
        `UPDATE timesheets SET comment = CASE WHEN comment IS NULL OR comment = '' THEN $4 ELSE comment || E'\\n' || $4 END, updated_by = $1
          WHERE id = (SELECT id FROM timesheets WHERE from_board AND user_id = $1 AND task_id = $2 AND work_date = $3 ORDER BY created_at DESC, id DESC LIMIT 1)`,
        [userId, task.id, date, note],
      );
    }
    return 0;
  }
  if (date > todayIn(timeZone)) throw badRequest('Time cannot be logged for a future day');
  const room = await roomOnDay(client, userId, date);
  if (minutes > room) {
    if (!clamp) throw conflict(`That would be more than 24 hours on ${date} in your timesheet (${Math.floor(room / 60)}h ${room % 60}m left)`);
    minutes = room;
    if (!(minutes > 0)) return 0;
  }

  const { rows: meta } = await client.query(`SELECT p.is_billable FROM projects p WHERE p.id = $1`, [task.project_id]);
  await client.query(
    `INSERT INTO timesheets (user_id, work_date, task_id, minutes, comment, is_billable, from_board, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, true, $1, $1)`,
    [userId, date, task.id, minutes, note || null, meta[0]?.is_billable ?? true],
  );
  await writeAudit(client, { entity: 'tasks', entityId: task.id, action: 'update', userId, message: `logged time: ${minutes} min` });
  return minutes;
}
