// Adds the team members of the old Task Management app that are not in PMS yet. People are matched BY E-MAIL.
//
//   npm run db:add-people                       dry run: shows what would be added, saves nothing
//   npm run db:add-people -- --apply            adds them, each with their OWN random password (printed once: copy it then)
//
// Options
//   --password=<text>       give everyone this one temporary password instead of a random one each (they should change it after signing in)
//   --like=<email>          copy site, shift, time zone, reports-to and resource grade from this existing PMS user (e.g. shibin@emqube.com)
//   --admin=<email,email>   make these people PMS Admins (default role: Employee)
//   --include-similar       also add a person whose first name matches someone already in PMS under another e-mail (skipped by default)
//   --apply                 save (default: dry run, rolled back)
//
// Nothing is changed for people already in PMS (found by e-mail or username), and running it again adds nobody twice.
// Each new person gets the next employee code (001, 002, ...), their e-mail as username and an entry in the audit log.
import { randomInt } from 'node:crypto';
import pg from 'pg';
import { hashPassword } from '../src/utils/crypto.js';
import { nextEmpCode } from '../src/modules/users/users.service.js';
import { writeAudit } from '../src/utils/audit.js';

// the people list of the old Task Management app (name, e-mail)
const PEOPLE = [
  ['Abdulla', 'abdullah@emqube.com'],
  ['Khadija', 'khadija@emqube.com'],
  ['Mohammed', 'mohammed@emqube.com'],
  ['Mohsin', 'mohsin.sayed@emqube.com'],
  ['Pradnya', 'pradnya@emqube.com'],
  ['Shibin', 'shibin@emqube.com'],
  ['Shradha', 'shradha@emqube.com'],
  ['Subash', 'subash@emqube.com'],
  ['Surya', 'surya@emqube.com'],
];

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
const fail = (m) => { console.error(`\n${m}\n\nUsage: npm run db:add-people -- [--password="<one password for all>"] [--like=<email>] [--admin=<email,...>] [--include-similar] [--apply]`); process.exit(1); };
if (args.password === true) fail('--password needs a value: --password="..." (or leave it out for a random password each)');
if (!process.env.DATABASE_URL) fail('DATABASE_URL (the PMS database, normally from .env) is not set.');
const apply = args.apply === true;
/** 12 characters without the look-alikes (0/O, 1/l/I), with a letter, a digit and a symbol, so it also passes the password rules. */
const randomPassword = () => {
  const pick = (set) => set[randomInt(set.length)];
  const L = 'abcdefghjkmnpqrstuvwxyz', U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', D = '23456789', X = '@#$%&*';
  const chars = [pick(U), pick(L), pick(D), pick(X), ...Array.from({ length: 8 }, () => pick(L + U + D))];
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
};
const admins = String(args.admin === true ? '' : (args.admin ?? '')).toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
const stem = (s) => s.toLowerCase().replace(/[^a-z]/g, '').slice(0, 4);

pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
const c = await pool.connect();
let exit = 0;
try {
  await c.query('BEGIN');
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const roles = Object.fromEntries((await q(`SELECT id, code FROM roles WHERE code IN ('EMPLOYEE', 'ADMIN')`)).map((r) => [r.code, r.id]));
  if (!roles.EMPLOYEE) throw new Error('There is no EMPLOYEE role in PMS');
  if (admins.length && !roles.ADMIN) throw new Error('There is no ADMIN role in PMS');
  let like = {};
  if (args.like && args.like !== true) {
    const [u] = await q(`SELECT site_id, site_shift_id, time_zone, manager_id, resource_grade_id FROM users WHERE lower(email) = lower($1)`, [args.like]);
    if (!u) throw new Error(`--like: no PMS user with the e-mail ${args.like}`);
    like = u;
  }
  const existing = await q(`SELECT id, name, username, email FROM users`);
  const report = [];
  for (const [name, email] of PEOPLE) {
    const e = email.toLowerCase();
    const hit = existing.find((u) => (u.email ?? '').toLowerCase() === e || u.username.toLowerCase() === e);
    if (hit) { report.push({ name, email, result: `already in PMS (#${hit.id} ${hit.name})` }); continue; }
    const similar = existing.find((u) => stem(u.name) === stem(name) || stem((u.email ?? '').split('@')[0]) === stem(name));
    if (similar && !args['include-similar']) {
      report.push({ name, email, result: `SKIPPED: PMS already has "${similar.name}" <${similar.email}> - probably the same person (use --include-similar to add anyway)` });
      continue;
    }
    const role = admins.includes(e) ? 'ADMIN' : 'EMPLOYEE';
    const empCode = await nextEmpCode(c);
    const password = args.password ? String(args.password) : randomPassword();
    const hash = await hashPassword(password);
    const [row] = await q(
      `INSERT INTO users (employee_code, username, password_hash, name, email, role_id, site_id, site_shift_id, time_zone, manager_id, resource_grade_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'Asia/Kolkata'), $10, $11) RETURNING id`,
      [empCode, e, hash, name, e, roles[role], like.site_id ?? null, like.site_shift_id ?? null, like.time_zone ?? null, like.manager_id ?? null, like.resource_grade_id ?? null],
    );
    await writeAudit(c, { entity: 'users', entityId: row.id, action: 'create', userId: null, message: `User ${e} created (Task Management people import)` });
    existing.push({ id: row.id, name, username: e, email: e });
    report.push({ name, email, result: `${apply ? 'ADDED' : 'would be added'} as ${role === 'ADMIN' ? 'Admin' : 'Employee'}, code ${empCode}`, ...(apply && !args.password ? { password } : {}) });
  }
  console.log(apply ? '== ADDING people ==' : '== DRY RUN - nothing is saved (add --apply to save) ==');
  console.table(report);
  if (apply) await c.query('COMMIT'); else await c.query('ROLLBACK');
  console.log(apply ? (args.password ? 'Done. Give everyone the temporary password; they can change it after signing in.' : 'Done. The passwords above are shown ONLY NOW - copy them, give each person their own; they can change it after signing in.') : 'Dry run finished: nothing was saved (passwords are made when you add --apply).');
} catch (err) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\nFailed - nothing was saved: ${err.message}`);
  exit = 1;
} finally {
  c.release();
  await pool.end();
}
process.exitCode = exit;
