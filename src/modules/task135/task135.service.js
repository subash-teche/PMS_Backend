import { badRequest, conflict, notFound } from '../../utils/errors.js';
import { todayIn } from '../../utils/time.js';
import { canUseFlow } from '../../config/flow.js';
import { planForDay, setPlan } from '../flow/flow.plan.service.js';
import { slotOf, startOfWeek } from '../flow/flow.weeks.js';

/*
 * 1-3-5 planner: each user plans a day as 1 big, 3 medium and 5 small tasks (positions 1–9).
 * A slot is one of the person's tasks on a day: it stores only the task, the person, the day and whether the day's plan is done.
 * Everything else (the title, the project, the status, the time logged that day) is read from the task.
 * Done here is the planner's own – the task status is never changed.
 * Positions are kept 1..n without gaps.
 */

export const SLOTS = 9;

const SELECT = `
  SELECT i.id, i.plan_date, i.position, i.task_id, t.name AS title,
         -- the time the person logged on the task that day
         (SELECT COALESCE(sum(l.minutes), 0)::int FROM timesheets l WHERE l.task_id = i.task_id AND l.user_id = i.user_id AND l.work_date = i.plan_date AND l.from_board) AS minutes,
         (SELECT s2.status FROM task_members s2 WHERE s2.task_id = i.task_id AND s2.user_id = i.user_id ORDER BY (s2.status = 'done'), s2.position LIMIT 1) AS step_status,
         (t.planned_end AT TIME ZONE 'Asia/Dubai')::date AS due_date,
         -- the same task is planned on a later day too: on a day that is over this slot is a Carryover record
         EXISTS (SELECT 1 FROM plan_items pi JOIN task_members m ON m.id = pi.member_id
                  WHERE m.user_id = i.user_id AND m.task_id = i.task_id AND pi.scope = 'day' AND pi.start_date > i.plan_date) AS later_plan,
         i.is_done, t.status AS task_status,
         p.id AS project_id, p.code AS project_code, p.title AS project_title,
         i.user_id, ou.name AS user_name, tc.id AS category_id, tc.name AS category_name
    FROM daily_plan_items i
    JOIN tasks t ON t.id = i.task_id
    LEFT JOIN users ou ON ou.id = i.user_id
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN task_categories tc ON tc.id = t.task_category_id`;

const toDto = (r, today = todayIn('Asia/Dubai')) => ({
  // went on to a later day: this day keeps only the record - unless the person ticked the day done ("done for today")
  carryover: Boolean(r.later_plan) && r.plan_date < today && !r.is_done,
  id: r.id,
  date: r.plan_date,
  position: r.position,
  size: r.position === 1 ? 'big' : r.position <= 4 ? 'medium' : 'small',
  taskId: r.task_id,
  title: r.title,
  minutes: r.minutes,
  // a slot is done when the person's own step is finished
  isDone: Boolean(r.is_done) || (r.step_status === 'done' && !(r.later_plan && r.plan_date < today)),
  // the day's plan is done, but the task itself is not finished: it goes on another day without being a carryover
  planDone: Boolean(r.is_done) && r.step_status !== 'done',
  taskStatus: r.task_status,
  projectId: r.project_id,
  categoryId: r.category_id, // the task's category (Project, Personal, Activity …)
  categoryName: r.category_name,
  projectCode: r.project_code,
  projectTitle: r.project_title,
  stepStatus: r.step_status, // where the user's own step is (offered / todo / active / done)
  dueDate: r.due_date ?? null,
  userName: r.user_name, // whose 1-3-5 it is
});

const dayOf = (auth, date) => date ?? todayIn(auth.timeZone);

async function dayItems(db, userId, date) {
  const { rows } = await db.query(`${SELECT} WHERE i.user_id = $1 AND i.plan_date = $2 ORDER BY i.position, i.id`, [userId, date]);
  return rows;
}

/** Positions 1..n again after a remove / move. */
async function renumber(client, userId, date) {
  await client.query(
    `UPDATE daily_plan_items i SET position = x.rn
       FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS rn FROM daily_plan_items WHERE user_id = $1 AND plan_date = $2) x
      WHERE i.id = x.id AND i.position <> x.rn`,
    [userId, date],
  );
}

