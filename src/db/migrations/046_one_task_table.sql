-- 046: one task table.
--   * Task-board tasks (flow_tasks) and PMS tasks (tasks) were two tables for the same thing. They are one table now (tasks).
--     A task has no parent or sub task any more. The "mirror" of a PMS task on the board is merged into that task itself.
--   * The people of a task and their order live in task_members (was flow_steps). tasks.assigned_to is gone: the person
--     holding a task is whoever holds its current step.
--   * Tables that belong to a task point at it (or at one of its members) and do not repeat anything the task already says.
--   * The task history (flow_task_history) is merged into audit_logs.
-- Back the database up first.

-- 1. tasks gets what the board tasks had ------------------------------------------------------------------------------
ALTER TABLE tasks ADD COLUMN notes text NOT NULL DEFAULT '', ADD COLUMN media text NOT NULL DEFAULT '', ADD COLUMN version int NOT NULL DEFAULT 1,
                  ADD COLUMN legacy_id bigint, ADD COLUMN _flow_id bigint;
CREATE UNIQUE INDEX uq_tasks__legacy_id ON tasks (legacy_id) WHERE legacy_id IS NOT NULL;

-- a board entry that mirrors a PMS task: the PMS task keeps its own details, and takes the board's notes, media and version
UPDATE tasks t SET notes = f.notes, media = f.media, version = f.version, actual_end = COALESCE(t.actual_end, f.completed_at)
  FROM flow_tasks f WHERE f.source_task_id = t.id;

-- every other board task becomes a task of its project (the project category)
INSERT INTO tasks (name, description, notes, media, project_id, task_category_id, task_group_id, task_type_id, owner_id, status, planned_end, display_order,
                   version, actual_end, completed_on, is_active, created_by, created_at, updated_by, updated_at, legacy_id, _flow_id)
SELECT left(f.title, 300), f.description, f.notes, f.media, f.project_id,
       (SELECT c.id FROM task_categories c WHERE c.is_project ORDER BY c.is_active DESC, c.display_order, c.id LIMIT 1),
       f.task_group_id, f.task_type_id, f.owner_id, f.status,
       CASE WHEN f.due_date IS NOT NULL THEN (f.due_date + time '18:00') AT TIME ZONE 'Asia/Dubai' END,
       f.priority_rank, f.version, f.completed_at,
       CASE WHEN f.completed_at IS NOT NULL THEN (f.completed_at AT TIME ZONE 'Asia/Dubai')::date END,
       true, f.created_by, f.created_at, f.updated_by, f.updated_at, f.legacy_id, f.id
  FROM flow_tasks f WHERE f.source_task_id IS NULL;

CREATE TEMP TABLE _task_map AS
  SELECT f.id AS flow_id, f.source_task_id AS task_id FROM flow_tasks f WHERE f.source_task_id IS NOT NULL
  UNION ALL
  SELECT t._flow_id, t.id FROM tasks t WHERE t._flow_id IS NOT NULL;

-- 2. the people of a task -----------------------------------------------------------------------------------------------
ALTER TABLE flow_steps RENAME TO task_members;
ALTER TABLE task_members ADD COLUMN task_id bigint;
UPDATE task_members m SET task_id = x.task_id FROM _task_map x WHERE x.flow_id = m.flow_task_id;
ALTER TABLE task_members ALTER COLUMN task_id SET NOT NULL, DROP COLUMN flow_task_id, DROP COLUMN minutes;
ALTER TABLE task_members ADD CONSTRAINT fk_task_members__task_id FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE;
CREATE INDEX ix_task_members__task_id ON task_members (task_id, position);

-- a PMS task that had nobody on the board: its assignee is its one member
INSERT INTO task_members (task_id, user_id, position, status, accepted_at, started_at, closed_at)
SELECT t.id, t.assigned_to, 1,
       CASE t.status WHEN 'completed' THEN 'done' WHEN 'in_progress' THEN 'active' ELSE 'todo' END,
       COALESCE(t.actual_start, t.created_at),
       CASE WHEN t.status IN ('in_progress', 'completed') THEN COALESCE(t.actual_start, t.created_at) END,
       CASE WHEN t.status = 'completed' THEN COALESCE(t.actual_end, now()) END
  FROM tasks t
 WHERE t.assigned_to IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_members m WHERE m.task_id = t.id);
ALTER TABLE tasks DROP COLUMN assigned_to;

-- 3. what belongs to a task ---------------------------------------------------------------------------------------------
-- the plan: one row per planned step; the person and the task come from the member
ALTER TABLE flow_plan_items RENAME TO plan_items;
ALTER TABLE plan_items RENAME COLUMN flow_step_id TO member_id;
ALTER TABLE plan_items DROP COLUMN user_id, DROP COLUMN flow_task_id;
ALTER TABLE plan_items RENAME CONSTRAINT fk_flow_plan_items__flow_step_id TO fk_plan_items__member_id;

-- the timer: a person's timer on a step on a day
ALTER TABLE flow_timers RENAME TO task_timers;
ALTER TABLE task_timers RENAME COLUMN flow_step_id TO member_id;
ALTER TABLE task_timers DROP COLUMN flow_task_id;

-- the time a person logged on a task
ALTER TABLE flow_time_logs RENAME TO task_time_logs;
ALTER TABLE task_time_logs ADD COLUMN task_id bigint;
UPDATE task_time_logs l SET task_id = x.task_id FROM _task_map x WHERE x.flow_id = l.flow_task_id;
ALTER TABLE task_time_logs ALTER COLUMN task_id SET NOT NULL, DROP COLUMN flow_task_id, DROP COLUMN flow_step_id;
ALTER TABLE task_time_logs ADD CONSTRAINT fk_task_time_logs__task_id FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE;
CREATE INDEX ix_task_time_logs__task_id ON task_time_logs (task_id);

