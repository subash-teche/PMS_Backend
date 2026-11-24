import { writeAudit, diff } from '../../utils/audit.js';
import { hashPassword } from '../../utils/crypto.js';
import { badRequest, conflict, forbidden, isReferenceError, notFound } from '../../utils/errors.js';
import { escapeLike, idList, WhereBuilder } from '../../utils/query.js';
import { assertCanManageLevel } from '../roles/roles.service.js';

const SORT_COLUMNS = { name: 'u.name', empCode: 'u.employee_code', username: 'u.username', lastLoginAt: 'u.last_login_at' };

// API field -> column, for the editable fields of the user form.
const FIELDS = {
  name: 'name',
  empCode: 'employee_code',
  email: 'email',
  dob: 'dob',
  username: 'username',
  roleId: 'role_id',
  userTypeId: 'user_type_id',
  isActive: 'is_active',
  reportsTo: 'manager_id',
  siteId: 'site_id',
  siteShiftId: 'site_shift_id',
  resourceGradeId: 'resource_grade_id',
  timeZone: 'time_zone',
  isOnLeave: 'is_on_leave',
  customerId: 'customer_id',
};

const SELECT = `
  SELECT u.*, r.name AS role_name, r.level AS role_level, r.code AS role_code,
         COALESCE((SELECT json_agg(json_build_object('id', l.id, 'name', l.name) ORDER BY l.display_order, l.name)
                     FROM user_skills us JOIN parameter_values l ON l.id = us.skill_id WHERE us.user_id = u.id), '[]') AS skills,
         rt.name AS manager_name,
         s.name AS site_name,
         ss.name || ' (' || to_char(ss.start_time, 'HH24:MI') || ' - ' || to_char(ss.end_time, 'HH24:MI') || ')' AS site_shift, ut.name AS user_type_name, c.name AS customer_name
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN users rt ON rt.id = u.manager_id
    LEFT JOIN sites s ON s.id = u.site_id
    LEFT JOIN site_shifts ss ON ss.id = u.site_shift_id
    LEFT JOIN parameter_values ut ON ut.id = u.user_type_id
    LEFT JOIN customers c ON c.id = u.customer_id`;

const toDto = (u) => ({
  id: u.id,
  empCode: u.employee_code,
  username: u.username,
  name: u.name,
  email: u.email,
  dob: u.dob,
  roleId: u.role_id,
  roleName: u.role_name,
  roleLevel: u.role_level,
  roleCode: u.role_code,
  skills: u.skills ?? [],
  userTypeId: u.user_type_id,
  userTypeName: u.user_type_name,
  reportsTo: u.manager_id,
  reportsToName: u.manager_name,
  siteId: u.site_id,
  siteName: u.site_name,
  siteShiftId: u.site_shift_id,
  siteShift: u.site_shift ?? null,
  resourceGradeId: u.resource_grade_id,
  timeZone: u.time_zone,
  customerId: u.customer_id,
  customerName: u.customer_name,
  isActive: u.is_active,
  isOnLeave: u.is_on_leave,
  isLocked: u.failed_login_attempts > 0 && u.failed_login_attempts >= (u.max_failed ?? Infinity),
  failedLoginAttempts: u.failed_login_attempts,
  lastLoginAt: u.last_login_at,
  createdAt: u.created_at,
  updatedAt: u.updated_at,
});

export async function listUsers(db, q, maxFailedLogins) {
  const where = new WhereBuilder();
  if (q.search) {
    const s = `%${escapeLike(q.search)}%`;
    where.add(`(u.name ILIKE $? OR u.username ILIKE $? OR u.email ILIKE $? OR u.employee_code ILIKE $?)`, s, s, s, s);
  }
  const roleIds = idList(q.roleId);
  if (roleIds.length) where.add(`u.role_id = ANY($?)`, roleIds);
  const siteIds = idList(q.siteId);
  if (siteIds.length) where.add(`u.site_id = ANY($?)`, siteIds);
  const reportsTo = idList(q.reportsTo);
  if (reportsTo.length) where.add(`u.manager_id = ANY($?)`, reportsTo);
  const userTypes = idList(q.userTypeId);
  if (userTypes.length) where.add(`u.user_type_id = ANY($?)`, userTypes);
  if (q.isActive !== undefined) where.add(`u.is_active = $?`, q.isActive);
  if (q.isOnLeave !== undefined) where.add(`u.is_on_leave = $?`, q.isOnLeave);

  const sort = SORT_COLUMNS[q.sortBy] || 'u.name';
  const max = where.param(maxFailedLogins);
  const limit = where.param(q.pageSize);
  const offset = where.param((q.page - 1) * q.pageSize);
  const { rows } = await db.query(
    `SELECT x.*, ${max}::int AS max_failed, count(*) OVER()::int AS total FROM (${SELECT} ${where.toSql()}) x
      ORDER BY ${sort.replace('u.', 'x.')} ${q.sortDir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, x.id
      LIMIT ${limit} OFFSET ${offset}`,
    where.params,
  );
  return { items: rows.map(toDto), total: rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize };
}

