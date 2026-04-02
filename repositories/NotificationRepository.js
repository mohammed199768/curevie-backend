const BaseRepository = require('./BaseRepository');

class NotificationRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'notifications');
  }

  async createNotification({ userId, userRole, type, title, body, data }, db = null) {
    return this._queryOne(
      `INSERT INTO notifications (user_id, user_role, type, title, body, data)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, userRole, type, title, body, data ? JSON.stringify(data) : null],
      db
    );
  }

  async createMany(notifications, db = null) {
    if (!notifications.length) return;
    const executor = db || this.pool;

    const values = notifications.map((_, i) => {
      const base = i * 6;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    }).join(', ');

    const params = notifications.flatMap((n) => [
      n.userId,
      n.userRole,
      n.type,
      n.title,
      n.body,
      n.data ? JSON.stringify(n.data) : null,
    ]);

    await executor.query(
      `INSERT INTO notifications (user_id, user_role, type, title, body, data) VALUES ${values}`,
      params
    );
  }

  async getAllAdminIds(db = null) {
    const result = await this._query('SELECT id FROM admins', [], db);
    return result.rows.map((r) => r.id);
  }

  async getNotifications(userId, userRole, { limit, offset, unreadOnly = false } = {}, db = null) {
    const whereExtra = unreadOnly ? 'AND is_read = FALSE' : '';

    const [rows, count, unreadCount] = await Promise.all([
      this._query(
        `SELECT * FROM notifications
         WHERE user_id = $1 AND user_role = $2 ${whereExtra}
         ORDER BY created_at DESC
         LIMIT $3 OFFSET $4`,
        [userId, userRole, limit, offset], db
      ),
      this._query(
        `SELECT COUNT(*)::int AS total FROM notifications
         WHERE user_id = $1 AND user_role = $2 ${whereExtra}`,
        [userId, userRole], db
      ),
      this._query(
        'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE',
        [userId], db
      ),
    ]);

    return {
      data: rows.rows,
      total: count.rows[0].total,
      unread_count: unreadCount.rows[0].count,
    };
  }

  async markAsRead(notificationId, userId, db = null) {
    return this._queryOne(
      `UPDATE notifications SET is_read = TRUE, read_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [notificationId, userId], db
    );
  }

  async markAllAsRead(userId, userRole, db = null) {
    const result = await this._query(
      `UPDATE notifications SET is_read = TRUE, read_at = NOW()
       WHERE user_id = $1 AND user_role = $2 AND is_read = FALSE`,
      [userId, userRole], db
    );
    return result.rowCount;
  }

  async deleteNotification(notificationId, userId, db = null) {
    return this._queryOne(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id',
      [notificationId, userId], db
    );
  }
}

module.exports = NotificationRepository;
