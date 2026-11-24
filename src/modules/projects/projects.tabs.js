/*
 * Project details tabs that have their own child records:
 *   Users    – project_members (who is on the project; what they may do comes from their role)
 *   Estimate – project_effort_estimates (% of effort per task group)
 *   Update   – project_progress_updates + project_progress_update_groups (stage, comment, % completed per group)
 */
import { badRequest } from '../../utils/errors.js';
import { assertGroupsHaveNoWork, assertGroupsRemovable } from '../projectplan/plan-guard.js';
import { exact } from '../../utils/number.js';


const hrs = (minutes) => exact(Number(minutes) / 60);

/**
 * The cost per hour of the user's grade in the project's currency (the period covering today, else the
 * latest one). `u` / `p` are the users / projects aliases of the query.
 */
const GRADE_RATE = (u, p) => `(SELECT c.cost_per_hour FROM resource_grade_costs c
   WHERE c.resource_grade_id = ${u}.resource_grade_id AND trim(c.currency) = COALESCE(trim(${p}.estimated_amount_currency), 'INR')
   ORDER BY (c.from_date <= current_date AND (c.to_date IS NULL OR c.to_date >= current_date)) DESC, c.from_date DESC LIMIT 1)`;

/**
 * The grade's cost per hour in USD (Commercial tab): the period covering today – preferably in USD,
 * else in the project's currency, else any – converted with the currency's USD rate (Parameters → USD Rates).
 */
const GRADE_RATE_USD = (u, p) => `(SELECT c.cost_per_hour * r.usd_rate FROM resource_grade_costs c
   JOIN v_currency_usd_rates r ON r.code = trim(c.currency) AND r.usd_rate IS NOT NULL
   WHERE c.resource_grade_id = ${u}.resource_grade_id
   ORDER BY (c.from_date <= current_date AND (c.to_date IS NULL OR c.to_date >= current_date)) DESC,
            (trim(c.currency) = 'USD') DESC, (trim(c.currency) = COALESCE(trim(${p}.estimated_amount_currency), 'INR')) DESC, c.from_date DESC
   LIMIT 1)`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** Members with grade, team position, rate and the hours they logged on the project. */
export async function loadMembers(db, projectId, ownerId) {
  const { rows } = await db.query(
    `SELECT u.id, u.name, pm.access_level, pm.cost_per_hour, pm.currency,
            u.hourly_rate, u.hourly_rate_currency, g.name AS grade_name, ${GRADE_RATE('u', 'p')} AS grade_rate, ${GRADE_RATE_USD('u', 'p')} AS grade_rate_usd,
            trim(p.estimated_amount_currency) AS project_currency,
            (SELECT t.name FROM user_teams ut JOIN teams t ON t.id = ut.team_id WHERE ut.user_id = u.id ORDER BY ut.team_id LIMIT 1) AS team_name,
            (SELECT ut.position FROM user_teams ut WHERE ut.user_id = u.id AND ut.position IS NOT NULL ORDER BY ut.team_id LIMIT 1) AS position,
            COALESCE((SELECT SUM(t.minutes) FROM timesheets t JOIN tasks k ON k.id = t.task_id WHERE k.project_id = pm.project_id AND t.user_id = u.id), 0) AS logged_minutes
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
       JOIN users u ON u.id = pm.user_id
       LEFT JOIN resource_grades rg ON rg.id = u.resource_grade_id
       LEFT JOIN parameter_values g ON g.id = rg.grade_id
      WHERE pm.project_id = $1
      ORDER BY (u.id = $2) DESC, u.name`,
    [projectId, ownerId],
  );
  return rows.map((m) => ({
    id: m.id,
    name: m.name,
    costPerHour: num(m.cost_per_hour),
    currency: m.currency?.trim() ?? null,
    defaultRate: num(m.hourly_rate),
    defaultRateCurrency: m.hourly_rate_currency?.trim() ?? null,
    gradeRate: num(m.grade_rate), // grade's cost per hour in the project's currency
    gradeRateUsd: m.grade_rate_usd == null ? null : exact(Number(m.grade_rate_usd)),
    projectCurrency: m.project_currency || 'INR',
    gradeName: m.grade_name,
    teamName: m.team_name,
    position: m.position,
    loggedHours: hrs(m.logged_minutes),
    isOwner: m.id === ownerId,
  }));
}