/** Users list summary cards: total + trend, active share, on leave, external logins. */
export async function userSummary(db) {
  const [counts, trend, leave] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE u.created_at >= date_trunc('month', now()))::int AS created_this_month,
              count(*) FILTER (WHERE r.role_type = 'internal')::int AS internal,
              count(*) FILTER (WHERE r.role_type = 'external')::int AS external,
              count(*) FILTER (WHERE u.is_active)::int AS active,
              count(*) FILTER (WHERE u.customer_id IS NOT NULL OR r.data_scope = 'customer')::int AS customer_logins
         FROM users u JOIN roles r ON r.id = u.role_id`,
    ),
    db.query(
      `SELECT count(u.id)::int AS n
         FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') AS m(month)
         LEFT JOIN users u ON u.created_at < m.month + interval '1 month'
        GROUP BY m.month ORDER BY m.month`,
    ),
    db.query(`SELECT id, name, count(*) OVER()::int AS total FROM users WHERE is_on_leave AND is_active ORDER BY name LIMIT 4`),
  ]);
  const r = counts.rows[0];
  return {
    total: r.total,
    createdThisMonth: r.created_this_month,
    internal: r.internal,
    external: r.external,
    active: r.active,
    inactive: r.total - r.active,
    totalByMonth: trend.rows.map((m) => m.n),
    onLeave: { total: leave.rows[0]?.total ?? 0, people: leave.rows.map((u) => ({ id: u.id, name: u.name })) },
    externalLogins: { customer: r.customer_logins },
  };
}

export async function getUser(db, id, maxFailedLogins) {
  const { rows } = await db.query(`SELECT x.*, $2::int AS max_failed FROM (${SELECT} WHERE u.id = $1) x`, [id, maxFailedLogins]);
  if (!rows[0]) throw notFound('User');
  return toDto(rows[0]);
}

async function getRoleLevel(db, roleId) {
  const { rows } = await db.query(`SELECT level, is_active FROM roles WHERE id = $1`, [roleId]);
  if (!rows[0]) throw badRequest('Selected role does not exist', [{ field: 'roleId', message: 'does not exist' }]);
  if (!rows[0].is_active) throw badRequest('Selected role is inactive', [{ field: 'roleId', message: 'is inactive' }]);
  return rows[0].level;
}

/**
 * Next employee code: a number of at least three digits - 001 for the first employee, then the highest number + 1 (999 is
 * followed by 1000). Codes that are not plain numbers (EMQ099, or an old EMP-####) are ignored. Serialised with an advisory lock so two
 * inserts cannot collide.
 */
export async function nextEmpCode(client) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('users.employee_code'))`);
  const { rows } = await client.query(`SELECT COALESCE(MAX(employee_code::int), 0) + 1 AS n FROM users WHERE employee_code ~ '^[0-9]{1,9}$'`);
  return String(rows[0].n).padStart(3, '0');
}

/** The shift must be one of the user's site's shifts (no site → no shift). */
async function checkShift(db, siteId, shiftId) {
  if (shiftId == null) return;
  if (siteId == null) throw badRequest('Select the site before the shift', [{ field: 'siteShiftId', message: 'no site selected' }]);
  const { rowCount } = await db.query(`SELECT 1 FROM site_shifts WHERE id = $1 AND site_id = $2`, [shiftId, siteId]);
  if (!rowCount) throw badRequest('The selected shift is not a shift of the selected site', [{ field: 'siteShiftId', message: 'not in this site' }]);
}

/** Roles whose users have skills (Parameters → SKILL). */
export const SKILL_ROLES = ['EMPLOYEE', 'PROJECT_MANAGER'];

/**
 * Saves the user's skills: only for the Employee / Project Manager roles – any other role clears them.
 * Without skillIds the skills are left alone (unless the new role has none).
 */
