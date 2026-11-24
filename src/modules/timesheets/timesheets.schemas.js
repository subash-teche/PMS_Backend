import { paginationQuerySchema, pagedResponseSchema } from '../../utils/query.js';

const tags = ['Timesheet'];
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const scope = { type: 'string', enum: ['mine', 'team'], default: 'mine', description: 'mine = own entries; team = per the role data scope' };

const entry = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    userId: { type: 'integer' },
    userName: { type: 'string' },
    workDate: { type: 'string' },
    categoryId: { type: ['integer', 'null'] },
    categoryName: { type: ['string', 'null'] },
    isProjectCategory: { type: 'boolean' },
    isMasked: { type: 'boolean', description: "someone else's personal time – details hidden" },
    projectId: { type: ['integer', 'null'] },
    projectCode: { type: ['string', 'null'] },
    projectTitle: { type: ['string', 'null'] },
    taskGroupId: { type: ['integer', 'null'] },
    taskGroupName: { type: ['string', 'null'] },
    taskTypeId: { type: ['integer', 'null'] },
    taskTypeName: { type: ['string', 'null'] },
    taskId: { type: ['integer', 'null'] },
    taskName: { type: ['string', 'null'] },
    minutes: { type: 'integer' },
    hours: { type: 'number' },
    comment: { type: ['string', 'null'] },
    isBillable: { type: 'boolean' },
    source: { type: 'string', enum: ['manual', 'flow'], description: 'flow = logged in Task Management (read-only here)' },
    flowTaskId: { type: ['integer', 'null'] },
    entries: { type: 'integer', description: 'grouped by task: how many entries were added up' },
    firstDate: { type: 'string' },
    lastDate: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

// time spent in whole minutes; the day total is capped at 24 h (1440 mins) by the service
const fields = {
  workDate: { type: 'string', format: 'date' },
  taskId: { type: 'integer', minimum: 1, description: 'the task the time was spent on (one you work on)' },
  minutes: { type: 'integer', minimum: 1, maximum: 1440 },
  comment: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
  isBillable: { type: 'boolean' },
};

export const listSchema = {
  tags,
  summary: 'Time entries (own, or the team per the role data scope)',
  querystring: {
    type: 'object',
    properties: {
      ...paginationQuerySchema,
      sortDir: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
      sortBy: { type: 'string', enum: ['workDate', 'minutes', 'project', 'createdAt'], default: 'workDate' },
      scope,
      groupBy: { type: 'string', enum: ['task'], description: 'task = one row per task with the time collected on it' },
      projectId: { type: 'string', description: 'comma-separated ids' },
      userId: { type: 'string', description: 'comma-separated ids (team scope)' },
      taskGroupId: { type: 'string', description: 'comma-separated ids' },
      categoryId: { type: 'string', description: 'task category ids, comma-separated' },
      isBillable: { type: 'boolean' },
      from: { type: 'string', format: 'date' },
      to: { type: 'string', format: 'date' },
    },
  },
  response: { 200: { ...pagedResponseSchema(entry), properties: { ...pagedResponseSchema(entry).properties, totalMinutes: { type: 'integer' }, totalHours: { type: 'number' } } } },
};

export const summarySchema = {
  tags,
  summary: 'This week: hours, billable split, projects',
  querystring: { type: 'object', properties: { scope } },
  response: {
    200: {
      type: 'object',
      properties: {
        weekHours: { type: 'number' },
        billableHours: { type: 'number' },
        nonBillableHours: { type: 'number' },
        todayHours: { type: 'number' },
        projects: { type: 'integer' },
        clientProjects: { type: 'integer' },
        internalProjects: { type: 'integer' },
        daysLogged: { type: 'integer' },
      },
    },
  },
};

export const optionsSchema = {
  tags,
  summary: 'Log time form: the tasks you work on, with their project and category',
  response: {
    200: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          status: { type: 'string' },
          projectId: { type: ['integer', 'null'] },
          projectCode: { type: ['string', 'null'] },
          projectTitle: { type: ['string', 'null'] },
          categoryId: { type: ['integer', 'null'] },
          categoryName: { type: ['string', 'null'] },
        },
      },
    },
  },
};

export const filterProjectsSchema = {
  tags,
  summary: 'Projects for the list filter (all projects for the Super Admin)',
  response: {
    200: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, code: { type: 'string' }, title: { type: 'string' } } } },
  },
};

export const getSchema = { tags, summary: 'A time entry', params: idParams, response: { 200: entry } };

export const createSchema = {
  tags,
  summary: 'Log time',
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['workDate', 'taskId', 'minutes', 'comment'],
    properties: fields,
  },
  response: { 201: entry },
};

export const updateSchema = {
  tags,
  summary: 'Update an own time entry',
  params: idParams,
  body: { type: 'object', additionalProperties: false, minProperties: 1, properties: fields },
  response: { 200: entry },
};

export const deleteSchema = { tags, summary: 'Delete an own time entry', params: idParams, response: { 204: { type: 'null' } } };
