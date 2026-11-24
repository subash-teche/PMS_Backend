import { AppError, badRequest, notFound } from '../../utils/errors.js';
import { todayIn } from '../../utils/time.js';
import { currentStep } from './flow.rules.js';
import { addTime } from './flow.time.js';
import { flowStep } from './flow.service.js';

/*
 * The working-day timer: a person keeps an entry per task they work on, with Start, Pause and End.
 * Starting an entry starts the task (it moves to In progress); pausing logs the time and the task stays In progress;
 * ending either completes the person's step or only logs the time. A timer still running when its day ends is
 * abandoned, with no time counted. All time ends up in the PMS Timesheet through addTime.
 */

const conflict = (message) => new AppError(409, 'CONFLICT', message);
const OPEN = ['ready', 'running', 'paused'];

// a timer entry belongs to a member (a person's step on a task); the task comes from the member
const COLS = `e.id, m.task_id, e.member_id, e.day, e.status, e.run_started_at, e.minutes`;
const FROM = `task_timers e JOIN task_members m ON m.id = e.member_id`;
const dto = (r) => ({ id: r.id, taskId: r.task_id, stepId: r.member_id, day: r.day, status: r.status, runStartedAt: r.run_started_at, minutes: r.minutes });
const byId = async (db, id) => dto((await db.query(`SELECT ${COLS} FROM ${FROM} WHERE e.id = $1`, [id])).rows[0]);

/** A timer still running on a day that is over is abandoned. Done lazily, whenever the timer is read or changed. */
async function abandonStale(db, auth) {
  await db.query(
    `UPDATE task_timers SET status = 'abandoned', run_started_at = NULL WHERE user_id = $1 AND status = 'running' AND day < $2::date`,
    [auth.userId, todayIn(auth.timeZone)],
  );
}

async function mine(db, auth, id) {
  await abandonStale(db, auth);
  const { rows } = await db.query(`SELECT e.*, m.task_id FROM ${FROM} WHERE e.id = $1 AND e.user_id = $2`, [id, auth.userId]);
  if (!rows[0]) throw notFound('That timer entry');
  return rows[0];
}

/** The entry's step must still be the one the person holds. */
async function heldStep(db, userId, stepId) {
  const { rows } = await db.query(`SELECT * FROM task_members WHERE id = $1`, [stepId]);
  const step = rows[0];
  if (!step) throw notFound('That step');
  const { rows: steps } = await db.query(`SELECT * FROM task_members WHERE task_id = $1`, [step.task_id]);
  const current = currentStep(steps);
  if (!current || current.id !== step.id || step.user_id !== userId) throw conflict('You no longer hold this task');
  return step;
}

const taskVersion = async (db, id) => (await db.query(`SELECT version FROM tasks WHERE id = $1`, [id])).rows[0].version;
const taskRow = async (db, id) => (await db.query(`SELECT * FROM tasks WHERE id = $1`, [id])).rows[0];

/** The last 30 days, plus anything still open. */
export async function listEntries(db, auth) {
  await abandonStale(db, auth);
  const { rows } = await db.query(
    `SELECT ${COLS} FROM ${FROM} WHERE e.user_id = $1 AND (e.day >= $2::date - 30 OR e.status = ANY($3)) ORDER BY e.day DESC, e.id`,
    [auth.userId, todayIn(auth.timeZone), OPEN],
  );
  return rows.map(dto);
}

async function addEntry(db, auth, stepId, on) {
  const step = await heldStep(db, auth.userId, stepId);
  if (step.status !== 'todo' && step.status !== 'active') throw conflict('Accept the task first');
  const { rows: dup } = await db.query(
    `SELECT 1 FROM task_timers WHERE user_id = $1 AND member_id = $2 AND day = $3 AND status = ANY($4)`,
    [auth.userId, stepId, on, OPEN],
  );
  if (dup[0]) throw conflict('This task is already in your timer for that day');
  const { rows } = await db.query(`INSERT INTO task_timers (user_id, member_id, day) VALUES ($1, $2, $3) RETURNING id`, [auth.userId, stepId, on]);
  return byId(db, rows[0].id);
}

export async function createEntry(db, auth, { stepId, day }) {
  const today = todayIn(auth.timeZone);
  const on = day ?? today;
  if (on < today) throw badRequest('A timer entry cannot be added to a past day');
  await abandonStale(db, auth);
  return addEntry(db, auth, stepId, on);
}

