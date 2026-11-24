import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { escapeLike, WhereBuilder } from '../src/utils/query.js';

const app = await buildApp({ logger: false });
after(() => app.close());

test('protected routes need a login', async () => {
  for (const url of ['/api/v1/projects', '/api/v1/tasks', '/api/v1/timesheets', '/api/v1/users']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 401, url);
  }
});

test('the removed task-template endpoints are gone', async () => {
  for (const url of ['/api/v1/tasks/from-template', '/api/v1/tasks/template-projects']) {
    const res = await app.inject({ method: 'GET', url });
    assert.ok([401, 404].includes(res.statusCode), `${url} → ${res.statusCode}`);
    assert.notEqual(res.statusCode, 200);
  }
});

test('the API sends a strict content-security-policy, the docs page a relaxed one', async () => {
  const api = await app.inject({ method: 'GET', url: '/api/v1/projects' });
  assert.ok(api.headers['content-security-policy'], 'API responses carry a CSP');
  assert.equal(api.headers['x-content-type-options'], 'nosniff');
  const docs = await app.inject({ method: 'GET', url: '/docs' });
  assert.ok([200, 302].includes(docs.statusCode));
  assert.equal(docs.headers['content-security-policy'], undefined);
});

test('login rejects a body without the employee code', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'x' } });
  assert.ok([400, 422].includes(res.statusCode), `login without a code → ${res.statusCode}`);
});

test('search text is escaped for LIKE', () => {
  assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\');
});

test('WhereBuilder numbers its parameters', () => {
  const w = new WhereBuilder();
  w.add('a = $?', 1);
  w.add('b = $?', 2);
  assert.match(w.toSql(), /a = \$1/);
  assert.match(w.toSql(), /b = \$2/);
  assert.deepEqual(w.params, [1, 2]);
});
