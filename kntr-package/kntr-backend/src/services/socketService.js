const { createHash } = require('crypto');
const { verifyToken } = require('../utils/jwt');
const { query } = require('../config/database');

const ORDER_ID = /^ORD-\d{5,16}$/;
const VEHICLE_TYPES = ['motorcycle', 'car', 'van', 'truck'];
const TRACKING_ROLES = ['admin', 'support'];
const PUBLIC_ERROR_CODES = new Set([
  'UNAUTHORIZED', 'TOKEN_INVALID', 'SESSION_EXPIRED', 'ACCOUNT_INACTIVE',
  'NOT_FOUND', 'FORBIDDEN', 'VALIDATION_ERROR',
]);
const sessionRoom = (token) => `session:${createHash('sha256').update(token).digest('hex')}`;
const socketFailure = (code, message) => Object.assign(new Error(message), { code });
const isPayload = (payload) => payload !== null && typeof payload === 'object' && !Array.isArray(payload);
const validOrderId = (id) => typeof id === 'string' && ORDER_ID.test(id);
const validCoordinates = (lat, lng) => (
  typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
  typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180
);

// Serialize feed membership with the REST availability/acceptance change and its revocation.
const driverFeedLocks = new Map();
const withDriverFeedLock = async (userId, work) => {
  const previous = driverFeedLocks.get(userId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  driverFeedLocks.set(userId, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (driverFeedLocks.get(userId) === current) driverFeedLocks.delete(userId);
  }
};

// Use database identity and permissions, never the role embedded in an old JWT.
const authenticateSocket = async (token) => {
  if (typeof token !== 'string' || !token) throw socketFailure('UNAUTHORIZED', 'Authorization token required');
  const decoded = verifyToken(token);
  if (!decoded || decoded.type === 'refresh') throw socketFailure('TOKEN_INVALID', 'Invalid or expired token');

  const result = await query(
    `SELECT u.id, u.role, u.full_name_ar, u.status, u.deleted_at, s.expires_at, d.driver_status, d.availability,
            ARRAY(SELECT dv.vehicle_type FROM driver_vehicles dv
                  WHERE dv.driver_id = u.id AND dv.is_active = true) AS vehicle_types
     FROM sessions s JOIN users u ON u.id = s.user_id
     LEFT JOIN drivers d ON d.user_id = u.id
     WHERE s.token = $1 AND s.expires_at > NOW()`,
    [token]
  );
  const user = result.rows[0];
  if (!user || user.id !== decoded.id) throw socketFailure('SESSION_EXPIRED', 'Session expired or revoked');
  if (user.status !== 'active' || user.deleted_at) throw socketFailure('ACCOUNT_INACTIVE', 'Account is not active');

  return { user, expiresAt: Math.min(new Date(user.expires_at).getTime(), decoded.exp * 1000) };
};

const getOrder = async (orderId) => {
  const result = await query('SELECT id, customer_id, driver_id, status FROM orders WHERE id = $1', [orderId]);
  if (!result.rows.length) throw socketFailure('NOT_FOUND', 'Order not found');
  return result.rows[0];
};

const mayAccessOrder = (user, order) => (
  TRACKING_ROLES.includes(user.role) ||
  (user.role === 'customer' && order.customer_id === user.id) ||
  (user.role === 'driver' && user.driver_status === 'approved' && order.driver_id === user.id)
);

const disconnectUserSockets = (io, userId) => {
  if (io && userId) io.in(`user:${userId}`).disconnectSockets(true);
};

const disconnectSessionSockets = (io, token) => {
  if (io && typeof token === 'string' && token) io.in(sessionRoom(token)).disconnectSockets(true);
};

// Availability changes revoke only the feed, preserving an ongoing order's tracking/chat.
const revokeDriverFeedSockets = async (io, userId) => {
  if (!io || !userId) return;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const socket of sockets) {
    for (const room of socket.rooms) {
      if (room.startsWith('drivers:')) await socket.leave(room);
    }
  }
};

// Emit under the same driver lock as availability changes, with fresh authorization.
// A vehicle room alone is never proof that a socket may still receive the feed.
const emitNewOrder = async (io, vehicleType, payload) => {
  if (!io || !VEHICLE_TYPES.includes(vehicleType)) return 0;
  const room = `drivers:${vehicleType}`;
  const sockets = await io.in(room).fetchSockets();
  const byDriver = new Map();
  for (const socket of sockets) {
    const userId = socket.user?.id;
    if (!userId) {
      await socket.leave(room);
      continue;
    }
    if (!byDriver.has(userId)) byDriver.set(userId, []);
    byDriver.get(userId).push(socket);
  }
  const emitted = await Promise.all([...byDriver].map(([userId, driverSockets]) => (
    withDriverFeedLock(userId, async () => {
      let count = 0;
      for (const socket of driverSockets) {
        if (!socket.connected || !socket.rooms.has(room)) continue;
        try {
          const { user } = await authenticateSocket(socket.authToken);
          if (!socket.connected || !socket.rooms.has(room)) continue;
          if (user.role !== 'driver' || user.driver_status !== 'approved' || user.availability !== 'available' ||
              !user.vehicle_types.includes(vehicleType)) {
            await socket.leave(room);
            continue;
          }
          socket.user = user;
          socket.emit('new_order', payload);
          count++;
        } catch (err) {
          await socket.leave(room);
          if (['UNAUTHORIZED', 'TOKEN_INVALID', 'SESSION_EXPIRED', 'ACCOUNT_INACTIVE'].includes(err.code)) {
            socket.disconnect(true);
          }
        }
      }
      return count;
    })
  )));
  return emitted.reduce((total, count) => total + count, 0);
};

