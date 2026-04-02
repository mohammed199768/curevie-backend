const { isBunnyConfigured, uploadToBunny } = require('../../utils/bunny');
const { paginate, paginationMeta } = require('../../utils/pagination'); // AUDIT-FIX: DRY — shared pagination helpers replace manual message pagination logic

function resolveMediaType(mimeType) {
  if (!mimeType) return null;
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

const BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL
  || process.env.APP_BASE_URL
  || `http://localhost:${process.env.PORT || 5000}/api/v1`
);

function createChatController(chatService) {
  async function getAuthorizedConversation(conversationId, user) {
    const conversation = await chatService.getConversationById(conversationId);
    if (!conversation) return { notFound: true };

    const allowed = chatService.isConversationParticipant(
      conversation,
      user.id,
      user.role
    );

    if (!allowed) return { forbidden: true };

    return { conversation };
  }

  async function createConversation(req, res) {
    if (req.user.role === 'PATIENT') {
      if (req.body.participant_role !== 'ADMIN') {
        return res.status(403).json({
          message: 'Patients can only start direct general chat with admin',
          code: 'ADMIN_ONLY_GENERAL_CHAT',
        });
      }

      const participant = await chatService.getParticipantByRole(
        req.body.participant_id,
        req.body.participant_role
      );

      if (!participant) {
        return res.status(404).json({
          message: 'Participant not found',
          code: 'PARTICIPANT_NOT_FOUND',
        });
      }

      const result = await chatService.createOrGetConversation(
        req.user.id,
        'PATIENT',
        req.body.participant_id,
        req.body.participant_role
      );

      return res.status(result.created ? 201 : 200).json(result.conversation);
    }

    if (req.user.role === 'ADMIN') {
      if (req.body.patient_id) {
        const patient = await chatService.getPatientById(req.body.patient_id);
        if (!patient) {
          return res.status(404).json({
            message: 'Patient not found',
            code: 'PATIENT_NOT_FOUND',
          });
        }

        const result = await chatService.createOrGetConversation(
          req.body.patient_id,
          'PATIENT',
          req.user.id,
          'ADMIN'
        );

        return res.status(result.created ? 201 : 200).json(result.conversation);
      }

      const provider = await chatService.getParticipantByRole(
        req.body.participant_id,
        req.body.participant_role
      );

      if (!provider || req.body.participant_role !== 'PROVIDER') {
        return res.status(404).json({
          message: 'Provider not found',
          code: 'PARTICIPANT_NOT_FOUND',
        });
      }

      const result = await chatService.createOrGetConversation(
        req.body.participant_id,
        'PROVIDER',
        req.user.id,
        'ADMIN'
      );

      return res.status(result.created ? 201 : 200).json(result.conversation);
    }

    if (req.user.role === 'PROVIDER') {
      const participant = await chatService.getParticipantByRole(
        req.body.participant_id,
        req.body.participant_role
      );

      if (!participant || req.body.participant_role !== 'ADMIN') {
        return res.status(404).json({
          message: 'Admin not found',
          code: 'PARTICIPANT_NOT_FOUND',
        });
      }

      const result = await chatService.createOrGetConversation(
        req.user.id,
        'PROVIDER',
        req.body.participant_id,
        'ADMIN'
      );

      return res.status(result.created ? 201 : 200).json(result.conversation);
    }

    return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  }

  async function listConversations(req, res) {
    const data = await chatService.listMyConversations(req.user.id, req.user.role, req.query);
    return res.json({ data });
  }

  async function listParticipants(req, res) {
    if (req.user.role === 'PATIENT') {
      const data = await chatService.listPatientParticipants(req.user.id);
      return res.json({ data });
    }

    if (req.user.role === 'ADMIN') {
      const result = await chatService.listAdminPatients(req.user.id, {
        page: req.query.page,
        limit: req.query.limit,
      });

      return res.json(result);
    }

    return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  }

  async function listMessages(req, res) {
    const access = await getAuthorizedConversation(req.params.id, req.user);
    if (access.notFound) {
      return res.status(404).json({
        message: 'Conversation not found',
        code: 'CONVERSATION_NOT_FOUND',
      });
    }
    if (access.forbidden) {
      return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
    }

    const { page: currentPage, limit: currentLimit, offset } = paginate(req.query); // AUDIT-FIX: DRY — normalize message pagination through the shared helper

    const [total, data] = await Promise.all([
      chatService.countMessages(req.params.id),
      chatService.listMessages(req.params.id, currentLimit, offset), // AUDIT-FIX: DRY — pass normalized limit from shared pagination helper
    ]);

    return res.json({
      data,
      pagination: paginationMeta(total, currentPage, currentLimit), // AUDIT-FIX: DRY — standardized list response shape for chat messages
    });
  }

  async function sendMessage(req, res) {
    const access = await getAuthorizedConversation(req.params.id, req.user);
    if (access.notFound) {
      return res.status(404).json({
        message: 'Conversation not found',
        code: 'CONVERSATION_NOT_FOUND',
      });
    }
    if (access.forbidden) {
      return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
    }

    let mediaUrl = null;
    let mediaType = null;

    if (req.file) {
      mediaType = resolveMediaType(req.file.mimetype);

      if (isBunnyConfigured()) {
        mediaUrl = await uploadToBunny(
          req.file.buffer,
          req.file.originalname,
          'chat'
        );

        if (!mediaUrl) {
          return res.status(502).json({
            message: 'Failed to upload media',
            code: 'MEDIA_UPLOAD_FAILED',
          });
        }
      } else {
        // Local fallback: save to uploads/chat/
        const fs = require('fs');
        const path = require('path');
        const { randomUUID } = require('crypto');

        const chatUploadsDir = path.join(__dirname, '..', '..', 'uploads', 'chat');
        if (!fs.existsSync(chatUploadsDir)) {
          fs.mkdirSync(chatUploadsDir, { recursive: true });
        }

        const ext = (req.file.detectedExt || req.file.originalname.split('.').pop() || 'bin').toLowerCase();
        const filename = `${Date.now()}-${randomUUID()}.${ext}`;
        const filePath = path.join(chatUploadsDir, filename);
        fs.writeFileSync(filePath, req.file.buffer);

        const backendOrigin = BASE_URL
          .replace(/\/api\/v1\/?$/, '')
          .replace(/\/$/, '');
        mediaUrl = `${backendOrigin}/uploads/chat/${filename}`;
      }
    }

    const body = req.body.body || null;
    if (!body && !mediaUrl) {
      return res.status(400).json({
        message: 'Message body or media is required',
        code: 'EMPTY_MESSAGE',
      });
    }

    const message = await chatService.createMessage({
      conversationId: req.params.id,
      senderId: req.user.id,
      senderRole: req.user.role,
      body,
      mediaUrl,
      mediaType,
    });

    return res.status(201).json(message);
  }

  async function markConversationAsRead(req, res) {
    const access = await getAuthorizedConversation(req.params.id, req.user);
    if (access.notFound) {
      return res.status(404).json({
        message: 'Conversation not found',
        code: 'CONVERSATION_NOT_FOUND',
      });
    }
    if (access.forbidden) {
      return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
    }

    const updatedCount = await chatService.markMessagesAsRead(
      req.params.id,
      req.user.id
    );

    return res.json({
      message: 'Messages marked as read',
      updated_count: updatedCount,
    });
  }

  return {
    createConversation,
    listConversations,
    listParticipants,
    listMessages,
    sendMessage,
    markConversationAsRead,
  };
}

module.exports = { createChatController };
