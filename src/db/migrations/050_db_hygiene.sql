-- Housekeeping found in the database audit. Nothing here changes behaviour.

-- refresh tokens that can no longer be used (revoked or expired) were never removed
DELETE FROM refresh_tokens WHERE revoked_at IS NOT NULL OR expires_at < now();

-- identical to uq_resource_grades__grade_id
DROP INDEX IF EXISTS ix_resource_grades__grade_id;

-- foreign keys that were joined / filtered on without an index
CREATE INDEX IF NOT EXISTS ix_project_plan_weeks__task_group_id ON project_plan_weeks (task_group_id);
CREATE INDEX IF NOT EXISTS ix_task_messages__author_id ON task_messages (author_id);
CREATE INDEX IF NOT EXISTS ix_task_timers__member_id ON task_timers (member_id);
CREATE INDEX IF NOT EXISTS ix_tasks__completed_by ON tasks (completed_by);
