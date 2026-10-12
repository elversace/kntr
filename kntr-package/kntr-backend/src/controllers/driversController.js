const { query, getClient } = require('../config/database');
const { success, error, paginated, getPagination, buildPagination, calculateDistance } = require('../utils/helpers');
const { auditLog } = require('../middleware/errorHandler');
const { stripOrderSecrets } = require('../utils/orderAccess');
const { revokeDriverFeedSockets, withDriverFeedLock } = require('../services/socketService');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { resolveFilename, legacyFilename, removeUnreferencedFile } = require('../utils/documentStorage');

// ─── Get Available Orders ─────────────────────────────────────
const getAvailableOrders = async (req, res, next) => {
  try {
    const { vehicle_type, page, limit } = req.query;
    const { page: p, limit: l, offset } = getPagination(page, limit);

    // Get driver's current location and vehicle type
    const driverRes = await query(
      `SELECT d.*, dv.vehicle_type as v_type, dv.id as vehicle_id
       FROM drivers d
       LEFT JOIN driver_vehicles dv ON dv.driver_id = d.user_id AND dv.is_active = true
       WHERE d.user_id = $1`,
      [req.user.id]
    );

    if (!driverRes.rows.length) {
      return error(res, 'Driver profile not found', 'NOT_FOUND', 404);
    }

    const driver = driverRes.rows[0];

    if (driver.driver_status !== 'approved') {
      return error(res, 'Driver not approved yet', 'NOT_APPROVED', 403);
    }

    if (driver.availability !== 'available') {
      return error(res, 'Set availability to available first', 'NOT_AVAILABLE', 400);
    }

    const vehicleTypes = [...new Set(driverRes.rows.map((row) => row.v_type).filter(Boolean))];
    if (!vehicleTypes.length) {
      return error(res, 'Register an active vehicle before viewing orders', 'VEHICLE_REQUIRED', 400);
    }
    if (vehicle_type && !vehicleTypes.includes(vehicle_type)) {
      return error(res, 'This vehicle type is not registered to you', 'FORBIDDEN', 403);
    }
    const eligibleTypes = vehicle_type ? [vehicle_type] : vehicleTypes;

    const countRes = await query(
      `SELECT COUNT(*) FROM orders WHERE status = 'pending' AND driver_id IS NULL AND vehicle_type = ANY($1::text[])`,
      [eligibleTypes]
    );

    const ordersRes = await query(
      `SELECT o.*,
              u.full_name_ar as customer_name,
              u.phone as customer_phone
       FROM orders o
       JOIN users u ON u.id = o.customer_id
       WHERE o.status = 'pending'
         AND o.vehicle_type = ANY($1::text[])
         AND o.driver_id IS NULL
       ORDER BY
         CASE o.priority WHEN 'urgent' THEN 1 WHEN 'priority' THEN 2 ELSE 3 END,
         o.created_at ASC
       LIMIT $2 OFFSET $3`,
      [eligibleTypes, l, offset]
    );

    return paginated(res, ordersRes.rows.map(stripOrderSecrets), buildPagination(p, l, parseInt(countRes.rows[0].count)));
  } catch (err) {
    next(err);
  }
};

