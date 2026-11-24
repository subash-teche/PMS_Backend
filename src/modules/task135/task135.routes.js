import { SCREENS } from '../../config/menus.js';
import * as service from './task135.service.js';

const tags = ['1-3-5'];
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const date = { type: 'string', format: 'date' };
const item = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    date: { type: 'string' },
    position: { type: 'integer' },
    size: { type: 'string', enum: ['big', 'medium', 'small'] },
    taskId: { type: 'integer' },
    stepStatus: { type: ['string', 'null'], description: "Task Management item: the user's own step (offered / todo / active / done)" },
    carryover: { type: 'boolean', description: 'a day that is over whose task went on to a later day (not done on this day)' },
    dueDate: { type: ['string', 'null'] },
    title: { type: 'string' },
    minutes: { type: 'integer' },
    isDone: { type: 'boolean' },
    taskStatus: { type: ['string', 'null'] },
    projectId: { type: ['integer', 'null'] },
    categoryId: { type: ['integer', 'null'] },
    categoryName: { type: ['string', 'null'] },
    planDone: { type: 'boolean' },
    userName: { type: ['string', 'null'] },
    projectCode: { type: ['string', 'null'] },
    projectTitle: { type: ['string', 'null'] },
  },
};
const day = {
  type: 'object',
  properties: { date: { type: 'string' }, today: { type: 'string' }, slots: { type: 'integer' }, waiting: { type: 'integer', description: 'tasks planned for the day that did not fit in the slots' }, items: { type: 'array', items: item } },
};

export default async function task135Routes(fastify) {
  const { db, authorize } = fastify;
  fastify.addHook('onRequest', fastify.authenticate);
  const can = (action) => authorize(SCREENS.TASK_135, action);

  fastify.get(
    '/',
    { schema: { tags, summary: "The signed-in user's 1-3-5 of a day (today by default)", querystring: { type: 'object', properties: { date } }, response: { 200: day } }, preHandler: can('view') },
    (req) => service.listDay(db, req.auth, req.query.date),
  );

  fastify.get(
    '/flow-planned',
    {
      schema: {
        tags,
        summary: 'What you planned in Task Management for a day (pick from it to fill your slots)',
        querystring: { type: 'object', properties: { date } },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                taskId: { type: 'integer' },
                title: { type: 'string' },
                scope: { type: 'string', enum: ['day', 'week'] },
                stepStatus: { type: 'string' },
                taskStatus: { type: 'string' },
                dueDate: { type: ['string', 'null'] },
                projectId: { type: 'integer' },
                projectCode: { type: ['string', 'null'] },
                projectTitle: { type: ['string', 'null'] },
                inSlot: { type: 'boolean' },
              },
            },
          },
        },
      },
      preHandler: can('view'),
    },
    (req) => service.flowPlanned(db, req.auth, req.query.date),
  );

  fastify.post(
    '/',
    {
      schema: {
        tags,
        summary: 'Put one of your tasks on a day (next free slot)',
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['taskId'],
          properties: { date, taskId: { type: 'integer', minimum: 1 } },
        },
        response: { 201: item },
      },
      preHandler: can('create'),
    },
    async (req, reply) => reply.status(201).send(await service.addItem(db, req.auth, req.body)),
  );

  fastify.put(
    '/reorder',
    {
      schema: {
        tags,
        summary: 'New order of a day (ids, big first)',
        body: { type: 'object', required: ['date', 'ids'], additionalProperties: false, properties: { date, ids: { type: 'array', items: { type: 'integer' }, maxItems: 9 } } },
        response: { 200: day },
      },
      preHandler: can('edit'),
    },
    (req) => service.reorderDay(db, req.auth, req.body),
  );

  fastify.put(
    '/:id',
    {
      schema: {
        tags,
        summary: "Tick the day's plan done or open it again (the task itself is not changed)",
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { isDone: { type: 'boolean' } },
        },
        response: { 200: item },
      },
      preHandler: can('edit'),
    },
    (req) => service.updateItem(db, req.auth, req.params.id, req.body),
  );

  fastify.post(
    '/:id/move',
    {
      schema: {
        tags,
        summary: 'Move or copy an item to another day',
        params: idParams,
        body: { type: 'object', required: ['date', 'mode'], additionalProperties: false, properties: { date, mode: { type: 'string', enum: ['move', 'copy'] } } },
        response: { 200: item },
      },
      preHandler: can('edit'),
    },
    (req) => service.moveItem(db, req.auth, req.params.id, req.body),
  );

  fastify.delete('/:id', { schema: { tags, summary: 'Remove an item from the planner', params: idParams, response: { 204: { type: 'null' } } }, preHandler: can('delete') }, async (req, reply) => {
    await service.removeItem(db, req.auth, req.params.id);
    return reply.status(204).send();
  });
}
