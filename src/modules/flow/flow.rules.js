// Pure flow rules for Task Management tasks - no database access, so they are easy to test.
//
// A flow task has steps in order, one per person. The task waits on its "current step": the first one that is not done.
// Step status:  waiting (not its turn) -> offered (its turn) -> todo (accepted) -> active (started) -> done.

const TRANSITIONS = {
  accept: { from: 'offered', to: 'todo', stamp: 'accepted_at' },
  start: { from: 'todo', to: 'active', stamp: 'started_at' },
  close: { from: 'active', to: 'done', stamp: 'closed_at' },
};

export const ACTIONS = Object.freeze(Object.keys(TRANSITIONS));

const sorted = (steps) => [...steps].sort((a, b) => a.position - b.position);

/** The step the task is currently waiting on: the first one that is not done. */
export const currentStep = (steps) => sorted(steps).find((s) => s.status !== 'done');

/**
 * Applies accept / start / close by `userId`. Returns { ok: true, updates, completed } or { ok: false, status, error }.
 * `updates` is a list of { id, status, stamp? } for the caller to write (stamp = the timestamp column to set to now).
 */
export function transition(steps, action, userId) {
  const current = currentStep(steps);
  if (!current) return { ok: false, status: 409, error: 'This task is already complete' };
  if (current.user_id !== userId) return { ok: false, status: 403, error: 'Only the person holding this task can do that' };

  const t = TRANSITIONS[action];
  if (!t) return { ok: false, status: 400, error: `Unknown action ${action}` };
  if (current.status !== t.from) return { ok: false, status: 409, error: `You cannot ${action} a task that is ${current.status}` };

  const updates = [{ id: current.id, status: t.to, stamp: t.stamp }];
  let completed = false;
  if (action === 'close') {
    const next = sorted(steps).find((s) => s.position > current.position && s.status !== 'done');
    if (next) updates.push({ id: next.id, status: 'offered' });
    else completed = true;
  }
  return { ok: true, updates, completed };
}

/**
 * The task status shown in PMS, derived from its steps (the steps stay the source of truth):
 * no steps / nothing started -> to_do; some work started or done -> in_progress; every step done -> completed.
 */
export function statusOf(steps) {
  if (!steps.length) return 'to_do';
  if (steps.every((s) => s.status === 'done')) return 'completed';
  return steps.some((s) => s.status === 'todo' || s.status === 'active' || s.status === 'done') ? 'in_progress' : 'to_do';
}

/** Who owns a task: one person. */
export const ownersOf = (task) => [Number(task.owner_id)];

/** May this user edit the task, its owners and its flow? An owner or an admin. */
export const canEditFlow = (isAdmin, userId, task) => isAdmin || ownersOf(task).includes(userId);

/**
 * After a task is passed on, the same person must not hold two steps in a row. Returns the ids of later,
 * not-yet-reached steps held by the same person as the step before them (the caller deletes these).
 */
export function repeatedSteps(steps) {
  const drop = [];
  let prev;
  for (const s of sorted(steps)) {
    if (prev && prev.status !== 'done' && s.status === 'waiting' && s.user_id === prev.user_id) {
      drop.push(s.id);
      continue;
    }
    prev = s;
  }
  return drop;
}
