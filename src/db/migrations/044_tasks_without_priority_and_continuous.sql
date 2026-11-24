-- 044: a task no longer has a Priority or a "Continuous" (no dates) option: every task has a start and an end date.
-- Tasks that were continuous keep their empty dates until someone edits them; they are never shown as overdue.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS ck_tasks__priority;
ALTER TABLE tasks DROP COLUMN IF EXISTS priority;
ALTER TABLE tasks DROP COLUMN IF EXISTS is_continuous;