// ─── Accept Order ─────────────────────────────────────────────
const acceptOrder = async (req, res, next) => {
  if (req.user.role !== 'driver') {
    return error(res, 'Only approved drivers can accept orders', 'FORBIDDEN', 403);
  }
  let client;
  try {
    client = await getClient();
    await client.query('BEGIN');

    const { order_id } = req.params;
    const { vehicle_id } = req.body;

    // Check driver approved & available
    const driverRes = await client.query(
      `SELECT d.*, u.full_name_ar, u.phone FROM drivers d
       JOIN users u ON u.id = d.user_id WHERE d.user_id = $1 FOR UPDATE OF d`,
      [req.user.id]
    );
    if (!driverRes.rows.length) {
      await client.query('ROLLBACK');
      return error(res, 'Driver profile not found', 'NOT_FOUND', 404);
    }
    const driver = driverRes.rows[0];

    if (driver.driver_status !== 'approved') {
      await client.query('ROLLBACK');
      return error(res, 'Driver not approved', 'NOT_APPROVED', 403);
    }
    if (driver.availability !== 'available') {
      await client.query('ROLLBACK');
      return error(res, 'Driver not available', 'NOT_AVAILABLE', 400);
    }

    // The driver lock serializes acceptance of different orders by one driver.
    const activeOrder = await client.query(
      `SELECT id FROM orders WHERE driver_id = $1 AND status IN ('accepted', 'in_transit') LIMIT 1`,
      [req.user.id]
    );
    if (activeOrder.rows.length) {
      await client.query('ROLLBACK');
      return error(res, 'Finish your current order before accepting another', 'ACTIVE_ORDER', 409);
    }

    // Lock order row
    const orderRes = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND status = 'pending' AND driver_id IS NULL FOR UPDATE`,
      [order_id]
    );

    if (!orderRes.rows.length) {
      await client.query('ROLLBACK');
      return error(res, 'Order not available', 'ORDER_UNAVAILABLE', 409);
    }

    const order = orderRes.rows[0];
    const vehicleParams = [req.user.id, order.vehicle_type];
    let vehicleFilter = '';
    if (vehicle_id) {
      vehicleParams.push(vehicle_id);
      vehicleFilter = ' AND id = $3';
    }
    const vehicleRes = await client.query(
      `SELECT id FROM driver_vehicles WHERE driver_id = $1 AND vehicle_type = $2 AND is_active = true${vehicleFilter} LIMIT 1`,
      vehicleParams
    );
    if (!vehicleRes.rows.length) {
      await client.query('ROLLBACK');
      return error(res, 'An active vehicle owned by you and matching the order is required', 'VEHICLE_MISMATCH', 403);
    }

    await client.query(
      `UPDATE orders SET
         driver_id = $1, status = 'accepted', accepted_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [req.user.id, order_id]
    );

    await client.query(
      `UPDATE drivers SET availability = 'busy' WHERE user_id = $1`,
      [req.user.id]
    );

    await client.query('COMMIT');

    const io = req.app.get('io');
    if (io) {
      await revokeDriverFeedSockets(io, req.user.id);
      io.to('admins').emit('driver_availability_changed', { driver_id: req.user.id, status: 'busy' });
      io.to(`order:${order_id}`).emit('driver_accepted', {
        order_id,
        driver: {
          id: req.user.id,
          name: driver.full_name_ar,
          phone: driver.phone,
          rating: driver.rating,
        },
        accepted_at: new Date().toISOString(),
      });
    }

    return success(res, { order_id, status: 'accepted' }, 'Order accepted');
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
};