async function ownItem(db, auth, id) {
  const { rows } = await db.query(`${SELECT} WHERE i.id = $1 AND i.user_id = $2`, [id, auth.userId]);
  if (!rows[0]) throw notFound('1-3-5 item');
  return rows[0];
}

/** Room on the user's day for one more task, and the task is not on it yet. */
async function assertRoom(db, userId, date, taskId) {
  const items = await dayItems(db, userId, date);
  if (items.length >= SLOTS) throw badRequest(`The 1-3-5 of ${date} is full (9 items) – move or remove one first`);
  if (items.some((r) => r.task_id === taskId)) throw conflict(`This task is already on the 1-3-5 of ${date}`);
  return items.length + 1;
}

/**
 * Keeps a day's slots in line with the Plan (a day that is over only loses the slots of tasks that left that day's plan unfinished):
 * - what is planned ON that day (not a whole-week plan) goes into the next free slots, in the order of the plan;
 * - a slot whose task was taken out of the plan for that day goes too (unless it is ticked done or the step is finished);
 * - the slots of planned tasks keep the order of the Plan (changing the order here changes the Plan too, see reorderDay).
 * Returns how many tasks planned for the day did not fit in the 9 slots.
 */
async function syncPlan(db, auth, day) {
  if (!canUseFlow(auth)) return 0;
  const past = day < todayIn(auth.timeZone);
  const planned = past ? [] : (await planForDay(db, auth, day, { includeDone: true })).filter((p) => p.scope === 'day'); // in the order the Plan shows them: open tasks first, finished ones after
  const missing = planned.filter((p) => !p.inSlot);
  const { rows: stale } = await db.query(
    `SELECT i.id FROM daily_plan_items i
      WHERE i.user_id = $1 AND i.plan_date = $2::date AND NOT i.is_done
        AND NOT EXISTS (SELECT 1 FROM plan_items pi JOIN task_members m ON m.id = pi.member_id
                         WHERE m.user_id = i.user_id AND m.task_id = i.task_id
                           AND ((pi.scope = 'day' AND pi.start_date = i.plan_date) OR (pi.scope = 'week' AND pi.start_date = $3::date)))
        AND NOT EXISTS (SELECT 1 FROM task_members m WHERE m.task_id = i.task_id AND m.user_id = i.user_id AND m.status = 'done')`,
    [auth.userId, day, startOfWeek(slotOf(day))],
  );
  if (past) {
    // A day that is over gets nothing new and no new order, but a task that was carried over to another day (or taken out of that day's plan)
    // and was not finished on it does not stay behind there: the 1-3-5 of that day shows what the Plan shows for it.
    if (stale.length) {
      await db.tx(async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`task135:${auth.userId}:${day}`]);
        await c.query(`DELETE FROM daily_plan_items WHERE id = ANY($1)`, [stale.map((r) => r.id)]);
        await renumber(c, auth.userId, day);
      });
    }
    return 0;
  }
  // the planned tasks that already have a slot: are the slots in the order of the plan?
  const { rows: slots } = await db.query(`SELECT id, task_id, position FROM daily_plan_items WHERE user_id = $1 AND plan_date = $2 ORDER BY position, id`, [auth.userId, day]);
  // only the open tasks follow the order of the Plan; a finished task keeps the slot it had (it does not jump to the end)
  const rank = new Map(planned.filter((p) => p.stepStatus !== 'done').map((p, i) => [p.taskId, i]));
  const held = slots.filter((x) => rank.has(x.task_id));
  const wanted = [...held].sort((a, b) => rank.get(a.task_id) - rank.get(b.task_id));
  const outOfOrder = held.some((x, i) => x.id !== wanted[i].id);
  if (!missing.length && !stale.length && !outOfOrder) return 0;

  let waiting = missing.length;
  await db.tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`task135:${auth.userId}:${day}`]); // two screens loading together must not both fill
    if (stale.length) {
      await c.query(`DELETE FROM daily_plan_items WHERE id = ANY($1)`, [stale.map((r) => r.id)]);
      await renumber(c, auth.userId, day);
    }
    let { rows: [{ n }] } = await c.query(`SELECT count(*)::int AS n FROM daily_plan_items WHERE user_id = $1 AND plan_date = $2`, [auth.userId, day]);
    waiting = 0;
    for (const p of missing) {
      if (n >= SLOTS) { waiting += 1; continue; }
      const r = await c.query(
        `INSERT INTO daily_plan_items (user_id, plan_date, position, task_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $1, $1) ON CONFLICT DO NOTHING`,
        [auth.userId, day, n + 1, p.taskId],
      );
      n += r.rowCount;
    }
    // The planned tasks take the slot numbers they have, but in the order of the Plan (open tasks first, finished ones after).
    const { rows: now } = await c.query(`SELECT id, task_id, position FROM daily_plan_items WHERE user_id = $1 AND plan_date = $2 ORDER BY position, id`, [auth.userId, day]);
    const inPlan = now.filter((x) => rank.has(x.task_id));
    const inOrder = [...inPlan].sort((a, b) => rank.get(a.task_id) - rank.get(b.task_id));
    const places = inPlan.map((x) => x.position).sort((a, b) => a - b);
    const positions = new Map(inPlan.map((x) => [x.id, x.position]));
    for (const [i, x] of inOrder.entries()) if (positions.get(x.id) !== places[i]) await c.query(`UPDATE daily_plan_items SET position = $2 WHERE id = $1`, [x.id, places[i]]);
  });
  return waiting;
}

