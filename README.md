# emQube PMS – Backend (API)

Fastify 5 REST API on PostgreSQL. Phase 1 scope: **login + RBAC** (users, roles & permissions) and **project creation**.

## Requirements

- Node.js **22.12+** (tested on 24.15 — `nvm use 24.15.0`)
- PostgreSQL 14+ (tested on 18)

## Setup

```bash
npm install
cp .env.example .env        # then set DATABASE_URL, JWT_ACCESS_SECRET, COOKIE_SECRET
npm run db:setup            # create database → run migrations → seed
npm run dev                 # http://localhost:4000  ·  API docs: http://localhost:4000/docs
```

The seed creates a Super Admin: **admin / Admin@123** (override with `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`). Change the password after the first login.

| Script | What it does |
|---|---|
| `npm run dev` | Start with file watching |
| `npm start` | Start (production) |
| `npm run db:create` | Create the database in `DATABASE_URL` if missing |
| `npm run db:migrate` | Apply new files in `src/db/migrations` (tracked in `schema_migrations`) |
| `npm run db:seed` | Roles, menus, permissions, admin user, masters (idempotent) |

## Structure

```
src/
├── server.js                 entry: listen + graceful shutdown
├── app.js                    builds the Fastify app: plugins → modules under /api/v1
├── config/
│   ├── env.js                validated environment config (env-schema)
│   └── menus.js              RBAC screen keys (= menus.url) and actions
├── plugins/                  cross-cutting middleware
│   ├── db.js                 pg Pool → fastify.db.query() / fastify.db.tx()
│   ├── auth.js               JWT + cookies; fastify.authenticate / authorize / authorizeAny
│   ├── security.js           helmet, CORS, global rate limit
│   ├── error-handler.js      one error format; maps PG constraint errors to 400/409
│   └── swagger.js            OpenAPI docs at /docs
├── modules/<feature>/        one folder per feature
│   ├── *.routes.js           routes + guards (thin)
│   ├── *.schemas.js          JSON-schema validation and response serialisation
│   └── *.service.js          business rules and SQL
├── utils/                    errors, crypto, query builder, audit log
└── db/migrations/001_initial_schema.sql   = git2/PMS_schema.sql (full 67-table ERD)
scripts/                      create-db, migrate, seed
```

## Auth & RBAC

