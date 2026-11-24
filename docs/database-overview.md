# emQube PMS - database overview

Generated from the schema that migrations 001-048 create (44 tables, and a view task_holders: who holds each task now). "Used in the frontend" is worked out from the backend module that writes the table, the API it is served by (`src/api/endpoints.js`) and the screens that call that API; the Tasks screens (`src/tmx`) use the `/flow` API. A `*` after a column means NOT NULL, `→ table` is a foreign key.

## Tables at a glance

| Table | Columns | What it holds |
|---|---|---|
| [audit_logs](#audit_logs) | 8 | Who changed what, and when (history shown on projects and tasks) |
| [currency_usd_rates](#currency_usd_rates) | 6 | USD rate of each currency (Parameters → USD Rates) |
| [customers](#customers) | 12 | Customers / clients |
| [daily_plan_items](#daily_plan_items) | 10 | A day's 1-3-5: the 9 slots of a person for a day |
| [division_quote_rates](#division_quote_rates) | 8 | Quote rate per hour of a project division, per currency |
| [menus](#menus) | 12 | Screens of the application (sidebar and permission list) |
| [parameter_types](#parameter_types) | 10 | Kinds of Parameters (Skill, Grade, Currency …) |
| [parameter_values](#parameter_values) | 10 | Values of the Parameters screen (skills, currencies, project stages …) |
| [plan_items](#plan_items) | 6 | The Plan: a member of a task planned on a day or in a week |
| [project_divisions](#project_divisions) | 8 | Project divisions (Web, Software …) |
| [project_effort_estimates](#project_effort_estimates) | 8 | Effort % of each task group on a project |
| [project_members](#project_members) | 10 | People on a project, with access level and cost |
| [project_plan_weeks](#project_plan_weeks) | 6 | Weeks a task group is planned in (project Plan tab) |
| [project_progress_update_groups](#project_progress_update_groups) | 4 | % completed of each task group in one progress update |
| [project_progress_updates](#project_progress_updates) | 10 | Project progress updates / stage changes (the Update tab) |
| [project_type_effort_defaults](#project_type_effort_defaults) | 8 | Default effort % per task group of a project type |
| [project_type_task_template_roles](#project_type_task_template_roles) | 2 | Roles (skills) a template task needs |
| [project_type_task_templates](#project_type_task_templates) | 14 | Template tasks of a project type |
| [project_types](#project_types) | 9 | Project types (belong to a division) |
| [projects](#projects) | 26 | Projects |
| [refresh_tokens](#refresh_tokens) | 6 | Login sessions (refresh tokens) |
| [resource_grade_costs](#resource_grade_costs) | 10 | Cost per hour of a resource grade over time |
| [resource_grades](#resource_grades) | 6 | Resource grades (one per grade level) |
| [role_access_rules](#role_access_rules) | 4 | Field / tab access rules of a role |
| [role_permissions](#role_permissions) | 13 | What a role may view / create / edit / delete on each screen |
| [roles](#roles) | 12 | Roles and their data scope |
| [site_shifts](#site_shifts) | 13 | Shifts of a site |
| [sites](#sites) | 7 | Sites / locations |
| [task_categories](#task_categories) | 11 | Task categories (Project, Personal, Activity) |
| [task_category_groups](#task_category_groups) | 2 | Task groups a category may use |
| [task_groups](#task_groups) | 6 | Task groups |
| [task_members](#task_members) | 9 | The people who work on a task, in order, with where each one is (waiting, offered, accepted, in progress, done) |
| [task_message_recipients](#task_message_recipients) | 3 | Who was tagged in a message and whether they read it |
| [task_messages](#task_messages) | 8 | Chat messages on a task or between people |
| [task_skills](#task_skills) | 2 | Skills a task needs |
| [task_timers](#task_timers) | 9 | Start / pause / end timers of a person on a task on a day |
| [task_types](#task_types) | 9 | Task types (belong to a task group) |
| [task_viewer_access](#task_viewer_access) | 4 | Whose tasks a person may view (extra access) |
| [tasks](#tasks) | 28 | PMS tasks (Personal, Activity and Project tasks) |
| [teams](#teams) | 7 | Teams |
| [timesheets](#timesheets) | 13 | Logged time: who, when, how long, what was done, and the task (project, type and category come from the task). from_board = logged in Task Management (locked in the Timesheet) |
| [user_skills](#user_skills) | 2 | Skills of a user |
| [user_teams](#user_teams) | 3 | Which team(s) a user is in, with position |
| [users](#users) | 25 | People who can sign in |

## audit_logs

Who changed what, and when (history shown on projects and tasks)

| Column | Type |
|---|---|
| id | bigint |
| entity * | varchar(50) |
| entity_id * | bigint |
| action * | varchar(20) |
| message | text |
| changes | jsonb |
| user_id | bigint → users |
| logged_at * | timestamptz |

- **Backend:** written by flow; also read by flow, projects, tasks
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/tasks`: TaskFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …
  - Shown as "History" in the project and task detail pages

## currency_usd_rates

USD rate of each currency (Parameters → USD Rates)

| Column | Type |
|---|---|
| currency_id * | bigint → parameter_values |
| usd_rate * | numeric |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by config; also read by scripts
- **Used in the frontend:** 
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage

## customers

Customers / clients

| Column | Type |
|---|---|
| id | bigint |
| code * | varchar(30) |
| name * | varchar(200) |
| country_id | bigint → parameter_values |
| contact_person | varchar(150) |
| contact_number | varchar(30) |
| email | varchar(150) |
| is_active * | boolean |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by flow, scripts; also read by config, flow, masters, projects, tasks, users
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/tasks`: TaskFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## daily_plan_items

A day's 1-3-5: the 9 slots of a person for a day

| Column | Type |
|---|---|
| id | bigint |
| user_id * | bigint → users |
| plan_date * | date |
| position * | smallint |
| task_id * | bigint → tasks |
| is_done * | boolean |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by flow, task135; also read by flow, tasks
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/tasks`: TaskFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## division_quote_rates

Quote rate per hour of a project division, per currency

| Column | Type |
|---|---|
| id | bigint |
| project_division_id * | bigint → project_divisions |
| currency * | character |
| rate_per_hour * | numeric |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by config; also read by masters, projects
- **Used in the frontend:** 
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage

## menus

Screens of the application (sidebar and permission list)

| Column | Type |
|---|---|
| id | bigint |
| name * | varchar(100) |
| parent_id | bigint → menus |
| url | varchar(200) |
| icon | varchar(50) |
| display_order * | integer |
| is_visible * | boolean |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |
| actions * | ARRAY |

- **Backend:** written by —; also read by auth, config, menus, projectplan, projects, roles, task135, taskaccess, tasks, timesheets, users, scripts
- **Used in the frontend:** 
  - `auth/AuthProvider.jsx`: AuthProvider
  - `hooks/useOptions.js`: useOptions.js
  - `pages/account`: ChangePasswordPage
  - `pages/admin`: TaskMasterPage, RoleFormPage, RoleListPage, UserFormPage, UserListPage
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage
  - `pages/dashboard`: OverviewPage
  - `pages/projects`: ProjectDetailsPage, ProjectEditPage, ProjectFormPage, ProjectListPage, ProjectQuickView, CommercialTab, EditTabs, PlanTab, ViewTabs
  - `pages/tasks`: TaskFormPage, TaskListPage, TaskPlanSection, TaskTemplatePage, TaskViewPage
  - `pages/timesheet`: LogTimeModal, TimesheetFormPage, TimesheetListPage
  - Drives the sidebar and every screen guard through the session (components/layout/Sidebar.jsx, router.jsx, auth/*)

## parameter_types

Kinds of Parameters (Skill, Grade, Currency …)

| Column | Type |
|---|---|
| id | bigint |
| code * | varchar(50) |
| name * | varchar(100) |
| description | text |
| is_system * | boolean |
| display_order * | integer |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by —; also read by config
- **Used in the frontend:** 
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage

## parameter_values

Values of the Parameters screen (skills, currencies, project stages …)

| Column | Type |
|---|---|
| id | bigint |
| type * | varchar(50) → parameter_types |
| name * | varchar(150) |
| value | varchar(150) |
| display_order * | integer |
| is_visible * | boolean |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by scripts; also read by config, masters, projects, tasks, users
- **Used in the frontend:** not directly (only through other screens)

## plan_items

The Plan: a member of a task planned on a day or in a week

| Column | Type |
|---|---|
| id | bigint |
| member_id * | bigint → task_members |
| scope * | varchar(5) |
| start_date * | date |
| position * | integer |
| legacy_id | bigint |

- **Backend:** written by flow, task135, tasks
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/tasks`: TaskFormPage, TaskListPage, TaskPlanSection, TaskTemplatePage, TaskViewPage
  - `pages/timesheet`: TimesheetFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## project_divisions

Project divisions (Web, Software …)

| Column | Type |
|---|---|
| id | bigint |
| name * | varchar(100) |
| description | text |
| is_active * | boolean |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by config, flow, scripts; also read by config, masters, projects, scripts
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage
  - `pages/tasks`: TaskFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## project_effort_estimates

Effort % of each task group on a project

| Column | Type |
|---|---|
| id | bigint |
| project_id * | bigint → projects |
| task_group_id * | bigint → task_groups |
| effort_percentage * | numeric |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by flow, projects, scripts; also read by flow, projectplan, tasks, timesheets
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/dashboard`: OverviewPage
  - `pages/projects`: ProjectDetailsPage, ProjectEditPage, ProjectFormPage, ProjectListPage, ProjectQuickView, CommercialTab, EditTabs, PlanTab, ViewTabs
  - `pages/tasks`: TaskFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## project_members

People on a project, with access level and cost

| Column | Type |
|---|---|
| id | bigint |
| project_id * | bigint → projects |
| user_id * | bigint → users |
| access_level * | varchar(20) |
| cost_per_hour | numeric |
| currency | character |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by flow, projects; also read by flow, taskaccess, tasks, timesheets
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/dashboard`: OverviewPage
  - `pages/projects`: ProjectDetailsPage, ProjectEditPage, ProjectFormPage, ProjectListPage, ProjectQuickView, CommercialTab, EditTabs, PlanTab, ViewTabs
  - `pages/tasks`: TaskFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## project_plan_weeks

Weeks a task group is planned in (project Plan tab)

| Column | Type |
|---|---|
| id | bigint |
| project_id * | bigint → projects |
| task_group_id * | bigint → task_groups |
| week_start * | date |
| created_by | bigint → users |
| created_at * | timestamptz |

- **Backend:** written by projectplan, projects; also read by tasks
- **Used in the frontend:** 
  - `pages/dashboard`: OverviewPage
  - `pages/projects`: ProjectDetailsPage, ProjectEditPage, ProjectFormPage, ProjectListPage, ProjectQuickView, CommercialTab, EditTabs, PlanTab, ViewTabs

## project_progress_update_groups

% completed of each task group in one progress update

| Column | Type |
|---|---|
| id | bigint |
| progress_update_id * | bigint → project_progress_updates |
| task_group_id * | bigint → task_groups |
| completion_percentage * | numeric |

- **Backend:** written by projects, scripts; also read by projects
- **Used in the frontend:** 
  - `pages/dashboard`: OverviewPage
  - `pages/projects`: ProjectDetailsPage, ProjectEditPage, ProjectFormPage, ProjectListPage, ProjectQuickView, CommercialTab, EditTabs, PlanTab, ViewTabs

## project_progress_updates

Project progress updates / stage changes (the Update tab)

| Column | Type |
|---|---|
| id | bigint |
| project_id * | bigint → projects |
| stage | varchar(30) |
| review_date * | date |
| comment * | text |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |
| is_system * | boolean |

- **Backend:** written by projects; also read by projects
- **Used in the frontend:** 
  - `pages/dashboard`: OverviewPage
  - `pages/projects`: ProjectDetailsPage, ProjectEditPage, ProjectFormPage, ProjectListPage, ProjectQuickView, CommercialTab, EditTabs, PlanTab, ViewTabs

## project_type_effort_defaults

Default effort % per task group of a project type

| Column | Type |
|---|---|
| id | bigint |
| project_type_id * | bigint → project_types |
| task_group_id * | bigint → task_groups |
| effort_percentage * | numeric |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by config, scripts; also read by projects, scripts
- **Used in the frontend:** 
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage

## project_type_task_template_roles

Roles (skills) a template task needs

| Column | Type |
|---|---|
| task_template_id * | bigint → project_type_task_templates |
| role_id * | bigint → parameter_values |

- **Backend:** written by config, scripts; also read by config, projects, tasks
- **Used in the frontend:** 
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage

## project_type_task_templates

Template tasks of a project type

| Column | Type |
|---|---|
| id | bigint |
| project_type_id * | bigint → project_types |
| task_group_id * | bigint → task_groups |
| task_type_id * | bigint → task_types |
| task_title * | varchar(300) |
| sort_order * | integer |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |
| description | text |
| manager_approval * | boolean |
| client_approval * | boolean |
| effort_percentage | numeric |

- **Backend:** written by config, scripts; also read by config, projects, tasks, scripts
- **Used in the frontend:** 
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage

## project_types

Project types (belong to a division)

| Column | Type |
|---|---|
| id | bigint |
| name * | varchar(100) |
| description | text |
| is_active * | boolean |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |
| project_division_id * | bigint → project_divisions |

- **Backend:** written by config, flow, scripts; also read by config, masters, projects, tasks, scripts
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage
  - `pages/tasks`: TaskFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## projects

Projects

| Column | Type |
|---|---|
| id | bigint |
| code * | varchar(30) |
| title * | varchar(200) |
| project_division_id * | bigint → project_divisions |
| project_type_id * | bigint → project_types |
| is_retainer_project * | boolean |
| customer_id | bigint → customers |
| owner_id * | bigint → users |
| estimated_hours | numeric |
| estimated_amount | numeric |
| estimated_amount_currency | character |
| detail | text |
| status * | varchar(30) |
| stage | varchar(30) |
| start_date * | date |
| end_date | date |
| sharepoint_link | varchar(500) |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |
| stage_id | bigint → parameter_values |
| outsource_value | numeric |
| purchase_value | numeric |
| other_value | numeric |
| is_billable * | boolean |

- **Backend:** written by flow, projects, scripts; also read by auth, config, flow, projectplan, projects, roles, task135, taskaccess, tasks, timesheets, users, scripts
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/dashboard`: OverviewPage
  - `pages/projects`: ProjectDetailsPage, ProjectEditPage, ProjectFormPage, ProjectListPage, ProjectQuickView, CommercialTab, EditTabs, PlanTab, ViewTabs
  - `pages/tasks`: TaskFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## refresh_tokens

Login sessions (refresh tokens)

| Column | Type |
|---|---|
| id | bigint |
| user_id * | bigint → users |
| token_hash * | varchar(255) |
| expires_at * | timestamptz |
| revoked_at | timestamptz |
| created_at * | timestamptz |

- **Backend:** written by auth, users
- **Used in the frontend:** 
  - `auth/AuthProvider.jsx`: AuthProvider
  - `pages/account`: ChangePasswordPage
  - `pages/admin`: UserFormPage, UserListPage

## resource_grade_costs

Cost per hour of a resource grade over time

| Column | Type |
|---|---|
| id | bigint |
| resource_grade_id * | bigint → resource_grades |
| cost_per_hour * | numeric |
| currency * | character |
| from_date * | date |
| to_date | date |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by config; also read by projects
- **Used in the frontend:** 
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage

## resource_grades

Resource grades (one per grade level)

| Column | Type |
|---|---|
| id | bigint |
| grade_id * | bigint → parameter_values |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by config; also read by masters, projects, scripts
- **Used in the frontend:** 
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage

## role_access_rules

Field / tab access rules of a role

| Column | Type |
|---|---|
| role_id * | bigint → roles |
| scope * | varchar(30) |
| key * | varchar(50) |
| access * | varchar(10) |

- **Backend:** written by roles; also read by auth, projects
- **Used in the frontend:** 
  - `hooks/useOptions.js`: useOptions.js
  - `pages/admin`: RoleFormPage, RoleListPage
  - Drives the sidebar and every screen guard through the session (components/layout/Sidebar.jsx, router.jsx, auth/*)

## role_permissions

What a role may view / create / edit / delete on each screen

| Column | Type |
|---|---|
| id | bigint |
| role_id * | bigint → roles |
| menu_id * | bigint → menus |
| can_view * | boolean |
| can_create * | boolean |
| can_edit * | boolean |
| can_delete * | boolean |
| can_approve * | boolean |
| can_export * | boolean |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by roles, scripts; also read by auth
- **Used in the frontend:** 
  - `hooks/useOptions.js`: useOptions.js
  - `pages/admin`: RoleFormPage, RoleListPage
  - Drives the sidebar and every screen guard through the session (components/layout/Sidebar.jsx, router.jsx, auth/*)

## roles

Roles and their data scope

| Column | Type |
|---|---|
| id | bigint |
| code * | varchar(50) |
| name * | varchar(100) |
| level * | smallint |
| role_type * | varchar(20) |
| data_scope * | varchar(20) |
| is_system * | boolean |
| is_active * | boolean |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by roles; also read by auth, config, flow, projects, roles, task135, taskaccess, tasks, users, scripts
- **Used in the frontend:** 
  - `hooks/useOptions.js`: useOptions.js
  - `pages/admin`: RoleFormPage, RoleListPage

## site_shifts

Shifts of a site

| Column | Type |
|---|---|
| id | bigint |
| site_id * | bigint → sites |
| name * | varchar(100) |
| start_time * | time without time zone |
| end_time * | time without time zone |
| late_after_minutes | smallint |
| half_day_minutes | smallint |
| display_order * | smallint |
| is_active * | boolean |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by config; also read by masters, users, scripts
- **Used in the frontend:** 
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage

## sites

Sites / locations

| Column | Type |
|---|---|
| id | bigint |
| name * | varchar(100) |
| is_active * | boolean |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by config; also read by config, masters, users, scripts
- **Used in the frontend:** 
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage

## task_categories

Task categories (Project, Personal, Activity)

| Column | Type |
|---|---|
| id | bigint |
| name * | varchar(100) |
| description | text |
| is_project * | boolean |
| display_order * | integer |
| is_active * | boolean |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |
| is_private * | boolean |

- **Backend:** written by —; also read by config, flow, masters, projects, task135, tasks, timesheets, scripts
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `hooks/useOptions.js`: useOptions.js
  - `pages/admin`: UserFormPage
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage
  - `pages/dashboard`: OverviewPage
  - `pages/projects`: ProjectDetailsPage, ProjectEditPage, ProjectFormPage, ProjectListPage, ProjectQuickView, CommercialTab, EditTabs, PlanTab, ViewTabs
  - `pages/tasks`: TaskFormPage, TaskListPage, TaskPlanSection, TaskTemplatePage, TaskViewPage
  - `pages/timesheet`: LogTimeModal, TimesheetFormPage, TimesheetListPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## task_category_groups

Task groups a category may use

| Column | Type |
|---|---|
| task_category_id * | bigint → task_categories |
| task_group_id * | bigint → task_groups |

- **Backend:** written by scripts; also read by config, masters, tasks, timesheets
- **Used in the frontend:** not directly (only through other screens)

## task_groups

Task groups

| Column | Type |
|---|---|
| id | bigint |
| name * | varchar(100) |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by config, flow, scripts; also read by config, flow, masters, projectplan, projects, tasks, timesheets, scripts
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage
  - `pages/tasks`: TaskFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## task_members

The people who work on a task, in order, with where each one is (waiting, offered, accepted, in progress, done)

| Column | Type |
|---|---|
| id | bigint |
| user_id * | bigint → users |
| position * | integer |
| status * | varchar(10) |
| accepted_at | timestamptz |
| started_at | timestamptz |
| closed_at | timestamptz |
| legacy_id | bigint |
| task_id * | bigint → tasks |

- **Backend:** written by flow, tasks; also read by flow, projects, task135, timesheets
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/tasks`: TaskFormPage, TaskListPage, TaskPlanSection, TaskTemplatePage, TaskViewPage
  - `pages/timesheet`: TimesheetFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## task_message_recipients

Who was tagged in a message and whether they read it

| Column | Type |
|---|---|
| message_id * | bigint → task_messages |
| user_id * | bigint → users |
| read_at | timestamptz |

- **Backend:** written by flow
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/tasks`: TaskFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## task_messages

Chat messages on a task or between people

| Column | Type |
|---|---|
| id | bigint |
| author_id * | bigint → users |
| kind * | varchar(10) |
| body * | text |
| is_private * | boolean |
| created_at * | timestamptz |
| legacy_id | bigint |
| task_id | bigint → tasks |

- **Backend:** written by flow
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/tasks`: TaskFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## task_skills

Skills a task needs

| Column | Type |
|---|---|
| task_id * | bigint → tasks |
| skill_id * | bigint → parameter_values |

- **Backend:** written by projects
- **Used in the frontend:** 
  - `pages/dashboard`: OverviewPage
  - `pages/projects`: ProjectDetailsPage, ProjectEditPage, ProjectFormPage, ProjectListPage, ProjectQuickView, CommercialTab, EditTabs, PlanTab, ViewTabs


## task_timers

Start / pause / end timers of a person on a task on a day

| Column | Type |
|---|---|
| id | bigint |
| user_id * | bigint → users |
| member_id * | bigint → task_members |
| day * | date |
| status * | varchar(10) |
| run_started_at | timestamptz |
| minutes * | integer |
| created_at * | timestamptz |
| legacy_id | bigint |

- **Backend:** written by flow, tasks
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/tasks`: TaskFormPage, TaskListPage, TaskPlanSection, TaskTemplatePage, TaskViewPage
  - `pages/timesheet`: TimesheetFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## task_types

Task types (belong to a task group)

| Column | Type |
|---|---|
| id | bigint |
| name * | varchar(100) |
| description | text |
| task_group_id * | bigint → task_groups |
| is_active * | boolean |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by config, flow, scripts; also read by config, flow, masters, projectplan, projects, tasks, timesheets, scripts
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage
  - `pages/tasks`: TaskFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## task_viewer_access

Whose tasks a person may view (extra access)

| Column | Type |
|---|---|
| viewer_id * | bigint → users |
| user_id * | bigint → users |
| created_by | bigint → users |
| created_at * | timestamptz |

- **Backend:** written by taskaccess
- **Used in the frontend:** 
  - `pages/admin`: TaskMasterPage
  - `pages/tasks`: TaskListPage
  - `pages/timesheet`: TimesheetListPage

## tasks

PMS tasks (Personal, Activity and Project tasks)

| Column | Type |
|---|---|
| id | bigint |
| project_id | bigint → projects |
| task_group_id | bigint → task_groups |
| task_type_id | bigint → task_types |
| name * | varchar(300) |
| description | text |
| owner_id | bigint → users |
| status * | varchar(30) |
| is_private * | boolean |
| display_order * | integer |
| estimated_minutes | integer |
| planned_start | timestamptz |
| planned_end | timestamptz |
| actual_start | timestamptz |
| actual_end | timestamptz |
| is_active * | boolean |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |
| task_category_id | bigint → task_categories |
| completed_on | date |
| completed_by | bigint → users |
| from_plan * | boolean |
| notes * | text |
| media * | text |
| version * | integer |
| legacy_id | bigint |

- **Backend:** written by flow, projectplan, projects, tasks, scripts; also read by config, flow, projectplan, projects, task135, taskaccess, tasks, timesheets, scripts
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/dashboard`: OverviewPage
  - `pages/projects`: ProjectDetailsPage, ProjectEditPage, ProjectFormPage, ProjectListPage, ProjectQuickView, CommercialTab, EditTabs, PlanTab, ViewTabs
  - `pages/tasks`: TaskFormPage, TaskListPage, TaskPlanSection, TaskTemplatePage, TaskViewPage
  - `pages/timesheet`: TimesheetFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## teams

Teams

| Column | Type |
|---|---|
| id | bigint |
| name * | varchar(100) |
| country_id | bigint → parameter_values |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |

- **Backend:** written by —; also read by config, masters, projects, tasks, timesheets, scripts
- **Used in the frontend:** 
  - `hooks/useOptions.js`: useOptions.js
  - `pages/admin`: UserFormPage
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage
  - `pages/dashboard`: OverviewPage
  - `pages/projects`: ProjectDetailsPage, ProjectEditPage, ProjectFormPage, ProjectListPage, ProjectQuickView, CommercialTab, EditTabs, PlanTab, ViewTabs
  - `pages/tasks`: TaskFormPage, TaskListPage, TaskPlanSection, TaskTemplatePage, TaskViewPage
  - `pages/timesheet`: LogTimeModal, TimesheetFormPage, TimesheetListPage

## timesheets

Logged time: who, when, how long, what was done, and the task (project, type and category come from the task). from_board = logged in Task Management (locked in the Timesheet)

| Column | Type |
|---|---|
| id | bigint |
| user_id * | bigint → users |
| work_date * | date |
| task_id * | bigint → tasks |
| minutes * | integer |
| comment | text |
| is_billable * | boolean |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |
| from_board * | boolean |
| legacy_id | bigint |

- **Backend:** written by flow, timesheets, scripts; also read by config, flow, projectplan, projects, taskaccess, tasks, timesheets, scripts
- **Used in the frontend:** 
  - `components/layout`: SidebarFooter
  - `pages/tasks`: TaskFormPage
  - `pages/timesheet`: LogTimeModal, TimesheetFormPage, TimesheetListPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …

## user_skills

Skills of a user

| Column | Type |
|---|---|
| user_id * | bigint → users |
| skill_id * | bigint → parameter_values |

- **Backend:** written by users; also read by config, projects, tasks
- **Used in the frontend:** 
  - `pages/admin`: UserFormPage, UserListPage

## user_teams

Which team(s) a user is in, with position

| Column | Type |
|---|---|
| user_id * | bigint → users |
| team_id * | bigint → teams |
| position | varchar(50) |

- **Backend:** written by —; also read by config, masters, projects, taskaccess, tasks, timesheets
- **Used in the frontend:** 
  - `hooks/useOptions.js`: useOptions.js
  - `pages/admin`: TaskMasterPage, UserFormPage
  - `pages/config`: ConfigFormPage, ConfigListPage, DivisionFormPage, ProjectTypeFormPage, ResourceGradeFormPage, SiteFormPage
  - `pages/dashboard`: OverviewPage
  - `pages/projects`: ProjectDetailsPage, ProjectEditPage, ProjectFormPage, ProjectListPage, ProjectQuickView, CommercialTab, EditTabs, PlanTab, ViewTabs
  - `pages/tasks`: TaskFormPage, TaskListPage, TaskPlanSection, TaskTemplatePage, TaskViewPage
  - `pages/timesheet`: LogTimeModal, TimesheetFormPage, TimesheetListPage

## users

People who can sign in

| Column | Type |
|---|---|
| id | bigint |
| employee_code | varchar(30) |
| username * | varchar(100) |
| password_hash * | varchar(255) |
| name * | varchar(150) |
| email | varchar(150) |
| role_id * | bigint → roles |
| user_type_id | bigint → parameter_values |
| site_id | bigint → sites |
| time_zone * | varchar(50) |
| resource_grade_id | bigint → resource_grades |
| customer_id | bigint → customers |
| manager_id | bigint → users |
| dob | date |
| hourly_rate | numeric |
| hourly_rate_currency | character |
| is_active * | boolean |
| is_on_leave * | boolean |
| last_login_at | timestamptz |
| failed_login_attempts * | smallint |
| created_by | bigint → users |
| created_at * | timestamptz |
| updated_by | bigint → users |
| updated_at * | timestamptz |
| site_shift_id | bigint → site_shifts |

- **Backend:** written by auth, flow, users, scripts; also read by auth, config, flow, masters, projectplan, projects, roles, task135, taskaccess, tasks, timesheets, users, scripts
- **Used in the frontend:** 
  - `auth/AuthProvider.jsx`: AuthProvider
  - `components/layout`: SidebarFooter
  - `pages/account`: ChangePasswordPage
  - `pages/admin`: UserFormPage, UserListPage
  - `pages/tasks`: TaskFormPage
  - `Tasks screens (src/tmx)`: TmApp, dialogs, hooks.ts, Board, CatchUp, Chat, Dashboard, FilterBar, FlowEditor, Inbox, MessagesPage, Pickers …
