import { paginationQuerySchema, pagedResponseSchema } from '../../utils/query.js';

const tags = ['Tasks'];
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const scope = { type: 'string', enum: ['mine', 'all'], default: 'mine', description: 'mine = owned / assigned / created by me; all = per the role data scope' };

export const STATUSES = ['to_do', 'in_progress', 'completed', 'hold'];

const nullableStr = { type: ['string', 'null'] };
const nullableInt = { type: ['integer', 'null'] };

const task = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: nullableStr,
    categoryId: nullableInt,
    categoryName: nullableStr,
    isProjectCategory: { type: 'boolean' },
    projectId: nullableInt,
    projectCode: nullableStr,
    projectTitle: nullableStr,
    projectOwnerId: nullableInt,
    isMasked: { type: 'boolean', description: "someone else's personal task – details hidden" },
    inToday135: { type: 'boolean' },
    taskGroupId: nullableInt,
    taskGroupName: nullableStr,
    taskTypeId: nullableInt,
    taskTypeName: nullableStr,
    ownerId: nullableInt,
    ownerName: nullableStr,
    assignedTo: nullableInt,
    assignedToName: nullableStr,
    estimatedMinutes: nullableInt,
    status: { type: 'string' },
    plannedStart: { type: ['string', 'null'], format: 'date-time' },
    plannedEnd: { type: ['string', 'null'], format: 'date-time' },
    completedOn: nullableStr,
    isOverdue: { type: 'boolean' },
    subtaskCount: { type: 'integer' },
    timesheetCount: { type: 'integer', description: 'timesheet entries logged on the task (a task with time cannot be deleted)' },
    subtaskDone: { type: 'integer' },
    createdBy: nullableInt,
    createdByName: nullableStr,
    startedAt: { type: ['string', 'null'], format: 'date-time' },
    completedByName: nullableStr,
    canEdit: { type: 'boolean' },
    canManage: { type: 'boolean', description: 'may change everything (owner, creator, All scope); otherwise only the status' },
    canDelete: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const fields = {
  name: { type: 'string', minLength: 1, maxLength: 300, pattern: '\\S' },
  description: { type: ['string', 'null'], maxLength: 5000 },
  categoryId: { type: 'integer', minimum: 1 },
  projectId: { type: ['integer', 'null'], minimum: 1, description: 'required when the category is a project category' },
  taskGroupId: { type: ['integer', 'null'], minimum: 1 },
  taskTypeId: { type: ['integer', 'null'], minimum: 1, description: 'must be a type of the task group' },
  ownerId: { type: 'integer', minimum: 1 },
  assignedTo: { type: 'integer', minimum: 1 },
  estimatedMinutes: { type: ['integer', 'null'], minimum: 1, maximum: 999999 },
  status: { type: 'string', enum: STATUSES },
  plannedStart: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }], description: 'earliest start' },
  plannedEnd: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }], description: 'end before' },
  completedOn: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }], description: 'when status = completed (today if empty)' },
};

export const listSchema = {
  tags,
  summary: 'Tasks (mine, or all per the role data scope)',
  querystring: {
    type: 'object',
    properties: {
      ...paginationQuerySchema,
      sortBy: { type: 'string', enum: ['name', 'plannedEnd', 'plannedStart', 'status', 'createdAt'], default: 'plannedEnd' },
      scope,
      status: { type: 'string', description: 'comma-separated: to_do, in_progress, completed, hold' },
      categoryId: { type: 'string', description: 'comma-separated ids' },
      projectId: { type: 'string', description: 'comma-separated ids' },
      assignedTo: { type: 'string', description: 'comma-separated user ids' },
      employeeId: { type: 'string', description: 'Employee filter: tasks owned by / assigned to these users (comma-separated), from all the user can see' },
      overdue: { type: 'boolean' },
    },
  },
  response: { 200: pagedResponseSchema(task) },
};

export const summarySchema = {
  tags,
  summary: 'Task counts by status, overdue and due today',
  querystring: { type: 'object', properties: { scope, employeeId: { type: 'string', description: 'comma-separated user ids' } } },
  response: {
    200: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        toDo: { type: 'integer' },
        inProgress: { type: 'integer' },
        hold: { type: 'integer' },
        completed: { type: 'integer' },
        completedThisWeek: { type: 'integer' },
        overdue: { type: 'integer' },
        dueToday: { type: 'integer' },
      },
    },
  },
};

const opt = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    code: nullableStr,
    isProject: { type: 'boolean' },
    // categories: the task groups they can use (empty = any)
    taskGroupIds: { type: 'array', items: { type: 'integer' } },
    // projects: default task owner and the people a task can be assigned to (owner + members)
    ownerId: nullableInt,
    peopleIds: { type: 'array', items: { type: 'integer' } },
  },
};
export const optionsSchema = {
  tags,
  summary: 'Task form options: categories, projects, people the user may assign',
  response: {
    200: {
      type: 'object',
      properties: {
        categories: { type: 'array', items: opt },
        projects: { type: 'array', items: opt },
        users: { type: 'array', items: opt },
        canAssignOthers: { type: 'boolean' },
        canSeeAll: { type: 'boolean' },
      },
    },
  },
};

export const getSchema = { tags, summary: 'A task', params: idParams, response: { 200: task } };