export async function listDay(db, auth, date) {
  const day = dayOf(auth, date);
  const waiting = await syncPlan(db, auth, day);
  return { date: day, today: todayIn(auth.timeZone), slots: SLOTS, waiting, items: (await dayItems(db, auth.userId, day)).map((r) => toDto(r, todayIn(auth.timeZone))) };
}

/** The member (step) of a task that this user holds, or waits on. */
async function myMember(db, userId, taskId) {
  const { rows } = await db.query(`SELECT id FROM task_members WHERE task_id = $1 AND user_id = $2 AND status <> 'done' ORDER BY position LIMIT 1`, [taskId, userId]);
  return rows[0]?.id ?? null;
}

/** Puts one of your tasks on a day (it goes in the Plan too, and takes the next free slot). */
export async function addItem(db, auth, body) {
  const date = dayOf(auth, body.date);
  if (!canUseFlow(auth)) throw badRequest('Task Management is not available for your role');
  if (date < todayIn(auth.timeZone)) throw badRequest('A day that is over cannot get new tasks. Plan it on today or a later day.');
  const memberId = await myMember(db, auth.userId, body.taskId);
  if (!memberId) throw badRequest('Only a task you hold or are waiting on can be added', [{ field: 'taskId', message: 'not your task' }]);
  await assertRoom(db, auth.userId, date, body.taskId);
  await setPlan(db, auth, { stepId: memberId, slot: { ...slotOf(date), day: Number(date.slice(8)) } });
  const day = await listDay(db, auth, date);
  const added = day.items.find((i) => i.taskId === body.taskId);
  if (!added) throw badRequest(`The 1-3-5 of ${date} is full (9 items) – move or remove one first`);
  return added;
}

export async function updateItem(db, auth, id, body) {
  const before = await ownItem(db, auth, id);
  const isDone = body.isDone ?? before.is_done;
  // a day that is over is closed: its plan cannot be reopened or ticked afterwards (Catch up logs the time and completes the task)
  if (body.isDone !== undefined && Boolean(body.isDone) !== Boolean(before.is_done) && before.plan_date < todayIn(auth.timeZone)) {
    throw badRequest('A day that is over cannot be changed. Use Catch up to log time or complete the task.');
  }
  await db.query(`UPDATE daily_plan_items SET is_done = $2, updated_by = $3 WHERE id = $1`, [id, isDone, auth.userId]);
  return toDto(await ownItem(db, auth, id));
}

