import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Employee codes are plain numbers from 1. Run on an EMPTY throwaway database with all migrations applied:
//   FLOW_TEST_DB=postgres://postgres@127.0.0.1:55432/pms_emp_test node --test test/emp-code.test.js
const URL = process.env.FLOW_TEST_DB;
process.env.DATABASE_URL ??= URL ?? 'postgres://x:x@localhost:5432/x';
process.env.JWT_ACCESS_SECRET ??= 'x'.repeat(32);
process.env.COOKIE_SECRET ??= 'y'.repeat(32);
const skip = URL ? false : 'set FLOW_TEST_DB to a throwaway database to run';
const here = path.dirname(fileURLToPath(import.meta.url));

describe('employee codes', { skip }, () => {
  let pool, nextEmpCode, roleId;
  const q = async (sql, p) => (await pool.query(sql, p)).rows;
  const addUser = async (name, code) => (await q(`INSERT INTO users (username, password_hash, name, role_id, employee_code) VALUES ($1::varchar, 'x', $1::varchar, $2, $3) RETURNING id`, [name, roleId, code]))[0].id;
  const codes = async () => Object.fromEntries((await q(`SELECT name, employee_code FROM users`)).map((r) => [r.name, r.employee_code]));

  // migration 041 was written when the column was still called emp_code (045 renamed it): replay it under that name
  const replay041 = async () => {
    await q(`ALTER TABLE users RENAME COLUMN employee_code TO emp_code`);
    try { await q(await readFile(path.resolve(here, '../src/db/migrations/041_numeric_employee_codes.sql'), 'utf8')); }
    finally { await q(`ALTER TABLE users RENAME COLUMN emp_code TO employee_code`); }
  };

  before(async () => {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: URL, max: 2 });
    if (Number((await q(`SELECT count(*) AS n FROM users`))[0].n) !== 0) throw new Error('FLOW_TEST_DB must be an empty throwaway database');
    roleId = (await q(`INSERT INTO roles (code, name, level) VALUES ('R', 'R', 5) RETURNING id`))[0].id;
    ({ nextEmpCode } = await import('../src/modules/users/users.service.js'));
  });
  after(async () => { await pool?.end(); });

  it('the first employee is 001, then the highest number + 1 (at least three digits)', async () => {
    assert.equal(await nextEmpCode(pool), '001');
    await addUser('a', '001');
    assert.equal(await nextEmpCode(pool), '002');
    await addUser('b', '7'); // typed by hand without the zeros: still the number 7
    assert.equal(await nextEmpCode(pool), '008');
    await addUser('c', '099');
    assert.equal(await nextEmpCode(pool), '100');
    await addUser('d', '999');
    assert.equal(await nextEmpCode(pool), '1000');
    await addUser('e', 'EMQ099'); // not a plain number: ignored
    await addUser('f', null);
    assert.equal(await nextEmpCode(pool), '1000');
    await q(`DELETE FROM users`);
  });

  it('converts the old EMP-#### codes (EMP-1001 -> 001) and leaves everything else alone', async () => {
    await addUser('admin', 'EMP-1001');
    await addUser('sundaram', 'EMP-1002');
    await addUser('subash', 'EMP-1003');
    await addUser('mohsin', 'EMP-1004');
    await addUser('manual', 'EMQ099');
    await addUser('nocode', null);
    await addUser('low', 'EMP-0042'); // below 1001: just loses the prefix
    await addUser('taken', 'EMP-1010'); // number 10 ...
    await addUser('holder', '10'); // ... is already used by someone else (010 counts as 10): left as it is
    await replay041();
    assert.deepEqual(await codes(), { admin: '001', sundaram: '002', subash: '003', mohsin: '004', manual: 'EMQ099', nocode: null, low: '042', taken: 'EMP-1010', holder: '10' });
    // running it again changes nothing, and the next employee carries on after the highest number
    await replay041();
    assert.equal((await codes()).admin, '001');
    assert.equal(await nextEmpCode(pool), '043');
  });
});