/** Start (or carry on after a pause). One timer at a time is not forced; starting a task that was only accepted moves it to In progress. */
export async function startEntry(db, auth, id) {
  const entry = await mine(db, auth, id);
  if (entry.status !== 'ready' && entry.status !== 'paused') throw conflict(`A ${entry.status} entry cannot be started`);
  const today = todayIn(auth.timeZone);
  if (entry.day > today) throw conflict('This entry is for a later day');
  const step = await heldStep(db, auth.userId, entry.member_id);
  if (step.status === 'todo') await flowStep(db, auth, entry.task_id, await taskVersion(db, entry.task_id), ['start']);
  await db.query(`UPDATE task_timers SET status = 'running', run_started_at = now(), day = $2 WHERE id = $1`, [id, today]);
  return byId(db, id);
}

/** Pause: the minutes are logged and the task stays In progress. */
export async function pauseEntry(db, auth, id, { minutes, note }) {
  const entry = await mine(db, auth, id);
  if (entry.status !== 'running') throw conflict('Only a running timer can be paused');
  return db.tx(async (c) => {
    await addTime(c, { userId: auth.userId, timeZone: auth.timeZone, task: await taskRow(c, entry.task_id), minutes, note });
    await c.query(`UPDATE task_timers SET status = 'paused', run_started_at = NULL, minutes = minutes + $2 WHERE id = $1`, [id, minutes]);
    return byId(c, id);
  });
}

/** End: complete the task (close my step and pass it on) or only log the time (the task stays In progress). */
export async function endEntry(db, auth, id, { complete, minutes, note, comment }) {
  const entry = await mine(db, auth, id);
  if (entry.status !== 'running' && entry.status !== 'paused') throw conflict('Start the timer before ending it');
  const step = await heldStep(db, auth.userId, entry.member_id);
  if (complete) {
    if (step.status !== 'active') throw conflict('This task is not in progress');
    await flowStep(db, auth, entry.task_id, await taskVersion(db, entry.task_id), ['close'], { minutes, note: comment });
  } else {
    await db.tx(async (c) => {
      await addTime(c, { userId: auth.userId, timeZone: auth.timeZone, task: await taskRow(c, entry.task_id), minutes, note });
      // only the time was logged: that day's plan is done ("done for today"), the task itself stays open
      await c.query(
        `UPDATE daily_plan_items SET is_done = true, updated_by = $1
          WHERE user_id = $1 AND plan_date = $2 AND task_id = $3 AND NOT is_done`,
        [auth.userId, entry.day, entry.task_id],
      );
    });
  }
  await db.query(`UPDATE task_timers SET status = 'ended', run_started_at = NULL, minutes = minutes + $2 WHERE id = $1`, [id, minutes]);
  return byId(db, id);
}

/** An abandoned entry can be moved to a day... */
export async function moveEntry(db, auth, id, { day }) {
  const entry = await mine(db, auth, id);
  if (entry.status !== 'abandoned') throw conflict('Only an abandoned entry can be moved');
  if (day < todayIn(auth.timeZone)) throw badRequest('Pick today or a later day');
  await heldStep(db, auth.userId, entry.member_id);
  // time was already logged on this task on that day: the day keeps it, so the entry can only be copied
  const { rows: worked } = await db.query(
    `SELECT 1 FROM timesheets WHERE from_board AND user_id = $1 AND task_id = $2 AND work_date = $3 AND minutes > 0
     UNION ALL SELECT 1 FROM task_timers WHERE user_id = $1 AND member_id = $4 AND day = $3 AND minutes > 0 AND id <> $5 LIMIT 1`,
    [auth.userId, entry.task_id, entry.day, entry.member_id, id],
  );
  if (worked[0]) throw conflict('Time was already logged on this task on that day, so it cannot be moved. Copy it to another day instead.');
  const { rows: dup } = await db.query(
    `SELECT 1 FROM task_timers WHERE user_id = $1 AND member_id = $2 AND day = $3 AND status = ANY($4)`,
    [auth.userId, entry.member_id, day, OPEN],
  );
  if (dup[0]) throw conflict('This task is already in your timer for that day');
  await db.query(`UPDATE task_timers SET day = $2, status = 'ready', run_started_at = NULL, minutes = 0 WHERE id = $1`, [id, day]);
  return byId(db, id);
}

/** ...or copied there (the abandoned one stays as a record). */
export async function copyEntry(db, auth, id, { day }) {
  const entry = await mine(db, auth, id);
  if (day < todayIn(auth.timeZone)) throw badRequest('Pick today or a later day');
  return addEntry(db, auth, entry.member_id, day);
}

/** Take back an entry that was never started. */
export async function removeEntry(db, auth, id) {
  const entry = await mine(db, auth, id);
  if (entry.status !== 'ready') throw conflict('Only an entry that was not started can be removed');
  await db.query(`DELETE FROM task_timers WHERE id = $1`, [id]);
}
