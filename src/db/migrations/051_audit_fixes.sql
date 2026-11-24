-- Fixes from the database audit.

-- 1. import leftovers: legacy_id was never filled and is not used
ALTER TABLE tasks DROP COLUMN IF EXISTS legacy_id;
ALTER TABLE timesheets DROP COLUMN IF EXISTS legacy_id;
ALTER TABLE task_members DROP COLUMN IF EXISTS legacy_id;
ALTER TABLE task_timers DROP COLUMN IF EXISTS legacy_id;
ALTER TABLE task_messages DROP COLUMN IF EXISTS legacy_id;
ALTER TABLE plan_items DROP COLUMN IF EXISTS legacy_id;

-- 2. project status: only the statuses the project stages (Parameters → PROJECT_STAGE) can set
ALTER TABLE projects DROP CONSTRAINT IF EXISTS ck_projects__status;
ALTER TABLE projects ADD CONSTRAINT ck_projects__status
  CHECK (status IN ('not_started', 'in_progress', 'on_hold', 'completed', 'cancelled'));

-- 3. data: "in progress" tasks without a start get the day time was first logged on (09:00 in the owner's time zone)
UPDATE tasks t
   SET actual_start = (f.first_day + time '09:00') AT TIME ZONE COALESCE(u.time_zone, 'UTC')
  FROM (SELECT task_id, min(work_date) AS first_day FROM timesheets GROUP BY task_id) f
  LEFT JOIN tasks t2 ON t2.id = f.task_id
  LEFT JOIN users u ON u.id = t2.owner_id
 WHERE f.task_id = t.id AND t.status = 'in_progress' AND t.actual_start IS NULL;

-- 4. data: an "in progress" task nobody is working on (no assignee, no start, no time) goes back to "to do"
UPDATE tasks t SET status = 'to_do'
 WHERE t.status = 'in_progress' AND t.actual_start IS NULL
   AND NOT EXISTS (SELECT 1 FROM task_members m WHERE m.task_id = t.id)
   AND NOT EXISTS (SELECT 1 FROM timesheets s WHERE s.task_id = t.id);
