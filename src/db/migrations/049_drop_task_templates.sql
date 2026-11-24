-- Task templates (a project type's list of tasks created with every new project) are removed.
-- Tasks already created from them stay as normal tasks; only the template tables and their data go.
DROP TABLE IF EXISTS project_type_task_template_roles;
DROP TABLE IF EXISTS project_type_task_templates;