const setupSocketIO = (io) => {
  io.use(async (socket, next) => {
    try {
      const authorization = socket.handshake.headers?.authorization;
      const token = socket.handshake.auth?.token ||
        (typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : null);
      const auth = await authenticateSocket(token);
      socket.user = auth.user;
      socket.authToken = token;
      socket.authExpiresAt = auth.expiresAt;
      next();
    } catch (err) {
      const isPublic = PUBLIC_ERROR_CODES.has(err.code);
      const failure = new Error(isPublic ? err.message : 'Authentication failed');
      failure.data = { code: isPublic ? err.code : 'AUTH_ERROR' };
      next(failure);
    }
  });

  io.on('connection', (socket) => {
    const privateRoomsReady = Promise.all([
      socket.join(`user:${socket.user.id}`),
      socket.join(sessionRoom(socket.authToken)),
    ]);
    let expiryTimer;
    const scheduleExpiry = () => {
      clearTimeout(expiryTimer);
      const remaining = socket.authExpiresAt - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        socket.disconnect(true);
        return;
      }
      expiryTimer = setTimeout(() => {
        if (socket.authExpiresAt <= Date.now()) socket.disconnect(true);
        else scheduleExpiry();
      }, Math.min(remaining, 2147483647));
      expiryTimer.unref?.();
    };
    scheduleExpiry();
    const syncPermissionRooms = async () => {
      if (!socket.connected) return;
      if (socket.user.role === 'driver' && socket.user.driver_status === 'approved') {
        await socket.join(`driver:${socket.user.id}`);
      } else {
        await socket.leave(`driver:${socket.user.id}`);
      }
      if (TRACKING_ROLES.includes(socket.user.role)) await socket.join('admins');
      else await socket.leave('admins');
      for (const room of [...socket.rooms]) {
        if (room.startsWith('drivers:') &&
            (socket.user.role !== 'driver' || socket.user.driver_status !== 'approved' || socket.user.availability !== 'available' ||
             !socket.user.vehicle_types.includes(room.slice('drivers:'.length)))) {
          await socket.leave(room);
        }
        if (room.startsWith('order:')) {
          // Stop receiving while checking a previously authorized subscription.
          await socket.leave(room);
          try {
            const order = await getOrder(room.slice('order:'.length));
            if (socket.connected && mayAccessOrder(socket.user, order)) await socket.join(room);
          } catch (err) {
            if (err.code !== 'NOT_FOUND') throw err;
          }
        }
      }
    };
    // A logout between middleware and room registration must not leave an idle socket authorized.
    const initialization = privateRoomsReady.then(async () => {
      const auth = await authenticateSocket(socket.authToken);
      if (!socket.connected) return false;
      socket.user = auth.user;
      socket.authExpiresAt = auth.expiresAt;
      scheduleExpiry();
      await syncPermissionRooms();
      return socket.connected;
    }).catch(() => {
      socket.disconnect(true);
      return false;
    });

    // All inbound operations refresh the session and return stable validation/permission errors.
    const onAuthorized = (event, handler) => socket.on(event, async (payload, acknowledgment) => {
      const respond = (response) => {
        if (typeof acknowledgment === 'function') acknowledgment(response);
      };
      try {
        if (!(await initialization)) return;
        const auth = await authenticateSocket(socket.authToken);
        if (!socket.connected) return;
        socket.user = auth.user;
        socket.authExpiresAt = auth.expiresAt;
        scheduleExpiry();
        await syncPermissionRooms();
        if (!isPayload(payload)) throw socketFailure('VALIDATION_ERROR', 'Event payload must be an object');
        const data = await handler(payload, auth.user);
        respond({ success: true, data });
      } catch (err) {
        const isPublic = PUBLIC_ERROR_CODES.has(err.code);
        const error = { code: isPublic ? err.code : 'SERVER_ERROR', message: isPublic ? err.message : 'Unable to process event' };
        socket.emit('operation_error', { event, ...error });
        respond({ success: false, error });
        if (['UNAUTHORIZED', 'TOKEN_INVALID', 'SESSION_EXPIRED', 'ACCOUNT_INACTIVE'].includes(error.code)) {
          socket.disconnect(true);
        }
      }
    });

    onAuthorized('track_order', async ({ order_id }, user) => {
      if (!validOrderId(order_id)) throw socketFailure('VALIDATION_ERROR', 'Valid order_id required');
      const order = await getOrder(order_id);
      if (!mayAccessOrder(user, order)) throw socketFailure('FORBIDDEN', 'Order access denied');
      if (!socket.connected) throw socketFailure('SESSION_EXPIRED', 'Session expired or revoked');
      await socket.join(`order:${order.id}`);
      const data = { order_id: order.id };
      socket.emit('tracking_started', data);
      return data;
    });

    onAuthorized('join_driver_room', async ({ vehicle_type }, user) => withDriverFeedLock(user.id, async () => {
      if (!VEHICLE_TYPES.includes(vehicle_type)) throw socketFailure('VALIDATION_ERROR', 'Invalid vehicle_type');
      const auth = await authenticateSocket(socket.authToken);
      if (!socket.connected) throw socketFailure('SESSION_EXPIRED', 'Session expired or revoked');
      const current = auth.user;
      if (current.role !== 'driver' || current.driver_status !== 'approved' || current.availability !== 'available' || !current.vehicle_types.includes(vehicle_type)) {
        throw socketFailure('FORBIDDEN', 'Available approved driver with matching active vehicle required');
      }
      const room = `drivers:${vehicle_type}`;
      await socket.join(room);
      if (!socket.connected) throw socketFailure('SESSION_EXPIRED', 'Session expired or revoked');
      socket.emit('joined_room', { room });
      return { room };
    }));

    onAuthorized('driver_location', async ({ lat, lng, order_id }, user) => {
      if (!validCoordinates(lat, lng)) throw socketFailure('VALIDATION_ERROR', 'Valid numeric coordinates required');
      if (user.role !== 'driver' || user.driver_status !== 'approved') {
        throw socketFailure('FORBIDDEN', 'Approved driver required');
      }
      let order;
      if (order_id !== undefined && order_id !== null) {
        if (!validOrderId(order_id)) throw socketFailure('VALIDATION_ERROR', 'Valid order_id required');
        order = await getOrder(order_id);
        if (order.driver_id !== user.id || !['accepted', 'in_transit'].includes(order.status)) {
          throw socketFailure('FORBIDDEN', 'Only the assigned driver may update an active order');
        }
      }
      if (!socket.connected) throw socketFailure('SESSION_EXPIRED', 'Session expired or revoked');
      const updated = await query(
        `UPDATE drivers SET current_lat=$1, current_lng=$2, last_location_update=NOW()
         WHERE user_id=$3 AND driver_status='approved'
           AND EXISTS (
             SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
             WHERE s.token=$4 AND s.user_id=$3 AND s.expires_at > NOW()
               AND u.role='driver' AND u.status='active' AND u.deleted_at IS NULL
           )
           AND ($5::varchar IS NULL OR EXISTS (
             SELECT 1 FROM orders o WHERE o.id=$5 AND o.driver_id=$3
               AND o.status IN ('accepted','in_transit')
           ))
         RETURNING user_id`,
        [lat, lng, user.id, socket.authToken, order?.id || null]
      );
      if (updated.rowCount !== 1) throw socketFailure('FORBIDDEN', 'Driver or order authorization changed');
      if (!socket.connected) throw socketFailure('SESSION_EXPIRED', 'Session expired or revoked');
      if (order) {
        io.to(`order:${order.id}`).emit('driver_location_update', {
          driver_id: user.id, lat, lng, updated_at: new Date().toISOString(),
        });
      }
      io.to('admins').emit('driver_moved', { driver_id: user.id, lat, lng });
      return { updated: true };
    });

    onAuthorized('chat_message', async ({ order_id, message }, user) => {
      if (!validOrderId(order_id) || typeof message !== 'string' || !message.trim() || message.length > 2000) {
        throw socketFailure('VALIDATION_ERROR', 'Valid order_id and message of 1–2000 characters required');
      }
      const order = await getOrder(order_id);
      if (!mayAccessOrder(user, order)) throw socketFailure('FORBIDDEN', 'Order access denied');
      if (!socket.connected) throw socketFailure('SESSION_EXPIRED', 'Session expired or revoked');
      io.to(`order:${order.id}`).emit('chat_message', {
        from: user.id, role: user.role, name: user.full_name_ar,
        message: message.trim(), timestamp: new Date().toISOString(),
      });
      return { sent: true };
    });

    socket.on('disconnect', () => clearTimeout(expiryTimer));
  });

  console.log('✅ Socket.io initialized');
};

module.exports = {
  setupSocketIO, disconnectUserSockets, disconnectSessionSockets,
  revokeDriverFeedSockets, withDriverFeedLock, emitNewOrder,
};
