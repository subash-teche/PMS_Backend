-- 047: every time entry belongs to a task.
-- A timesheet row used to repeat the task's project, task type and task category (and could exist without a task). It now stores only
-- who, when, how long, what was done and which task; the project, type and category are read from the task.
-- Entries that had no task get one (a "General work" task of the project, or a task of the category), owned by the person who logged it.

ALTER TABLE tasks ADD COLUMN _key text;

INSERT INTO tasks (name, task_category_id, project_id, task_group_id, task_type_id, owner_id, status, created_by, updated_by, _key)
SELECT CASE WHEN o.project_id IS NOT NULL THEN 'General work' ELSE COALESCE(c.name, 'General work') END,
       o.task_category_id, o.project_id, tt.task_group_id, o.task_type_id, o.user_id, 'in_progress', o.user_id, o.user_id,
       concat_ws('|', o.user_id, COALESCE(o.project_id, 0), COALESCE(o.task_type_id, 0), COALESCE(o.task_category_id, 0))
  FROM (SELECT DISTINCT user_id, project_id, task_type_id, task_category_id FROM timesheets WHERE task_id IS NULL) o
  LEFT JOIN task_categories c ON c.id = o.task_category_id
  LEFT JOIN task_types tt ON tt.id = o.task_type_id;

-- the person is the one member of the task they made
INSERT INTO task_members (task_id, user_id, position, status, accepted_at, started_at)
SELECT t.id, t.owner_id, 1, 'active', now(), now() FROM tasks t WHERE t._key IS NOT NULL;

UPDATE timesheets ts SET task_id = t.id
  FROM tasks t
 WHERE ts.task_id IS NULL AND t._key = concat_ws('|', ts.user_id, COALESCE(ts.project_id, 0), COALESCE(ts.task_type_id, 0), COALESCE(ts.task_category_id, 0));

ALTER TABLE timesheets ALTER COLUMN task_id SET NOT NULL;
ALTER TABLE timesheets DROP COLUMN project_id, DROP COLUMN task_type_id, DROP COLUMN task_category_id;
ALTER TABLE tasks DROP COLUMN _key;