// ─── Update Availability ──────────────────────────────────────
const updateAvailability = async (req, res, next) => {
  let client;
  try {
    const { status } = req.body;
    const valid = ['available', 'busy', 'on_break', 'offline'];
    if (!valid.includes(status)) {
      return error(res, `Status must be one of: ${valid.join(', ')}`, 'INVALID_STATUS', 400);
    }

    client = await getClient();
    await client.query('BEGIN');
    const driverRes = await client.query('SELECT * FROM drivers WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    if (!driverRes.rows.length) {
      await client.query('ROLLBACK');
      return error(res, 'Driver profile not found', 'NOT_FOUND', 404);
    }
    if (req.user.role !== 'driver' || driverRes.rows[0].driver_status !== 'approved') {
      await client.query('ROLLBACK');
      return error(res, 'Driver not approved', 'NOT_APPROVED', 403);
    }
    if (status === 'available') {
      const activeOrder = await client.query(
        `SELECT id FROM orders WHERE driver_id = $1 AND status IN ('accepted', 'in_transit') LIMIT 1`,
        [req.user.id]
      );
      if (activeOrder.rows.length) {
        await client.query('ROLLBACK');
        return error(res, 'Cannot become available while you have an active order', 'ACTIVE_ORDER', 409);
      }
    }

    await client.query(
      `UPDATE drivers SET availability = $1 WHERE user_id = $2`,
      [status, req.user.id]
    );
    await client.query('COMMIT');

    const io = req.app.get('io');
    if (io) {
      await revokeDriverFeedSockets(io, req.user.id);
      io.to('admins').emit('driver_availability_changed', { driver_id: req.user.id, status });
    }

    return success(res, { status }, 'Availability updated');
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
};

// ─── Update Location ──────────────────────────────────────────
const updateLocation = async (req, res, next) => {
  try {
    const { lat, lng } = req.body;

    await query(
      `UPDATE drivers SET
         current_lat = $1, current_lng = $2, last_location_update = NOW()
       WHERE user_id = $3`,
      [lat, lng, req.user.id]
    );

    // Broadcast to any active order rooms
    const io = req.app.get('io');
    if (io) {
      const activeOrder = await query(
        `SELECT id FROM orders WHERE driver_id = $1 AND status IN ('accepted','in_transit')`,
        [req.user.id]
      );
      if (activeOrder.rows.length) {
        const orderId = activeOrder.rows[0].id;
        io.to(`order:${orderId}`).emit('driver_location_update', {
          driver_id: req.user.id, lat, lng,
          updated_at: new Date().toISOString(),
        });
      }
    }

    return success(res, { lat, lng });
  } catch (err) {
    next(err);
  }
};

// ─── Get Earnings ─────────────────────────────────────────────
const getEarnings = async (req, res, next) => {
  try {
    const { period = 'week' } = req.query;

    const periodMap = { today: '1 day', week: '7 days', month: '30 days' };
    const interval = periodMap[period] || '7 days';

    const earningsRes = await query(
      `SELECT
         COALESCE(SUM(driver_earnings), 0) as total_earnings,
         COALESCE(SUM(tip_amount), 0) as total_tips,
         COUNT(*) as trip_count,
         AVG(driver_earnings) as avg_per_trip
       FROM orders
       WHERE driver_id = $1
         AND status = 'delivered'
         AND delivered_at >= NOW() - INTERVAL '${interval}'`,
      [req.user.id]
    );

    const breakdown = await query(
      `SELECT id, pickup_address, dropoff_address, driver_earnings, tip_amount,
              final_price, distance, delivered_at
       FROM orders
       WHERE driver_id = $1 AND status = 'delivered'
         AND delivered_at >= NOW() - INTERVAL '${interval}'
       ORDER BY delivered_at DESC`,
      [req.user.id]
    );

    const stats = earningsRes.rows[0];

    return success(res, {
      period,
      total_earnings: parseFloat(stats.total_earnings),
      total_tips: parseFloat(stats.total_tips),
      trip_count: parseInt(stats.trip_count),
      avg_per_trip: parseFloat(stats.avg_per_trip || 0),
      breakdown: breakdown.rows,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Upload Document ──────────────────────────────────────────
const discardNewDocumentFile = async (file) => {
  if (!file?.filename) return;
  let filename;
  try { filename = resolveFilename(file.filename); } catch { return; }
  if (!filename) return;
  await fs.unlink(filename).catch(err => {
    if (err.code !== 'ENOENT') console.error('Document upload cleanup failed:', err.message);
  });
};

const uploadDocument = async (req, res, next) => {
  req.documentUploadCleanupManaged = true;
  let client;
  let committed = false;
  let commitAttempted = false;
  try {
    const { document_type, document_number, expiry_date, issue_date } = req.body;

    if (!req.file) {
      return error(res, 'Document file required', 'FILE_REQUIRED', 400);
    }

    const validTypes = ['license', 'insurance', 'registration', 'criminal_record'];
    if (!validTypes.includes(document_type)) {
      await discardNewDocumentFile(req.file);
      return error(res, `Document type must be: ${validTypes.join(', ')}`, 'INVALID_TYPE', 400);
    }
    if (req.user.role !== 'driver') {
      await discardNewDocumentFile(req.file);
      return error(res, 'Only a driver can upload these documents', 'FORBIDDEN', 403);
    }

    client = await getClient();
    await client.query('BEGIN');
    const driver = await client.query('SELECT user_id FROM drivers WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    if (!driver.rows.length) {
      await client.query('ROLLBACK');
      await discardNewDocumentFile(req.file);
      return error(res, 'Driver profile not found', 'NOT_FOUND', 404);
    }
    // Serializing on the driver's row also covers concurrent first uploads,
    // when there is no existing document row to lock yet.
    const previous = await client.query(
      'SELECT id, storage_filename, document_url FROM driver_documents WHERE driver_id = $1 AND document_type = $2',
      [req.user.id, document_type]
    );
    const previousDocument = previous.rows[0];
    const documentId = previousDocument?.id || randomUUID();
    const documentUrl = `/v1/drivers/documents/${documentId}/file`;

    const document = await client.query(
      `INSERT INTO driver_documents
         (id, driver_id, document_type, document_url, storage_filename, document_number, issue_date, expiry_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
         (CASE WHEN $8::date < CURRENT_DATE THEN 'expired'
               WHEN $8::date <= CURRENT_DATE + 30 THEN 'expiring'
               ELSE 'valid' END)::document_status)
       ON CONFLICT (driver_id, document_type) DO UPDATE SET
         document_url = EXCLUDED.document_url,
         storage_filename = EXCLUDED.storage_filename,
         document_number = EXCLUDED.document_number,
         issue_date = EXCLUDED.issue_date,
         expiry_date = EXCLUDED.expiry_date,
         status = EXCLUDED.status,
         verified_by = NULL,
         verified_at = NULL,
         updated_at = clock_timestamp()
       RETURNING id, document_type, document_url, status, expiry_date`,
      [documentId, req.user.id, document_type, documentUrl, req.file.filename,
        document_number || null, issue_date || null, expiry_date || null]
    );
    commitAttempted = true;
    req.documentUploadCommitPending = true;
    await client.query('COMMIT');
    committed = true;
    req.documentUploadCommitted = true;
    req.documentUploadCommitPending = false;
    client.release();
    client = null;

    await auditLog(req.user.id, 'driver_document_uploaded', 'driver_document', documentId,
      { document_type, replaced: !!previousDocument }, req);
    const oldFilename = previousDocument?.storage_filename || legacyFilename(previousDocument?.document_url);
    if (oldFilename && oldFilename !== req.file.filename) {
      // Cleanup failure retains a private old file, never loses the new upload.
      await removeUnreferencedFile(oldFilename).catch(err => {
        console.error('Previous document cleanup failed:', err.message);
      });
    }
    const { id, ...data } = document.rows[0];
    return success(res, { document_id: id, ...data }, 'Document uploaded');
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (!committed) {
      if (commitAttempted) {
        // A lost COMMIT acknowledgement is ambiguous. Check persistent
        // references before deleting the file, and retain it if the DB is down.
        await removeUnreferencedFile(req.file.filename).catch(cleanup => {
          console.error('Uncertain document commit cleanup failed:', cleanup.message);
        });
      } else {
        await discardNewDocumentFile(req.file);
      }
    }
    next(err);
  } finally {
    client?.release();
  }
};

// Documents are private even when an older installation still has /uploads URLs.
const getDocumentFile = async (req, res, next) => {
  try {
    const result = await query(
      'SELECT id, driver_id, storage_filename, document_url FROM driver_documents WHERE id = $1',
      [req.params.document_id]
    );
    if (!result.rows.length) return error(res, 'Document not found', 'NOT_FOUND', 404);
    const document = result.rows[0];
    if (req.user.role !== 'admin' &&
        !(req.user.role === 'driver' && req.user.id === document.driver_id)) {
      return error(res, 'You do not have permission to read this document', 'FORBIDDEN', 403);
    }
    const filename = document.storage_filename || legacyFilename(document.document_url);
    let filePath;
    try { filePath = resolveFilename(filename); } catch { filePath = null; }
    if (!filePath) return error(res, 'Document file not found', 'NOT_FOUND', 404);
    const info = await fs.lstat(filePath).catch(err => {
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(err.code)) return null;
      throw err;
    });
    // Reject directories and symlinks instead of following an unexpected path.
    if (!info?.isFile()) return error(res, 'Document file not found', 'NOT_FOUND', 404);
    const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf' };
    const mimeType = mimeTypes[path.extname(filename).toLowerCase()];
    if (!mimeType) return error(res, 'Document file not found', 'NOT_FOUND', 404);
    return res.download(filePath, filename, {
      headers: { 'Content-Type': mimeType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' },
    }, err => {
      if (!err) return;
      if (res.headersSent) return next(err);
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(err.code) || err.status === 404 || err.statusCode === 404) {
        return error(res, 'Document file not found', 'NOT_FOUND', 404);
      }
      next(err);
    });
  } catch (err) {
    next(err);
  }
};

// ─── Add Vehicle ──────────────────────────────────────────────
const addVehicle = async (req, res, next) => {
  try {
    const { vehicle_type, plate_number, make, model, year, color, photos = [] } = req.body;

    const vehicleRes = await query(
      `INSERT INTO driver_vehicles (driver_id, vehicle_type, plate_number, make, model, year, color, photos)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, vehicle_type, plate_number.toUpperCase(), make || null, model || null, year || null, color || null, JSON.stringify(photos)]
    );

    return success(res, vehicleRes.rows[0], 'Vehicle added', 201);
  } catch (err) {
    next(err);
  }
};

// ─── Panic Button ─────────────────────────────────────────────
const panicButton = async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const { lat, lng, reason = 'emergency' } = req.body;

    const driverRes = await client.query(
      `SELECT u.full_name_ar, u.phone FROM users u WHERE u.id = $1`,
      [req.user.id]
    );
    const driver = driverRes.rows[0];

    // Get active order
    const orderRes = await client.query(
      `SELECT id FROM orders WHERE driver_id = $1 AND status IN ('accepted','in_transit') LIMIT 1`,
      [req.user.id]
    );
    const orderId = orderRes.rows[0]?.id || null;

    // Create urgent support ticket
    const ticketRes = await client.query(
      `INSERT INTO support_tickets (user_id, order_id, type, priority, subject, description)
       VALUES ($1,$2,'other','urgent',$3,$4) RETURNING id`,
      [
        req.user.id,
        orderId,
        `🚨 زر الطوارئ — ${driver.full_name_ar}`,
        `السائق ${driver.full_name_ar} (${driver.phone}) ضغط زر الطوارئ.\nالموقع: ${lat}, ${lng}\nالسبب: ${reason}\nالطلب: ${orderId || 'غير محدد'}`,
      ]
    );

    await client.query('COMMIT');

    // Notify admins via socket
    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('panic_alert', {
        driver_id: req.user.id,
        driver_name: driver.full_name_ar,
        driver_phone: driver.phone,
        lat, lng, reason,
        order_id: orderId,
        ticket_id: ticketRes.rows[0].id,
        timestamp: new Date().toISOString(),
      });
    }

    await auditLog(req.user.id, 'driver_panic', 'driver', req.user.id, { lat, lng, reason }, req);

    return success(res, {
      alert_sent: true,
      support_notified: true,
      ticket_id: ticketRes.rows[0].id,
    }, 'Emergency alert sent');
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ─── Get Driver Profile ───────────────────────────────────────
const getDriverProfile = async (req, res, next) => {
  try {
    const driverId = req.params.driver_id || req.user.id;

    const driverRes = await query(
      `SELECT u.id, u.full_name_ar, u.full_name_en, u.phone, u.email, u.preferred_language,
              d.driver_status, d.availability, d.rating, d.total_trips, d.total_earnings,
              d.accepts_intercity, d.current_lat, d.current_lng, d.last_location_update, d.approved_at
       FROM users u
       JOIN drivers d ON d.user_id = u.id
       WHERE u.id = $1`,
      [driverId]
    );

    if (!driverRes.rows.length) {
      return error(res, 'Driver not found', 'NOT_FOUND', 404);
    }

    const driver = driverRes.rows[0];

    const vehicles = await query(
      `SELECT * FROM driver_vehicles WHERE driver_id = $1 AND is_active = true`,
      [driverId]
    );

    const docs = await query(
      `SELECT document_type, document_url, status, expiry_date, verified_at
       FROM driver_documents WHERE driver_id = $1`,
      [driverId]
    );

    return success(res, { ...driver, vehicles: vehicles.rows, documents: docs.rows });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAvailableOrders,
  acceptOrder: (req, res, next) => withDriverFeedLock(req.user.id, () => acceptOrder(req, res, next)),
  updateAvailability: (req, res, next) => withDriverFeedLock(req.user.id, () => updateAvailability(req, res, next)),
  updateLocation, getEarnings, uploadDocument, getDocumentFile, addVehicle,
  panicButton, getDriverProfile,
};
