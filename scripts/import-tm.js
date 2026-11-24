// Imports the old Task Management (Content Flow) database into PMS.  See src/modules/flow/import/tm-import.js.
//
//   npm run db:import-tm -- --source=<Task Management DATABASE_URL>                 dry run: reports, saves nothing
//   npm run db:import-tm -- --source=<url> --apply                                  saves it
//
// The Task Management database is only READ (one read-only snapshot): nothing in it is changed or deleted, ever.
// PMS only gets inserts. Take a backup / Neon branch of the PMS database before --apply.
//
// Options
//   --source=<url>          or set TM_DATABASE_URL
//   --apply                 save the import (default: dry run, rolled back)
//   --mapping=<file.json>   { "clients": { "<TM client name>": <PMS project id> }, "defaultProjectId": <id>,
//                             "taskTypes": { "<TM task type>": { "taskGroupId": <id>, "taskTypeId": <id> } },
//                             "users": { "<TM e-mail>": "<PMS e-mail>" } }   (same person, different e-mail: no second account is made)
//   --admin-role=ADMIN      PMS role for TM admins that get a new account (default EMPLOYEE)
//   --legacy-owner=<user>   PMS username that owns the projects created for tasks that had none (default: first Admin)
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { importTm, openSource } from '../src/modules/flow/import/tm-import.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  }),
);
const sourceUrl = args.source || process.env.TM_DATABASE_URL;
const targetUrl = process.env.DATABASE_URL;
const fail = (msg) => {
  console.error(`
${msg}
`);
  console.error('Usage:');
  console.error('  npm run db:import-tm -- --source="<Task Management database URL>"           (dry run: saves nothing)');
  console.error('  npm run db:import-tm -- --source="<Task Management database URL>" --apply   (saves the import)');
  console.error('or put TM_DATABASE_URL=<url> in .env (or set it in the shell) and leave out --source.');
  console.error('PowerShell without the "--" trouble:  $env:TM_DATABASE_URL = "<url>"; npm run db:import-tm');
  process.exit(1);
};
if (!sourceUrl) fail('The Task Management database is not given (--source=<url> or TM_DATABASE_URL).');
if (!targetUrl) fail('DATABASE_URL (the PMS database, normally from .env) is not set.');
const id = (u) => {
  try {
    const x = new URL(u);
    return `${x.hostname}${x.port}/${x.pathname}`.toLowerCase();
  } catch {
    return fail('A database URL is not valid. It looks like postgresql://user:password@host/dbname');
  }
};
if (id(sourceUrl) === id(targetUrl)) fail('The Task Management database and the PMS database are the same database - refusing to run.');

pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

const sourceClient = new pg.Client({ connectionString: sourceUrl });
const pool = new pg.Pool({ connectionString: targetUrl, max: 2, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
const target = {
  async tx(fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  },
};

let exit = 0;
try {
  await sourceClient.connect();
  const source = await openSource(sourceClient);
  const mapping = args.mapping ? JSON.parse(await readFile(String(args.mapping), 'utf8')) : {};
  const apply = args.apply === true;
  console.log(apply ? '== APPLYING the import ==' : '== DRY RUN - nothing will be saved (add --apply to save) ==');
  const report = await importTm({
    source,
    target,
    apply,
    mapping,
    options: { adminRole: args['admin-role'] || 'EMPLOYEE', legacyOwner: args['legacy-owner'] },
    log: (m) => console.log(m),
  });
  await source.close();

  console.log('\nWhat was found / created');
  console.table(report.stats);
  console.log('Reconciliation (PMS must hold everything the source had)');
  console.table(report.check);
  console.log('Projects used for the imported tasks');
  console.table(report.projects);
  console.log(`Project members added to the imported projects: ${report.membersAdded}`);
  console.log('Left in the Task Management database (not imported):', JSON.stringify(report.notImported));
  console.log(`Task Management database unchanged: ${report.sourceUnchanged ? 'yes' : 'NO'}`);
  if (report.warnings.length) {
    console.log(`\n${report.warnings.length} warning(s):`);
    for (const w of report.warnings) console.log(' -', w);
  }
  const file = `import-tm-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to ${file}`);
  console.log(apply ? 'Done. The Task Management database was not touched and can be kept as the archive.' : 'Dry run finished: nothing was saved. Run again with --apply when the report looks right.');
} catch (err) {
  console.error(`\nImport failed - nothing was saved: ${err.message}`);
  exit = 1;
} finally {
  await sourceClient.end().catch(() => {});
  await pool.end();
}
process.exitCode = exit;