async function saveSkills(client, userId, roleId, skillIds) {
  const { rows } = await client.query(`SELECT code FROM roles WHERE id = $1`, [roleId]);
  if (!SKILL_ROLES.includes(rows[0]?.code)) {
    await client.query(`DELETE FROM user_skills WHERE user_id = $1`, [userId]);
    return;
  }
  if (!Array.isArray(skillIds)) return;
  const ids = [...new Set(skillIds)];
  if (ids.length) {
    const { rows: found } = await client.query(`SELECT id FROM parameter_values WHERE id = ANY($1) AND type = 'SKILL'`, [ids]);
    if (found.length !== ids.length) throw badRequest('A selected skill does not exist (Parameters → SKILL)', [{ field: 'skillIds', message: 'unknown skill' }]);
  }
  await client.query(`DELETE FROM user_skills WHERE user_id = $1`, [userId]);
  if (ids.length) await client.query(`INSERT INTO user_skills (user_id, skill_id) SELECT $1, unnest($2::bigint[])`, [userId, ids]);
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

export async function createUser(db, auth, body, maxFailedLogins) {
  assertCanManageLevel(auth, await getRoleLevel(db, body.roleId));
  await checkShift(db, body.siteId ?? null, body.siteShiftId ?? null);
  const passwordHash = await hashPassword(body.password);

  const id = await db.tx(async (client) => {
    const data = { ...body };
    delete data.password;
    delete data.skillIds;
    if (!data.empCode?.trim()) data.empCode = await nextEmpCode(client);
    const { cols, vals } = pickColumns(data);
    cols.push('password_hash', 'created_by', 'updated_by');
    vals.push(passwordHash, auth.userId, auth.userId);
    const { rows } = await client.query(
      `INSERT INTO users (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, username`,
      vals,
    );
    await saveSkills(client, rows[0].id, body.roleId, body.skillIds);
    await writeAudit(client, { entity: 'users', entityId: rows[0].id, action: 'create', userId: auth.userId, message: `User ${rows[0].username} created` });
    return rows[0].id;
  });
  return getUser(db, id, maxFailedLogins);
}

export async function updateUser(db, auth, id, body, maxFailedLogins) {
  const { rows } = await db.query(`SELECT u.*, r.level AS role_level FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [id]);
  const before = rows[0];
  if (!before) throw notFound('User');

  const isSelf = before.id === auth.userId;
  if (!isSelf) assertCanManageLevel(auth, before.role_level);
  if (body.roleId !== undefined && body.roleId !== before.role_id) {
    if (isSelf) throw forbidden('You cannot change your own role');
    assertCanManageLevel(auth, await getRoleLevel(db, body.roleId));
  }
  if (isSelf && body.isActive === false) throw forbidden('You cannot deactivate your own account');
  if (body.reportsTo === id) throw badRequest('A user cannot report to themselves');

  const data = { ...body };
  delete data.password;
  delete data.skillIds;
  const siteId = data.siteId !== undefined ? data.siteId : before.site_id;
  // moving to another site without picking a shift drops the old site's shift
  if (data.siteShiftId === undefined && siteId !== before.site_id) data.siteShiftId = null;
  await checkShift(db, siteId, data.siteShiftId !== undefined ? data.siteShiftId : before.site_shift_id);
  if (data.empCode !== undefined && !data.empCode?.trim()) delete data.empCode; // keep the existing code
  const { cols, vals } = pickColumns(data);

  await db.tx(async (client) => {
    if (body.password) {
      // Password reset by an admin also unlocks the account and signs the user out everywhere.
      cols.push('password_hash', 'failed_login_attempts');
      vals.push(await hashPassword(body.password), 0);
      await client.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
    }
    cols.push('updated_by');
    vals.push(auth.userId);
    const { rows: after } = await client.query(
      `UPDATE users SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
      [id, ...vals],
    );
    if (body.isActive === false) {
      await client.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
    }
    await saveSkills(client, id, after[0].role_id, body.skillIds);
    await writeAudit(client, {
      entity: 'users',
      entityId: id,
      action: 'update',
      userId: auth.userId,
      message: body.password ? 'Password reset' : null,
      changes: diff(before, after[0], Object.values(FIELDS)),
    });
  });
  return getUser(db, id, maxFailedLogins);
}

export async function unlockUser(db, auth, id) {
  const { rows } = await db.query(`SELECT r.level FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [id]);
  if (!rows[0]) throw notFound('User');
  assertCanManageLevel(auth, rows[0].level);
  await db.query(`UPDATE users SET failed_login_attempts = 0, updated_by = $2 WHERE id = $1`, [id, auth.userId]);
  await writeAudit(db, { entity: 'users', entityId: id, action: 'update', userId: auth.userId, message: 'Account unlocked' });
}

export async function deleteUser(db, auth, id) {
  if (id === auth.userId) throw forbidden('You cannot delete your own account');
  const { rows } = await db.query(`SELECT u.username, r.level FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [id]);
  if (!rows[0]) throw notFound('User');
  assertCanManageLevel(auth, rows[0].level);
  try {
    await db.tx(async (client) => {
      await client.query(`DELETE FROM users WHERE id = $1`, [id]);
      await writeAudit(client, { entity: 'users', entityId: id, action: 'delete', userId: auth.userId, message: `User ${rows[0].username} deleted` });
    });
  } catch (err) {
    if (isReferenceError(err)) throw conflict('This user is linked to projects or other records. Deactivate the user instead.');
    throw err;
  }
}
