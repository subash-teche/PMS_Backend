import { SCREENS } from '../../config/menus.js';
import * as service from './projectplan.service.js';

const tags = ['Project plan'];
const date = { type: 'string', format: 'date' };
const params = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const itemParams = { type: 'object', required: ['id', 'itemId'], properties: { id: { type: 'integer', minimum: 1 }, itemId: { type: 'integer', minimum: 1 } } };
const plan = {
  type: 'object',
  properties: {
    startDate: { type: ['string', 'null'] },
    endDate: { type: ['string', 'null'] },
    openEnded: { type: 'boolean' },
    estimateGap: { type: ['string', 'null'], description: 'why planning is locked (estimate not finished), else null' },
    weeks: { type: 'array', items: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } } } },
    groups: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, effortPercentage: { type: 'number' } } } },
    items: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, taskGroupId: { type: 'integer' }, weekStart: { type: 'string' } } } },
    progress: {
      type: 'array',
      description: 'the work done per task group: tasks by status, when it started and when the last task was completed',
      items: {
        type: 'object',
        properties: {
          taskGroupId: { type: 'integer' },
          total: { type: 'integer' },
          completed: { type: 'integer' },
          inProgress: { type: 'integer' },
          hold: { type: 'integer' },
          toDo: { type: 'integer' },
          overdue: { type: 'integer' },
          estimatedMinutes: { type: 'integer' },
          loggedMinutes: { type: 'integer' },
          started: { type: ['string', 'null'] },
          finished: { type: ['string', 'null'] },
        },
      },
    },
    tasks: {
      type: 'array',
      description: 'every task of the planned groups, with its planned dates and when it started / was completed',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          taskGroupId: { type: 'integer' },
          taskTypeId: { type: ['integer', 'null'] },
          taskTypeName: { type: ['string', 'null'] },
          name: { type: 'string' },
          status: { type: 'string' },
          assignedToName: { type: ['string', 'null'] },
          plannedStart: { type: ['string', 'null'] },
          plannedEnd: { type: ['string', 'null'] },
          started: { type: ['string', 'null'] },
          finished: { type: ['string', 'null'] },
          estimatedMinutes: { type: 'integer' },
          loggedMinutes: { type: 'integer' },
          logs: { type: 'array', description: 'the days time was logged on the task', items: { type: 'object', properties: { date: { type: 'string' }, minutes: { type: 'integer' } } } },
        },
      },
    },
    applyCandidates: {
      type: 'array',
      description: 'after a save: task groups whose open plan tasks are not in the new period (ask whether to apply it)',
      items: { type: 'object', properties: { taskGroupId: { type: 'integer' }, name: { type: 'string' }, tasks: { type: 'integer' }, start: { type: 'string' }, end: { type: 'string' } } },
    },
  },
};

/** Plan tab of a project (/projects/:id/plan) – by the role's Project access for the Plan tab (checked in the service). */
export default async function projectPlanRoutes(fastify) {
  const { db, authorize } = fastify;
  fastify.addHook('onRequest', fastify.authenticate);
  const view = authorize(SCREENS.PROJECTS, 'view');

  fastify.get('/:id/plan', { schema: { tags, summary: 'Weekly plan by task group', params, response: { 200: plan } }, preHandler: view }, (req) =>
    service.getPlan(db, req.auth, req.params.id),
  );
  fastify.post(
    '/:id/plan',
    {
      schema: {
        tags,
        summary: 'Plan a task group in a week',
        params,
        body: { type: 'object', additionalProperties: false, required: ['taskGroupId', 'weekStart'], properties: { taskGroupId: { type: 'integer', minimum: 1 }, weekStart: date } },
        response: { 200: plan },
      },
      preHandler: view,
    },
    (req) => service.addItem(db, req.auth, req.params.id, req.body),
  );
  fastify.put(
    '/:id/plan',
    {
      schema: {
        tags,
        summary: 'Save the whole plan (replaces the planned weeks)',
        params,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['items'],
          properties: {
            confirmRemove: { type: 'boolean', description: 'remove task groups whose plan tasks are all completed' },
            items: {
              type: 'array',
              maxItems: 5000,
              items: { type: 'object', additionalProperties: false, required: ['taskGroupId', 'weekStart'], properties: { taskGroupId: { type: 'integer', minimum: 1 }, weekStart: date } },
            },
          },
        },
        response: { 200: plan },
      },
      preHandler: view,
    },
    (req) => service.savePlan(db, req.auth, req.params.id, req.body),
  );
  fastify.post(
    '/:id/plan/apply',
    {
      schema: {
        tags,
        summary: 'Apply the planned period to the open tasks made from the plan',
        params,
        body: { type: 'object', additionalProperties: false, required: ['taskGroupIds'], properties: { taskGroupIds: { type: 'array', maxItems: 100, items: { type: 'integer', minimum: 1 } } } },
        response: { 200: { type: 'object', properties: { updated: { type: 'integer' } } } },
      },
      preHandler: view,
    },
    (req) => service.applyPlan(db, req.auth, req.params.id, req.body),
  );
  fastify.put(
    '/:id/plan/:itemId',
    {
      schema: {
        tags,
        summary: 'Move a planned task group to another week',
        params: itemParams,
        body: { type: 'object', additionalProperties: false, required: ['weekStart'], properties: { weekStart: date } },
        response: { 200: plan },
      },
      preHandler: view,
    },
    (req) => service.moveItem(db, req.auth, req.params.id, req.params.itemId, req.body),
  );
  fastify.delete('/:id/plan/:itemId', { schema: { tags, summary: 'Remove a planned task group from a week', params: itemParams, response: { 200: plan } }, preHandler: view }, (req) =>
    service.removeItem(db, req.auth, req.params.id, req.params.itemId),
  );
}
