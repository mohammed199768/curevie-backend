const { paginate, paginationMeta } = require('../../utils/pagination'); // AUDIT-FIX: DRY — shared pagination helpers replace repeated admin-patient list pagination code

function isConversationParticipant(conversation, userId, userRole) {
  if (!conversation) return false;

  const subjectRole = String(
    conversation.subject_role || (conversation.patient_id ? 'PATIENT' : '')
  ).toUpperCase();
  const subjectId = conversation.subject_id || conversation.patient_id || null;

  if (userRole === subjectRole && subjectId === userId) {
    return true;
  }

  if (userRole === 'ADMIN' || userRole === 'PROVIDER') {
    return conversation.participant_id === userId
      && conversation.participant_role === userRole;
  }

  return false;
}

function formatConversationRow(row, userRole) {
  const subjectName = row.subject_role === 'PROVIDER'
    ? row.provider_subject_name
    : row.patient_name;

  const displayName = (() => {
    if (userRole === 'PATIENT') {
      return row.participant_name || subjectName || null;
    }

    if (userRole === 'PROVIDER') {
      return row.subject_role === 'PROVIDER'
        ? (row.participant_name || 'Admin')
        : (row.patient_name || row.participant_name || null);
    }

    return row.subject_role === 'PROVIDER'
      ? (subjectName || row.participant_name || null)
      : (row.patient_name || row.participant_name || null);
  })();

  return {
    id: row.id,
    patient_id: row.patient_id || null,
    patient_name: row.patient_name || null,
    subject_id: row.subject_id,
    subject_role: row.subject_role,
    subject_name: subjectName || null,
    participant_id: row.participant_id,
    participant_role: row.participant_role,
    participant_name: row.participant_name || null,
    display_name: displayName,
    unread_count: row.unread_count,
    last_message_at: row.last_message_at,
    created_at: row.created_at,
    last_message: row.last_message_id ? {
      id: row.last_message_id,
      sender_id: row.last_message_sender_id,
      sender_role: row.last_message_sender_role,
      body: row.last_message_body,
      media_url: row.last_message_media_url,
      media_type: row.last_message_media_type,
      created_at: row.last_message_created_at,
    } : null,
  };
}

function formatAdminPatientRow(row) {
  return {
    patient_id: row.patient_id,
    patient_name: row.patient_name,
    conversation_id: row.conversation_id || null,
    unread_count: row.unread_count,
    last_message_at: row.last_message_at,
    created_at: row.conversation_created_at || null,
    last_message: row.last_message_id ? {
      id: row.last_message_id,
      sender_id: row.last_message_sender_id,
      sender_role: row.last_message_sender_role,
      body: row.last_message_body,
      media_url: row.last_message_media_url,
      media_type: row.last_message_media_type,
      created_at: row.last_message_created_at,
    } : null,
  };
}

function createChatService(chatRepo) {
  async function getConversationById(id) {
    return chatRepo.getConversationById(id);
  }

  async function getParticipantByRole(id, role) {
    return chatRepo.getParticipantByRole(id, role);
  }

  async function getPatientById(id) {
    return chatRepo.getPatientById(id);
  }

  async function createOrGetConversation(
    subjectId,
    subjectRole,
    participantId,
    participantRole
  ) {
    const existing = await chatRepo.getConversationByPair(
      subjectId,
      subjectRole,
      participantId,
      participantRole
    );

    if (existing) {
      return { created: false, conversation: existing };
    }

    try {
      const conversation = await chatRepo.insertConversation(
        subjectId,
        subjectRole,
        participantId,
        participantRole
      );

      return { created: true, conversation };
    } catch (err) {
      if (err.code !== '23505') throw err;

      const fallback = await chatRepo.getConversationByPair(
        subjectId,
        subjectRole,
        participantId,
        participantRole
      );

      return { created: false, conversation: fallback };
    }
  }

  async function listMyConversations(userId, userRole, { page = 1, limit = 50 } = {}) {
    const {
      limit: safeLimit,
      offset,
    } = paginate({ page, limit }, { defaultLimit: 50, maxLimit: 50 });
    const rows = await chatRepo.listMyConversations(
      userId,
      userRole,
      { limit: safeLimit, offset }
    );
    return rows.map((row) => formatConversationRow(row, userRole));
  }

  async function listPatientParticipants() {
    return chatRepo.listPatientParticipants();
  }

  async function listAdminPatients(adminId, { page = 1, limit = 50 } = {}) {
    const { page: safePage, limit: safeLimit, offset } = paginate({ page, limit }, { defaultLimit: 50 }); // AUDIT-FIX: DRY — shared helper now normalizes admin-patient list pagination
    const { rows, total } = await chatRepo.listAdminPatients(
      adminId,
      { limit: safeLimit, offset }
    );

    return {
      data: rows.map(formatAdminPatientRow),
      pagination: paginationMeta(total, safePage, safeLimit), // AUDIT-FIX: DRY — standardized list response shape for admin-patient listings
    };
  }

  async function countMessages(conversationId) {
    return chatRepo.countMessages(conversationId);
  }

  async function listMessages(conversationId, limit, offset) {
    const rows = await chatRepo.listMessages(conversationId, limit, offset);
    return rows.reverse();
  }

  async function createMessage({
    conversationId,
    senderId,
    senderRole,
    body,
    mediaUrl,
    mediaType,
  }) {
    return chatRepo.withTransaction(async (client) => {
      const message = await chatRepo.insertMessage(
        {
          conversationId,
          senderId,
          senderRole,
          body,
          mediaUrl,
          mediaType,
        },
        client
      );

      await chatRepo.updateConversationLastMessage(
        conversationId,
        message.created_at,
        client
      );

      return message;
    });
  }

  async function markMessagesAsRead(conversationId, userId) {
    return chatRepo.markMessagesAsRead(conversationId, userId);
  }

  return {
    isConversationParticipant,
    getConversationById,
    getParticipantByRole,
    getPatientById,
    createOrGetConversation,
    listMyConversations,
    listPatientParticipants,
    listAdminPatients,
    countMessages,
    listMessages,
    createMessage,
    markMessagesAsRead,
  };
}

