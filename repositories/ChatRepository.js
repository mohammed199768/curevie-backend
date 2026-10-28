const { toPublicMediaUrl } = require('../utils/storage');

// Chat rooms exist per case line item (case_services row) between the patient and the
// provider currently assigned to it. Guests have no account and therefore no chat.
const ROOM_SELECT = `
  SELECT
    cr.id, cr.case_service_id, cr.patient_id, cr.provider_id, cr.created_at,
    cs.case_id, cs.item_name AS service_name, cs.status AS service_status,
    cs.provider_id AS assigned_provider_id,
    c.status AS case_status,
    p.full_name AS patient_name,
    sp.full_name AS provider_name,
    sp.avatar_url AS provider_avatar_url
  FROM case_chat_rooms cr
  JOIN case_services cs ON cs.id = cr.case_service_id
  JOIN cases c ON c.id = cs.case_id
  LEFT JOIN patients p ON p.id = cr.patient_id
  LEFT JOIN service_providers sp ON sp.id = cr.provider_id
`;

const CLOSED_CASE_STATUSES = new Set(['CLOSED', 'CANCELLED']);

function withSendFlag(room) {
  if (!room) return null;
  return {
    ...room,
    provider_avatar_url: toPublicMediaUrl(room.provider_avatar_url),
    can_send: !CLOSED_CASE_STATUSES.has(room.case_status) && room.service_status !== 'CANCELLED',
  };
}

/** Returns true when the user may read this room. */
function canAccessRoom(room, user) {
  if (!room || !user) return false;
  if (user.role === 'ADMIN') return true;
  if (user.role === 'PATIENT') return room.patient_id === user.id;
  if (user.role === 'PROVIDER') {
    return room.provider_id === user.id && room.assigned_provider_id === user.id;
  }
  return false;
}

class ChatRepository {
  constructor(pool) {
    this.pool = pool;
  }

  _db(client) {
    return client || this.pool;
  }

  /** Creates the room for a line item, or moves it to the newly assigned provider. */
  async upsertRoom({ caseServiceId, patientId, providerId }, client = null) {
    const result = await this._db(client).query(
      `INSERT INTO case_chat_rooms (case_service_id, patient_id, provider_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (case_service_id) DO UPDATE SET provider_id = EXCLUDED.provider_id
       RETURNING *`,
      [caseServiceId, patientId, providerId]
    );
    return result.rows[0] || null;
  }

  async findRoomById(roomId, client = null) {
    const result = await this._db(client).query(`${ROOM_SELECT} WHERE cr.id = $1`, [roomId]);
    return withSendFlag(result.rows[0]);
  }

  /** Returns the room when the user may access it, otherwise null. */
  async findAccessibleRoom(roomId, user, client = null) {
    if (!roomId || !/^[0-9a-f-]{36}$/i.test(String(roomId))) return null;
    const room = await this.findRoomById(roomId, client);
    return canAccessRoom(room, user) ? room : null;
  }

  /**
   * Lists the rooms visible to the user, with last message and unread count, in one query.
   * @param {{ caseId?: string }} filters
   */
  async listRoomsForUser(user, { caseId = null } = {}) {
    const params = [];
    const where = [];

    if (caseId) {
      params.push(caseId);
      where.push(`cs.case_id = $${params.length}`);
    }
    if (user.role === 'PATIENT') {
      params.push(user.id);
      where.push(`cr.patient_id = $${params.length}`);
    } else if (user.role === 'PROVIDER') {
      params.push(user.id);
      where.push(`cr.provider_id = $${params.length} AND cs.provider_id = $${params.length}`);
    }

    params.push(user.role === 'ADMIN' ? null : user.id);
    const readerParam = `$${params.length}`;

    const result = await this.pool.query(
      `
      WITH rooms AS (
        ${ROOM_SELECT}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      )
      SELECT
        rooms.*,
        last_msg.content AS last_message_preview,
        last_msg.file_name AS last_message_file_name,
        last_msg.sender_role AS last_message_sender_role,
        last_msg.created_at AS last_message_at,
        COALESCE(unread.count, 0)::int AS unread_count
      FROM rooms
      LEFT JOIN LATERAL (
        SELECT m.content, m.file_name, m.sender_role, m.created_at
        FROM case_chat_messages m
        WHERE m.room_id = rooms.id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) last_msg ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS count
        FROM case_chat_messages m
        WHERE m.room_id = rooms.id
          AND m.is_read = FALSE
          AND ${readerParam}::uuid IS NOT NULL
          AND m.sender_id <> ${readerParam}::uuid
      ) unread ON TRUE
      ORDER BY COALESCE(last_msg.created_at, rooms.created_at) DESC
      `,
      params
    );

    return result.rows.map(withSendFlag);
  }

  async saveMessage(data, client = null) {
    const result = await this._db(client).query(
      `INSERT INTO case_chat_messages (room_id, sender_id, sender_role, content, file_url, file_name, file_mime)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, room_id, sender_id, sender_role, content, file_name, file_mime,
                 (file_url IS NOT NULL) AS has_file, is_read, created_at`,
      [
        data.room_id,
        data.sender_id,
        data.sender_role,
        data.content || null,
        data.file_url || null,
        data.file_name || null,
        data.file_mime || null,
      ]
    );
    return result.rows[0] || null;
  }

  async getMessages(roomId, { limit = 50, before = null } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const result = await this.pool.query(
      `SELECT id, room_id, sender_id, sender_role, content, file_name, file_mime,
              (file_url IS NOT NULL) AS has_file, is_read, created_at
       FROM case_chat_messages
       WHERE room_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
       ORDER BY created_at DESC
       LIMIT $3`,
      [roomId, before || null, safeLimit]
    );
    return result.rows.reverse();
  }

  async findMessageFile(messageId, roomId) {
    const result = await this.pool.query(
      `SELECT id, file_url, file_name, file_mime
       FROM case_chat_messages
       WHERE id = $1 AND room_id = $2 AND file_url IS NOT NULL`,
      [messageId, roomId]
    );
    return result.rows[0] || null;
  }

  async markAsRead(roomId, readerId) {
    const result = await this.pool.query(
      `UPDATE case_chat_messages
       SET is_read = TRUE
       WHERE room_id = $1 AND sender_id <> $2 AND is_read = FALSE
       RETURNING id`,
      [roomId, readerId]
    );
    return result.rows;
  }

  async countUnreadByParticipant(userId, userRole) {
    if (!userId || !['PATIENT', 'PROVIDER'].includes(userRole)) return 0;

    const scope = userRole === 'PATIENT'
      ? 'cr.patient_id = $1'
      : 'cr.provider_id = $1 AND cs.provider_id = $1';

    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS count
       FROM case_chat_messages cm
       JOIN case_chat_rooms cr ON cr.id = cm.room_id
       JOIN case_services cs ON cs.id = cr.case_service_id
       WHERE ${scope} AND cm.sender_id <> $1 AND cm.is_read = FALSE`,
      [userId]
    );
    return result.rows[0]?.count || 0;
  }
}

module.exports = ChatRepository;
module.exports.canAccessRoom = canAccessRoom;
