import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Names of the migration files that have not been applied to this database yet (all of them when it was never migrated). */
export async function pendingMigrations(db) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  let applied = new Set();
  try {
    const { rows } = await db.query('SELECT name FROM schema_migrations');
    applied = new Set(rows.map((r) => r.name));
  } catch {
    /* no schema_migrations table: nothing was ever applied */
  }
  return files.filter((f) => !applied.has(f));
}
