import { SCREENS } from '../../config/menus.js';
import * as service from './tasks.service.js';
import * as schemas from './tasks.schemas.js';

export default async function tasksRoutes(fastify) {
  const { db, authorize } = fastify;
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/', { schema: schemas.listSchema, preHandler: authorize(SCREENS.TASKS, 'view') }, (req) => service.listTasks(db, req.auth, req.query));

  fastify.get('/summary', { schema: schemas.summarySchema, preHandler: authorize(SCREENS.TASKS, 'view') }, (req) =>
    service.taskSummary(db, req.auth, req.query),
  );

  fastify.get('/options', { schema: schemas.optionsSchema, preHandler: authorize(SCREENS.TASKS, 'view') }, (req) => service.taskOptions(db, req.auth));

  // add from the plan (before "/:id")
  fastify.get('/plan-projects', { schema: schemas.templateProjectsSchema, preHandler: authorize(SCREENS.TASKS, 'create') }, (req) =>
    service.templateProjects(db, req.auth),
  );
  fastify.get('/plan-projects/:projectId/plan', { schema: schemas.planTasksSchema, preHandler: authorize(SCREENS.TASKS, 'create') }, (req) =>
    service.planTasks(db, req.auth, req.params.projectId),
  );
  fastify.post('/from-plan', { schema: schemas.fromPlanSchema, preHandler: authorize(SCREENS.TASKS, 'create') }, async (req, reply) =>
    reply.status(201).send(await service.createFromPlan(db, req.auth, req.body)),
  );

  fastify.get('/:id', { schema: schemas.getSchema, preHandler: authorize(SCREENS.TASKS, 'view') }, (req) => service.getTask(db, req.auth, req.params.id));

  fastify.get('/:id/activity', { schema: schemas.activitySchema, preHandler: authorize(SCREENS.TASKS, 'view') }, (req) =>
    service.taskActivity(db, req.auth, req.params.id),
  );

  fastify.get('/:id/efforts', { schema: schemas.effortsSchema, preHandler: authorize(SCREENS.TASKS, 'view') }, (req) =>
    service.taskEfforts(db, req.auth, req.params.id),
  );

  fastify.post('/', { schema: schemas.createSchema, preHandler: authorize(SCREENS.TASKS, 'create') }, async (req, reply) =>
    reply.status(201).send(await service.createTask(db, req.auth, req.body)),
  );

  fastify.put('/:id', { schema: schemas.updateSchema, preHandler: authorize(SCREENS.TASKS, 'edit') }, (req) =>
    service.updateTask(db, req.auth, req.params.id, req.body),
  );

  // view permission: a subtask assignee may only have read access to the task itself
  fastify.put('/:id/subtasks/:subtaskId/done', { schema: schemas.subtaskDoneSchema, preHandler: authorize(SCREENS.TASKS, 'view') }, (req) =>
    service.setSubtaskDone(db, req.auth, req.params.id, req.params.subtaskId, req.body.isDone),
  );

  fastify.delete('/:id', { schema: schemas.deleteSchema, preHandler: authorize(SCREENS.TASKS, 'delete') }, async (req, reply) => {
    await service.deleteTask(db, req.auth, req.params.id);
    return reply.status(204).send();
  });
}
