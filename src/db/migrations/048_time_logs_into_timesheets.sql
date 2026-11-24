-- 048: one table for logged time.
-- task_time_logs repeated the Timesheet row it pointed at (person, task, minutes, day). The Timesheet row now says whether the time was
-- logged on the board (from_board), keeps the board's note as its comment (empty when there was no note) and the Task Manager id it was
-- imported from (legacy_id). task_time_logs is dropped.

ALTER TABLE timesheets ADD COLUMN from_board boolean NOT NULL DEFAULT false, ADD COLUMN legacy_id bigint;

UPDATE timesheets t
   SET from_board = true, legacy_id = l.legacy_id, comment = NULLIF(l.note, '')
  FROM task_time_logs l
 WHERE l.timesheet_id = t.id;

-- board time that never reached the Timesheet becomes a Timesheet row (billable like its project)
INSERT INTO timesheets (user_id, work_date, task_id, minutes, comment, is_billable, from_board, legacy_id, created_by, updated_by, created_at)
SELECT l.user_id, l.work_date, l.task_id, l.minutes, NULLIF(l.note, ''), COALESCE(p.is_billable, false), true, l.legacy_id, l.user_id, l.user_id, l.created_at
  FROM task_time_logs l
  JOIN tasks k ON k.id = l.task_id
  LEFT JOIN projects p ON p.id = k.project_id
 WHERE l.timesheet_id IS NULL;

CREATE UNIQUE INDEX uq_timesheets__legacy_id ON timesheets (legacy_id) WHERE legacy_id IS NOT NULL;

DROP TABLE task_time_logs;
