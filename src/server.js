import { buildApp } from './app.js';
import { config } from './config/env.js';
import { pendingMigrations } from './db/pending.js';

const app = await buildApp();

// Graceful shutdown: stop accepting requests, finish in-flight ones, close the DB pool.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  });
}

// The code reads tables and columns that the migrations add (Task Management, employee codes ...). Starting on a database that
// is behind would fail halfway through (for example the Timesheet), so refuse to start and say what to run.
if (process.env.SKIP_MIGRATION_CHECK !== 'true') {
  const pending = await pendingMigrations(app.db);
  if (pending.length) {
    app.log.error(`The database is behind: ${pending.length} migration(s) not applied (${pending.join(', ')}). Run "npm run db:migrate" first, then start the server.`);
    await app.close();
    process.exit(1);
  }
}

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`API docs: http://localhost:${config.port}/docs`);
} catch (err) {
  app.log.error({ err }, 'Failed to start');
  process.exit(1);
}