export const createSchema = {
  tags,
  summary: 'Create a task (for yourself, or for others when the role allows)',
  body: { type: 'object', additionalProperties: false, required: ['name', 'categoryId'], properties: fields },
  response: { 201: task },
};

export const updateSchema = {
  tags,
  summary: 'Update a task (send only the changed fields)',
  params: idParams,
  body: { type: 'object', additionalProperties: false, minProperties: 1, properties: fields },
  response: { 200: task },
};

export const activitySchema = {
  tags,
  summary: 'Task history for the Activity tab (newest first)',
  params: idParams,
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, action: { type: 'string' }, message: nullableStr, userName: nullableStr, at: { type: 'string', format: 'date-time' } },
      },
    },
  },
};

const int = { type: 'integer' };
export const effortsSchema = {
  tags,
  summary: "Efforts: time logged in the timesheet against the task (everyone's for the task / project owner, else your own)",
  params: idParams,
  response: {
    200: {
      type: 'object',
      properties: {
        seesAll: { type: 'boolean' },
        estimatedMinutes: nullableInt,
        totalMinutes: int,
        taskMinutes: int,
        people: { type: 'array', items: { type: 'object', properties: { userId: int, name: { type: 'string' }, minutes: int, days: int, lastDate: { type: 'string' } } } },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: int, date: { type: 'string' }, userId: int, userName: { type: 'string' }, comment: nullableStr, minutes: int },
          },
        },
      },
    },
  },
};

export const templateProjectsSchema = {
  tags,
  summary: 'Your ongoing projects (not completed / cancelled), for adding tasks from the plan',
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          code: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
          projectTypeName: nullableStr,
          customerName: nullableStr,
          ownerId: nullableInt,
          peopleIds: { type: 'array', items: { type: 'integer' }, description: 'owner + members – who tasks can be assigned to' },
          taskGroupIds: { type: 'array', items: { type: 'integer' }, description: 'the project task groups (Estimate tab); empty = the estimate is not set, no group' },
        },
      },
    },
  },
};

export const planTasksSchema = {
  tags,
  summary: "A project's planned task groups, for adding tasks from the plan",
  params: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'integer', minimum: 1 } } },
  response: {
    200: {
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              taskGroupId: { type: 'integer' },
              name: { type: 'string' },
              effortPercentage: { type: 'number' },
              estimatedMinutes: nullableInt,
              tasks: {
                type: 'array',
                description: 'the tasks this group gets: one named after the group',
                items: {
                  type: 'object',
                  properties: { title: { type: 'string' }, taskTypeName: nullableStr, estimatedMinutes: nullableInt, existing: { type: 'boolean' } },
                },
              },
              periods: { type: 'array', items: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' }, weeks: { type: 'integer' } } } },
            },
          },
        },
      },
    },
  },
};

export const fromPlanSchema = {
  tags,
  summary: "Create the tasks of the picked planned task groups (dates from each group's first planned period)",
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['projectId', 'items'],
    properties: {
      projectId: { type: 'integer', minimum: 1 },
      ownerId: fields.ownerId,
      assignedTo: { ...fields.assignedTo, description: 'default assignee (each item can override)' },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['taskGroupId'],
          properties: {
            taskGroupId: { type: 'integer', minimum: 1 },
            ownerId: fields.ownerId,
            assignedTo: fields.assignedTo,
            assignees: {
              type: 'array',
              maxItems: 500,
              description: 'a different assignee for some of the group\'s tasks (by task title)',
              items: { type: 'object', additionalProperties: false, required: ['title', 'assignedTo'], properties: { title: { type: 'string', maxLength: 300 }, assignedTo: { type: 'integer', minimum: 1 } } },
            },
            estimatedMinutes: fields.estimatedMinutes,
          },
        },
      },
    },
  },
  response: { 201: { type: 'object', properties: { created: { type: 'integer' }, skipped: { type: 'integer' }, ids: { type: 'array', items: { type: 'integer' } } } } },
};

<<<<<<< HEAD
export const deleteSchema = { tags, summary: 'Delete a task and its subtasks', params: idParams, response: { 204: { type: 'null' } } };
=======
export const fromTemplateSchema = {
  tags,
  summary: 'Create tasks on a project from picked template tasks',
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['projectId', 'items'],
    properties: {
      projectId: { type: 'integer', minimum: 1 },
      ownerId: fields.ownerId,
      assignedTo: { ...fields.assignedTo, description: 'default assignee (each item can override)' },
      plannedStart: fields.plannedStart,
      plannedEnd: fields.plannedEnd,
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['templateId'],
          // per task – each falls back to the common value above
          properties: {
            templateId: { type: 'integer', minimum: 1 },
            ownerId: fields.ownerId,
            assignedTo: fields.assignedTo,
            plannedStart: fields.plannedStart,
            plannedEnd: fields.plannedEnd,
            estimatedMinutes: fields.estimatedMinutes,
          },
        },
      },
    },
  },
  response: { 201: { type: 'object', properties: { created: { type: 'integer' }, ids: { type: 'array', items: { type: 'integer' } } } } },
};

export const deleteSchema = { tags, summary: 'Delete a task', params: idParams, response: { 204: { type: 'null' } } };
>>>>>>> 3ea51260a802144b6537da0f3d1d9141600b4276
