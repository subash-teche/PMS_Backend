import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { pendingMigrations } from '../src/db/pending.js';

// The server refuses to start on a database that is behind (see src/server.js); this is the check it uses. No database needed.
const files = (await readdir(new URL('../src/db/migrations/', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();

describe('pending migrations', () => {
  it('lists every file when the database was never migrated', async () => {
    const never = { query: async () => { throw new Error('relation "schema_migrations" does not exist'); } };
    assert.deepEqual(await pendingMigrations(never), files);
  });
  it('lists only the files that are not recorded as applied', async () => {
    const behind = { query: async () => ({ rows: files.slice(0, -3).map((name) => ({ name })) }) };
    assert.deepEqual(await pendingMigrations(behind), files.slice(-3));
  });
  it('is empty when everything is applied', async () => {
    const upToDate = { query: async () => ({ rows: files.map((name) => ({ name })) }) };
    assert.deepEqual(await pendingMigrations(upToDate), []);
  });
});
