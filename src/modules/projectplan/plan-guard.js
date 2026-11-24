import { AppError, badRequest } from '../../utils/errors.js';

/**
 * A task group where work has started – time logged in the timesheet, or tasks in progress / completed – keeps its
 * share of the estimate: it cannot be set to 0%. `db` is a pool or a transaction client.
 */
export async function assertGroupsHaveNoWork(db, projectId, groupIds) {
  if (!groupIds.length) return;
  const { rows } = await db.query(
    `SELECT g.name,
            (SELECT count(*)::int FROM timesheets t JOIN tasks k0 ON k0.id = t.task_id JOIN task_types tt ON tt.id = k0.task_type_id WHERE k0.project_id = $1 AND tt.task_group_id = g.id) AS entries,
            (SELECT count(*)::int FROM tasks k WHERE k.project_id = $1 AND k.task_group_id = g.id AND k.is_active AND k.status IN ('in_progress', 'completed')) AS started
       FROM task_groups g WHERE g.id = ANY($2) ORDER BY g.name`,
    [projectId, groupIds],
  );
  const busy = rows.filter((r) => r.entries > 0 || r.started > 0);
  if (!busy.length) return;
  const what = busy.map((r) => `${r.name} (${workLabel(r)})`).join(', ');
  throw badRequest(`Work has already started in ${what} – its effort cannot be set to 0%.`, [{ field: 'estimates', message: 'work has started in this task group' }]);
}

/** "3 timesheet entries, 2 tasks in progress or completed" for a { entries, started } row. */
export const workLabel = (r) =>
  [r.entries > 0 && `${r.entries} timesheet entr${r.entries === 1 ? 'y' : 'ies'}`, r.started > 0 && `${r.started} task${r.started === 1 ? '' : 's'} in progress or completed`]
    .filter(Boolean)
    .join(', ');

/**
 * A task group that has tasks created from the plan cannot leave the plan / the estimate:
 *   - while one of those tasks is open: refused;
 *   - when they are all completed: asks for a confirmation first (confirmed = true to go on).
 * `db` is a pool or a transaction client.
 */
export async function assertGroupsRemovable(db, projectId, groupIds, confirmed, field) {
  if (!groupIds.length) return;
  const { rows } = await db.query(
    `SELECT g.name,
            count(*) FILTER (WHERE t.status <> 'completed')::int AS open,
            count(*) FILTER (WHERE t.status = 'completed')::int AS done
       FROM tasks t JOIN task_groups g ON g.id = t.task_group_id
      WHERE t.project_id = $1 AND t.task_group_id = ANY($2) AND t.from_plan AND t.is_active
      GROUP BY g.name ORDER BY g.name`,
    [projectId, groupIds],
  );
  const open = rows.filter((r) => r.open > 0);
  if (open.length) {
    const what = open.map((r) => `${r.name} (${r.open} open task${r.open === 1 ? '' : 's'})`).join(', ');
    throw badRequest(`A task group with tasks created from the plan cannot be removed while they are open: ${what}. Complete or delete those tasks first.`, [{ field, message: 'has open tasks' }]);
  }
  const done = rows.filter((r) => r.done > 0);
  if (done.length && !confirmed) {
    const names = done.map((r) => r.name).join(', ');
    throw new AppError(409, 'CONFIRM_REQUIRED', `Tasks were already done in ${names}. Do you still want to remove ${done.length === 1 ? 'it' : 'them'}?`, [{ field, message: 'confirm to remove' }]);
  }
}
