import { FLOW_ROLES } from '../../config/flow.js';
import { badRequest, notFound } from '../../utils/errors.js';

/*
 * The team's message feed. Everyone with access to Task Management can read every post; a post may be tagged with a flow
 * task and with people, and a tagged person has it as unread until they mark it read. A private (one-to-one) message
 * is only for its author and the people it tags.
 */

export async function feed(db, auth, q) {
  const me = auth.userId;
  const params = [me];
  const where = [`(NOT p.is_private OR p.author_id = $1 OR EXISTS (SELECT 1 FROM task_message_recipients m WHERE m.message_id = p.id AND m.user_id = $1))`];
  if (q.task) {
    params.push(q.task);
    where.push(`p.task_id = $${params.length}`);
  }
  if (q.mine) where.push(`EXISTS (SELECT 1 FROM task_message_recipients m WHERE m.message_id = p.id AND m.user_id = $1)`);
  if (q.with) {
    params.push(q.with);
    const n = params.length;
    // a conversation with someone: what I wrote that tags them, and what they wrote that tags me
    where.push(`((p.author_id = $1 AND EXISTS (SELECT 1 FROM task_message_recipients m WHERE m.message_id = p.id AND m.user_id = $${n}))
              OR (p.author_id = $${n} AND EXISTS (SELECT 1 FROM task_message_recipients m WHERE m.message_id = p.id AND m.user_id = $1)))`);
  }
  const { rows } = await db.query(
    `SELECT p.id, p.task_id, f.name AS task_title, p.author_id, u.name AS author_name, p.kind, p.body, p.is_private, p.created_at
       FROM task_messages p
       JOIN users u ON u.id = p.author_id
       LEFT JOIN tasks f ON f.id = p.task_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.created_at DESC, p.id DESC LIMIT 100`,
    params,
  );
  const [tags, unread] = await Promise.all([
    rows.length ? db.query(`SELECT message_id, user_id, read_at FROM task_message_recipients WHERE message_id = ANY($1)`, [rows.map((r) => r.id)]) : { rows: [] },
    db.query(`SELECT count(*)::int AS n FROM task_message_recipients WHERE user_id = $1 AND read_at IS NULL`, [me]),
  ]);
  return {
    unread: unread.rows[0].n,
    items: rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      taskTitle: r.task_title,
      authorId: r.author_id,
      authorName: r.author_name,
      kind: r.kind,
      body: r.body,
      isPrivate: r.is_private,
      createdAt: r.created_at,
      mentions: tags.rows.filter((t) => t.message_id === r.id).map((t) => ({ userId: t.user_id, readAt: t.read_at })),
    })),
  };
}

export async function createPost(db, auth, { body, taskId, mentionIds = [], private: isPrivate = false }) {
  const tagged = [...new Set(mentionIds)];
  if (isPrivate && !tagged.length) throw badRequest('A private message needs a person to send it to');
  if (taskId) {
    const { rows } = await db.query(`SELECT 1 FROM tasks WHERE id = $1`, [taskId]);
    if (!rows[0]) throw notFound('Task');
  }
  if (tagged.length) {
    const { rows } = await db.query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ANY($1) AND u.is_active AND r.is_active AND (r.level = 0 OR r.code = ANY($2))`,
      [tagged, FLOW_ROLES],
    );
    if (rows.length !== tagged.length) throw badRequest('One of the tagged people is unknown, inactive or has no access to Task Management');
  }
  return db.tx(async (c) => {
    const { rows } = await c.query(`INSERT INTO task_messages (task_id, author_id, kind, body, is_private) VALUES ($1, $2, 'note', $3, $4) RETURNING id`, [taskId ?? null, auth.userId, body.trim(), isPrivate]);
    for (const userId of tagged) await c.query(`INSERT INTO task_message_recipients (message_id, user_id) VALUES ($1, $2)`, [rows[0].id, userId]);
    return { id: rows[0].id };
  });
}

export const readAll = (db, auth) => db.query(`UPDATE task_message_recipients SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [auth.userId]);

export const readMany = (db, auth, ids) =>
  db.query(`UPDATE task_message_recipients SET read_at = now() WHERE message_id = ANY($1) AND user_id = $2 AND read_at IS NULL`, [ids, auth.userId]);
