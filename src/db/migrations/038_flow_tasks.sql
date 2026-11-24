-- Task Management (flow tasks): a task that passes through a flow of people (accept -> start -> close -> next person).
-- A flow task is a sub task of a main PMS task (tasks.id) and always belongs to a project, task group and task type.
-- Additive only: no existing table or column is changed except the nullable links added at the end
-- (timesheets, task_135_items). Flow tasks live in their own tables so they never show up in the PMS task list,
-- project plan counts or delete guards.

-- ---------------------------------------------------------------------------------------------------------------
-- flow_tasks
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE flow_tasks (
    id bigint GENERATED ALWAYS AS IDENTITY,
    parent_task_id bigint NOT NULL,
    project_id bigint NOT NULL,
    task_group_id bigint NOT NULL,
    task_type_id bigint NOT NULL,
    month char(7) NOT NULL,
    title varchar(300) NOT NULL,
    description text NOT NULL DEFAULT '',
    notes text NOT NULL DEFAULT '',
    owner_id bigint NOT NULL,
    owner_ids bigint[] NOT NULL DEFAULT '{}',
    due_date date,
    media varchar(500) NOT NULL DEFAULT '',
    priority_rank int NOT NULL DEFAULT 0,
    version int NOT NULL DEFAULT 1,
    status varchar(20) NOT NULL DEFAULT 'to_do',
    completed_at timestamptz,
    legacy_id bigint,
    created_by bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_by bigint,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_flow_tasks PRIMARY KEY (id),
    CONSTRAINT ck_flow_tasks__status CHECK (status IN ('to_do', 'in_progress', 'completed')),
    CONSTRAINT ck_flow_tasks__month CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT fk_flow_tasks__parent_task_id FOREIGN KEY (parent_task_id) REFERENCES tasks (id) ON DELETE RESTRICT,
    CONSTRAINT fk_flow_tasks__project_id FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
    CONSTRAINT fk_flow_tasks__task_group_id FOREIGN KEY (task_group_id) REFERENCES task_groups (id) ON DELETE RESTRICT,
    CONSTRAINT fk_flow_tasks__task_type_id FOREIGN KEY (task_type_id) REFERENCES task_types (id) ON DELETE RESTRICT,
    CONSTRAINT fk_flow_tasks__owner_id FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_flow_tasks__created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_flow_tasks__updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX ix_flow_tasks__parent_task_id ON flow_tasks (parent_task_id);
CREATE INDEX ix_flow_tasks__project_id ON flow_tasks (project_id);
CREATE INDEX ix_flow_tasks__month ON flow_tasks (month);
CREATE INDEX ix_flow_tasks__status ON flow_tasks (status);
CREATE UNIQUE INDEX uq_flow_tasks__legacy_id ON flow_tasks (legacy_id) WHERE legacy_id IS NOT NULL;
CREATE TRIGGER trg_flow_tasks__updated_at BEFORE UPDATE ON flow_tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMENT ON TABLE flow_tasks IS 'Task Management tasks: sub tasks of a main PMS task that move through a flow of people';
COMMENT ON COLUMN flow_tasks.parent_task_id IS 'the main PMS task (tasks.id) of the same project and task group';
COMMENT ON COLUMN flow_tasks.owner_ids IS 'every owner (they can all edit the task); owner_id is the first';
COMMENT ON COLUMN flow_tasks.version IS 'optimistic lock: a change made on an older version is rejected';
COMMENT ON COLUMN flow_tasks.status IS 'derived from flow_steps: to_do (nothing started), in_progress, completed (every step done)';
COMMENT ON COLUMN flow_tasks.legacy_id IS 'tasks.id in the old Task Management database';

-- ---------------------------------------------------------------------------------------------------------------
-- flow_steps: the flow. One row per person, in order.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE flow_steps (
    id bigint GENERATED ALWAYS AS IDENTITY,
    flow_task_id bigint NOT NULL,
    user_id bigint NOT NULL,
    position int NOT NULL,
    status varchar(10) NOT NULL DEFAULT 'waiting',
    accepted_at timestamptz,
    started_at timestamptz,
    closed_at timestamptz,
    minutes int,
    legacy_id bigint,
    CONSTRAINT pk_flow_steps PRIMARY KEY (id),
    CONSTRAINT ck_flow_steps__status CHECK (status IN ('waiting', 'offered', 'todo', 'active', 'done')),
    CONSTRAINT fk_flow_steps__flow_task_id FOREIGN KEY (flow_task_id) REFERENCES flow_tasks (id) ON DELETE CASCADE,
    CONSTRAINT fk_flow_steps__user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT
);
CREATE INDEX ix_flow_steps__flow_task_id ON flow_steps (flow_task_id, position);
CREATE INDEX ix_flow_steps__user_id ON flow_steps (user_id, status);
COMMENT ON COLUMN flow_steps.status IS 'waiting (not its turn) | offered (its turn, not accepted) | todo (accepted) | active (started) | done';
COMMENT ON COLUMN flow_steps.minutes IS 'time spent on the step; set as time is logged';

-- ---------------------------------------------------------------------------------------------------------------
-- flow_time_logs: time logged on a step, kept with the person who logged it. Each log has a PMS timesheet row.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE flow_time_logs (
    id bigint GENERATED ALWAYS AS IDENTITY,
    flow_task_id bigint NOT NULL,
    flow_step_id bigint,
    user_id bigint NOT NULL,
    minutes int NOT NULL,
    note varchar(500) NOT NULL DEFAULT '',
    work_date date NOT NULL,
    timesheet_id bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    legacy_id bigint,
    CONSTRAINT pk_flow_time_logs PRIMARY KEY (id),
    CONSTRAINT ck_flow_time_logs__minutes CHECK (minutes > 0),
    CONSTRAINT fk_flow_time_logs__flow_task_id FOREIGN KEY (flow_task_id) REFERENCES flow_tasks (id) ON DELETE CASCADE,
    CONSTRAINT fk_flow_time_logs__flow_step_id FOREIGN KEY (flow_step_id) REFERENCES flow_steps (id) ON DELETE SET NULL,
    CONSTRAINT fk_flow_time_logs__user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_flow_time_logs__timesheet_id FOREIGN KEY (timesheet_id) REFERENCES timesheets (id) ON DELETE SET NULL
);
CREATE INDEX ix_flow_time_logs__flow_task_id ON flow_time_logs (flow_task_id);
CREATE INDEX ix_flow_time_logs__user_id ON flow_time_logs (user_id, work_date);

-- ---------------------------------------------------------------------------------------------------------------
-- flow_time_entries: the timer of the person's working day (ready -> running -> paused -> ended / abandoned).
-- The time itself is kept in flow_time_logs.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE flow_time_entries (
    id bigint GENERATED ALWAYS AS IDENTITY,
    user_id bigint NOT NULL,
    flow_task_id bigint NOT NULL,
    flow_step_id bigint NOT NULL,
    day date NOT NULL,
    status varchar(10) NOT NULL DEFAULT 'ready',
    run_started_at timestamptz,
    minutes int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    legacy_id bigint,
    CONSTRAINT pk_flow_time_entries PRIMARY KEY (id),
    CONSTRAINT ck_flow_time_entries__status CHECK (status IN ('ready', 'running', 'paused', 'ended', 'abandoned')),
    CONSTRAINT fk_flow_time_entries__user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_flow_time_entries__flow_task_id FOREIGN KEY (flow_task_id) REFERENCES flow_tasks (id) ON DELETE CASCADE,
    CONSTRAINT fk_flow_time_entries__flow_step_id FOREIGN KEY (flow_step_id) REFERENCES flow_steps (id) ON DELETE CASCADE
);
CREATE INDEX ix_flow_time_entries__user_day ON flow_time_entries (user_id, day);

-- ---------------------------------------------------------------------------------------------------------------
-- flow_plan_items: the weekly / daily plan. scope 'day' + start_date = that day; 'week' + start_date = the week's first day.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE flow_plan_items (
    id bigint GENERATED ALWAYS AS IDENTITY,
    user_id bigint NOT NULL,
    flow_task_id bigint NOT NULL,
    flow_step_id bigint NOT NULL,
    scope varchar(5) NOT NULL,
    start_date date NOT NULL,
    position int NOT NULL DEFAULT 0,
    legacy_id bigint,
    CONSTRAINT pk_flow_plan_items PRIMARY KEY (id),
    CONSTRAINT ck_flow_plan_items__scope CHECK (scope IN ('day', 'week')),
    CONSTRAINT uq_flow_plan_items__step_day UNIQUE (flow_step_id, start_date),
    CONSTRAINT fk_flow_plan_items__user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_flow_plan_items__flow_task_id FOREIGN KEY (flow_task_id) REFERENCES flow_tasks (id) ON DELETE CASCADE,
    CONSTRAINT fk_flow_plan_items__flow_step_id FOREIGN KEY (flow_step_id) REFERENCES flow_steps (id) ON DELETE CASCADE
);
CREATE INDEX ix_flow_plan_items__user_id ON flow_plan_items (user_id, start_date);

