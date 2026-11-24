import { writeAudit, diff } from '../../utils/audit.js';
import { badRequest, conflict, forbidden, isReferenceError, notFound } from '../../utils/errors.js';
import { escapeLike, idList, WhereBuilder } from '../../utils/query.js';
import { sqlToday } from '../../utils/time.js';
import { exact } from '../../utils/number.js';
import { fieldAccess, maskFields, PROJECT_FIELDS, tabAccess } from './project-access.js';

/** Refuses when the user's role may not use / change a project tab (Roles & Permissions → Project access). */
function needTab(auth, tab, level, what) {
  const a = tabAccess(auth, tab);
  if (a === 'hidden' || (level === 'edit' && a !== 'edit')) throw forbidden(`Your role cannot ${level === 'edit' ? 'change' : 'see'} ${what}`);
}

const norm = (v) => (v === null || v === undefined || v === '' ? null : typeof v === 'string' ? v.trim() : v);
const changed = (oldValue, newValue) => {
  const a = norm(oldValue);
  const b = norm(newValue);
  if (a === null || b === null) return a !== b;
  if (typeof b === 'number' || typeof b === 'boolean') return String(Number(a)) !== String(Number(b)) && String(a) !== String(b);
  return String(a) !== String(b);
};

/** Edits of a saved project: each changed part needs its tab / field rule at 'edit'. */
function assertProjectEdits(auth, before, body, members, estimates) {
  if (members !== undefined) needTab(auth, 'users', 'edit', 'the project members');
  if (estimates !== undefined || (body.estimatedHours !== undefined && changed(before.estimated_hours, body.estimatedHours))) {
    needTab(auth, 'estimate', 'edit', 'the estimate');
  }
  if (body.stageId !== undefined && changed(before.stage_id, body.stageId)) needTab(auth, 'update', 'edit', 'the stage');
  for (const f of PROJECT_FIELDS) {
    if (body[f.key] === undefined || !changed(before[f.col], body[f.key])) continue;
    if (tabAccess(auth, 'project') !== 'edit' || fieldAccess(auth, f.key) !== 'edit') throw forbidden(`Your role cannot change the ${f.label.toLowerCase()}`);
  }
}

/** New project: optional fields the role may not edit get their default (required ones are always set). */
const NEW_DEFAULTS = { estimatedAmountCurrency: 'AED', isRetainerProject: false, isBillable: true };
function applyCreateRules(auth, body) {
  const out = { ...body };
  for (const f of PROJECT_FIELDS) {
    if (f.required || fieldAccess(auth, f.key) === 'edit') continue;
    out[f.key] = NEW_DEFAULTS[f.key] ?? null;
  }
  return out;
}
import { workLabel } from '../projectplan/plan-guard.js';
import { insertReview, insertSystemLog, listReviews, memberUsage, loadMemberHours, loadMembers, saveEstimates, saveMembers } from './projects.tabs.js';

export const PROJECT_STATUSES = ['not_started', 'in_progress', 'on_hold', 'completed', 'cancelled'];
const ACTIVE_STATUSES = ['not_started', 'in_progress'];

const SORT_COLUMNS = { title: 'p.title', code: 'p.code', endDate: 'p.end_date', startDate: 'p.start_date', createdAt: 'p.created_at' };

// API field -> column for the editable project fields (Project tab / New project form).
const FIELDS = {
  title: 'title',
  customerId: 'customer_id',
  ownerId: 'owner_id',
  projectDivisionId: 'project_division_id',
  projectTypeId: 'project_type_id',
  startDate: 'start_date',
  endDate: 'end_date',
  estimatedHours: 'estimated_hours',
  estimatedAmount: 'estimated_amount',
  estimatedAmountCurrency: 'estimated_amount_currency',
  sharepointLink: 'sharepoint_link',
  isRetainerProject: 'is_retainer_project',
  isBillable: 'is_billable',
  detail: 'detail',
  stageId: 'stage_id',
};
// audited columns: the stage is logged by name, together with the category it puts the project in
const AUDIT_KEYS = [...Object.values(FIELDS).filter((c) => c !== 'stage_id'), 'stage', 'status'];

// Progress = Σ(effort % of task group × completed % at the latest review) / 100.
const SELECT = `
  SELECT p.*, c.name AS customer_name, d.name AS division_name, t.name AS type_name,
         o.name AS owner_name, o.email AS owner_email, st.name AS stage_name,
         (SELECT q.rate_per_hour FROM division_quote_rates q
           WHERE q.project_division_id = p.project_division_id AND q.currency = p.estimated_amount_currency) AS quote_rate,
         COALESCE(prog.progress, 0) AS progress,
         COALESCE(ts.logged_minutes, 0) AS logged_minutes,
         lc.comment AS last_comment, lc.created_at AS last_comment_at, lc.author AS last_comment_by,
         (SELECT max(r.review_date) FROM project_progress_updates r
           WHERE r.project_id = p.id
             AND EXISTS (SELECT 1 FROM project_progress_update_groups g WHERE g.progress_update_id = r.id)) AS last_review_date
    FROM projects p
    JOIN project_divisions d ON d.id = p.project_division_id
    JOIN project_types t ON t.id = p.project_type_id
    JOIN users o ON o.id = p.owner_id
    LEFT JOIN customers c ON c.id = p.customer_id
    LEFT JOIN parameter_values st ON st.id = p.stage_id
    LEFT JOIN LATERAL (
      SELECT ROUND(SUM(e.effort_percentage * rtg.completion_percentage) / 100)::int AS progress
        FROM project_progress_updates pr
        JOIN project_progress_update_groups rtg ON rtg.progress_update_id = pr.id
        JOIN project_effort_estimates e ON e.project_id = p.id AND e.task_group_id = rtg.task_group_id
       WHERE pr.id = (SELECT r.id FROM project_progress_updates r
                       WHERE r.project_id = p.id
                         AND EXISTS (SELECT 1 FROM project_progress_update_groups g WHERE g.progress_update_id = r.id)
                       ORDER BY r.review_date DESC, r.id DESC LIMIT 1)
    ) prog ON true
    LEFT JOIN LATERAL (
      SELECT SUM(x.minutes)::int AS logged_minutes FROM timesheets x JOIN tasks k ON k.id = x.task_id WHERE k.project_id = p.id
    ) ts ON true
    LEFT JOIN LATERAL (
      -- latest progress comment (Update tab)
      SELECT r.comment, r.created_at, u.name AS author
        FROM project_progress_updates r LEFT JOIN users u ON u.id = r.created_by
       WHERE r.project_id = p.id AND r.comment <> ''
       ORDER BY r.created_at DESC, r.id DESC LIMIT 1
    ) lc ON true`;

