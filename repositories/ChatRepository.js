const BaseRepository = require('./BaseRepository');

const participantTables = {
  ADMIN: 'admins',
  PROVIDER: 'service_providers',
};

class ChatRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'conversations');
  }

  async getConversationById(id, db = null) {
    return this._queryOne('SELECT * FROM conversations WHERE id = $1', [id], db);
  }

  async getParticipantByRole(id, role, db = null) {
    const table = participantTables[role];
    if (!table) return null;
    return this._queryOne(`SELECT id, full_name FROM ${table} WHERE id = $1`, [id], db);
  }

  async getPatientById(id, db = null) {
    return this._queryOne('SELECT id, full_name FROM patients WHERE id = $1 LIMIT 1', [id], db);
  }

  async getConversationByPair(subjectId, subjectRole, participantId, participantRole, db = null) {
    return this._queryOne(
      `SELECT * FROM conversations
       WHERE subject_id = $1 AND subject_role = $2
         AND participant_id = $3 AND participant_role = $4
       LIMIT 1`,
      [subjectId, subjectRole, participantId, participantRole], db
    );
  }

  async insertConversation(subjectId, subjectRole, participantId, participantRole, db = null) {
    return this._queryOne(
      `INSERT INTO conversations (patient_id, subject_id, subject_role, participant_id, participant_role)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        subjectRole === 'PATIENT' ? subjectId : null,
        subjectId, subjectRole, participantId, participantRole,
      ], db
    );
  }

  async listMyConversations(userId, userRole, { limit = 50, offset = 0 } = {}, db = null) {
    const params = [userId];
    let whereSql = `
      c.subject_id = $1
      AND c.subject_role = 'PATIENT'
      AND c.participant_role = 'ADMIN'
    `;

    if (userRole === 'ADMIN') {
      whereSql = "c.participant_id = $1 AND c.participant_role = 'ADMIN'";
    } else if (userRole === 'PROVIDER') {
      whereSql = `
        c.subject_id = $1
        AND c.subject_role = 'PROVIDER'
        AND c.participant_role = 'ADMIN'
      `;
    }

    const result = await this._query(
      `SELECT
        c.id, c.patient_id, c.subject_id, c.subject_role,
        c.participant_id, c.participant_role, c.last_message_at, c.created_at,
        p.full_name AS patient_name,
        provider_subject.full_name AS provider_subject_name,
        CASE
          WHEN c.participant_role = 'ADMIN' THEN a.full_name
          WHEN c.participant_role = 'PROVIDER' THEN provider_participant.full_name
        END AS participant_name,
        lm.id AS last_message_id,
        lm.sender_id AS last_message_sender_id,
        lm.sender_role AS last_message_sender_role,
        lm.body AS last_message_body,
        lm.media_url AS last_message_media_url,
        lm.media_type AS last_message_media_type,
        lm.created_at AS last_message_created_at,
        COALESCE(uc.unread_count, 0)::int AS unread_count
      FROM conversations c
      LEFT JOIN patients p ON c.subject_role = 'PATIENT' AND p.id = c.subject_id
      LEFT JOIN service_providers provider_subject ON c.subject_role = 'PROVIDER' AND provider_subject.id = c.subject_id
      LEFT JOIN admins a ON c.participant_role = 'ADMIN' AND a.id = c.participant_id
      LEFT JOIN service_providers provider_participant ON c.participant_role = 'PROVIDER' AND provider_participant.id = c.participant_id
      LEFT JOIN LATERAL (
        SELECT m.id, m.sender_id, m.sender_role, m.body, m.media_url, m.media_type, m.created_at
        FROM messages m WHERE m.conversation_id = c.id
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1
      ) lm ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS unread_count
        FROM messages m
        WHERE m.conversation_id = c.id AND m.is_read = FALSE AND m.sender_id <> $1
      ) uc ON TRUE
      WHERE ${whereSql}
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.created_at DESC
      LIMIT $2
      OFFSET $3`,
      [...params, limit, offset], db
    );

    return result.rows;
  }

  async listPatientParticipants(db = null) {
    const result = await this._query(
      `SELECT a.id, a.full_name AS participant_name, 'ADMIN'::text AS participant_role
       FROM admins a ORDER BY a.full_name ASC`,
      [], db
    );
    return result.rows;
  }

  async listAdminPatients(adminId, { limit, offset } = {}, db = null) {
    const [result, countResult] = await Promise.all([
      this._query(
        `SELECT
          p.id AS patient_id, p.full_name AS patient_name,
          c.id AS conversation_id, c.last_message_at,
          c.created_at AS conversation_created_at,
          lm.id AS last_message_id, lm.sender_id AS last_message_sender_id,
          lm.sender_role AS last_message_sender_role, lm.body AS last_message_body,
          lm.media_url AS last_message_media_url, lm.media_type AS last_message_media_type,
          lm.created_at AS last_message_created_at,
          COALESCE(uc.unread_count, 0)::int AS unread_count
        FROM patients p
        LEFT JOIN conversations c
          ON c.subject_role = 'PATIENT' AND c.subject_id = p.id
          AND c.participant_id = $1 AND c.participant_role = 'ADMIN'
        LEFT JOIN LATERAL (
          SELECT m.id, m.sender_id, m.sender_role, m.body, m.media_url, m.media_type, m.created_at
          FROM messages m WHERE c.id IS NOT NULL AND m.conversation_id = c.id
          ORDER BY m.created_at DESC, m.id DESC LIMIT 1
        ) lm ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS unread_count
          FROM messages m
          WHERE c.id IS NOT NULL AND m.conversation_id = c.id
            AND m.is_read = FALSE AND m.sender_id <> $1
        ) uc ON TRUE
        ORDER BY LOWER(p.full_name) ASC, p.id ASC
        LIMIT $2 OFFSET $3`,
        [adminId, limit, offset], db
      ),
      this._query('SELECT COUNT(*)::int AS total FROM patients', [], db),
    ]);

    return { rows: result.rows, total: parseInt(countResult.rows[0].total) };
  }

  async countMessages(conversationId, db = null) {
    const result = await this._query(
      'SELECT COUNT(*)::int AS total FROM messages WHERE conversation_id = $1',
      [conversationId], db
    );
    return result.rows[0].total;
  }

  async listMessages(conversationId, limit, offset, db = null) {
    const result = await this._query(
      `SELECT id, conversation_id, sender_id, sender_role, body, media_url, media_type, is_read, created_at
       FROM messages WHERE conversation_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [conversationId, limit, offset], db
    );
    return result.rows;
  }

  async insertMessage({ conversationId, senderId, senderRole, body, mediaUrl, mediaType }, db = null) {
    return this._queryOne(
      `INSERT INTO messages (conversation_id, sender_id, sender_role, body, media_url, media_type)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [conversationId, senderId, senderRole, body || null, mediaUrl || null, mediaType || null], db
    );
  }

  async updateConversationLastMessage(conversationId, timestamp, db = null) {
    await this._query(
      'UPDATE conversations SET last_message_at = $1 WHERE id = $2',
      [timestamp, conversationId], db
    );
  }

  async markMessagesAsRead(conversationId, userId, db = null) {
    const result = await this._query(
      `UPDATE messages SET is_read = TRUE
       WHERE conversation_id = $1 AND is_read = FALSE AND sender_id <> $2`,
      [conversationId, userId], db
    );
    return result.rowCount;
  }
}

module.exports = ChatRepository;
