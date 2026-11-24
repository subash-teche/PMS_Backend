-- 042: clean up the schema.
--   1. drop tables nothing uses (leftovers of the old PMS: HR reviews, attendance, vendors, installations, uploads ...)
--   2. drop columns nothing reads or writes
--   3. give the remaining tables plain, easy to understand names
-- Back the database up first: the dropped tables and columns lose their data. Tables and columns the app uses are
-- only renamed, never emptied. The Task Manager database is not touched.

-- 1. unused tables ------------------------------------------------------------------------------------------------------
DROP TABLE IF EXISTS
  assets, installation_request_documents, installation_requests,
  attendance, rosters, biometric_logs, holidays, weekly_off_assignments, weekly_off_rules, weekly_offs,
  employee_review_kpis, employee_review_kras, employee_reviews,
  review_template_kpis, review_template_kras, review_templates, review_periods, review_assignments,
  points, ratings, mood_logs,
  weekly_plan_entries, weekly_plans, daily_plans,
  uploads, upload_errors, upload_type_columns, upload_types,
  task_checklist_items, task_teams, task_watchers,
  vendors, customer_locations, cities, states,
  currency_rates, project_commercials, messages, error_logs
CASCADE;

-- the old "daily plan" tables are gone; the name is reused below for the 1-3-5 plan
ALTER TABLE timesheets DROP COLUMN IF EXISTS daily_plan_item_id;
DROP TABLE IF EXISTS daily_plan_items CASCADE;

-- 2. unused columns -----------------------------------------------------------------------------------------------------
ALTER TABLE projects   DROP COLUMN IF EXISTS status_comments, DROP COLUMN IF EXISTS stage_date, DROP COLUMN IF EXISTS is_synced,
                       DROP COLUMN IF EXISTS transfer_to_sales_pro, DROP COLUMN IF EXISTS allocation_locked_at;
ALTER TABLE task_types DROP COLUMN IF EXISTS procedure_text, DROP COLUMN IF EXISTS completion_certificate;
ALTER TABLE tasks      DROP COLUMN IF EXISTS scope_of_work, DROP COLUMN IF EXISTS remind_on_start, DROP COLUMN IF EXISTS remind_on_end,
                       DROP COLUMN IF EXISTS completion_comment, DROP COLUMN IF EXISTS email_on_change,
                       DROP COLUMN IF EXISTS completion_certificate_required, DROP COLUMN IF EXISTS client_contact;

-- legacy_id remembered the id in the old system; only the flow tables still use it (the Task Manager import)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'legacy_id' AND table_name NOT LIKE 'flow\_%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP COLUMN legacy_id', r.table_name);
  END LOOP;
END $$;

-- 3. clearer table names ------------------------------------------------------------------------------------------------
ALTER TABLE task_135_items                  RENAME TO daily_plan_items;          -- the 1-3-5 plan of a day
ALTER TABLE lookups                         RENAME TO parameter_values;          -- values of the Parameters screen
ALTER TABLE flow_posts                      RENAME TO flow_messages;             -- the chat messages of a task
ALTER TABLE flow_post_mentions              RENAME TO flow_message_recipients;
ALTER TABLE flow_time_entries               RENAME TO flow_timers;               -- start / pause / end timers
ALTER TABLE flow_activity                   RENAME TO flow_task_history;
ALTER TABLE project_task_group_estimates    RENAME TO project_effort_estimates;
ALTER TABLE project_type_default_estimates  RENAME TO project_type_effort_defaults;
ALTER TABLE project_week_plans              RENAME TO project_plan_weeks;
ALTER TABLE project_reviews                 RENAME TO project_progress_updates;
ALTER TABLE project_review_task_groups      RENAME TO project_progress_update_groups;
ALTER TABLE project_division_quote_rates    RENAME TO division_quote_rates;
ALTER TABLE task_access                     RENAME TO task_viewer_access;