const toDto = (p) => ({
  id: p.id,
  code: p.code,
  title: p.title,
  customerId: p.customer_id,
  customerName: p.customer_name,
  ownerId: p.owner_id,
  ownerName: p.owner_name,
  ownerEmail: p.owner_email,
  projectDivisionId: p.project_division_id,
  divisionName: p.division_name,
  projectTypeId: p.project_type_id,
  typeName: p.type_name,
  isRetainerProject: p.is_retainer_project,
  isBillable: p.is_billable,
  startDate: p.start_date,
  endDate: p.end_date,
  estimatedHours: p.estimated_hours,
  estimatedAmount: p.estimated_amount,
  estimatedAmountCurrency: p.estimated_amount_currency?.trim() ?? null,
  quoteRatePerHour: p.quote_rate ?? null, // the division's quote rate in the project's currency
  sharepointLink: p.sharepoint_link,
  detail: p.detail,
  status: p.status, // category of the stage
  stageId: p.stage_id,
  stageName: p.stage_name ?? p.stage,
  progress: p.progress,
  loggedHours: exact(p.logged_minutes / 60),
  lastComment: p.last_comment ?? null,
  lastCommentBy: p.last_comment_by ?? null,
  lastCommentAt: p.last_comment_at ? new Date(p.last_comment_at).toISOString() : null,
  lastReviewDate: p.last_review_date ?? null, // review date of the latest progress entry
  createdAt: p.created_at,
  updatedAt: p.updated_at,
});

/**
 * Row-level security from the role's data scope:
 *   all      – every project
 *   team     – projects owned by / shared with anyone in the user's teams
 *   own      – projects the user owns or is a member of
 *   customer – projects of the user's customer (customer logins)
 */
function applyDataScope(where, auth) {
  if (auth.isSuperAdmin || auth.role.dataScope === 'all') return;
  const me = auth.userId;
  // the owner, a member, or the person who created the project (who may have made it for someone else)
  const ownOrMember = `(p.owner_id = $? OR p.created_by = $? OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $?))`;

  switch (auth.role.dataScope) {
    case 'customer':
      where.add(`p.customer_id = $?`, auth.customerId ?? -1);
      break;
    case 'team':
      where.add(
        `(${ownOrMember} OR EXISTS (
            SELECT 1 FROM user_teams mine
              JOIN user_teams other ON other.team_id = mine.team_id
             WHERE mine.user_id = $?
               AND (other.user_id = p.owner_id
                    OR EXISTS (SELECT 1 FROM project_members pm2 WHERE pm2.project_id = p.id AND pm2.user_id = other.user_id))))`,
        me,
        me,
        me,
        me,
      );
      break;
    default:
      where.add(ownOrMember, me, me, me);
  }
}

function buildFilters(auth, q) {
  const where = new WhereBuilder();
  applyDataScope(where, auth);

  if (q.tab === 'mine') {
    where.add(`(p.owner_id = $? OR EXISTS (SELECT 1 FROM project_members pm3 WHERE pm3.project_id = p.id AND pm3.user_id = $?))`, auth.userId, auth.userId);
  } else if (q.tab === 'owned') {
    where.add(`p.owner_id = $?`, auth.userId);
  }
  if (q.search) {
    const s = `%${escapeLike(q.search)}%`;
    where.add(`(p.title ILIKE $? OR p.code ILIKE $? OR c.name ILIKE $?)`, s, s, s);
  }
  if (q.status) {
    const statuses = q.status.split(',').filter((s) => PROJECT_STATUSES.includes(s));
    if (statuses.length) where.add(`p.status = ANY($?)`, statuses);
  }
  for (const [param, col] of [
    ['divisionId', 'p.project_division_id'],
    ['typeId', 'p.project_type_id'],
    ['ownerId', 'p.owner_id'],
    ['customerId', 'p.customer_id'],
  ]) {
    const ids = idList(q[param]);
    if (ids.length) where.add(`${col} = ANY($?)`, ids);
  }
  const stageIds = idList(q.stageId);
  if (stageIds.length) where.add(`p.stage_id = ANY($?)`, stageIds);
  if (q.isRetainerProject !== undefined) where.add(`p.is_retainer_project = $?`, q.isRetainerProject);
  if (q.overdue) where.add(`p.end_date < ${sqlToday(auth)} AND p.status = ANY($?)`, ACTIVE_STATUSES);
  if (q.startFrom) where.add(`p.start_date >= $?`, q.startFrom);
  if (q.startTo) where.add(`p.start_date <= $?`, q.startTo);
  if (q.endFrom) where.add(`p.end_date >= $?`, q.endFrom);
  if (q.endTo) where.add(`p.end_date <= $?`, q.endTo);
  return where;
}

