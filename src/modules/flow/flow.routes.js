import { canUseFlow } from '../../config/flow.js';
import { badRequest, forbidden } from '../../utils/errors.js';
import * as messages from './flow.messages.service.js';
import * as plan from './flow.plan.service.js';
import * as service from './flow.service.js';
import * as timer from './flow.timer.service.js';
import * as day from '../task135/task135.service.js';

/*
 * Task Management API (/api/v1/flow). Access is by role (see config/flow.js), not by Roles & Permissions.
 */

const tags = ['Task Management'];
const id = { type: 'integer', minimum: 1 };
const idParams = { type: 'object', required: ['id'], properties: { id } };
const month = { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' };
const date = { type: 'string', format: 'date' };
const version = { type: 'integer' };
const ids = (max = 30) => ({ type: 'array', items: id, maxItems: max });
const body = (required, properties) => ({ type: 'object', required, additionalProperties: false, properties });

const taskFields = {
  title: { type: 'string', minLength: 1, maxLength: 300 },
  description: { type: 'string', maxLength: 10000 },
  notes: { type: 'string', maxLength: 10000 },
  dueDate: { type: ['string', 'null'], format: 'date' },
  media: { type: 'string', maxLength: 500 },
  ownerIds: { type: 'array', items: id, minItems: 1, maxItems: 1 },
};
const comment = { type: 'string', maxLength: 1000 };

export default async function flowRoutes(fastify) {
  const { db } = fastify;
  fastify.addHook('onRequest', fastify.authenticate);

  const requireFlow = async (req) => {
    if (!canUseFlow(req.auth)) throw forbidden('Task Management is not available for your role');
  };
  const route = (method, url, schema, handler, extra = {}) =>
    fastify[method](url, { schema: { tags, ...schema }, preHandler: requireFlow, ...extra }, handler);

  // --- reading ---------------------------------------------------------------------------------------------------

  route('get', '/options', { summary: 'Projects (with task groups and types) and people for the New task dialog' }, (req) => service.options(db, req.auth));

  route('get', '/lookups', { summary: 'Customers and task types, for filters and labels' }, (req) => service.lookups(db, req.auth));

  route(
    'get',
    '/tasks',
    {
      summary: 'Tasks with their members and time logs',
      querystring: {
        type: 'object',
        properties: { owner: id, customerId: id, projectId: id, taskGroupId: id, taskTypeId: id, scope: { type: 'string', enum: ['board', 'all'], default: 'all' } },
      },
    },
    (req) => service.listTasks(db, req.query),
  );
  route('get', '/tasks/:id', { summary: 'One flow task', params: idParams }, (req) => service.getTask(db, req.params.id));
  route('get', '/tasks/:id/activity', { summary: 'History of a flow task', params: idParams }, (req) => service.listActivity(db, req.params.id));

  // --- create / edit ---------------------------------------------------------------------------------------------

  route(
    'post',
    '/tasks',
    {
      summary: 'Create a task of a project, with the people who work on it in order',
      body: body(['projectId', 'taskGroupId', 'taskTypeId', 'title'], {
        projectId: id,
        taskGroupId: id,
        taskTypeId: id,
        flow: ids(),
        ...taskFields,
      }),
    },
    async (req, reply) => reply.status(201).send(await service.createTask(db, req.auth, req.body)),
  );

  route(
    'patch',
    '/tasks/:id',
    {
      summary: 'Edit a flow task',
      params: idParams,
      body: { type: 'object', required: ['version'], additionalProperties: false, properties: { version, taskTypeId: id, ...taskFields } },
    },
    (req) => service.updateTask(db, req.auth, req.params.id, req.body),
  );

  route('delete', '/tasks/:id', { summary: 'Delete a task (refused once time is logged on it)', params: idParams }, async (req, reply) => {
    await service.deleteTask(db, req.auth, req.params.id);
    return reply.status(204).send();
  });

  // --- flow actions ----------------------------------------------------------------------------------------------

  // accepting can carry on into starting or closing, and starting into closing, in one go
  const CHAIN = { accept: { start: ['start'], close: ['start', 'close'] }, start: { close: ['close'] }, close: {} };
  for (const action of ['accept', 'start', 'close']) {
    route(
      'post',
      `/tasks/:id/${action}`,
      {
        summary: `${action[0].toUpperCase()}${action.slice(1)} the step you hold`,
        params: idParams,
        body: body(['version'], { version, comment, then: { type: 'string', enum: ['start', 'close'] }, minutes: { type: 'integer', minimum: 0, maximum: 100000 }, workDate: date }),
      },
      (req) => {
        const { version: v, comment: note, then, minutes, workDate } = req.body;
        const chain = [action];
        if (then) {
          const more = CHAIN[action][then];
          if (!more) throw badRequest(`You cannot ${action} and then ${then}`);
          chain.push(...more);
        }
        return service.flowStep(db, req.auth, req.params.id, v, chain, { minutes, note, workDate });
      },
    );
  }

  route(
    'post',
    '/tasks/:id/log',
    {
      summary: 'Log time part-way through the step you hold (also written to the PMS Timesheet)',
      params: idParams,
      body: body(['minutes'], { minutes: { type: 'integer', minimum: 1, maximum: 1440 }, note: { type: 'string', maxLength: 500 }, workDate: date, doneForDay: { type: 'boolean' } }),
    },
    (req) => service.logTime(db, req.auth, req.params.id, req.body),
  );

  route(
    'post',
    '/tasks/:id/pass',
    {
      summary: 'Pass the task on (handover), or ask someone first and come back (circle)',
      params: idParams,
      body: body(['version', 'toUserId'], { version, toUserId: id, comment, mode: { type: 'string', enum: ['handover', 'circle'], default: 'handover' } }),
    },
    (req) => service.passTask(db, req.auth, req.params.id, req.body),
  );

  route(
    'put',
    '/tasks/:id/flow',
    { summary: 'Edit the people who have not finished yet', params: idParams, body: body(['version', 'userIds'], { version, userIds: ids() }) },
    (req) => service.editFlow(db, req.auth, req.params.id, req.body),
  );

  route(
    'post',
    '/tasks/reorder',
    { summary: 'New priority order of tasks', body: body(['taskIds'], { taskIds: { type: 'array', items: id, minItems: 1, maxItems: 500 } }) },
    async (req) => {
      await service.reorder(db, req.auth, req.body.taskIds);
      return { ok: true };
    },
  );

  // --- plan ------------------------------------------------------------------------------------------------------

  route('get', '/plan', { summary: "A person's plan (yours by default)", querystring: { type: 'object', properties: { user: id } } }, (req) => plan.listPlan(db, req.query.user ?? req.auth.userId));
  route(
    'get',
    '/plan/day',
    { summary: 'What you planned in Task Management for a day (feeds the 1-3-5)', querystring: { type: 'object', required: ['date'], properties: { date } } },
    (req) => plan.planForDay(db, req.auth, req.query.date),
  );
  route(
    'put',
    '/plan',
    {
      summary: 'Put a step in a week / day of a month, or take it out of the plan (slot null)',
      body: body(['stepId'], {
        stepId: id,
        slot: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['month', 'week'],
          properties: { month, week: { type: 'integer', minimum: 1, maximum: 6 }, day: { type: 'integer', minimum: 1, maximum: 31 } },
        },
        before: { type: ['integer', 'null'] },
        from: date,
        copy: { type: 'boolean' },
        dropTime: { type: 'boolean' },
      }),
    },
    (req) => plan.setPlan(db, req.auth, req.body),
  );

  // --- dashboard: the 1-3-5 of a day --------------------------------------------------------------------------------
  // The same list as the PMS 1-3-5 page (one source), but open to everyone who can use Task Management - it does not depend on
  // the PMS 1-3-5 screen permission. An item is a Task Management task from the plan, or a short free text.

  route('get', '/day', { summary: 'Your 1-3-5 of a day (today by default)', querystring: { type: 'object', properties: { date } } }, (req) => day.listDay(db, req.auth, req.query.date));
  route(
    'post',
    '/day',
    { summary: 'Put one of your tasks in the next free slot of a day', body: body(['taskId'], { date, taskId: id }) },
    async (req, reply) => reply.status(201).send(await day.addItem(db, req.auth, req.body)),
  );
  route(
    'put',
    '/day/reorder',
    { summary: 'New order of a day (ids, big first)', body: body(['date', 'ids'], { date, ids: { type: 'array', items: id, maxItems: 9 } }) },
    (req) => day.reorderDay(db, req.auth, req.body),
  );
  route(
    'put',
    '/day/:id',
    {
      summary: "Tick the day's plan done or open it again (the task itself is not changed)",
      params: idParams,
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { isDone: { type: 'boolean' } } },
    },
    (req) => day.updateItem(db, req.auth, req.params.id, req.body),
  );
  route('post', '/day/:id/move', { summary: 'Move or copy a slot to another day', params: idParams, body: body(['date', 'mode'], { date, mode: { type: 'string', enum: ['move', 'copy'] } }) }, (req) =>
    day.moveItem(db, req.auth, req.params.id, req.body),
  );
  route('delete', '/day/:id', { summary: 'Take a slot out of the day', params: idParams }, async (req, reply) => {
    await day.removeItem(db, req.auth, req.params.id);
    return reply.status(204).send();
  });

  // --- timer (the working day) -----------------------------------------------------------------------------------

  const minutesIn = { type: 'integer', minimum: 0, maximum: 100000 };
  const entryParams = idParams;
  route('get', '/timer', { summary: 'Your timer entries: the last 30 days plus anything open' }, (req) => timer.listEntries(db, req.auth));
  route('post', '/timer', { summary: 'Add a task you hold to your timer', body: body(['stepId'], { stepId: id, day: date }) }, async (req, reply) => reply.status(201).send(await timer.createEntry(db, req.auth, req.body)));
  route('post', '/timer/:id/start', { summary: 'Start / resume the timer', params: entryParams }, (req) => timer.startEntry(db, req.auth, req.params.id));
  route('post', '/timer/:id/pause', { summary: 'Pause and log the time', params: entryParams, body: body(['minutes'], { minutes: minutesIn, note: { type: 'string', maxLength: 500 } }) }, (req) => timer.pauseEntry(db, req.auth, req.params.id, req.body));
  route(
    'post',
    '/timer/:id/end',
    { summary: 'End: complete your step, or only log the time', params: entryParams, body: body(['complete', 'minutes'], { complete: { type: 'boolean' }, minutes: minutesIn, note: { type: 'string', maxLength: 500 }, comment }) },
    (req) => timer.endEntry(db, req.auth, req.params.id, req.body),
  );
  route('post', '/timer/:id/move', { summary: 'Move an abandoned entry to a day', params: entryParams, body: body(['day'], { day: date }) }, (req) => timer.moveEntry(db, req.auth, req.params.id, req.body));
  route('post', '/timer/:id/copy', { summary: 'Copy an entry to a day', params: entryParams, body: body(['day'], { day: date }) }, async (req, reply) => reply.status(201).send(await timer.copyEntry(db, req.auth, req.params.id, req.body)));
  route('delete', '/timer/:id', { summary: 'Remove an entry that was never started', params: entryParams }, async (req, reply) => {
    await timer.removeEntry(db, req.auth, req.params.id);
    return reply.status(204).send();
  });

  // --- messages --------------------------------------------------------------------------------------------------

  route(
    'get',
    '/messages',
    { summary: 'The message feed', querystring: { type: 'object', properties: { task: id, mine: { type: 'string', enum: ['1'] }, with: id } } },
    (req) => messages.feed(db, req.auth, req.query),
  );
  route(
    'post',
    '/messages',
    {
      summary: 'Post a message, optionally tagged with a task and people',
      body: body(['body'], { body: { type: 'string', minLength: 1, maxLength: 2000 }, taskId: { type: ['integer', 'null'] }, mentionIds: ids(), private: { type: 'boolean' } }),
    },
    async (req, reply) => reply.status(201).send(await messages.createPost(db, req.auth, req.body)),
  );
  route('post', '/messages/read-all', { summary: 'Mark every message that tags you as read' }, async (req, reply) => {
    await messages.readAll(db, req.auth);
    return reply.status(204).send();
  });
  route(
    'post',
    '/messages/read-many',
    { summary: 'Mark some messages as read', body: body(['ids'], { ids: { type: 'array', items: id, minItems: 1, maxItems: 200 } }) },
    async (req, reply) => {
      await messages.readMany(db, req.auth, req.body.ids);
      return reply.status(204).send();
    },
  );
}
