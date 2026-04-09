class ChatRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async findOrCreateRoom(case_service_id, patient_id, provider_id, client = null) {
    const executor = client || this.pool;
    const result = await executor.query(
      `
      INSERT INTO case_chat_rooms (case_service_id, patient_id, provider_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (case_service_id) DO UPDATE SET case_service_id = EXCLUDED.case_service_id
      RETURNING *
      `,
      [case_service_id, patient_id, provider_id]
    );
    return result.rows[0] || null;
  }

  async findRoomById(room_id, client = null) {
    const executor = client || this.pool;
    const result = await executor.query(
      `
      SELECT cr.*, cs.case_id
      FROM case_chat_rooms cr
      JOIN case_services cs ON cs.id = cr.case_service_id
      WHERE cr.id = $1
      `,
      [room_id]
    );
    return result.rows[0] || null;
  }

  async findRoomsByPatient(patient_id) {
    const result = await this.pool.query(
      `
      SELECT cr.*, cs.case_id, s.name AS service_name,
             sp.full_name AS provider_name
      FROM case_chat_rooms cr
      JOIN case_services cs ON cs.id = cr.case_service_id
      JOIN services s ON s.id = cs.service_id
      JOIN service_providers sp ON sp.id = cr.provider_id
      WHERE cr.patient_id = $1
      ORDER BY cr.created_at DESC
      `,
      [patient_id]
    );
    return result.rows;
  }

  async findRoomsByProvider(provider_id) {
    const result = await this.pool.query(
      `
      SELECT cr.*, cs.case_id, s.name AS service_name,
             p.full_name AS patient_name
      FROM case_chat_rooms cr
      JOIN case_services cs ON cs.id = cr.case_service_id
      JOIN services s ON s.id = cs.service_id
      JOIN patients p ON p.id = cr.patient_id
      WHERE cr.provider_id = $1
      ORDER BY cr.created_at DESC
      `,
      [provider_id]
    );
    return result.rows;
  }

  async findRoomsByCase(case_id) {
    const result = await this.pool.query(
      `
      SELECT cr.*, s.name AS service_name,
             sp.full_name AS provider_name,
             p.full_name AS patient_name
      FROM case_chat_rooms cr
      JOIN case_services cs ON cs.id = cr.case_service_id
      JOIN services s ON s.id = cs.service_id
      JOIN service_providers sp ON sp.id = cr.provider_id
      JOIN patients p ON p.id = cr.patient_id
      WHERE cs.case_id = $1
      ORDER BY cr.created_at ASC
      `,
      [case_id]
    );
    return result.rows;
  }

  async saveMessage(data, client = null) {
    const executor = client || this.pool;
    const result = await executor.query(
      `
      INSERT INTO case_chat_messages
        (room_id, sender_id, sender_role, content, file_url)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        data.room_id,
        data.sender_id,
        data.sender_role,
        data.content || null,
        data.file_url || null,
      ]
    );
    return result.rows[0] || null;
  }

  async getMessages(room_id, { limit = 50, before = null } = {}) {
    const safeLimit = Math.max(Number(limit) || 50, 1);
    let result;

    if (before) {
      result = await this.pool.query(
        `
        SELECT *
        FROM case_chat_messages
        WHERE room_id = $1 AND created_at < $2
        ORDER BY created_at DESC
        LIMIT $3
        `,
        [room_id, before, safeLimit]
      );
    } else {
      result = await this.pool.query(
        `
        SELECT *
        FROM case_chat_messages
        WHERE room_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        `,
        [room_id, safeLimit]
      );
    }

    return result.rows.reverse();
  }

  async markAsRead(room_id, reader_id) {
    const result = await this.pool.query(
      `
      UPDATE case_chat_messages
      SET is_read = TRUE
      WHERE room_id = $1
        AND sender_id != $2
        AND is_read = FALSE
      RETURNING id
      `,
      [room_id, reader_id]
    );
    return result.rows;
  }

  async countUnread(room_id, reader_id) {
    const result = await this.pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM case_chat_messages
      WHERE room_id = $1
        AND sender_id != $2
        AND is_read = FALSE
      `,
      [room_id, reader_id]
    );
    return result.rows[0]?.count || 0;
  }
}

module.exports = ChatRepository;