/** New order of a day: ids from first (big) to last. */
export async function reorderDay(db, auth, body) {
  const items = await dayItems(db, auth.userId, body.date);
  const ids = items.map((r) => r.id);
  if (ids.length !== body.ids.length || !body.ids.every((x) => ids.includes(x))) {
    throw badRequest('The list changed meanwhile – reload and try again');
  }
  await db.tx(async (client) => {
    for (const [i, id] of body.ids.entries()) await client.query(`UPDATE daily_plan_items SET position = $2, updated_by = $3 WHERE id = $1`, [id, i + 1, auth.userId]);
    // The Plan follows: the tasks planned ON this day swap their places in the plan to match the new order of the slots.
    if (body.date >= todayIn(auth.timeZone)) {
      const order = body.ids.map((id) => items.find((r) => r.id === id).task_id);
      if (order.length > 1) {
        const { rows: plan } = await client.query(
          `SELECT pi.id, m.task_id, pi.position FROM plan_items pi JOIN task_members m ON m.id = pi.member_id
            WHERE m.user_id = $1 AND pi.scope = 'day' AND pi.start_date = $2::date AND m.task_id = ANY($3)`,
          [auth.userId, body.date, order],
        );
        const places = plan.map((r) => r.position).sort((a, b) => a - b);
        const byTask = new Map(plan.map((r) => [r.task_id, r]));
        const ordered = order.map((t) => byTask.get(t)).filter(Boolean);
        for (const [i, r] of ordered.entries()) if (r.position !== places[i]) await client.query(`UPDATE plan_items SET position = $2 WHERE id = $1`, [r.id, places[i]]);
      }
    }
  });
  return listDay(db, auth, body.date);
}

/** Move or copy a slot to another day (at the end of that day's list). */
export async function moveItem(db, auth, id, body) {
  const item = await ownItem(db, auth, id);
  const from = item.plan_date;
  if (body.date === from) throw badRequest('Pick another day');
  const position = await assertRoom(db, auth.userId, body.date, item.task_id);
  const stepId = await plannedStep(db, auth, item);
  const newId = await db.tx(async (client) => {
    if (body.mode === 'copy') {
      const { rows } = await client.query(
        `INSERT INTO daily_plan_items (user_id, plan_date, position, task_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $1, $1) RETURNING id`,
        [auth.userId, body.date, position, item.task_id],
      );
      return rows[0].id;
    }
    await client.query(`UPDATE daily_plan_items SET plan_date = $2, position = $3, updated_by = $4 WHERE id = $1`, [id, body.date, position, auth.userId]);
    await renumber(client, auth.userId, from);
    return id;
  });
  // a task planned on that day moves (or is copied) in the Plan too
  if (stepId) await setPlan(db, auth, { stepId, slot: { ...slotOf(body.date), day: Number(body.date.slice(8)) }, from, copy: body.mode === 'copy' });
  return toDto(await ownItem(db, auth, newId));
}

/** The member (step) a slot stands for on its day, when the task is planned ON that day (else null). */
async function plannedStep(db, auth, item) {
  if (item.plan_date < todayIn(auth.timeZone)) return null;
  const { rows } = await db.query(
    `SELECT pi.member_id FROM plan_items pi JOIN task_members m ON m.id = pi.member_id
      WHERE m.user_id = $1 AND m.task_id = $2 AND pi.scope = 'day' AND pi.start_date = $3::date`,
    [auth.userId, item.task_id, item.plan_date],
  );
  return rows[0]?.member_id ?? null;
}

export async function removeItem(db, auth, id) {
  const item = await ownItem(db, auth, id);
  const stepId = await plannedStep(db, auth, item); // the Plan and the day agree: out of the day is out of that day's plan
  if (stepId) await setPlan(db, auth, { stepId, slot: null, from: item.plan_date });
  await db.tx(async (client) => {
    await client.query(`DELETE FROM daily_plan_items WHERE id = $1`, [id]);
    await renumber(client, auth.userId, item.plan_date);
  });
}

/**
 * What the user planned for a day (a day plan, or a whole-week plan that includes it), for the
 * "Planned" panel: the user picks from it to fill their slots. Empty for roles without Task Management.
 */
export async function flowPlanned(db, auth, date) {
  if (!canUseFlow(auth)) return [];
  return planForDay(db, auth, dayOf(auth, date));
}