export async function listProjects(db, auth, q) {
  const where = buildFilters(auth, q);
  const sort = SORT_COLUMNS[q.sortBy] || 'p.created_at';
  const dir = q.sortDir === 'asc' ? 'ASC' : 'DESC';
  const limit = where.param(q.pageSize);
  const offset = where.param((q.page - 1) * q.pageSize);
  const { rows } = await db.query(
    `${SELECT} ${where.toSql()}
      ORDER BY ${sort} ${dir} NULLS LAST, p.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    where.params,
  );
  // total in a separate light query (the list query has lateral joins)
  const countWhere = buildFilters(auth, q);
  const { rows: cnt } = await db.query(
    `SELECT count(*)::int AS total FROM projects p LEFT JOIN customers c ON c.id = p.customer_id ${countWhere.toSql()}`,
    countWhere.params,
  );
  return { items: rows.map((r) => maskFields(auth, toDto(r))), total: cnt[0].total, page: q.page, pageSize: q.pageSize };
}

/**
 * Everything the Project List summary cards and tabs show, within the user's data scope:
 *   Active projects  – count, created this month, on track / at risk (ends in 14 days) / late, 12-month trend
 *   On hold          – client (has a customer) / internal
 *   Over allocation  – projects whose logged hours exceed the estimate (top 2 listed)
 *   Hours this month – logged hours, billable / internal, hours per day of the current week
 */
export async function projectSummary(db, auth) {
  const today = sqlToday(auth); // the user's today (their time zone)
  const where = new WhereBuilder();
  applyDataScope(where, auth);
  const scope = { sql: where.toSql(), params: [...where.params] }; // for queries that don't use "me"
  const me = where.param(auth.userId);
  const active = `p.status = ANY('{${ACTIVE_STATUSES.join(',')}}')`;
  const scoped = `scoped AS (SELECT p.* FROM projects p ${scope.sql})`;

  const [counts, trend, overAlloc, hours, week, stages] = await Promise.all([
    db.query(
      `WITH ${scoped}
       SELECT count(*)::int AS total,
              count(*) FILTER (WHERE ${active})::int AS active,
              count(*) FILTER (WHERE p.status = 'not_started')::int AS not_started,
              count(*) FILTER (WHERE p.status = 'in_progress')::int AS in_progress,
              count(*) FILTER (WHERE p.status = 'on_hold')::int AS on_hold,
              count(*) FILTER (WHERE p.status = 'on_hold' AND p.customer_id IS NOT NULL)::int AS on_hold_client,
              count(*) FILTER (WHERE p.status = 'completed')::int AS completed,
              count(*) FILTER (WHERE p.status = 'cancelled')::int AS cancelled,
              count(*) FILTER (WHERE ${active} AND p.end_date < ${today})::int AS late,
              count(*) FILTER (WHERE ${active} AND p.end_date BETWEEN ${today} AND ${today} + 14)::int AS at_risk,
              count(*) FILTER (WHERE ${active} AND p.created_at >= date_trunc('month', now()))::int AS created_this_month,
              count(*) FILTER (WHERE p.owner_id = ${me}
                                OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ${me}))::int AS mine,
              count(*) FILTER (WHERE p.owner_id = ${me})::int AS owned
         FROM scoped p`,
      where.params,
    ),
    // projects created per month, last 12 months (sparkline)
    db.query(
      `WITH ${scoped}
       SELECT m.month, count(p.id)::int AS n
         FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') AS m(month)
         LEFT JOIN scoped p ON date_trunc('month', p.created_at) = m.month
        GROUP BY m.month ORDER BY m.month`,
      scope.params,
    ),
    db.query(
      `WITH ${scoped}, burn AS (
         SELECT p.id, p.title, o.name AS owner_name, p.estimated_hours,
                COALESCE((SELECT SUM(t.minutes) FROM timesheets t JOIN tasks k ON k.id = t.task_id WHERE k.project_id = p.id), 0) / 60.0 AS logged
           FROM scoped p JOIN users o ON o.id = p.owner_id
          WHERE p.estimated_hours > 0 AND p.status <> 'cancelled')
       SELECT id, title, owner_name, ROUND(logged * 100 / estimated_hours)::int AS pct, count(*) OVER()::int AS total
         FROM burn WHERE logged > estimated_hours
        ORDER BY logged / estimated_hours DESC LIMIT 2`,
      scope.params,
    ),
    db.query(
      `WITH ${scoped}
       SELECT COALESCE(SUM(t.minutes), 0)::int AS total,
              COALESCE(SUM(t.minutes) FILTER (WHERE t.is_billable), 0)::int AS billable
         FROM timesheets t JOIN tasks k ON k.id = t.task_id JOIN scoped p ON p.id = k.project_id
        WHERE t.work_date >= date_trunc('month', ${today})`,
      scope.params,
    ),
    // hours per day of the current week, Monday first
    db.query(
      `WITH ${scoped}
       SELECT d.day::date AS day, COALESCE(SUM(t.minutes), 0)::int AS minutes
         FROM generate_series(date_trunc('week', ${today}), date_trunc('week', ${today}) + interval '6 days', interval '1 day') AS d(day)
         LEFT JOIN timesheets t ON t.work_date = d.day::date AND t.task_id IN (SELECT k.id FROM tasks k WHERE k.project_id IN (SELECT id FROM scoped))
        GROUP BY d.day ORDER BY d.day`,
      scope.params,
    ),
    // projects per stage (Project stages pie)
    db.query(
      `WITH ${scoped}
       SELECT l.id, l.name, l.value AS status, count(p.id)::int AS n
         FROM scoped p JOIN parameter_values l ON l.id = p.stage_id
        GROUP BY l.id, l.name, l.value, l.display_order
        ORDER BY l.display_order, l.name`,
      scope.params,
    ),
  ]);

  const r = counts.rows[0];
  const hrs = (min) => exact(min / 60);
  return {
    total: r.total,
    active: r.active,
    overdue: r.late,
    createdThisMonth: r.created_this_month,
    mine: r.mine,
    owned: r.owned,
    activeHealth: { onTrack: r.active - r.late - r.at_risk, atRisk: r.at_risk, late: r.late },
    onHold: { total: r.on_hold, client: r.on_hold_client, internal: r.on_hold - r.on_hold_client },
    createdByMonth: trend.rows.map((m) => m.n),
    overAllocation: {
      total: overAlloc.rows[0]?.total ?? 0,
      items: overAlloc.rows.map((o) => ({ id: o.id, title: o.title, ownerName: o.owner_name, percent: o.pct })),
    },
    hoursThisMonth: {
      total: hrs(hours.rows[0].total),
      billable: hrs(hours.rows[0].billable),
      internal: hrs(hours.rows[0].total - hours.rows[0].billable),
      week: week.rows.map((d) => hrs(d.minutes)),
    },
    byStage: stages.rows.map((st) => ({ id: st.id, name: st.name, status: st.status, count: st.n })),
    byStatus: {
      not_started: r.not_started,
      in_progress: r.in_progress,
      on_hold: r.on_hold,
      completed: r.completed,
      cancelled: r.cancelled,
    },
  };
}

/**
 * Commercial tab (project value, outsource / purchase / other values, members' rates and value):
 * whoever's role has the tab (Roles & Permissions → Project access); Super Admin always.
 */
export const canSeeCommercial = (auth) => tabAccess(auth, 'commercial') !== 'hidden';

/** USD rate of each currency (Parameters → CURRENCY): { INR: 0.0119, USD: 1, … }. */
async function usdRates(db) {
  const { rows } = await db.query(`SELECT code, usd_rate FROM v_currency_usd_rates WHERE usd_rate IS NOT NULL`); // Parameters → USD Rates
  return { USD: 1, ...Object.fromEntries(rows.map((r) => [r.code, Number(r.usd_rate)])) };
}

/**
 * Commercial figures – always in the project's currency. Project value = the project's total amount.
 * Member value = logged hours × rate, where the rate is the member's project rate, else the cost of the user's grade
 * (Resource Grade & Cost) in the project's currency; a grade with no cost in that currency is taken in USD
 * (or its own currency, through USD) and converted to the project's currency with the USD rates
 * (Parameters → USD Rates). Outsource / purchase / other values are kept in the project's currency.
 * Net value = project value − total cost.
 */
function commercialOf(row, members, rates) {
  const projectCurrency = (row.estimated_amount_currency?.trim() || 'INR').toUpperCase();
  const pRate = rates[projectCurrency] ?? null; // 1 unit of the project currency in USD
  const missing = new Set();
  // an amount in another currency → the project currency, through USD
  const toProject = (v, cur) => {
    if (v == null) return null;
    const code = (cur || projectCurrency).trim().toUpperCase();
    if (code === projectCurrency) return exact(Number(v));
    if (rates[code] == null) {
      missing.add(code);
      return null;
    }
    if (!pRate) {
      missing.add(projectCurrency);
      return null;
    }
    return exact((Number(v) * rates[code]) / pRate);
  };
  const fromUsd = (usd) => {
    if (usd == null) return null;
    if (!pRate) {
      missing.add(projectCurrency);
      return null;
    }
    return exact(usd / pRate);
  };
  const list = members.map((m) => {
    const projectRate = toProject(m.costPerHour, m.currency);
    // users have no own rate: their cost comes from their grade – in the project currency, else through USD
    const gradeDirect = m.gradeRate;
    const gradeViaUsd = gradeDirect == null ? fromUsd(m.gradeRateUsd) : null;
    const gradeRate = gradeDirect ?? gradeViaUsd;
    const rate = projectRate ?? gradeRate;
    const rateSource = projectRate != null ? 'project' : gradeDirect != null ? 'grade' : gradeViaUsd != null ? 'grade_usd' : null;
    return {
      id: m.id,
      name: m.name,
      isOwner: m.isOwner,
      gradeName: m.gradeName,
      teamName: m.teamName,
      costPerHour: projectRate,
      gradeRate,
      gradeRateViaUsd: gradeViaUsd != null,
      defaultRate: null,
      rateSource,
      rate,
      loggedHours: m.loggedHours,
      value: rate != null ? exact(m.loggedHours * rate) : null,
    };
  });
  const totalValue = row.estimated_amount != null ? Number(row.estimated_amount) : null;
  const membersValue = exact(list.reduce((s, m) => s + (m.value ?? 0), 0));
  const other = [row.outsource_value, row.purchase_value, row.other_value].reduce((s, v) => s + Number(v ?? 0), 0);
  const totalCost = exact(membersValue + other);
  return {
    currency: projectCurrency,
    projectCurrency,
    projectAmount: row.estimated_amount,
    usdRate: pRate,
    missingRates: [...missing],
    totalValue,
    outsourceValue: row.outsource_value,
    purchaseValue: row.purchase_value,
    otherValue: row.other_value,
    membersValue,
    totalCost,
    netValue: totalValue != null ? exact(totalValue - totalCost) : null,
    members: list,
  };
}

export async function getProject(db, auth, id) {
  const where = new WhereBuilder();
  where.add(`p.id = $?`, id);
  applyDataScope(where, auth);
  const { rows } = await db.query(`${SELECT} ${where.toSql()}`, where.params);
  if (!rows[0]) throw notFound('Project');

  const [estimates, taskCount, members, record, memberHours] = await Promise.all([
    // effort % per task group, with the hours actually logged against task types of that group
    db.query(
      `SELECT e.task_group_id, g.name, e.effort_percentage,
              COALESCE((SELECT SUM(t.minutes) FROM timesheets t JOIN tasks k ON k.id = t.task_id JOIN task_types tt ON tt.id = k.task_type_id
                         WHERE k.project_id = e.project_id AND tt.task_group_id = e.task_group_id), 0) AS actual_minutes,
              (SELECT count(*)::int FROM timesheets t JOIN tasks k ON k.id = t.task_id JOIN task_types tt ON tt.id = k.task_type_id
                WHERE k.project_id = e.project_id AND tt.task_group_id = e.task_group_id) AS entries,
              (SELECT count(*)::int FROM tasks k WHERE k.project_id = e.project_id AND k.task_group_id = e.task_group_id AND k.is_active
                  AND k.status IN ('in_progress', 'completed')) AS started,
              -- the % complete of the group in the latest Update-tab review that reported it
              (SELECT g2.completion_percentage FROM project_progress_update_groups g2 JOIN project_progress_updates r2 ON r2.id = g2.progress_update_id
                WHERE r2.project_id = e.project_id AND g2.task_group_id = e.task_group_id ORDER BY r2.review_date DESC, r2.id DESC LIMIT 1) AS reported
         FROM project_effort_estimates e JOIN task_groups g ON g.id = e.task_group_id
        WHERE e.project_id = $1 ORDER BY e.effort_percentage DESC, g.name`,
      [id],
    ),
    db.query(`SELECT count(*)::int AS n FROM tasks WHERE project_id = $1`, [id]),
    loadMembers(db, id, rows[0].owner_id),
    db.query(
      `SELECT c.name AS created_by_name, u.name AS updated_by_name
         FROM projects p LEFT JOIN users c ON c.id = p.created_by LEFT JOIN users u ON u.id = p.updated_by WHERE p.id = $1`,
      [id],
    ),
    loadMemberHours(db, id),
  ]);
  const est = rows[0].estimated_hours;
  // rates, grades and costs are commercial – hidden from everyone else (and from roles without the tab)
  const commercial = canSeeCommercial(auth);
  const hiddenTab = (t) => tabAccess(auth, t) === 'hidden';
  const hide = { costPerHour: null, currency: null, defaultRate: null, defaultRateCurrency: null, gradeName: null, gradeRate: null, gradeRateUsd: null };
  return maskFields(auth, {
    ...toDto(rows[0]),
    taskCount: taskCount.rows[0].n,
    createdByName: record.rows[0].created_by_name,
    updatedByName: record.rows[0].updated_by_name,
    canSeeCommercial: commercial,
    commercial: commercial ? commercialOf(rows[0], members, await usdRates(db)) : null,
    members: hiddenTab('users') ? [] : commercial ? members : members.map((m) => ({ ...m, ...hide })),
    memberHours: hiddenTab('analysis') ? [] : commercial ? memberHours : memberHours.map((m) => ({ ...m, rate: null, cost: null })),
    estimates: estimates.rows.map((e) => ({
      taskGroupId: e.task_group_id,
      taskGroupName: e.name,
      effortPercentage: e.effort_percentage,
      hours: est != null ? exact((est * e.effort_percentage) / 100) : null,
      actualHours: exact(Number(e.actual_minutes) / 60),
      // work has started in the group: its effort cannot be set to 0%
      reportedPercentage: e.reported == null ? 0 : Number(e.reported),
      locked: e.entries > 0 || e.started > 0,
      lockReason: e.entries > 0 || e.started > 0 ? workLabel(e) : null,
    })),
  });
}

/** Audit-log entries of a project, newest first. */
export async function projectActivity(db, auth, id) {
  needTab(auth, 'history', 'view', 'the project history');
  await getProject(db, auth, id); // existence + data scope
  const { rows } = await db.query(
    `SELECT a.id, a.action, a.message, a.changes, a.logged_at, u.name AS user_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity = 'projects' AND a.entity_id = $1
      ORDER BY a.logged_at DESC, a.id DESC LIMIT 20`,
    [id],
  );
  return rows.map((a) => ({ id: a.id, action: a.action, message: a.message, changes: a.changes, userName: a.user_name, loggedAt: a.logged_at }));
}

/** A stage (lookups PROJECT_STAGE) and the status category it stands for. */
async function resolveStage(db, stageId) {
  const { rows } = stageId
    ? await db.query(`SELECT id, name, value, is_visible FROM parameter_values WHERE id = $1 AND type = 'PROJECT_STAGE'`, [stageId])
    : // default for new projects: the first "not started" stage (Draft)
      await db.query(
        `SELECT id, name, value, is_visible FROM parameter_values WHERE type = 'PROJECT_STAGE' AND is_visible
          ORDER BY (value = 'not_started') DESC, display_order, name LIMIT 1`,
      );
  const st = rows[0];
  if (!st) throw badRequest('Select a valid project stage', [{ field: 'stageId', message: 'is not a project stage' }]);
  if (!st.is_visible && stageId) throw badRequest('This stage is hidden – pick another one', [{ field: 'stageId', message: 'is hidden' }]);
  const status = PROJECT_STATUSES.includes(st.value) ? st.value : 'in_progress';
  return { id: st.id, name: st.name, status };
}

/** Checks that the selected masters exist and are active. */
async function validateReferences(db, body) {
  const checks = [];
  if (body.projectDivisionId !== undefined)
    checks.push(['projectDivisionId', 'Project division', `SELECT is_active FROM project_divisions WHERE id = $1`, body.projectDivisionId]);
  if (body.projectTypeId !== undefined)
    checks.push(['projectTypeId', 'Project type', `SELECT is_active FROM project_types WHERE id = $1`, body.projectTypeId]);
  if (body.ownerId !== undefined)
    checks.push(['ownerId', 'Project owner', `SELECT is_active FROM users WHERE id = $1`, body.ownerId]);
  if (body.customerId)
    checks.push(['customerId', 'Customer', `SELECT is_active FROM customers WHERE id = $1`, body.customerId]);

  for (const [field, label, sql, value] of checks) {
    const { rows } = await db.query(sql, [value]);
    if (!rows[0]) throw badRequest(`${label} does not exist`, [{ field, message: 'does not exist' }]);
    if (!rows[0].is_active) throw badRequest(`${label} is inactive`, [{ field, message: 'is inactive' }]);
  }
  if (body.projectTypeId !== undefined && body.projectDivisionId !== undefined) {
    const { rows } = await db.query(`SELECT project_division_id FROM project_types WHERE id = $1`, [body.projectTypeId]);
    if (rows[0]?.project_division_id && rows[0].project_division_id !== body.projectDivisionId) {
      throw badRequest('This project type belongs to another division', [{ field: 'projectTypeId', message: 'not in the selected division' }]);
    }
  }
  if (body.startDate && body.endDate && body.endDate < body.startDate) {
    throw badRequest('End date cannot be before the start date', [{ field: 'endDate', message: 'must be on or after the start date' }]);
  }
}

/** Next free PRJ-#### code (serialised with an advisory lock). */
async function nextProjectCode(client) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('projects.code'))`);
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(substring(code FROM '^PRJ-(\\d+)$')::int), 1000) + 1 AS n FROM projects`,
  );
  return `PRJ-${rows[0].n}`;
}

function pickColumns(body) {
  const cols = [];
  const vals = [];
  for (const [field, col] of Object.entries(FIELDS)) {
    if (body[field] !== undefined) {
      cols.push(col);
      vals.push(typeof body[field] === 'string' ? body[field].trim() || null : body[field]);
    }
  }
  return { cols, vals };
}

/**
 * Creates a project and, from its project type:
 *   - copies the default effort % per task group into the project estimate
 * The owner is added as a project member with edit access.
 */
/**
 * Default estimated hours from the quote: total amount / the division's quote rate per hour in the
 * project's currency. Only fills the hours while they are empty – hours entered by hand are kept.
 */
async function applyQuotedHours(db, body, before = {}) {
  const hours = body.estimatedHours !== undefined ? body.estimatedHours : before.estimated_hours;
  if (hours != null) return body;
  const amount = body.estimatedAmount !== undefined ? body.estimatedAmount : before.estimated_amount;
  const currency = (body.estimatedAmountCurrency !== undefined ? body.estimatedAmountCurrency : before.estimated_amount_currency)?.trim();
  const divisionId = body.projectDivisionId ?? before.project_division_id;
  if (amount == null || !currency || !divisionId) return body;
  const { rows } = await db.query(`SELECT rate_per_hour FROM division_quote_rates WHERE project_division_id = $1 AND currency = $2`, [divisionId, currency]);
  if (!rows[0]) return body;
  return { ...body, estimatedHours: exact(amount / rows[0].rate_per_hour) };
}

export async function createProject(db, auth, input) {
  input = applyCreateRules(auth, input);
  await validateReferences(db, input);
  const body = await applyQuotedHours(db, input);
  const id = await db.tx(async (client) => {
    const code = await nextProjectCode(client);
    const stage = await resolveStage(client, body.stageId);
    const { cols, vals } = pickColumns({ ...body, stageId: stage.id });
    cols.push('stage', 'status', 'code', 'created_by', 'updated_by');
    vals.push(stage.name, stage.status, code, auth.userId, auth.userId);
    const { rows } = await client.query(
      `INSERT INTO projects (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      vals,
    );
    const projectId = rows[0].id;

    await client.query(
      `INSERT INTO project_effort_estimates (project_id, task_group_id, effort_percentage, created_by, updated_by)
       SELECT $1, task_group_id, effort_percentage, $3, $3
         FROM project_type_effort_defaults WHERE project_type_id = $2`,
      [projectId, body.projectTypeId, auth.userId],
    );
    await client.query(
      `INSERT INTO project_members (project_id, user_id, access_level, created_by, updated_by) VALUES ($1, $2, 'edit', $3, $3)`,
      [projectId, body.ownerId, auth.userId],
    );
    await writeAudit(client, {
      entity: 'projects',
      entityId: projectId,
      action: 'create',
      userId: auth.userId,
      message: `Project ${code} created`,
    });
    return projectId;
  });
  return getProject(db, auth, id);
}

