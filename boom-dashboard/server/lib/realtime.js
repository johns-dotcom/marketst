/**
 * Realtime transport — the websocket layer behind the team message board.
 *
 * One socket.io server attached to the Express http.Server (see the boot block
 * at the bottom of index.js). Sockets authenticate with the SAME JWT the REST
 * API uses, re-verified against the live `users` row exactly the way
 * middleware/auth.js does — a socket that outlived a forced logout would be a
 * session-invalidation hole, and sockets live for hours.
 *
 * ── Delivery model ──
 * Mutations NEVER travel over a socket. Every write goes through the REST
 * routes in routes/chat.js, where auth, validation and membership checks live
 * once; those handlers then call the emit* helpers below to fan the change out.
 * Sockets carry only ephemeral signals in the other direction: typing, and a
 * join request for a channel the client just created.
 *
 * ── Rooms ──
 *   user:<id>      every socket for one person (multi-tab safe)
 *   channel:<id>   the members of one chat channel
 *   all            every connected user — presence broadcasts
 *
 * This app is single-tenant: there is no label/workspace scoping anywhere here.
 * The reference implementation this was ported from is multi-tenant and scopes
 * every room and query by `label_id`; that column does not exist in this repo.
 */
const jwt = require('jsonwebtoken');
const pool = require('../db');

let io = null;

// userId -> number of live sockets. A user with three tabs open is ONE online
// person; presence only broadcasts on the 0→1 and 1→0 transitions so opening a
// tab doesn't spam every connected client.
const presence = new Map();

function onlineUsers() {
  return [...presence.keys()];
}

// Returns 'online' when this bump took the user from offline to online,
// false when it took them to offline, and true for every other tab churn.
function bumpPresence(userId, delta) {
  userId = Number(userId);
  const next = (presence.get(userId) || 0) + delta;
  if (next <= 0) { presence.delete(userId); return false; }
  presence.set(userId, next);
  return next === 1 && delta > 0 ? 'online' : true;
}

// The channel rooms a socket should join on connect, so REST broadcasts reach
// it without the client having to subscribe to anything.
async function channelRooms(userId) {
  try {
    const { rows } = await pool.query(
      'SELECT channel_id FROM chat_members WHERE user_id = $1',
      [userId]
    );
    return rows.map(r => `channel:${r.channel_id}`);
  } catch {
    // chat_members may not exist yet on a first boot — migrations run in the
    // background after listen(). An empty room list is correct then.
    return [];
  }
}

function init(server) {
  const { Server } = require('socket.io');

  // The socket.io server needs its OWN dev origin allowlist. There is no Vite
  // proxy in this repo — client/src/api.js points at http://localhost:3001/api
  // directly — so in dev the handshake is genuinely cross-origin (:5173 → :3001)
  // and Express's own cors() middleware never sees it. In production Express
  // serves the React build, so the two are same-origin.
  io = new Server(server, {
    path: '/socket.io',
    cors: process.env.NODE_ENV !== 'production'
      ? { origin: ['http://localhost:5173', 'http://localhost:3001'], credentials: true }
      : { origin: true, credentials: true },
  });

  // ── Handshake auth ──────────────────────────────────────────────────────
  // Mirrors middleware/auth.js: verify the JWT, then re-read the user row so a
  // bumped token_version (forced logout / password change) kills the socket
  // too. The claim in this app is `id`, not `user_id`.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('No token'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (!decoded.id) return next(new Error('Malformed token'));

      const { rows } = await pool.query(
        'SELECT token_version, role, name, is_test FROM users WHERE id = $1',
        [decoded.id]
      );
      if (!rows.length) return next(new Error('No such user'));
      if (decoded.tv !== undefined && rows[0].token_version !== decoded.tv) {
        return next(new Error('Stale session'));
      }
      // Test accounts are blocked from every real-data endpoint by
      // middleware/testUserGuard.js. A socket is a real-data endpoint: piping
      // internal staff conversation into the demo account is exactly what that
      // guard exists to prevent, so the handshake refuses here too.
      if (rows[0].is_test === true) return next(new Error('Not available in demo mode'));

      socket.user = {
        id: decoded.id,
        name: rows[0].name || decoded.name,
        role: rows[0].role || decoded.role,
      };
      next();
    } catch {
      next(new Error('Auth failed'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.user.id;
    socket.join(`user:${userId}`);
    socket.join('all');
    for (const room of await channelRooms(userId)) socket.join(room);

    const state = bumpPresence(userId, +1);
    if (state === 'online') io.to('all').emit('presence:update', { userId, online: true });
    socket.emit('presence:list', { online: onlineUsers() });

    // Typing relay — ephemeral, never persisted, scoped to the channel room.
    // socket.to(room) excludes the sender, which is what we want.
    socket.on('typing', (payload) => {
      const channelId = Number(payload?.channelId);
      if (!Number.isInteger(channelId)) return;
      socket.to(`channel:${channelId}`).emit('typing', { channelId, userId, name: socket.user.name });
    });
    socket.on('typing:stop', (payload) => {
      const channelId = Number(payload?.channelId);
      if (!Number.isInteger(channelId)) return;
      socket.to(`channel:${channelId}`).emit('typing:stop', { channelId, userId });
    });

    // Let a socket join a channel room the moment it creates or joins a
    // channel, without needing to reconnect. The REST route already emitted
    // 'channel:new' to this user; this is the client's acknowledgement.
    //
    // Membership is re-checked against the DB — a socket event is client input,
    // and joining a room you aren't a member of would leak every message
    // broadcast to it. addUsersToChannelRoom() below is the server-driven path
    // and does not need this check because the route just wrote the membership.
    socket.on('channel:subscribe', async (payload) => {
      const channelId = Number(payload?.channelId);
      if (!Number.isInteger(channelId)) return;
      try {
        const { rows } = await pool.query(
          'SELECT 1 FROM chat_members WHERE channel_id = $1 AND user_id = $2',
          [channelId, userId]
        );
        if (rows.length) socket.join(`channel:${channelId}`);
      } catch { /* transient — the next connect rejoins from channelRooms() */ }
    });

    socket.on('disconnect', () => {
      if (bumpPresence(userId, -1) === false) {
        io.to('all').emit('presence:update', { userId, online: false });
      }
    });
  });

  return io;
}

// ── Emit helpers, called from the REST routes ──────────────────────────────
// All of them no-op when init() hasn't run (scripts that require a route file
// without booting the server), so a missing transport never throws into a
// request handler.
function emitToChannel(channelId, event, payload) {
  if (io) io.to(`channel:${channelId}`).emit(event, payload);
}
function emitToUser(userId, event, payload) {
  if (io) io.to(`user:${userId}`).emit(event, payload);
}
function emitToAll(event, payload) {
  if (io) io.to('all').emit(event, payload);
}

// Force already-connected sockets into a channel room — used when a channel or
// DM is created so its members get live messages without a reconnect.
function addUsersToChannelRoom(channelId, userIds) {
  if (!io) return;
  for (const uid of userIds) io.to(`user:${uid}`).socketsJoin(`channel:${channelId}`);
}

function close() { if (io) io.close(); }

module.exports = {
  init,
  emitToChannel,
  emitToUser,
  emitToAll,
  addUsersToChannelRoom,
  onlineUsers,
  close,
};
