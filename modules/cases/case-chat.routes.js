// Chat between a patient and the provider assigned to one of their case line items.
// Mounted at /cases/chat. Text messages can also be sent over the socket ("send_message").
const express = require('express');
const xss = require('xss');
const { authenticate } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { AppError } = require('../../middlewares/errorHandler');
const { uploadChatMedia } = require('../../utils/upload');
const { savePrivateFile, readStoredFile, sendFile } = require('../../utils/storage');
const { emitToChatRoom, broadcastChatUnread } = require('../../utils/socket');
const pool = require('../../config/db');
const ChatRepository = require('../../repositories/ChatRepository');
const schemas = require('./case.schemas');

const router = express.Router();
const chatRepo = new ChatRepository(pool);

router.use(authenticate);

async function requireRoom(req) {
  const room = await chatRepo.findAccessibleRoom(req.params.room_id, req.user);
  if (!room) throw new AppError('Room not found', 404, 'NOT_FOUND');
  return room;
}

router.get(
  '/rooms',
  readLimiter,
  validate(schemas.chatRoomsQuerySchema, 'query'),
  asyncHandler(async (req, res) => res.json({
    data: await chatRepo.listRoomsForUser(req.user, { caseId: req.query.case_id || null }),
  }))
);

router.get(
  '/unread-count',
  readLimiter,
  asyncHandler(async (req, res) => res.json({
    unread_count: Number(await chatRepo.countUnreadByParticipant(req.user.id, req.user.role)),
  }))
);

router.get(
  '/rooms/:room_id/messages',
  readLimiter,
  validate(schemas.chatRoomParams, 'params'),
  validate(schemas.chatMessagesQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const room = await requireRoom(req);
    const messages = await chatRepo.getMessages(room.id, { limit: req.query.limit, before: req.query.before });

    if (req.user.role !== 'ADMIN') {
      const marked = await chatRepo.markAsRead(room.id, req.user.id);
      if (marked.length) await broadcastChatUnread(chatRepo, room);
    }

    return res.json({ data: messages, room });
  })
);

router.post(
  '/rooms/:room_id/messages',
  apiLimiter,
  validate(schemas.chatRoomParams, 'params'),
  ...uploadChatMedia,
  validate(schemas.chatMessageSchema),
  asyncHandler(async (req, res) => {
    const room = await requireRoom(req);
    if (!room.can_send) throw new AppError('This conversation is closed', 409, 'CHAT_CLOSED');

    const content = req.body.content ? xss(req.body.content) : '';
    if (!content && !req.file) throw new AppError('Message content or a file is required', 400, 'EMPTY_MESSAGE');

    let fileKey = null;
    if (req.file) {
      fileKey = await savePrivateFile(req.file.buffer, { folder: 'chat', mimeType: req.file.mimetype });
    }

    const message = await chatRepo.saveMessage({
      room_id: room.id,
      sender_id: req.user.id,
      sender_role: req.user.role,
      content: content || null,
      file_url: fileKey,
      file_name: req.file ? String(req.file.originalname || 'attachment').slice(0, 255) : null,
      file_mime: req.file ? req.file.mimetype : null,
    });

    emitToChatRoom(room.id, 'new_message', message);
    await broadcastChatUnread(chatRepo, room);
    return res.status(201).json({ data: message });
  })
);

router.get(
  '/rooms/:room_id/messages/:message_id/file',
  readLimiter,
  validate(schemas.chatMessageFileParams, 'params'),
  asyncHandler(async (req, res) => {
    const room = await requireRoom(req);
    const message = await chatRepo.findMessageFile(req.params.message_id, room.id);
    if (!message) throw new AppError('File not found', 404, 'NOT_FOUND');

    let buffer;
    try {
      buffer = await readStoredFile(message.file_url);
    } catch (_) {
      throw new AppError('File is not available', 404, 'FILE_NOT_FOUND');
    }
    return sendFile(res, buffer, {
      fileName: message.file_name || 'attachment',
      mimeType: message.file_mime || 'application/octet-stream',
      inline: req.query.inline === 'true',
    });
  })
);

module.exports = router;
