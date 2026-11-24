/*
 * Project tabs and Project-tab fields a role may see / edit (Roles & Permissions → Project access).
 * Stored in role_access_rules; no rule = 'edit' (today's behaviour). Super Admin always has 'edit'.
 * A role still needs the Projects screen permission (view / edit) – these rules only narrow it.
 */

export const ACCESS = ['hidden', 'view', 'edit'];

// tabs without their own editing (Tasks, Analysis, History) only have hidden / view
export const PROJECT_TABS = [
  { key: 'update', label: 'Update', editable: true },
  { key: 'project', label: 'Project', editable: true },
  { key: 'users', label: 'Users', editable: true },
  { key: 'estimate', label: 'Estimate', editable: true },
  { key: 'plan', label: 'Plan', editable: true }, // weekly plan by task group
  { key: 'tasks', label: 'Tasks', editable: false },
  { key: 'commercial', label: 'Commercial', editable: true },
  { key: 'analysis', label: 'Analysis', editable: false },
  { key: 'history', label: 'History', editable: false },
];

// Project tab fields; required ones can't be hidden (a project needs them) and are always set on create
export const PROJECT_FIELDS = [
  { key: 'title', label: 'Project title', required: true, col: 'title' },
  { key: 'customerId', label: 'Customer', col: 'customer_id', alsoHide: ['customerName'] },
  { key: 'ownerId', label: 'Project owner', required: true, col: 'owner_id', alsoHide: ['ownerName', 'ownerEmail'] },
  { key: 'projectDivisionId', label: 'Project division', required: true, col: 'project_division_id', alsoHide: ['divisionName'] },
  { key: 'projectTypeId', label: 'Project type', required: true, col: 'project_type_id', alsoHide: ['typeName'] },
  { key: 'startDate', label: 'Start date', required: true, col: 'start_date' },
  { key: 'endDate', label: 'End date', col: 'end_date' },
  { key: 'estimatedAmount', label: 'Total amount', col: 'estimated_amount', alsoHide: ['quoteRatePerHour'] },
  { key: 'estimatedAmountCurrency', label: 'Currency', col: 'estimated_amount_currency' },
  { key: 'sharepointLink', label: 'SharePoint link', col: 'sharepoint_link' },
  { key: 'isRetainerProject', label: 'Retainer project', col: 'is_retainer_project' },
  { key: 'isBillable', label: 'Billable', col: 'is_billable' },
  { key: 'detail', label: 'Detail', col: 'detail' },
];

export const SCOPES = { tab: 'project_tab', field: 'project_field' };

/** 'hidden' | 'view' | 'edit' of a project tab for the signed-in user. */
export function tabAccess(auth, key) {
  if (auth.isSuperAdmin) return 'edit';
  const tab = PROJECT_TABS.find((t) => t.key === key);
  const a = auth.access?.[SCOPES.tab]?.[key] ?? 'edit';
  return a === 'edit' && tab && !tab.editable ? 'view' : a;
}

/** 'hidden' | 'view' | 'edit' of a Project-tab field; a required field is never hidden. */
export function fieldAccess(auth, key) {
  if (auth.isSuperAdmin) return 'edit';
  const field = PROJECT_FIELDS.find((f) => f.key === key);
  const a = auth.access?.[SCOPES.field]?.[key] ?? 'edit';
  return a === 'hidden' && field?.required ? 'view' : a;
}

/** Everything resolved for the session (the screens hide / lock with it). */
export function projectAccessOf(auth) {
  return {
    tabs: Object.fromEntries(PROJECT_TABS.map((t) => [t.key, tabAccess(auth, t.key)])),
    fields: Object.fromEntries(PROJECT_FIELDS.map((f) => [f.key, fieldAccess(auth, f.key)])),
  };
}

/** Blanks the fields the user may not see (project list rows and details). */
export function maskFields(auth, dto) {
  if (auth.isSuperAdmin) return dto;
  const out = { ...dto };
  for (const f of PROJECT_FIELDS) {
    if (fieldAccess(auth, f.key) !== 'hidden') continue;
    out[f.key] = null;
    for (const k of f.alsoHide ?? []) out[k] = null;
  }
  return out;
}