/** An amount in USD, with the currency's USD rate (Parameters → USD Rates); USD stays as it is. */
const IN_USD = (amount, cur) => `(CASE WHEN upper(trim(${cur})) = 'USD' THEN ${amount}
  ELSE ${amount} * (SELECT r.usd_rate FROM v_currency_usd_rates r WHERE r.code = upper(trim(${cur})) LIMIT 1) END)`;

/** Member rate in USD (Analysis tab, same as the Commercial tab): the project rate, else the user's grade cost. */
const RATE_USD = (pm, u, p) =>
  `COALESCE(${IN_USD(`${pm}.cost_per_hour`, `COALESCE(${pm}.currency, ${p}.estimated_amount_currency, 'INR')`)},
            ${GRADE_RATE_USD(u, p)})`;

/** Hours and cost (in USD) of everyone who logged time on the project (Analysis tab). */
export async function loadMemberHours(db, projectId) {
  const { rows } = await db.query(
    `SELECT u.id, u.name, SUM(t.minutes)::int AS minutes, ${RATE_USD('pm', 'u', 'p')} AS rate
       FROM timesheets t
       JOIN tasks k ON k.id = t.task_id
       JOIN projects p ON p.id = k.project_id
       JOIN users u ON u.id = t.user_id
       LEFT JOIN project_members pm ON pm.project_id = k.project_id AND pm.user_id = t.user_id
      WHERE k.project_id = $1
      GROUP BY u.id, u.name, pm.cost_per_hour, pm.currency, u.resource_grade_id, p.estimated_amount_currency
      ORDER BY minutes DESC, u.name`,
    [projectId],
  );
  return rows.map((r) => {
    const hours = hrs(r.minutes);
    const rate = num(r.rate);
    // cost from the exact minutes, not the displayed hours
    return { id: r.id, name: r.name, hours, rate, cost: rate != null ? exact((Number(r.minutes) / 60) * rate) : null };
  });
}

/**
 * Why members cannot leave the project: time they logged on it or project tasks they own / are assigned.
 * Only for the given users – run when someone is removed, not on every load.
 */
export async function memberUsage(db, projectId, userIds) {
  if (!userIds.length) return [];
  const { rows } = await db.query(
    `SELECT u.id, u.name,
            (SELECT count(*)::int FROM timesheets t JOIN tasks k ON k.id = t.task_id WHERE k.project_id = $1 AND t.user_id = u.id) AS entries,
            (SELECT count(*)::int FROM tasks k WHERE k.project_id = $1 AND (EXISTS (SELECT 1 FROM task_members km WHERE km.task_id = k.id AND km.user_id = u.id) OR k.owner_id = u.id)) AS tasks
       FROM users u WHERE u.id = ANY($2)`,
    [projectId, userIds],
  );
  return rows.map((r) => {
    const why = [r.entries && `${r.entries} time entr${r.entries === 1 ? 'y' : 'ies'}`, r.tasks && `${r.tasks} task${r.tasks === 1 ? '' : 's'}`].filter(Boolean);
    return { userId: r.id, name: r.name, canRemove: !why.length, reason: why.length ? `${r.name} has ${why.join(' and ')} on this project and cannot be removed` : null };
  });
}

const memberLabel = (rows) => rows.map((m) => m.name).join(', ') || null;

/**
 * Replaces the project members. The owner always stays (with edit access);
 * people who logged time on the project cannot be removed.
 */
