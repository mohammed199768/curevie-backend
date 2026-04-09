const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const jwt = require('jsonwebtoken');
const { logger } = require('./logger');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

let io = null;

function initSocketServer(httpServer) {
  const pubClient = new Redis(redisUrl);
  const subClient = pubClient.duplicate();

  pubClient.on('error', (err) =>
    logger.warn('Socket.io Redis pub error', { message: err.message }));
  subClient.on('error', (err) =>
    logger.warn('Socket.io Redis sub error', { message: err.message }));

  io = new Server(httpServer, {
    cors: {
      origin: [
        'https://curvie.net',
        'https://www.curvie.net',
        'https://admin.curvie.net',
        'https://provider.curvie.net',
        /^https:\/\/curvie.*\.vercel\.app$/,
      ],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.adapter(createAdapter(pubClient, subClient));

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
      || socket.handshake.headers?.authorization?.replace('Bearer ', '');
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = decoded;
      next();
    } catch (err) {
      return next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    logger.info('Socket connected', {
      userId: socket.user.id,
      role: socket.user.role,
    });

    socket.on('join_room', async ({ room_id }) => {
      try {
        const pool = require('../config/db');
        const ChatRepository = require('../repositories/ChatRepository');
        const chatRepo = new ChatRepository(pool);

        const room = await chatRepo.findRoomById(room_id);
        if (!room) {
          socket.emit('error', { message: 'Room not found' });
          return;
        }

        const user = socket.user;
        const canAccess =
          user.role === 'ADMIN' ||
          (user.role === 'PATIENT' && room.patient_id === user.id) ||
          (user.role === 'PROVIDER' && room.provider_id === user.id);

        if (!canAccess) {
          socket.emit('error', { message: 'Access denied' });
          return;
        }

        socket.join(`room:${room_id}`);
        socket.emit('joined_room', { room_id });

        await chatRepo.markAsRead(room_id, user.id);

        logger.info('Socket joined room', {
          userId: user.id, room_id,
        });
      } catch (err) {
        logger.error('Socket join_room error', { message: err.message });
        socket.emit('error', { message: 'Failed to join room' });
      }
    });

    socket.on('send_message', async ({ room_id, content, file_url }) => {
      try {
        if (!content && !file_url) {
          socket.emit('error', { message: 'Message content required' });
          return;
        }

        const pool = require('../config/db');
        const ChatRepository = require('../repositories/ChatRepository');
        const chatRepo = new ChatRepository(pool);

        const socketRooms = socket.rooms;
        if (!socketRooms.has(`room:${room_id}`)) {
          socket.emit('error', { message: 'Join the room first' });
          return;
        }

        const user = socket.user;
        const message = await chatRepo.saveMessage({
          room_id,
          sender_id: user.id,
          sender_role: user.role,
          content: content || null,
          file_url: file_url || null,
        });

        io.to(`room:${room_id}`).emit('new_message', message);
      } catch (err) {
        logger.error('Socket send_message error', { message: err.message });
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    socket.on('typing', ({ room_id }) => {
      socket.to(`room:${room_id}`).emit('user_typing', {
        user_id: socket.user.id,
        role: socket.user.role,
      });
    });

    socket.on('disconnect', () => {
      logger.info('Socket disconnected', { userId: socket.user?.id });
    });
  });

  logger.info('Socket.io server initialized');
  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}

module.exports = { initSocketServer, getIO };
