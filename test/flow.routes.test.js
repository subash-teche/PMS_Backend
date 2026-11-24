import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Boots the real Task Management routes on Fastify with a stubbed database: checks that every route schema compiles,
// that access is by role, and that bad input is rejected before it reaches the database.
process.env.DATABASE_URL ??= 'postgres://x:x@localhost:5432/x';
process.env.JWT_ACCESS_SECRET ??= 'x'.repeat(32);
process.env.COOKIE_SECRET ??= 'y'.repeat(32);

const { default: Fastify } = await import('fastify');
const { default: errorHandler } = await import('../src/plugins/error-handler.js');
const { default: flowRoutes } = await import('../src/modules/flow/flow.routes.js');
const { default: task135Routes } = await import('../src/modules/task135/task135.routes.js');
const { canUseFlow, appsOf } = await import('../src/config/flow.js');

const auth = (code, extra = {}) => ({ userId: 7, name: 'Test', timeZone: 'Asia/Dubai', isActive: true, isSuperAdmin: false, role: { code, level: 5, dataScope: 'own' }, permissions: {}, ...extra });

describe('Task Management access', () => {
  it('is for ADMIN, PROJECT_MANAGER, EMPLOYEE and the super admin only', () => {
    for (const code of ['ADMIN', 'PROJECT_MANAGER', 'EMPLOYEE']) assert.equal(canUseFlow(auth(code)), true, code);
    assert.equal(canUseFlow(auth('CUSTOMER')), false);
    assert.equal(canUseFlow(auth('VENDOR')), false);
    assert.equal(canUseFlow(auth('X', { isSuperAdmin: true })), true);
    assert.deepEqual(appsOf(auth('EMPLOYEE')), ['pms', 'tm']);
    assert.deepEqual(appsOf(auth('CUSTOMER')), ['pms']);
  });
});

describe('flow routes', () => {
  let app;
  let current = auth('EMPLOYEE');
  const queries = [];

  before(async () => {
    app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: 'all', coerceTypes: 'array', useDefaults: true } } });
    await app.register(errorHandler);
    app.decorate('db', { query: async (sql, params) => (queries.push({ sql, params }), { rows: [] }), tx: async (fn) => fn({ query: async () => ({ rows: [] }) }) });
    app.decorate('authenticate', async (req) => { req.auth = current; });
    app.decorate('authorize', () => async () => {});
    await app.register(flowRoutes, { prefix: '/api/v1/flow' });
    await app.register(task135Routes, { prefix: '/api/v1/task-135' });
    await app.ready(); // compiles every route schema
  });
  after(() => app.close());

  const call = (method, url, payload) => app.inject({ method, url: `/api/v1/flow${url}`, payload });

  it('keeps people without access out', async () => {
    current = auth('CUSTOMER');
    for (const [m, u] of [['GET', '/tasks'], ['GET', '/options'], ['GET', '/plan'], ['GET', '/timer'], ['GET', '/messages']]) {
      const res = await call(m, u);
      assert.equal(res.statusCode, 403, `${m} ${u}`);
    }
    assert.equal(queries.length, 0, 'no query ran for a forbidden user');
  });

  it('lets an employee read the board', async () => {
    current = auth('EMPLOYEE');
    const res = await call('GET', '/tasks?month=2026-11&scope=board');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  });

  it('rejects a bad new task before touching the database', async () => {
    current = auth('EMPLOYEE');
    queries.length = 0;
    const missing = await call('POST', '/tasks', { month: '2026-11', title: 'x' });
    assert.equal(missing.statusCode, 400);
    const badMonth = await call('POST', '/tasks', { month: '2026-13', projectId: 1, taskGroupId: 1, taskTypeId: 1, title: 'x' });
    assert.equal(badMonth.statusCode, 400);
    assert.equal(queries.length, 0);
  });

  it('rejects an unknown flow action chain', async () => {
    current = auth('EMPLOYEE');
    const res = await call('POST', '/tasks/1/close', { version: 1, then: 'start' });
    assert.equal(res.statusCode, 400);
  });

  it('validates plan and timer input', async () => {
    current = auth('EMPLOYEE');
    assert.equal((await call('PUT', '/plan', { stepId: 1, slot: { month: '2026-11', week: 9 } })).statusCode, 400);
    assert.equal((await call('POST', '/timer/1/pause', {})).statusCode, 400);
    assert.equal((await call('POST', '/messages', { body: '' })).statusCode, 400);
  });

  it('serves the 1-3-5 panel as an empty list for a role without Task Management', async () => {
    current = auth('CUSTOMER');
    const res = await app.inject({ method: 'GET', url: '/api/v1/task-135/flow-planned?date=2026-11-12' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), []);
  });
});
