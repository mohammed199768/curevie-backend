const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const jwt = require('jsonwebtoken');
const xss = require('xss');
const { logger } = require('./logger');
const { isOriginAllowed } = require('../config/cors');

const MAX_MESSAGE_LENGTH = 4000;

let io = null;

function getUserRoom(userId) {
  return userId ? `user:${userId}` : null;
}

function getRoleRoom(role) {
  return role ? `role:${role}` : null;
}

function emitToUser(userId, event, payload = {}) {
  if (!io || !userId) return false;
  io.to(getUserRoom(userId)).emit(event, payload);
  return true;
}

function emitToRole(role, event, payload = {}) {
  if (!io || !role) return false;
  io.to(getRoleRoom(role)).emit(event, payload);
  return true;
}

function emitToChatRoom(roomId, event, payload = {}) {
  if (!io || !roomId) return false;
  io.to(`room:${roomId}`).emit(event, payload);
  return true;
}

function getChatRepository() {
  const pool = require('../config/db');
  const ChatRepository = require('../repositories/ChatRepository');
  return new ChatRepository(pool);
}

async function emitChatUnreadUpdate(chatRepo, userId, userRole, payload = {}) {
  if (!chatRepo || !userId || !userRole) return;
  const unreadCount = await chatRepo.countUnreadByParticipant(userId, userRole);
  emitToUser(userId, 'chat_unread_updated', { ...payload, unread_count: Number(unreadCount || 0) });
}

/** Notifies both chat participants that their unread counters changed. */
async function broadcastChatUnread(chatRepo, room) {
  const participants = [
    { userId: room.patient_id, userRole: 'PATIENT' },
    { userId: room.provider_id, userRole: 'PROVIDER' },
  ].filter((participant) => participant.userId);

  await Promise.allSettled(participants.map((participant) =>
    emitChatUnreadUpdate(chatRepo, participant.userId, participant.userRole, {
      source: 'case_room',
      room_id: room.id,
      case_id: room.case_id,
    })
  ));
}

async function authenticateSocket(socket, next) {
  const token = socket.handshake.auth?.token
    || socket.handshake.headers?.authorization?.replace('Bearer ', '');
  if (!token) return next(new Error('Authentication required'));

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.jti) {
      const { isTokenBlacklisted } = require('./cache');
      if (await isTokenBlacklisted(decoded.jti)) return next(new Error('Token revoked'));
    }
    socket.user = decoded;
    return next();
  } catch (_) {
    return next(new Error('Invalid token'));
  }
}

function initSocketServer(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, !origin || isOriginAllowed(origin)),
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 64 * 1024,
  });

  // Redis fans events out across backend instances; a single local instance works without it.
  if (process.env.REDIS_URL) {
    const pubClient = new Redis(process.env.REDIS_URL);
    const subClient = pubClient.duplicate();
    pubClient.on('error', (err) => logger.warn('Socket.io Redis pub error', { message: err.message }));
    subClient.on('error', (err) => logger.warn('Socket.io Redis sub error', { message: err.message }));
    io.adapter(createAdapter(pubClient, subClient));
  }
  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    const { user } = socket;
    socket.join(getUserRoom(user.id));
    socket.join(getRoleRoom(user.role));

    // Access tokens are short lived; drop the socket when the token expires so the
    // client reconnects with a fresh token (and revoked users lose live updates).
    if (user.exp) {
      const msUntilExpiry = user.exp * 1000 - Date.now();
      const timer = setTimeout(() => socket.disconnect(true), Math.max(msUntilExpiry, 0));
      socket.on('disconnect', () => clearTimeout(timer));
    }

    socket.on('join_room', async (payload = {}) => {
      try {
        const chatRepo = getChatRepository();
        const room = await chatRepo.findAccessibleRoom(payload.room_id, user);
        if (!room) {
          socket.emit('error', { message: 'Room not found or access denied' });
          return;
        }

        socket.join(`room:${room.id}`);
        socket.emit('joined_room', { room_id: room.id });

        if (user.role !== 'ADMIN') {
          const marked = await chatRepo.markAsRead(room.id, user.id);
          if (marked.length) await broadcastChatUnread(chatRepo, room);
        }
      } catch (err) {
        logger.error('Socket join_room error', { message: err.message });
        socket.emit('error', { message: 'Failed to join room' });
      }
    });

    socket.on('leave_room', (payload = {}) => {
      if (payload.room_id) socket.leave(`room:${payload.room_id}`);
    });

    socket.on('send_message', async (payload = {}) => {
      try {
        const content = typeof payload.content === 'string' ? xss(payload.content.trim()) : '';
        if (!content) {
          socket.emit('error', { message: 'Message content required' });
          return;
        }
        if (content.length > MAX_MESSAGE_LENGTH) {
          socket.emit('error', { message: `Message is longer than ${MAX_MESSAGE_LENGTH} characters` });
          return;
        }

        // Re-check access on every send: assignments can change while a socket stays open.
        const chatRepo = getChatRepository();
        const room = await chatRepo.findAccessibleRoom(payload.room_id, user);
        if (!room) {
          socket.emit('error', { message: 'Room not found or access denied' });
          return;
        }
        if (!room.can_send) {
          socket.emit('error', { message: 'This conversation is closed' });
          return;
        }

        const message = await chatRepo.saveMessage({
          room_id: room.id,
          sender_id: user.id,
          sender_role: user.role,
          content,
        });

        emitToChatRoom(room.id, 'new_message', message);
        await broadcastChatUnread(chatRepo, room);
      } catch (err) {
        logger.error('Socket send_message error', { message: err.message });
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    socket.on('typing', (payload = {}) => {
      const roomName = `room:${payload.room_id}`;
      if (!payload.room_id || !socket.rooms.has(roomName)) return;
      socket.to(roomName).emit('user_typing', { room_id: payload.room_id, user_id: user.id, role: user.role });
    });
  });

  logger.info('Socket.io server initialized');
  return io;
}

module.exports = {
  initSocketServer,
  emitToUser,
  emitToRole,
  emitToChatRoom,
  broadcastChatUnread,
  getUserRoom,
};
