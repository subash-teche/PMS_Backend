import { writeAudit } from '../../utils/audit.js';
import { badRequest, notFound } from '../../utils/errors.js';

/*
 * Task Master: per person, the employees whose tasks and timesheet entries they may see (view only).
 * Personal (private category) work of those employees shows as "Personal" without its details.
 */

/** SQL: `col` is a user the viewer (param `viewer`) was given in Task Master. */
export const GRANTED = (col, viewer) => `${col} IN (SELECT ta.user_id FROM task_viewer_access ta WHERE ta.viewer_id = ${viewer})`;

/** Every active user with the people they may see. */
export async function listAccess(db) {
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.username, r.name AS role_name,
            COALESCE(array_agg(ta.user_id ORDER BY ta.user_id) FILTER (WHERE ta.user_id IS NOT NULL), '{}') AS user_ids
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN task_viewer_access ta ON ta.viewer_id = u.id
      WHERE u.is_active
      GROUP BY u.id, r.name
      ORDER BY u.name`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, username: r.username, roleName: r.role_name, userIds: r.user_ids.map(Number) }));
}

/** Replaces the people `viewerId` may see. */
export async function saveAccess(db, auth, viewerId, userIds) {
  const { rows: viewer } = await db.query(`SELECT id, name FROM users WHERE id = $1`, [viewerId]);
  if (!viewer[0]) throw notFound('User');
  const ids = [...new Set(userIds)].filter((id) => id !== viewerId);
  if (ids.length) {
    const { rows } = await db.query(`SELECT id FROM users WHERE id = ANY($1)`, [ids]);
    if (rows.length !== ids.length) throw badRequest('Some of the selected people do not exist', [{ field: 'userIds', message: 'unknown user' }]);
  }
  await db.tx(async (client) => {
    await client.query(`DELETE FROM task_viewer_access WHERE viewer_id = $1 AND NOT (user_id = ANY($2))`, [viewerId, ids]);
    await client.query(
      `INSERT INTO task_viewer_access (viewer_id, user_id, created_by) SELECT $1, x, $3 FROM unnest($2::bigint[]) x
       ON CONFLICT (viewer_id, user_id) DO NOTHING`,
      [viewerId, ids, auth.userId],
    );
    await writeAudit(client, { entity: 'task_viewer_access', entityId: viewerId, action: 'update', userId: auth.userId, message: `${viewer[0].name} can see ${ids.length} people` });
  });
  return (await listAccess(db)).find((u) => u.id === viewerId);
}

/**
 * The people whose work the signed-in user can see (the Employee filter): themselves, everyone for the
 * Super Admin / All data scope, their team for Team scope, the people on projects they own, and Task Master grants.
 */
export async function visibleUsers(db, auth) {
  const everyone = auth.isSuperAdmin || auth.role.dataScope === 'all';
  const { rows } = await db.query(
    `SELECT u.id, u.name FROM users u
      WHERE u.is_active AND (
            $2::boolean
         OR u.id = $1
         OR ${GRANTED('u.id', '$1')}
         OR ($3::boolean AND u.id IN (SELECT other.user_id FROM user_teams mine JOIN user_teams other ON other.team_id = mine.team_id WHERE mine.user_id = $1))
         OR u.id IN (SELECT pm.user_id FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE p.owner_id = $1))
      ORDER BY (u.id = $1) DESC, u.name`,
    [auth.userId, everyone, auth.role.dataScope === 'team'],
  );
  return rows.map((r) => ({ id: r.id, name: r.name }));
}
