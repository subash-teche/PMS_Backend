import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canEditFlow, currentStep, repeatedSteps, statusOf, transition } from '../src/modules/flow/flow.rules.js';
import { shiftDateToMonth, slotOf, startOfWeek, weekDays, weeksIn } from '../src/modules/flow/flow.weeks.js';

const flow = () => [
  { id: 1, user_id: 10, position: 1, status: 'offered' },
  { id: 2, user_id: 20, position: 2, status: 'waiting' },
];

describe('transition', () => {
  it('lets the holder accept, then start, then close and offers the next person', () => {
    const steps = flow();
    assert.deepEqual(transition(steps, 'accept', 10), { ok: true, updates: [{ id: 1, status: 'todo', stamp: 'accepted_at' }], completed: false });
    steps[0].status = 'todo';
    assert.equal(transition(steps, 'start', 10).ok, true);
    steps[0].status = 'active';
    const close = transition(steps, 'close', 10);
    assert.equal(close.ok, true);
    assert.equal(close.completed, false);
    assert.deepEqual(close.updates[1], { id: 2, status: 'offered' });
  });

  it('completes the task when the last step closes', () => {
    const steps = [{ id: 1, user_id: 10, position: 1, status: 'active' }];
    assert.equal(transition(steps, 'close', 10).completed, true);
  });

  it('rejects anyone who does not hold the task', () => {
    assert.deepEqual(transition(flow(), 'accept', 20), { ok: false, status: 403, error: 'Only the person holding this task can do that' });
  });

  it('rejects out-of-order actions and finished tasks', () => {
    assert.equal(transition(flow(), 'close', 10).status, 409);
    assert.equal(transition(flow(), 'start', 10).status, 409);
    assert.equal(transition([{ id: 1, user_id: 10, position: 1, status: 'done' }], 'accept', 10).status, 409);
  });
});

describe('statusOf', () => {
  it('derives the task status from its steps', () => {
    assert.equal(statusOf([]), 'to_do');
    assert.equal(statusOf(flow()), 'to_do');
    assert.equal(statusOf([{ status: 'todo' }, { status: 'waiting' }]), 'in_progress');
    assert.equal(statusOf([{ status: 'done' }, { status: 'offered' }]), 'in_progress');
    assert.equal(statusOf([{ status: 'done' }, { status: 'done' }]), 'completed');
  });
});

describe('flow helpers', () => {
  it('finds the current step', () => {
    assert.equal(currentStep(flow()).id, 1);
    assert.equal(currentStep([{ id: 1, position: 1, status: 'done' }]), undefined);
  });

  it('lets only an owner or an admin edit the flow', () => {
    const task = { owner_id: 5 };
    assert.equal(canEditFlow(false, 5, task), true);
    assert.equal(canEditFlow(false, 7, task), false);
    assert.equal(canEditFlow(true, 7, task), true);
    assert.equal(canEditFlow(false, 5, { owner_id: 5 }), true);
    assert.equal(canEditFlow(false, 5, { owner_id: '5' }), true, 'pg returns bigint as a string');
  });

  it('drops a later step held by the same person as the step before it', () => {
    const steps = [
      { id: 1, user_id: 10, position: 1, status: 'offered' },
      { id: 2, user_id: 10, position: 2, status: 'waiting' },
      { id: 3, user_id: 20, position: 3, status: 'waiting' },
    ];
    assert.deepEqual(repeatedSteps(steps), [2]);
  });
});

describe('plan weeks', () => {
  it('cuts a month into Monday-to-Sunday weeks', () => {
    // November 2026 starts on a Sunday: W1 is just the 1st
    assert.deepEqual(weekDays({ month: '2026-11', week: 1 }), { from: 1, to: 1 });
    assert.deepEqual(weekDays({ month: '2026-11', week: 2 }), { from: 2, to: 8 });
    assert.equal(weeksIn('2026-11'), 6); // the 1st (Sun) and the 30th (Mon) are weeks of their own
    assert.equal(weeksIn('2027-02'), 4); // starts on a Monday, 28 days
  });

  it('stores a plan by a date and maps it back to its week', () => {
    assert.equal(startOfWeek({ month: '2026-11', week: 2 }), '2026-11-02');
    assert.equal(startOfWeek({ month: '2026-11', week: 2, day: 5 }), '2026-11-05');
    assert.deepEqual(slotOf('2026-11-10'), { month: '2026-11', week: 3 });
  });

  it('clamps the day when moving a date to a shorter month', () => {
    assert.equal(shiftDateToMonth('2026-01-31', '2026-02'), '2026-02-28');
  });
});