export async function updateProject(db, auth, id, input) {
  // members / estimates (Users and Estimate tabs) are saved in the same transaction as the fields
  const { members, estimates, confirmRemove, ...body } = input;
  await getProject(db, auth, id); // existence + data scope
  const { rows } = await db.query(`SELECT * FROM projects WHERE id = $1`, [id]);
  const before = rows[0];
  assertProjectEdits(auth, before, body, members, estimates);
  await validateReferences(db, {
    ...body,
    // check the type against the division even when only one of them changes
    ...(body.projectTypeId !== undefined || body.projectDivisionId !== undefined
      ? { projectTypeId: body.projectTypeId ?? before.project_type_id, projectDivisionId: body.projectDivisionId ?? before.project_division_id }
      : {}),
    startDate: body.startDate ?? before.start_date,
    endDate: body.endDate === undefined ? before.end_date : body.endDate,
  });

  const { cols, vals } = pickColumns(await applyQuotedHours(db, body, before));
  if (body.stageId !== undefined) {
    const stage = await resolveStage(db, body.stageId);
    cols.push('stage', 'status');
    vals.push(stage.name, stage.status);
  }
  cols.push('updated_by');
  vals.push(auth.userId);
  await db.tx(async (client) => {
    const { rows: after } = await client.query(
      `UPDATE projects SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
      [id, ...vals],
    );
    if (body.ownerId && body.ownerId !== before.owner_id) {
      await client.query(
        `INSERT INTO project_members (project_id, user_id, access_level, created_by, updated_by)
         SELECT $1, $2, 'edit', $3, $3
          WHERE NOT EXISTS (SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2)`,
        [id, body.ownerId, auth.userId],
      );
    }
    const changes = diff(before, after[0], AUDIT_KEYS) ?? {};
    if (members) {
      const c = await saveMembers(client, auth, after[0], members);
      if (c) changes.members = c;
    }
    if (estimates) {
      const c = await saveEstimates(client, auth, id, estimates, confirmRemove === true);
      if (c) changes.estimate = c;
    }
    await writeAudit(client, {
      entity: 'projects',
      entityId: id,
      action: changes.stage && Object.keys(changes).every((k) => k === 'stage' || k === 'status') ? 'status_change' : 'update',
      userId: auth.userId,
      changes: Object.keys(changes).length ? changes : null,
    });
  });
  return getProject(db, auth, id);
}

/** Commercial tab: outsource / purchase / other values and the members' cost per hour. */
export async function updateCommercial(db, auth, id, body) {
  needTab(auth, 'commercial', 'edit', 'the commercial values');
  const project = await getProject(db, auth, id); // existence + data scope
  if (!project.canSeeCommercial) throw forbidden('Your role cannot change the commercial values');
  const { rows } = await db.query(`SELECT * FROM projects WHERE id = $1`, [id]);
  const before = rows[0];
  // the Commercial tab works in the project's currency: values and member rates are saved in it
  const cur = project.commercial.projectCurrency;
  const usd = new Map(project.commercial.members.map((m) => [m.id, m.costPerHour]));
  const memberIds = new Set(project.members.map((m) => m.id));
  const unknown = (body.members ?? []).find((m) => !memberIds.has(m.userId));
  if (unknown) throw badRequest('A rate is given for someone who is not a member of the project', [{ field: 'members', message: 'not a member' }]);

  await db.tx(async (client) => {
    const { rows: after } = await client.query(
      `UPDATE projects SET outsource_value = $2, purchase_value = $3, other_value = $4, updated_by = $5 WHERE id = $1 RETURNING *`,
      [id, body.outsourceValue ?? null, body.purchaseValue ?? null, body.otherValue ?? null, auth.userId],
    );
    const changes = diff(before, after[0], ['outsource_value', 'purchase_value', 'other_value']) ?? {};
    for (const m of body.members ?? []) {
      const old = project.members.find((x) => x.id === m.userId);
      if ((usd.get(m.userId) ?? null) === (m.costPerHour ?? null)) continue;
      await client.query(`UPDATE project_members SET cost_per_hour = $3, currency = $4, updated_by = $5 WHERE project_id = $1 AND user_id = $2`, [
        id,
        m.userId,
        m.costPerHour ?? null,
        m.costPerHour != null ? cur : null,
        auth.userId,
      ]);
      changes[`rate (${cur}): ${old.name}`] = { old: usd.get(m.userId) ?? null, new: m.costPerHour ?? null };
    }
    await writeAudit(client, {
      entity: 'projects',
      entityId: id,
      action: 'update',
      userId: auth.userId,
      message: 'Commercial values saved',
      changes: Object.keys(changes).length ? changes : null,
    });
  });
  return getProject(db, auth, id);
}

/**
 * Tasks tab: the project's tasks with the skills they need and the project members who have one of
 * those skills (Users → Skills).
 */
export async function projectTasks(db, auth, id) {
  needTab(auth, 'tasks', 'view', 'the project tasks');
  await getProject(db, auth, id); // existence + data scope
  const [tasks, members] = await Promise.all([
    db.query(
      `SELECT t.id, t.name, t.description, t.status, g.name AS group_name, tt.name AS type_name,
              t.owner_id, o.name AS owner_name, h.user_id AS assigned_to, a.name AS assigned_to_name,
              t.planned_start, t.planned_end, t.completed_on,
              (t.status <> 'completed' AND t.planned_end < now()) AS is_overdue,
              COALESCE((SELECT json_agg(json_build_object('id', l.id, 'name', l.name) ORDER BY l.display_order, l.name)
                          FROM task_skills ts JOIN parameter_values l ON l.id = ts.skill_id WHERE ts.task_id = t.id), '[]') AS skills
         FROM tasks t
         LEFT JOIN task_groups g ON g.id = t.task_group_id
         LEFT JOIN task_types tt ON tt.id = t.task_type_id
         LEFT JOIN users o ON o.id = t.owner_id
         LEFT JOIN task_holders h ON h.task_id = t.id
         LEFT JOIN users a ON a.id = h.user_id
        WHERE t.project_id = $1 AND t.is_active
        -- open work first, then the soonest end date
        ORDER BY (t.status = 'completed'),
                 t.planned_end NULLS LAST, t.display_order, t.id`,
      [id],
    ),
    db.query(
      `SELECT u.id, u.name, r.name AS role_name, COALESCE(array_agg(us.skill_id) FILTER (WHERE us.skill_id IS NOT NULL), '{}') AS skill_ids
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN user_skills us ON us.user_id = u.id
        WHERE pm.project_id = $1
        GROUP BY u.id, u.name, r.name
        ORDER BY u.name`,
      [id],
    ),
  ]);
  return tasks.rows.map((t) => {
    const need = new Set(t.skills.map((x) => x.id));
    const matches = members.rows
      .map((m) => ({ id: m.id, name: m.name, roleName: m.role_name, skills: t.skills.filter((x) => m.skill_ids.map(Number).includes(x.id)).map((x) => x.name) }))
      .filter((m) => need.size && m.skills.length);
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      status: t.status,
      taskGroupName: t.group_name,
      taskTypeName: t.type_name,
      ownerId: t.owner_id,
      ownerName: t.owner_name,
      assignedTo: t.assigned_to,
      assignedToName: t.assigned_to_name,
      plannedStart: t.planned_start,
      plannedEnd: t.planned_end,
      completedOn: t.completed_on,
      isOverdue: t.is_overdue,
      skills: t.skills,
      matches,
    };
  });
}

/** Users tab: can this member be removed? (asked when the remove button is clicked) */
export async function memberRemovable(db, auth, id, userId) {
  needTab(auth, 'users', 'edit', 'the project members');
  const project = await getProject(db, auth, id); // existence + data scope
  if (project.ownerId === userId) return { userId, canRemove: false, reason: 'The project owner cannot be removed – change the owner on the Project tab' };
  const [usage] = await memberUsage(db, id, [userId]);
  return usage ?? { userId, canRemove: true, reason: null };
}

export async function projectReviews(db, auth, id) {
  // the Update tab and the History → Comments list both read them
  if (tabAccess(auth, 'update') === 'hidden' && tabAccess(auth, 'history') === 'hidden') needTab(auth, 'update', 'view', 'the project updates');
  await getProject(db, auth, id); // existence + data scope
  return listReviews(db, id);
}

/**
 * Update tab: adds a progress entry (stage, review date, % completed per task group) and/or a comment.
 * Either can be sent on its own; a new stage is applied to the project as well.
 */
export async function addReview(db, auth, id, input) {
  needTab(auth, 'update', 'edit', 'the project progress, stage or comments');
  const body = { ...input, comment: input.comment?.trim() ?? '', reviewDate: input.reviewDate ?? new Date().toISOString().slice(0, 10) };
  if (!body.comment && !body.completion?.length && !body.stageId) {
    throw badRequest('Add a comment or the % completed', [{ field: 'comment', message: 'is required without progress' }]);
  }
  const project = await getProject(db, auth, id);
  const stage = body.stageId && body.stageId !== project.stageId ? await resolveStage(db, body.stageId) : null;
  if (!stage && !body.comment && !body.completion?.length) throw badRequest('Nothing has changed – update the stage, a % or write a comment');
  await db.tx(async (client) => {
    let changes = null;
    if (stage) {
      await client.query(`UPDATE projects SET stage_id = $2, stage = $3, status = $4, updated_by = $5 WHERE id = $1`, [
        id,
        stage.id,
        stage.name,
        stage.status,
        auth.userId,
      ]);
      changes = { stage: { old: project.stageName, new: stage.name } };
      if (stage.status !== project.status) changes.status = { old: project.status, new: stage.status };
    }
    // a stage change is logged by the system; progress and / or a comment make the user's entry
    if (stage) await insertSystemLog(client, auth, id, stage.name, body.reviewDate, `Stage changed from ${project.stageName ?? 'no stage'} to ${stage.name}`);
    if (body.comment || body.completion?.length) await insertReview(client, auth, id, stage?.name ?? project.stageName, body);
    const message = body.comment || (body.completion?.length ? 'Progress updated' : null);
    await writeAudit(client, { entity: 'projects', entityId: id, action: 'update', userId: auth.userId, message, changes });
  });
  return listReviews(db, id);
}

/** Deletes a project with its tasks; refused once time has been logged against it. */
export async function deleteProject(db, auth, id) {
  const project = await getProject(db, auth, id);
  try {
    await db.tx(async (client) => {
      await client.query(`DELETE FROM tasks WHERE project_id = $1`, [id]);
      await client.query(`DELETE FROM projects WHERE id = $1`, [id]);
      await writeAudit(client, { entity: 'projects', entityId: id, action: 'delete', userId: auth.userId, message: `Project ${project.code} deleted` });
    });
  } catch (err) {
    if (isReferenceError(err)) {
      throw conflict('This project has timesheets, plans or other linked records. Set its stage to Cancelled instead.');
    }
    throw err;
  }
}
