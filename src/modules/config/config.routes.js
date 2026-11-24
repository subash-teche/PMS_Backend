import { SCREENS } from '../../config/menus.js';
import { CONFIG_DEFS } from './config.defs.js';
import { crudRoutes } from './crud-factory.js';
import projectTypesRoutes from './project-types.routes.js';
import taskGroupsRoutes from './task-groups.routes.js';
import projectDivisionsRoutes from './project-divisions.routes.js';
import sitesRoutes from './sites.routes.js';
import resourceGradesRoutes from './resource-grades.routes.js';
import usdRatesRoutes from './usd-rates.routes.js';

/** Configuration (master data) screens: /api/v1/config/<name> */
export default async function configRoutes(fastify) {
  // extra read-only endpoints first, so they are not taken as "/:id"
  await fastify.register(async (f) => {
    f.addHook('onRequest', f.authenticate);

    f.get(
      '/parameters/types',
      {
        schema: { tags: ['Parameters'], summary: 'Lookup types in use', response: { 200: { type: 'array', items: { type: 'string' } } } },
        preHandler: f.authorize(SCREENS.PARAMETERS, 'view'),
      },
      async () => {
        // the parameters (Parameters tab); project stages have their own screen
        const { rows } = await f.db.query(`SELECT code FROM parameter_types WHERE code <> 'PROJECT_STAGE' ORDER BY display_order, name`);
        return rows.map((r) => r.code);
      },
    );

    f.get(
      '/customers/summary',
      {
        schema: {
          tags: ['Customers'],
          summary: 'Customer list summary cards',
          response: {
            200: {
              type: 'object',
              properties: {
                total: { type: 'integer' },
                active: { type: 'integer' },
                inactive: { type: 'integer' },
                createdThisQuarter: { type: 'integer' },
                totalByMonth: { type: 'array', items: { type: 'integer' } },
                projectsRunning: {
                  type: 'object',
                  properties: {
                    total: { type: 'integer' },
                    fixed: { type: 'integer' },
                    retainer: { type: 'integer' },
                    customers: { type: 'integer' },
                    byMonth: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, count: { type: 'integer' } } } },
                  },
                },
                byCountry: {
                  type: 'array',
                  items: { type: 'object', properties: { id: { type: ['integer', 'null'] }, name: { type: 'string' }, count: { type: 'integer' } } },
                },
                missingContact: {
                  type: 'object',
                  properties: {
                    total: { type: 'integer' },
                    items: {
                      type: 'array',
                      items: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, missing: { type: 'array', items: { type: 'string' } } } },
                    },
                  },
                },
              },
            },
          },
        },
        preHandler: f.authorize(SCREENS.CUSTOMERS, 'view'),
      },
      async () => {
        const [c, trend, running, months, countries, gaps] = await Promise.all([
          f.db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE is_active)::int AS active,
                             count(*) FILTER (WHERE created_at >= date_trunc('quarter', now()))::int AS quarter FROM customers`),
          f.db.query(`SELECT count(c.id)::int AS n
                        FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m(month)
                        LEFT JOIN customers c ON c.created_at < m.month + interval '1 month'
                       GROUP BY m.month ORDER BY m.month`),
          f.db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE is_retainer_project)::int AS retainer,
                             count(DISTINCT customer_id)::int AS customers
                        FROM projects WHERE customer_id IS NOT NULL AND status IN ('not_started', 'in_progress')`),
          // customer projects started per month, last 7 months
          f.db.query(`SELECT to_char(m.month, 'Mon') AS label, count(p.id)::int AS n
                        FROM generate_series(date_trunc('month', now()) - interval '6 months', date_trunc('month', now()), interval '1 month') m(month)
                        LEFT JOIN projects p ON p.customer_id IS NOT NULL AND date_trunc('month', p.start_date) = m.month
                       GROUP BY m.month ORDER BY m.month`),
          // customers per country (lookups COUNTRY); "Not set" when empty
          f.db.query(`SELECT l.id, COALESCE(l.name, 'Not set') AS name, count(*)::int AS n
                        FROM customers c LEFT JOIN parameter_values l ON l.id = c.country_id
                       GROUP BY l.id, l.name ORDER BY n DESC, name`),
          // active customers without a contact person, email or phone
          f.db.query(`SELECT id, name, count(*) OVER()::int AS total,
                             array_remove(ARRAY[
                               CASE WHEN COALESCE(trim(contact_person), '') = '' THEN 'Contact person' END,
                               CASE WHEN COALESCE(trim(email), '') = '' THEN 'Email' END,
                               CASE WHEN COALESCE(trim(contact_number), '') = '' THEN 'Phone' END], NULL) AS missing
                        FROM customers
                       WHERE is_active AND (COALESCE(trim(contact_person), '') = '' OR COALESCE(trim(email), '') = '' OR COALESCE(trim(contact_number), '') = '')
                       ORDER BY name LIMIT 3`),
        ]);
        const r = c.rows[0];
        const run = running.rows[0];
        return {
          total: r.total,
          active: r.active,
          inactive: r.total - r.active,
          createdThisQuarter: r.quarter,
          totalByMonth: trend.rows.map((m) => m.n),
          projectsRunning: {
            total: run.total,
            fixed: run.total - run.retainer,
            retainer: run.retainer,
            customers: run.customers,
            byMonth: months.rows.map((m) => ({ label: m.label, count: m.n })),
          },
          byCountry: countries.rows.map((x) => ({ id: x.id, name: x.name, count: x.n })),
          missingContact: { total: gaps.rows[0]?.total ?? 0, items: gaps.rows.map((g) => ({ id: g.id, name: g.name, missing: g.missing })) },
        };
      },
    );
  });

  for (const def of CONFIG_DEFS) {
    await fastify.register(crudRoutes(def), { prefix: `/${def.name}` });
  }
  await fastify.register(projectTypesRoutes, { prefix: '/project-types' });
  await fastify.register(taskGroupsRoutes, { prefix: '/task-groups' });
  await fastify.register(projectDivisionsRoutes, { prefix: '/project-divisions' });
  await fastify.register(sitesRoutes, { prefix: '/sites' });
  await fastify.register(resourceGradesRoutes, { prefix: '/resource-grades' });
  await fastify.register(usdRatesRoutes, { prefix: '/usd-rates' });
}