-- ---------------------------------------------------------------------------------------------------------------
-- flow_activity: who did what to a flow task and when
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE flow_activity (
    id bigint GENERATED ALWAYS AS IDENTITY,
    flow_task_id bigint NOT NULL,
    user_id bigint,
    action varchar(60) NOT NULL,
    detail text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    legacy_id bigint,
    CONSTRAINT pk_flow_activity PRIMARY KEY (id),
    CONSTRAINT fk_flow_activity__flow_task_id FOREIGN KEY (flow_task_id) REFERENCES flow_tasks (id) ON DELETE CASCADE,
    CONSTRAINT fk_flow_activity__user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX ix_flow_activity__flow_task_id ON flow_activity (flow_task_id);

-- ---------------------------------------------------------------------------------------------------------------
-- flow_posts / flow_post_mentions: the Messages feed. A post may be tagged with a flow task and with people.
-- kind: 'note' (written by hand), 'handover' or 'close' (the optional comment on those actions).
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE flow_posts (
    id bigint GENERATED ALWAYS AS IDENTITY,
    flow_task_id bigint,
    author_id bigint NOT NULL,
    kind varchar(10) NOT NULL DEFAULT 'note',
    body text NOT NULL,
    is_private boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    legacy_id bigint,
    CONSTRAINT pk_flow_posts PRIMARY KEY (id),
    CONSTRAINT ck_flow_posts__kind CHECK (kind IN ('note', 'handover', 'close')),
    CONSTRAINT fk_flow_posts__flow_task_id FOREIGN KEY (flow_task_id) REFERENCES flow_tasks (id) ON DELETE CASCADE,
    CONSTRAINT fk_flow_posts__author_id FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE RESTRICT
);
CREATE INDEX ix_flow_posts__flow_task_id ON flow_posts (flow_task_id);
CREATE INDEX ix_flow_posts__created_at ON flow_posts (created_at DESC);
COMMENT ON COLUMN flow_posts.is_private IS 'one-to-one message: only the author and the people it tags can see it';

CREATE TABLE flow_post_mentions (
    post_id bigint NOT NULL,
    user_id bigint NOT NULL,
    read_at timestamptz,
    CONSTRAINT pk_flow_post_mentions PRIMARY KEY (post_id, user_id),
    CONSTRAINT fk_flow_post_mentions__post_id FOREIGN KEY (post_id) REFERENCES flow_posts (id) ON DELETE CASCADE,
    CONSTRAINT fk_flow_post_mentions__user_id FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX ix_flow_post_mentions__user_id ON flow_post_mentions (user_id, read_at);

-- ---------------------------------------------------------------------------------------------------------------
-- Links from the existing PMS screens (nullable, additive)
-- ---------------------------------------------------------------------------------------------------------------
-- Timesheet: time logged in Task Management shows in the PMS Timesheet read-only.
-- task_id of such a row is the main task of the flow task, so the time rolls up to it.
ALTER TABLE timesheets
    ADD COLUMN source varchar(10) NOT NULL DEFAULT 'manual',
    ADD COLUMN flow_task_id bigint,
    ADD CONSTRAINT ck_timesheets__source CHECK (source IN ('manual', 'flow')),
    ADD CONSTRAINT fk_timesheets__flow_task_id FOREIGN KEY (flow_task_id) REFERENCES flow_tasks (id) ON DELETE SET NULL;
CREATE INDEX ix_timesheets__flow_task_id ON timesheets (flow_task_id) WHERE flow_task_id IS NOT NULL;
COMMENT ON COLUMN timesheets.source IS 'manual = entered in the PMS Timesheet; flow = logged in Task Management (read-only here)';

-- 1-3-5: a flow task planned in Task Management can be put in a slot (the item's done tick stays its own)
ALTER TABLE task_135_items
    ADD COLUMN flow_task_id bigint,
    ADD CONSTRAINT fk_task_135_items__flow_task_id FOREIGN KEY (flow_task_id) REFERENCES flow_tasks (id) ON DELETE CASCADE;
ALTER TABLE task_135_items DROP CONSTRAINT ck_task_135_items__task_or_subtask;
ALTER TABLE task_135_items
    ADD CONSTRAINT ck_task_135_items__one_link CHECK (num_nonnulls(task_id, subtask_id, flow_task_id) <= 1);
CREATE INDEX ix_task_135_items__flow_task_id ON task_135_items (flow_task_id) WHERE flow_task_id IS NOT NULL;
CREATE UNIQUE INDEX uq_task_135_items__user_date_flow_task ON task_135_items (user_id, plan_date, flow_task_id) WHERE flow_task_id IS NOT NULL;
COMMENT ON COLUMN task_135_items.flow_task_id IS 'a Task Management task planned in a slot (picked from the Task Management plan)';
