# Schema audit: facts stored in more than one place

The rule: if a table points at another row (task, project, task type, stage …), it keeps the pointer and its own facts, and reads everything
else from the row it points at. Checked on the schema after migration 046 (45 tables and the view `task_holders`).

## Already clean
`plan_items`, `task_timers`, `task_messages`, `task_message_recipients`, `task_members`, `task_skills`, `user_skills`, `user_teams`,
`project_members`, `project_effort_estimates`, `project_plan_weeks`, `project_progress_update_groups`, `role_permissions`, `role_access_rules`,
`task_category_groups`, `division_quote_rates`, `resource_grade_costs`, `currency_usd_rates`, `site_shifts`, `refresh_tokens`, `audit_logs`, `menus` and the
master tables (`customers`, `teams`, `sites`, `parameter_*`, `task_groups`, `task_types`, `task_categories`, `project_divisions`).
They store a pointer plus a fact of their own.

## Done
- Migration 048: `task_time_logs` is gone; a Timesheet row says `from_board` and keeps the board note as its comment.
- Migration 047: `timesheets` no longer stores `project_id`, `task_type_id`, `task_category_id`; every entry has a `task_id` (entries that had no task got a "General work" task of their project / category, owned by the person).

## Repeats what a pointed-to row already says

| # | Where | Repeats | Read it from | Needs first |
|---|---|---|---|---|
| 2 | `tasks.task_group_id` | the group of the task's type | `task_types.task_group_id` | a type on every task (2 real tasks have none) |
| 3 | `daily_plan_items` (user, day, task) | the day plan in `plan_items` (member, day) | one table: `plan_items` with a done flag; the slot is the day's first 9 items | not a pure copy: a past day's slot keeps the carry-over record and "done for today" after the plan row has moved to another day, so merging changes behaviour (see notes) |
| 5 | `projects.stage` (name) | the name of `projects.stage_id` | `parameter_values` through `stage_id` | none |
| 6 | `projects.project_division_id` | the division of the project type | `project_types.project_division_id` | none |
| 7 | `project_type_task_templates.task_group_id` | the group of its task type | `task_types.task_group_id` | none (type is required there) |
| 8 | `resource_grades` | a one-to-one wrapper of one `parameter_values` row (id + grade_id + audit columns) | point `users` and `resource_grade_costs` at the grade directly | none |
| 9 | `tasks.completed_on` next to `tasks.actual_end` | the day of the completion time | `actual_end` | the form lets a person type a different completed date, so this is a decision |

## Left as they are on purpose
- `timesheets.is_billable` (a person may change it for one entry), `project_members.cost_per_hour` (a per-project rate), `tasks.completed_by`.
- `task_timers.user_id`: after a hand-over the member row changes person, so these record who it was at the time.
- `project_progress_updates.stage`: the stage name at that moment (history).
