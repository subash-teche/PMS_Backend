-- PMS main tasks carried out in Task Management.
-- A main task assigned to a Task Management user also appears in Task Management, where the assignee starts, plans and
-- completes it. It is represented by a flow task of its own with one step (the assignee): flow_tasks.main_task_id is the
-- PMS task; parent_task_id stays empty (it is not a sub task of anything). Status changes made in Task Management are copied
-- to tasks.status; title, due date and assignee follow the PMS task (see syncMainTasks in modules/flow/flow.service.js).
-- Additive: existing flow tasks are untouched (they all have a parent_task_id and a task type).

ALTER TABLE flow_tasks
    ALTER COLUMN parent_task_id DROP NOT NULL,
    ALTER COLUMN task_type_id DROP NOT NULL, -- a PMS task may have no task type
    ADD COLUMN main_task_id bigint,
    ADD CONSTRAINT fk_flow_tasks__main_task_id FOREIGN KEY (main_task_id) REFERENCES tasks (id) ON DELETE CASCADE,
    ADD CONSTRAINT ck_flow_tasks__parent_or_main CHECK (num_nonnulls(parent_task_id, main_task_id) = 1),
    ADD CONSTRAINT ck_flow_tasks__type_for_sub_task CHECK (main_task_id IS NOT NULL OR task_type_id IS NOT NULL);

CREATE UNIQUE INDEX uq_flow_tasks__main_task_id ON flow_tasks (main_task_id) WHERE main_task_id IS NOT NULL;
COMMENT ON COLUMN flow_tasks.main_task_id IS 'set when this flow task is a PMS main task carried out in Task Management (one step: its assignee); then parent_task_id is empty';