let configuredChatService = null; // AUDIT-FIX: P3-STEP8-DIP - chat-service singleton wiring now happens outside the module.

function configureChatService(chatRepo) { // AUDIT-FIX: P3-STEP8-DIP - composition roots can configure the backward-compatible chat singleton explicitly.
  configuredChatService = createChatService(chatRepo); // AUDIT-FIX: P3-STEP8-DIP - cache the injected repository-backed service for legacy method callers.
  return module.exports; // AUDIT-FIX: P3-STEP8-COMPAT - keep the historical object export shape available after configuration.
} // AUDIT-FIX: P3-STEP8-DIP - configuration helper ends the composition-root bridge for chat consumers.

function getConfiguredChatService() { // AUDIT-FIX: P3-STEP8-DIP - centralize singleton access so the legacy surface stays intact without config/db.
  if (!configuredChatService) throw new Error('Chat service is not configured'); // AUDIT-FIX: P3-STEP8-DIP - fail fast if a composition root forgot to inject dependencies.
  return configuredChatService; // AUDIT-FIX: P3-STEP8-DIP - return the injected singleton for legacy method callers.
} // AUDIT-FIX: P3-STEP8-DIP - singleton accessor ends the compatibility bridge.

async function getConversationById(...args) { return getConfiguredChatService().getConversationById(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level getConversationById method without a service-level DB import.
async function getParticipantByRole(...args) { return getConfiguredChatService().getParticipantByRole(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level getParticipantByRole method without a service-level DB import.
async function getPatientById(...args) { return getConfiguredChatService().getPatientById(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level getPatientById method without a service-level DB import.
async function createOrGetConversation(...args) { return getConfiguredChatService().createOrGetConversation(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level createOrGetConversation method without a service-level DB import.
async function listMyConversations(...args) { return getConfiguredChatService().listMyConversations(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level listMyConversations method without a service-level DB import.
async function listPatientParticipants(...args) { return getConfiguredChatService().listPatientParticipants(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level listPatientParticipants method without a service-level DB import.
async function listAdminPatients(...args) { return getConfiguredChatService().listAdminPatients(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level listAdminPatients method without a service-level DB import.
async function countMessages(...args) { return getConfiguredChatService().countMessages(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level countMessages method without a service-level DB import.
async function listMessages(...args) { return getConfiguredChatService().listMessages(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level listMessages method without a service-level DB import.
async function createMessage(...args) { return getConfiguredChatService().createMessage(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level createMessage method without a service-level DB import.
async function markMessagesAsRead(...args) { return getConfiguredChatService().markMessagesAsRead(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level markMessagesAsRead method without a service-level DB import.

module.exports = {
  isConversationParticipant,
  configureChatService,
  getConversationById,
  getParticipantByRole,
  getPatientById,
  createOrGetConversation,
  listMyConversations,
  listPatientParticipants,
  listAdminPatients,
  countMessages,
  listMessages,
  createMessage,
  markMessagesAsRead,
  createChatService,
};