-- the messages
ALTER TABLE flow_messages RENAME TO task_messages;
ALTER TABLE task_messages ADD COLUMN task_id bigint;
UPDATE task_messages m SET task_id = x.task_id FROM _task_map x WHERE x.flow_id = m.flow_task_id;
ALTER TABLE task_messages DROP COLUMN flow_task_id;
ALTER TABLE task_messages ADD CONSTRAINT fk_task_messages__task_id FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE;
CREATE INDEX ix_task_messages__task_id ON task_messages (task_id);
ALTER TABLE flow_message_recipients RENAME TO task_message_recipients;

-- the history of a task is part of the audit log
INSERT INTO audit_logs (entity, entity_id, action, message, user_id, logged_at)
SELECT 'tasks', x.task_id,
       CASE h.action WHEN 'created' THEN 'create' WHEN 'accept' THEN 'status_change' WHEN 'start' THEN 'status_change' WHEN 'close' THEN 'status_change' ELSE 'update' END,
       left(h.action || CASE WHEN h.detail <> '' THEN ': ' || h.detail ELSE '' END, 2000), h.user_id, h.created_at
  FROM flow_task_history h JOIN _task_map x ON x.flow_id = h.flow_task_id
 WHERE h.user_id IS NOT NULL;
DROP TABLE flow_task_history;

-- 4. the 1-3-5: a slot is a task on a day ---------------------------------------------------------------------------------
-- a task that was planned on a day twice (as a PMS task and as a board task) keeps one slot: the board one, which the Plan knows
DELETE FROM daily_plan_items j USING daily_plan_items i JOIN _task_map x ON x.flow_id = i.flow_task_id
 WHERE i.task_id IS NULL AND j.user_id = i.user_id AND j.plan_date = i.plan_date AND j.task_id = x.task_id AND j.flow_task_id IS NULL;
UPDATE daily_plan_items i SET task_id = x.task_id FROM _task_map x WHERE i.task_id IS NULL AND x.flow_id = i.flow_task_id;
-- free-text slots become personal tasks of the person
INSERT INTO tasks (name, task_category_id, owner_id, status, planned_end, created_by, updated_by, _flow_id)
SELECT left(i.title, 300), (SELECT c.id FROM task_categories c WHERE c.name = 'Personal' ORDER BY c.id LIMIT 1), i.user_id,
       CASE WHEN i.is_done THEN 'completed' ELSE 'to_do' END, (i.plan_date + time '18:00') AT TIME ZONE 'Asia/Dubai', i.user_id, i.user_id, -i.id
  FROM daily_plan_items i WHERE i.task_id IS NULL AND i.flow_task_id IS NULL;
UPDATE daily_plan_items i SET task_id = t.id FROM tasks t WHERE i.task_id IS NULL AND t._flow_id = -i.id;
INSERT INTO task_members (task_id, user_id, position, status, accepted_at, started_at, closed_at)
SELECT t.id, t.owner_id, 1, CASE WHEN t.status = 'completed' THEN 'done' ELSE 'todo' END, t.created_at, NULL, CASE WHEN t.status = 'completed' THEN now() END
  FROM tasks t WHERE t._flow_id < 0 AND t.owner_id IS NOT NULL;
UPDATE tasks SET _flow_id = NULL WHERE _flow_id < 0;
ALTER TABLE daily_plan_items ALTER COLUMN task_id SET NOT NULL, DROP COLUMN flow_task_id, DROP COLUMN title, DROP COLUMN minutes;
-- a slot is kept in line with the Plan: every slot whose person is a member of the task gets its Plan entry for that day (so nothing is dropped as stale)
INSERT INTO plan_items (member_id, scope, start_date, position)
SELECT DISTINCT ON (m.id, i.plan_date) m.id, 'day', i.plan_date, i.position
  FROM daily_plan_items i JOIN task_members m ON m.task_id = i.task_id AND m.user_id = i.user_id
 WHERE NOT EXISTS (SELECT 1 FROM plan_items p WHERE p.member_id = m.id AND p.start_date = i.plan_date)
 ORDER BY m.id, i.plan_date, m.position;
CREATE UNIQUE INDEX uq_daily_plan_items__user_date_task ON daily_plan_items (user_id, plan_date, task_id);

-- 5. the Timesheet: time on a flow task is time on that task ----------------------------------------------------------------
UPDATE timesheets ts SET task_id = x.task_id FROM _task_map x WHERE ts.flow_task_id IS NOT NULL AND x.flow_id = ts.flow_task_id;
ALTER TABLE timesheets DROP COLUMN flow_task_id, DROP COLUMN source;

-- 6. the two task tables become one -------------------------------------------------------------------------------------------
DROP TABLE flow_tasks CASCADE;
ALTER TABLE tasks DROP COLUMN _flow_id;

-- who holds a task right now: the person on its current step (or, once every step is done, the last one)
CREATE VIEW task_holders AS
SELECT DISTINCT ON (m.task_id) m.task_id, m.user_id, m.status
  FROM task_members m
 ORDER BY m.task_id, (m.status = 'done'), CASE WHEN m.status = 'done' THEN -m.position ELSE m.position END;

-- a task's customer is its project's customer: it is not stored on the task
ALTER TABLE tasks DROP COLUMN customer_id;
