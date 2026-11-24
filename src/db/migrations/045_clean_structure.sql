-- 045: a second clean-up of the structure.
--   * subtasks: nothing in the application creates them any more (sub tasks are Task-board tasks under a main task)
--   * tasks: columns nothing reads (kind, level, parent / predecessor links, actual minutes, reopen count, last comment)
--   * the 1-3-5: columns that were only ever written (copied_from, done_at) and the subtask link
--   * vendors: the vendors table is gone, so the vendor link on users and the "vendor" data scope go too
--   * users: reviewed_by (the old review process is gone)
--   * clearer column names
-- Back the database up first. Only data nobody can see in the application is lost.

-- subtasks -----------------------------------------------------------------------------------------------------------
ALTER TABLE daily_plan_items DROP COLUMN IF EXISTS subtask_id, DROP COLUMN IF EXISTS copied_from, DROP COLUMN IF EXISTS done_at;
DROP TABLE IF EXISTS task_subtasks CASCADE;

-- tasks --------------------------------------------------------------------------------------------------------------
ALTER TABLE tasks
  DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS level, DROP COLUMN IF EXISTS parent_task_id, DROP COLUMN IF EXISTS predecessor_task_id,
  DROP COLUMN IF EXISTS actual_minutes, DROP COLUMN IF EXISTS reopen_count, DROP COLUMN IF EXISTS last_comment;

-- vendors ------------------------------------------------------------------------------------------------------------
ALTER TABLE users DROP COLUMN IF EXISTS vendor_id, DROP COLUMN IF EXISTS reviewed_by;
DELETE FROM role_permissions rp USING roles r WHERE rp.role_id = r.id AND r.code = 'VENDOR' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role_id = r.id);
DELETE FROM role_access_rules ra USING roles r WHERE ra.role_id = r.id AND r.code = 'VENDOR' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role_id = r.id);
DELETE FROM roles r WHERE r.code = 'VENDOR' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role_id = r.id);
UPDATE roles SET data_scope = 'own' WHERE data_scope = 'vendor';
ALTER TABLE roles DROP CONSTRAINT IF EXISTS ck_roles__data_scope;
ALTER TABLE roles ADD CONSTRAINT ck_roles__data_scope CHECK (data_scope IN ('all', 'team', 'own', 'customer'));
DELETE FROM parameter_values p WHERE p.type = 'USER_TYPE' AND p.name = 'Vendor user' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.user_type_id = p.id);
UPDATE menus SET name = 'Customers' WHERE name = 'Customers & Vendors';

-- clearer column names -----------------------------------------------------------------------------------------------
ALTER TABLE users RENAME COLUMN emp_code TO employee_code;
ALTER TABLE users RENAME COLUMN reports_to TO manager_id;
ALTER TABLE flow_message_recipients RENAME COLUMN post_id TO message_id;
ALTER TABLE project_progress_update_groups RENAME COLUMN project_review_id TO progress_update_id;
ALTER TABLE flow_tasks RENAME COLUMN main_task_id TO source_task_id;  -- the PMS main task this board entry mirrors