- **Login** `POST /api/v1/auth/login` → short-lived access token (JWT, 15 min, sent as `Authorization: Bearer`) + refresh token in an **httpOnly cookie** (`SameSite=Strict`, path `/api/v1/auth`). “Keep me signed in” → 30-day persistent cookie, otherwise 1 day / browser session.
- **Refresh rotation** `POST /auth/refresh`: every refresh revokes the old token. Re-using a revoked token revokes all of that user's sessions.
- **Lockout**: 5 wrong passwords lock the account (`423`). An admin unlocks it (`POST /users/:id/unlock`) or resets the password.
- **Permissions** come from `role_permissions` per screen (`menus.url`): `view / create / edit / delete / approve / export`. Routes use `preHandler: fastify.authorize(SCREENS.PROJECTS, 'create')`. Role level 0 (Super Admin) can do everything.
- **Level rule**: a user can only create/edit/delete roles — and assign roles to users — whose level is **higher** than their own, and cannot grant an action they don't have.
- **Data scope** (projects): `all` · `team` (shares a team via `user_teams`) · `own` (owner or member) · `customer` (user's customer) · `vendor` (as own).
- `GET /auth/me` returns the user, permission map and the **sidebar menu tree filtered to what the role can view**.

## Endpoints (v1)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/change-password` |
| Users | `GET /users` · `GET /users/:id` · `POST /users` · `PUT /users/:id` (send `password` to reset) · `POST /users/:id/unlock` · `DELETE /users/:id` |
| Roles | `GET /roles` · `GET /roles/options` · `GET /roles/:id` · `POST /roles` · `PUT /roles/:id` · `DELETE /roles/:id` · `GET /menus` |
| Projects | `GET /projects` (search, filters, tabs all/mine/owned, sort, paging) · `GET /projects/summary` · `GET /projects/:id` · `POST /projects` · `PUT /projects/:id` · `DELETE /projects/:id` |
| Masters (dropdowns) | `GET /masters/{customers,users,project-divisions,project-types,sites,shifts,currencies}` · `GET /masters/lookups/:type` |

**Creating a project** generates the code (`PRJ-1001`, …), copies the project type's default effort % into `project_task_group_estimates`, and adds the owner as a project member — all in one transaction, written to `audit_logs`.

Errors always look like `{ statusCode, code, message, details? }`; `details` lists field errors for `400 VALIDATION_ERROR`.

## Adding a new screen later

1. Add a migration if the schema changes (`src/db/migrations/002_….sql`).
2. Add the menu row (and default permissions) to `scripts/seed.js`, and its key to `src/config/menus.js`.
3. Create `src/modules/<feature>/` (routes, schemas, service) and register it in `src/app.js`.

## Importing the old Task Management database

`npm run db:import-tm` copies the old Task Management (Content Flow) data into PMS. It is built so that **the Task Management database is never changed or deleted from**: it is read inside one `READ ONLY` snapshot transaction (Postgres rejects any write) and the tool refuses anything but `SELECT`. After the import the old database is exactly as before and stays as the archive. PMS only receives inserts.

```bash
# 1. dry run (default): prints a report, saves nothing
npm run db:import-tm -- --source="<Task Management DATABASE_URL>"

# 2. when the report looks right, save it (the PMS DATABASE_URL comes from .env)
npm run db:import-tm -- --source="<Task Management DATABASE_URL>" --apply
```

Options: `--mapping=file.json`, `--admin-role=ADMIN`, `--legacy-owner=<username>`, `--no-timesheets`. A JSON report is written to the current folder.

| Task Management | PMS |
|---|---|
| users | matched by e-mail (or username) to existing PMS users, who keep their PMS password; the others get a new account (`EMPLOYEE`, the old password hash is copied so they sign in with the same password). Task Management admins are **not** made PMS admins unless `--admin-role=ADMIN` |
| clients | customers, matched by name (case-insensitive); missing ones are created |
| tasks, steps | `flow_tasks`, `flow_steps` (same order, status, times, owners, priority, version) |
| time logs | `flow_time_logs` **and** a read-only PMS Timesheet row each (day counted in Dubai time) |
| timer entries, plan, history, messages | `flow_timers`, `flow_plan_items`, `flow_task_history`, `flow_messages` + `flow_message_recipients` |
| templates, sessions, login attempts | **not imported** (they stay in the old database; the report lists the counts) |

A flow task needs a project, task group and type, which the old tasks did not have, so by default:

- a client becomes the project **"Task Management - <client>"** (tasks without a client: "Task Management - General"), not billable, with the people involved added as members; each task type becomes a type of the task group "Task Management (imported)", and a main task is created per project and group;
- to use real projects instead, give a mapping file:

```json
{
  "clients": { "ACME Foods": 12 },
  "defaultProjectId": 5,
  "taskTypes": { "Reel": { "taskGroupId": 3, "taskTypeId": 9 } }
}
```

**Safe to repeat, atomic:** everything runs in one PMS transaction. If anything fails, or the reconciliation at the end (tasks, steps, time logs, minutes, messages) does not match, nothing is saved. Running it again only adds rows that are not there yet (matched by `legacy_id`); it does **not** update rows that were already imported.

**Cutover:** try it on a copy (a Neon branch) of the PMS database as often as you like. For the real run, stop people from working in the old app first, take a backup of the PMS database, then run `--apply` once.

**Keep the old data:** the old app still has its daily cleanup job (Vercel Cron `/api/cron/cleanup`, which deletes tasks completed more than a year ago). To keep the old database intact, remove the `CRON_SECRET` environment variable from the old app's Vercel project (the endpoint then answers 403) or disable the cron there.

Tests: `FLOW_TEST_DB=… TM_TEST_DB=… node --test test/import-tm.test.js` (two empty throwaway databases on 127.0.0.1:55432; the test builds a fake Task Management database from `TaskManagement/drizzle/*.sql`, which is only read).

## Going live with Task Management: the order of steps

Do these in this order. Take a backup (or a Neon branch) of the PMS database first.

1. **Migrate the PMS database:** `npm run db:migrate` (Task Management tables, new task types, numeric employee codes). The API
   refuses to start while migrations are pending and tells you which; do not set `SKIP_MIGRATION_CHECK=true` on a real database.
2. **Add the people** who are in the old Task Management but not in PMS: `npm run db:add-people` (dry run), then
   `npm run db:add-people -- --apply`. Each person gets their own random password, shown once - copy it and hand it over.
   Use `--like=<email>` to copy site / shift / time zone from a colleague and `--admin=<email>` for admins.
3. **Dry-run the data import:** `npm run db:import-tm -- --source="<old database URL>"`. Read the warnings. A person who has a
   different e-mail in the two systems must be named in the mapping file (`"users": { "<TM e-mail>": "<PMS e-mail>" }`), or the
   import makes a second account for them; the warning tells you who. Map the old clients to PMS projects the same way.
4. **Import for real:** the same command with `--apply`. The old database is only read - nothing in it is changed or deleted.
   It can be run again later: it only adds what is missing.
5. **Cut over:** pick a date after which the old Task Management is no longer used. Work done in it after the import is not
   copied until you run the import again. If the old app is still deployed, remove its `CRON_SECRET` (it has a daily job that
   deletes tasks completed more than a year ago) so the old data stays intact.
6. **Deploy the new API and front end**, then sign in as an Admin, open Task Management and check the Board, the Plan and the 1-3-5.

Task Management is open to the roles in `src/config/flow.js` (Admin, Project Manager, Employee). A PMS user whose role is not in
that list cannot open it; for them the PMS task page and list keep the Start / Complete / Hold buttons, so their work is not blocked.