export async function saveMembers(client, auth, project, members) {
  const seen = new Set();
  for (const m of members) {
    if (seen.has(m.userId)) throw badRequest('A person is listed twice in the members', [{ field: 'members', message: 'duplicate user' }]);
    seen.add(m.userId);
  }
  // access_level is no longer used (roles decide) – every member is stored as 'edit'
  const list = members.map((m) => ({ ...m, accessLevel: 'edit' }));
  if (!seen.has(project.owner_id)) list.push({ userId: project.owner_id, accessLevel: 'edit' });

  const { rows: before } = await client.query(
    `SELECT pm.user_id, pm.access_level, pm.cost_per_hour, u.name
       FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = $1 ORDER BY u.name`,
    [project.id],
  );
  const keep = new Set(list.map((m) => m.userId));
  const removed = before.filter((m) => !keep.has(m.user_id));
  // checked only for the members being removed
  const blocked = (await memberUsage(client, project.id, removed.map((m) => m.user_id))).find((u) => !u.canRemove);
  if (blocked) throw badRequest(blocked.reason, [{ field: 'members', message: 'has time or tasks' }]);

  const existing = new Set(before.map((m) => m.user_id));
  const added = list.filter((m) => !existing.has(m.userId)).map((m) => m.userId);
  if (added.length) {
    const { rows } = await client.query(`SELECT id, name, is_active FROM users WHERE id = ANY($1)`, [added]);
    const missing = added.find((id) => !rows.some((r) => r.id === id));
    if (missing) throw badRequest('A selected member does not exist', [{ field: 'members', message: 'unknown user' }]);
    const inactive = rows.find((r) => !r.is_active);
    if (inactive) throw badRequest(`${inactive.name} is inactive`, [{ field: 'members', message: 'inactive user' }]);
  }

  if (removed.length) {
    await client.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = ANY($2)`, [project.id, removed.map((m) => m.user_id)]);
  }
  for (const m of list) {
    // the cost per hour is only changed when it is sent (the Users tab sends access levels only)
    const setCost = m.costPerHour !== undefined;
    await client.query(
      `INSERT INTO project_members (project_id, user_id, access_level, cost_per_hour, currency, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (project_id, user_id) DO UPDATE
          SET access_level = EXCLUDED.access_level,
              cost_per_hour = CASE WHEN $7::boolean THEN EXCLUDED.cost_per_hour ELSE project_members.cost_per_hour END,
              currency = CASE WHEN $7::boolean THEN EXCLUDED.currency ELSE project_members.currency END,
              updated_by = EXCLUDED.updated_by
        WHERE project_members.access_level IS DISTINCT FROM EXCLUDED.access_level
           OR ($7::boolean AND project_members.cost_per_hour IS DISTINCT FROM EXCLUDED.cost_per_hour)`,
      [project.id, m.userId, m.accessLevel, m.costPerHour ?? null, m.costPerHour != null ? project.estimated_amount_currency?.trim() || 'INR' : null, auth.userId, setCost],
    );
  }

  const { rows: after } = await client.query(
    `SELECT pm.user_id, pm.access_level, pm.cost_per_hour, u.name FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = $1 ORDER BY u.name`,
    [project.id],
  );
  const sig = (rows) => rows.map((m) => `${m.user_id}:${m.cost_per_hour ?? ''}`).join('|');
  return sig(before) === sig(after) ? null : { old: memberLabel(before), new: memberLabel(after) };
}

const estimateLabel = (rows) => rows.map((e) => `${e.name} ${Number(e.effort_percentage)}%`).join(', ') || null;

/** Replaces the effort split. Rows with 0% are dropped; the rest must total 100%. */
export async function saveEstimates(client, auth, projectId, estimates, confirmRemove = false) {
  const list = estimates.filter((e) => e.effortPercentage > 0);
  const ids = list.map((e) => e.taskGroupId);
  if (new Set(ids).size !== ids.length) throw badRequest('A task group is listed twice in the estimate', [{ field: 'estimates', message: 'duplicate task group' }]);
  const total = Math.round(list.reduce((s, e) => s + e.effortPercentage, 0) * 100) / 100;
  if (list.length && total !== 100) {
    throw badRequest(`The effort split must total 100% (now ${total}%)`, [{ field: 'estimates', message: 'must total 100%' }]);
  }
  if (ids.length) {
    const { rows } = await client.query(`SELECT id FROM task_groups WHERE id = ANY($1)`, [ids]);
    if (rows.length !== ids.length) throw badRequest('A task group in the estimate does not exist', [{ field: 'estimates', message: 'unknown task group' }]);
  }

  const read = () =>
    client.query(
      `SELECT e.task_group_id, e.effort_percentage, g.name FROM project_effort_estimates e JOIN task_groups g ON g.id = e.task_group_id
        WHERE e.project_id = $1 ORDER BY e.effort_percentage DESC, g.name`,
      [projectId],
    );
  const before = (await read()).rows;
  const removed = before.map((r) => Number(r.task_group_id)).filter((g) => !ids.includes(g));
  // a task group where work has started (time logged, tasks in progress / completed) cannot be set to 0%
  await assertGroupsHaveNoWork(client, projectId, removed);
  // a task group with tasks made from the plan cannot leave the estimate while they are open
  await assertGroupsRemovable(client, projectId, removed, confirmRemove, 'estimates');
  await client.query(`DELETE FROM project_effort_estimates WHERE project_id = $1 AND NOT (task_group_id = ANY($2))`, [projectId, ids]);
  // and it leaves the plan with it
  await client.query(`DELETE FROM project_plan_weeks WHERE project_id = $1 AND NOT (task_group_id = ANY($2))`, [projectId, ids]);
  for (const e of list) {
    await client.query(
      `INSERT INTO project_effort_estimates (project_id, task_group_id, effort_percentage, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (project_id, task_group_id) DO UPDATE SET effort_percentage = EXCLUDED.effort_percentage, updated_by = EXCLUDED.updated_by
        WHERE project_effort_estimates.effort_percentage IS DISTINCT FROM EXCLUDED.effort_percentage`,
      [projectId, e.taskGroupId, e.effortPercentage, auth.userId],
    );
  }
  const after = (await read()).rows;
  const a = estimateLabel(before);
  const b = estimateLabel(after);
  return a === b ? null : { old: a, new: b };
}

/** Reviews newest first, with % completed per task group and the effort-weighted overall. */
export async function listReviews(db, projectId) {
  const [reviews, groups, estimates] = await Promise.all([
    db.query(
      `SELECT r.id, r.stage, r.review_date, r.comment, r.is_system, r.created_at, u.name AS reviewer_name
         FROM project_progress_updates r LEFT JOIN users u ON u.id = r.created_by
        WHERE r.project_id = $1 ORDER BY r.review_date DESC, r.id DESC`,
      [projectId],
    ),
    db.query(
      `SELECT g.progress_update_id, g.task_group_id, g.completion_percentage
         FROM project_progress_update_groups g JOIN project_progress_updates r ON r.id = g.progress_update_id WHERE r.project_id = $1`,
      [projectId],
    ),
    db.query(`SELECT task_group_id, effort_percentage FROM project_effort_estimates WHERE project_id = $1`, [projectId]),
  ]);
  const effort = new Map(estimates.rows.map((e) => [e.task_group_id, Number(e.effort_percentage)]));
  return reviews.rows.map((r) => {
    const items = groups.rows
      .filter((g) => g.progress_update_id === r.id)
      .map((g) => ({ taskGroupId: g.task_group_id, completionPercentage: Number(g.completion_percentage) }));
    const overall = Math.round(items.reduce((s, g) => s + ((effort.get(g.taskGroupId) ?? 0) * g.completionPercentage) / 100, 0));
    return {
      id: r.id,
      stage: r.stage,
      reviewDate: r.review_date,
      comment: r.comment,
      isSystem: r.is_system,
      reviewerName: r.reviewer_name,
      createdAt: r.created_at,
      overall,
      groups: items,
    };
  });
}

/** A system log entry on the Update tab (e.g. "Stage changed from Draft to In Progress"). */
export async function insertSystemLog(client, auth, projectId, stageName, reviewDate, message) {
  await client.query(
    `INSERT INTO project_progress_updates (project_id, stage, review_date, comment, is_system, created_by, updated_by)
     VALUES ($1, $2, $3, $4, true, $5, $5)`,
    [projectId, stageName, reviewDate, message, auth.userId],
  );
}

/** Adds a review (progress and/or comment); only task groups of the project estimate are kept. */
export async function insertReview(client, auth, projectId, stageName, body) {
  const { rows: est } = await client.query(`SELECT task_group_id FROM project_effort_estimates WHERE project_id = $1`, [projectId]);
  const allowed = new Set(est.map((e) => e.task_group_id));
  const { rows } = await client.query(
    `INSERT INTO project_progress_updates (project_id, stage, review_date, comment, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
    [projectId, stageName, body.reviewDate, body.comment, auth.userId],
  );
  for (const g of body.completion ?? []) {
    if (!allowed.has(g.taskGroupId)) continue;
    await client.query(
      `INSERT INTO project_progress_update_groups (progress_update_id, task_group_id, completion_percentage) VALUES ($1, $2, $3)
       ON CONFLICT (progress_update_id, task_group_id) DO UPDATE SET completion_percentage = EXCLUDED.completion_percentage`,
      [rows[0].id, g.taskGroupId, g.completionPercentage],
    );
  }
  return rows[0].id;
}
