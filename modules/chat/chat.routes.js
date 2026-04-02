const express = require('express');
const { authenticate } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
// AUDIT-FIX: S2 — import magic bytes validator alongside upload middleware
const { uploadSingleChatMedia, validateChatMediaContents } = require('../../utils/upload');
const {
  createConversationSchema,
  chatMessagesQuerySchema,
  createChatMessageSchema,
} = require('../../utils/schemas');
const pool = require('../../config/db');
const ChatRepository = require('../../repositories/ChatRepository');
const chatServiceModule = require('./chat.service'); // AUDIT-FIX: P3-STEP8-DIP - chat routes now configure the service singleton explicitly.
const { createChatController } = require('./chat.controller');

const chatRepo = new ChatRepository(pool);
chatServiceModule.configureChatService(chatRepo); // AUDIT-FIX: P3-STEP8-DIP - route-level composition now wires the backward-compatible chat singleton explicitly.
const chatService = chatServiceModule; // AUDIT-FIX: P3-STEP8-COMPAT - keep the existing local service variable shape for controller wiring.
const chatController = createChatController(chatService);

const router = express.Router();

router.post(
  '/conversations',
  authenticate,
  apiLimiter,
  validate(createConversationSchema),
  asyncHandler(chatController.createConversation)
);

router.get(
  '/conversations',
  authenticate,
  readLimiter,
  asyncHandler(chatController.listConversations)
);

router.get(
  '/participants',
  authenticate,
  readLimiter,
  asyncHandler(chatController.listParticipants)
);

router.get(
  '/conversations/:id/messages',
  authenticate,
  readLimiter,
  validate(chatMessagesQuerySchema, 'query'),
  asyncHandler(chatController.listMessages)
);

router.post(
  '/conversations/:id/messages',
  authenticate,
  apiLimiter,
  uploadSingleChatMedia,
  // AUDIT-FIX: S2 — magic bytes check runs after multer, before controller
  validateChatMediaContents,
  validate(createChatMessageSchema),
  asyncHandler(chatController.sendMessage)
);

router.put(
  '/conversations/:id/read',
  authenticate,
  apiLimiter,
  asyncHandler(chatController.markConversationAsRead)
);

module.exports = router;
