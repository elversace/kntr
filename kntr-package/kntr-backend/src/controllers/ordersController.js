const QRCode = require('qrcode');
const { randomUUID: uuidv4 } = require('node:crypto');
const { query, getClient } = require('../config/database');
const { success, error, paginated, calculatePrice, calculateDistance, getCustomerTier, getPagination, buildPagination } = require('../utils/helpers');
const { auditLog } = require('../middleware/errorHandler');
const { GLOBAL_ORDER_READ_ROLES, canReadOrder, isOrderCustomer, isApprovedAssignedDriver, stripOrderSecrets } = require('../utils/orderAccess');
const { emitNewOrder } = require('../services/socketService');
const { DeliveryError, qrLifetimeMs, qrTiming, completeDelivery } = require('../services/deliveryService');
const { PaymentError, fundOrder, refundOrderForCancellation } = require('../services/paymentService');

// ─── Create Order ─────────────────────────────────────────────
const createOrder = async (req, res, next) => {
  let client;
  try {
    if (['card', 'bank_transfer'].includes(req.body.payment_method)) {
      return error(res, 'This payment method requires a configured payment provider', 'PAYMENT_UNAVAILABLE', 409);
    }
    client = await getClient();
    await client.query('BEGIN');

    const {
      pickup, dropoff,
      package_description, package_weight, package_photos = [],
      package_count = 1, special_instructions,
      vehicle_type, priority = 'standard',
      scheduled_pickup_time, payment_method = 'cash',
    } = req.body;

    // Get customer tier for discount
    const custRes = await client.query(
      'SELECT tier, total_orders FROM customers WHERE user_id = $1',
      [req.user.id]
    );
    if (!custRes.rows.length) {
      await client.query('ROLLBACK');
      return error(res, 'Customer profile not found', 'NOT_FOUND', 404);
    }
    const { tier, total_orders } = custRes.rows[0];

    // Calculate distance
    const distance = calculateDistance(
      pickup.lat, pickup.lng,
      dropoff.lat, dropoff.lng
    );

    // Calculate price
    const pricing = calculatePrice({
      vehicleType: vehicle_type,
      distanceKm: distance,
      priority,
      customerTier: tier,
      packageCount: package_count,
    });

    // Create order
    const orderRes = await client.query(
      `INSERT INTO orders (
        customer_id,
        pickup_address, pickup_lat, pickup_lng, pickup_contact_name, pickup_contact_phone,
        dropoff_address, dropoff_lat, dropoff_lng, dropoff_contact_name, dropoff_contact_phone,
        package_description, package_weight, package_photos, package_count, special_instructions,
        distance, vehicle_type, priority,
        base_price, vat_amount, total_price, customer_discount, final_price,
        driver_earnings, commission_amount,
        payment_method, payment_status,
        scheduled_pickup_time, is_scheduled, currency
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
        $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31
      ) RETURNING *`,
      [
        req.user.id,
        pickup.address, pickup.lat, pickup.lng, pickup.contact_name || null, pickup.contact_phone || null,
        dropoff.address, dropoff.lat, dropoff.lng, dropoff.contact_name || null, dropoff.contact_phone || null,
        package_description || null, package_weight || null,
        JSON.stringify(package_photos), package_count, special_instructions || null,
        distance, vehicle_type, priority,
        pricing.basePrice, pricing.vatAmount, pricing.totalPrice, pricing.customerDiscount, pricing.finalPrice,
        pricing.driverEarnings, pricing.commissionAmount,
        payment_method, 'pending',
        scheduled_pickup_time || null, !!scheduled_pickup_time, 'LYD',
      ]
    );

    const order = orderRes.rows[0];
    const payment = await fundOrder(client, order);
    Object.assign(order, payment);

    await client.query('COMMIT');
    client.release();
    client = null;

    // Emit socket event to available drivers
    const io = req.app.get('io');
    if (io) {
      await emitNewOrder(io, vehicle_type, {
        order_id: order.id,
        pickup: { address: order.pickup_address, lat: order.pickup_lat, lng: order.pickup_lng },
        dropoff: { address: order.dropoff_address },
        vehicle_type, priority, distance,
        final_price: order.final_price,
        driver_earnings: order.driver_earnings,
        package_photos,
      });
    }

    await auditLog(req.user.id, 'order_created', 'order', order.id, { vehicle_type, priority }, req);

    return success(res, {
      order_id: order.id,
      status: order.status,
      estimated_price: {
        base: pricing.basePrice,
        discount: pricing.customerDiscount,
        vat: pricing.vatAmount,
        total: pricing.finalPrice,
        currency: 'LYD',
      },
      estimated_distance: distance,
      driver_earnings: pricing.driverEarnings,
      payment_method: order.payment_method,
      payment_status: payment.payment_status,
      payment_transaction_id: payment.payment_transaction_id,
      wallet_balance: payment.wallet_balance,
    }, 'Order created', 201);

  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (err instanceof PaymentError) return error(res, err.message, err.code, err.status);
    next(err);
  } finally {
    client?.release();
  }
};

// ─── Get Orders ───────────────────────────────────────────────
const getOrders = async (req, res, next) => {
  try {
    const { status, page, limit, driver_id, customer_id, date_from, date_to, vehicle_type } = req.query;
    const { page: p, limit: l, offset } = getPagination(page, limit);

    let conditions = [];
    let params = [];
    let paramIdx = 1;

    // Role-based filtering
    if (req.user.role === 'customer') {
      conditions.push(`o.customer_id = $${paramIdx++}`);
      params.push(req.user.id);
    } else if (req.user.role === 'driver') {
      conditions.push(`o.driver_id = $${paramIdx++}`);
      params.push(req.user.id);
    } else if (GLOBAL_ORDER_READ_ROLES.includes(req.user.role)) {
      if (customer_id) { conditions.push(`o.customer_id = $${paramIdx++}`); params.push(customer_id); }
      if (driver_id)   { conditions.push(`o.driver_id = $${paramIdx++}`);   params.push(driver_id); }
    } else {
      return error(res, 'Insufficient permissions to read orders', 'FORBIDDEN', 403);
    }

    if (status)       { conditions.push(`o.status = $${paramIdx++}`);       params.push(status); }
    if (vehicle_type) { conditions.push(`o.vehicle_type = $${paramIdx++}`); params.push(vehicle_type); }
    if (date_from)    { conditions.push(`o.created_at >= $${paramIdx++}`);  params.push(date_from); }
    if (date_to)      { conditions.push(`o.created_at <= $${paramIdx++}`);  params.push(date_to); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const countRes = await query(`SELECT COUNT(*) FROM orders o ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    const ordersRes = await query(
      `SELECT o.*,
              u_c.full_name_ar as customer_name, u_c.phone as customer_phone,
              u_d.full_name_ar as driver_name, u_d.phone as driver_phone
       FROM orders o
       LEFT JOIN users u_c ON u_c.id = o.customer_id
       LEFT JOIN users u_d ON u_d.id = o.driver_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, l, offset]
    );

    return paginated(res, ordersRes.rows.map(stripOrderSecrets), buildPagination(p, l, total));
  } catch (err) {
    next(err);
  }
};

// ─── Get Single Order ─────────────────────────────────────────
const getOrder = async (req, res, next) => {
  try {
    const { order_id } = req.params;

    const orderRes = await query(
      `SELECT o.*,
              u_c.full_name_ar as customer_name, u_c.phone as customer_phone, u_c.email as customer_email,
              u_d.full_name_ar as driver_name, u_d.phone as driver_phone,
              dv.vehicle_type as driver_vehicle_type, dv.plate_number,
              r.rating, r.review_text
       FROM orders o
       LEFT JOIN users u_c ON u_c.id = o.customer_id
       LEFT JOIN users u_d ON u_d.id = o.driver_id
       LEFT JOIN driver_vehicles dv ON dv.driver_id = o.driver_id AND dv.is_active = true
       LEFT JOIN order_ratings r ON r.order_id = o.id
       WHERE o.id = $1`,
      [order_id]
    );

    if (!orderRes.rows.length) {
      return error(res, 'Order not found', 'NOT_FOUND', 404);
    }

    const order = orderRes.rows[0];

    // Access control
    if (!canReadOrder(req.user, order)) {
      return error(res, 'Forbidden', 'FORBIDDEN', 403);
    }

    return success(res, stripOrderSecrets(order));
  } catch (err) {
    next(err);
  }
};

// ─── Update Order Status ──────────────────────────────────────
const updateStatus = async (req, res, next) => {
  // These transitions share their fully validated operation with the dedicated
  // endpoints, so they cannot bypass acceptance or cancellation safeguards.
  if (req.body.status === 'accepted') {
    return require('./driversController').acceptOrder(req, res, next);
  }
  if (req.body.status === 'cancelled') {
    return cancelOrder(req, res, next);
  }
  let client;
  try {
    client = await getClient();
    await client.query('BEGIN');

    const { order_id } = req.params;
    const { status, lat, lng } = req.body;

    const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [order_id]);
    if (!orderRes.rows.length) {
      await client.query('ROLLBACK');
      return error(res, 'Order not found', 'NOT_FOUND', 404);
    }
    const order = orderRes.rows[0];

    if (req.user.role !== 'admin' && !(await isApprovedAssignedDriver(req.user, order, client))) {
      await client.query('ROLLBACK');
      return error(res, 'Only the assigned approved driver or an admin can update this order', 'FORBIDDEN', 403);
    }

    if (status === 'delivered') {
      await client.query('ROLLBACK');
      return error(res, 'The customer must confirm receipt using the delivery QR code', 'DELIVERY_CONFIRMATION_REQUIRED', 409);
    }

    // Validate transitions
    const validTransitions = {
      pending:    ['accepted', 'cancelled'],
      accepted:   ['in_transit', 'cancelled'],
      in_transit: ['cancelled'],
    };

    if (!validTransitions[order.status]?.includes(status)) {
      await client.query('ROLLBACK');
      return error(res, `Cannot transition from ${order.status} to ${status}`, 'INVALID_TRANSITION', 400);
    }

    let updateQuery = 'UPDATE orders SET status = $1, updated_at = NOW()';
    let updateParams = [status, order_id];
    if (status === 'in_transit') {
      updateQuery += `, picked_up_at = NOW()`;
    }
    updateQuery += ` WHERE id = $2 RETURNING *`;
    const updatedRes = await client.query(updateQuery, updateParams);
    const updated = updatedRes.rows[0];

    await client.query('COMMIT');
    client.release();
    client = null;

    // Emit real-time update
    const io = req.app.get('io');
    if (io) {
      io.to(`order:${order_id}`).emit('order_status_updated', {
        order_id, status,
        updated_at: new Date().toISOString(),
        driver_location: lat && lng ? { lat, lng } : null,
      });
    }

    await auditLog(req.user.id, `order_${status}`, 'order', order_id, { status }, req);

    return success(res, { order_id, status, updated_at: updated.updated_at });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
};

// ─── Cancel Order ─────────────────────────────────────────────
const cancelOrder = async (req, res, next) => {
  let client;
  try {
    client = await getClient();
    await client.query('BEGIN');

    const { order_id } = req.params;
    const { reason } = req.body;

    const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [order_id]);
    if (!orderRes.rows.length) {
      await client.query('ROLLBACK');
      return error(res, 'Order not found', 'NOT_FOUND', 404);
    }
    const order = orderRes.rows[0];

    const canCancel = ['admin', 'support'].includes(req.user.role) ||
      isOrderCustomer(req.user, order) ||
      (await isApprovedAssignedDriver(req.user, order, client));
    if (!canCancel) {
      await client.query('ROLLBACK');
      return error(res, 'You do not have permission to cancel this order', 'FORBIDDEN', 403);
    }

    if (['delivered', 'cancelled'].includes(order.status)) {
      await client.query('ROLLBACK');
      return error(res, 'Order cannot be cancelled', 'INVALID_TRANSITION', 400);
    }

    const refund = await refundOrderForCancellation(client, order, req.user.id, reason);
    // Cash cancellation fees are recorded only. Wallet cancellation returns
    // the entire original debit and does not collect an unfunded fee.
    const cancellationFee = order.payment_method === 'cash' &&
      ['accepted', 'in_transit'].includes(order.status) ? 5 : 0;

    await client.query(
      `UPDATE orders SET
         status = 'cancelled',
         cancelled_at = NOW(),
         cancellation_reason = $1,
         cancelled_by = $2,
         cancellation_fee = $3,
         payment_status = $5,
         updated_at = NOW()
       WHERE id = $4`,
      [reason || null, req.user.id, cancellationFee, order_id, refund.payment_status]
    );

    // Free up driver
    if (order.driver_id) {
      await client.query(
        `UPDATE drivers SET availability = (CASE WHEN EXISTS (
           SELECT 1 FROM orders WHERE driver_id = $1 AND id <> $2
             AND status IN ('accepted','in_transit')
         ) THEN 'busy' ELSE 'available' END)::driver_availability WHERE user_id = $1`,
        [order.driver_id, order_id]
      );
    }

    await client.query('COMMIT');
    client.release();
    client = null;

    const io = req.app.get('io');
    if (io) {
      io.to(`order:${order_id}`).emit('order_cancelled', {
        order_id, reason, cancellation_fee: cancellationFee,
        payment_status: refund.payment_status, refunded_amount: refund.refunded_amount,
      });
    }

    await auditLog(req.user.id, 'order_cancelled', 'order', order_id,
      { reason, payment_status: refund.payment_status, refunded_amount: refund.refunded_amount }, req);

    return success(res, { order_id, status: 'cancelled', cancellation_fee: cancellationFee, ...refund });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (err instanceof PaymentError) return error(res, err.message, err.code, err.status);
    next(err);
  } finally {
    client?.release();
  }
};

// ─── Generate QR ──────────────────────────────────────────────
const generateQR = async (req, res, next) => {
  let client;
  try {
    client = await getClient();
    await client.query('BEGIN');
    const { order_id } = req.params;
    const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [order_id]);

    if (!orderRes.rows.length) {
      await client.query('ROLLBACK');
      return error(res, 'Order not found', 'NOT_FOUND', 404);
    }
    const order = orderRes.rows[0];
    if (!(await isApprovedAssignedDriver(req.user, order, client))) {
      await client.query('ROLLBACK');
      return error(res, 'Only the assigned approved driver can generate this QR code', 'FORBIDDEN', 403);
    }
    if (order.status !== 'in_transit' || order.qr_scanned_at != null) {
      await client.query('ROLLBACK');
      return error(res, 'QR codes can only be generated for an active delivery', 'INVALID_TRANSITION', 409);
    }

    const lifetimeMs = qrLifetimeMs();
    const nowRes = await client.query('SELECT clock_timestamp() AS now');
    const now = nowRes.rows[0].now;
    const timing = qrTiming(order, now, lifetimeMs);
    let qrCode = order.qr_code;
    let generatedAt = order.qr_generated_at;
    if (typeof qrCode !== 'string' || !/^[A-F0-9]{32}$/.test(qrCode) || !timing.valid) {
      qrCode = uuidv4().replace(/-/g, '').toUpperCase();
      const updated = await client.query(
        `UPDATE orders SET qr_code = $1, qr_generated_at = $2, updated_at = clock_timestamp()
         WHERE id = $3 RETURNING qr_generated_at`,
        [qrCode, now, order_id]
      );
      generatedAt = updated.rows[0].qr_generated_at;
    }

    // Rendering failure also rolls back regeneration instead of invalidating
    // a previously displayed code that the driver never received a replacement for.
    const qrDataUrl = await QRCode.toDataURL(`QUICKSHIP:${order_id}:${qrCode}`);
    await client.query('COMMIT');
    client.release();
    client = null;

    return success(res, {
      qr_code: qrCode,
      qr_image: qrDataUrl,
      generated_at: new Date(generatedAt).toISOString(),
      expires_at: new Date(new Date(generatedAt).getTime() + lifetimeMs).toISOString(),
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
};

// ─── Verify QR (Delivery Confirmation) ────────────────────────
const verifyQR = async (req, res, next) => {
  let client;
  try {
    client = await getClient();
    await client.query('BEGIN');

    const { order_id } = req.params;
    const { qr_code, lat, lng } = req.body;

    const orderRes = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [order_id]
    );

    if (!orderRes.rows.length) {
      await client.query('ROLLBACK');
      return error(res, 'Order not found', 'NOT_FOUND', 404);
    }

    const order = orderRes.rows[0];

    if (!isOrderCustomer(req.user, order)) {
      await client.query('ROLLBACK');
      return error(res, 'Only the customer who owns this order can confirm receipt', 'FORBIDDEN', 403);
    }

    if (req.body.received !== true) {
      await client.query('ROLLBACK');
      return error(res, 'Customer must confirm receipt of the package', 'RECEIPT_REQUIRED', 400);
    }
    if (order.status === 'delivered' || order.qr_scanned_at != null) {
      await client.query('ROLLBACK');
      return error(res, 'This QR code has already been used', 'QR_ALREADY_USED', 409);
    }
    if (order.status !== 'in_transit') {
      await client.query('ROLLBACK');
      return error(res, 'This order is not awaiting delivery confirmation', 'INVALID_TRANSITION', 409);
    }
    if (!order.driver_id) {
      await client.query('ROLLBACK');
      return error(res, 'Order has no assigned driver', 'DRIVER_REQUIRED', 409);
    }
    if (typeof qr_code !== 'string' || !/^[A-Fa-f0-9]{32}$/.test(qr_code) || order.qr_code !== qr_code.toUpperCase()) {
      await client.query('ROLLBACK');
      return error(res, 'Invalid QR code', 'INVALID_QR', 400);
    }

    // Read the clock after acquiring the lock, including time spent waiting for
    // another operation. Missing, future, expired and boundary timestamps fail.
    const nowRes = await client.query('SELECT clock_timestamp() AS now');
    const timing = qrTiming(order, nowRes.rows[0].now, qrLifetimeMs());
    if (!timing.valid) {
      await client.query('ROLLBACK');
      return error(res, 'QR code is expired or has no valid generation time', 'QR_EXPIRED', 400);
    }

    const delivered = await completeDelivery(client, order, req.body);
    await client.query('COMMIT');
    client.release();
    client = null;

    const io = req.app.get('io');
    if (io) {
      io.to(`order:${order_id}`).emit('order_status_updated', {
        order_id, status: 'delivered', updated_at: delivered.updated_at,
        driver_location: lat != null && lng != null ? { lat, lng } : null,
      });
      io.to(`order:${order_id}`).emit('order_delivered', {
        order_id, delivered_at: delivered.delivered_at,
      });
    }
    await auditLog(req.user.id, 'order_completed', 'order', order_id,
      { status: 'delivered', confirmation: 'customer_qr', payment_method: order.payment_method }, req);

    return success(res, { order_id, status: 'delivered', delivered_at: delivered.delivered_at, message: 'Delivery confirmed' });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (err instanceof DeliveryError) return error(res, err.message, err.code, err.status);
    next(err);
  } finally {
    client?.release();
  }
};

// ─── Rate Order ───────────────────────────────────────────────
const rateOrder = async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const { order_id } = req.params;
    const { rating, review_text } = req.body;

    if (rating < 1 || rating > 5) {
      await client.query('ROLLBACK');
      return error(res, 'Rating must be between 1 and 5', 'INVALID_RATING', 400);
    }

    const orderRes = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND customer_id = $2 AND status = 'delivered'`,
      [order_id, req.user.id]
    );

    if (!orderRes.rows.length) {
      await client.query('ROLLBACK');
      return error(res, 'Order not found or not eligible for rating', 'NOT_FOUND', 404);
    }

    const order = orderRes.rows[0];

    // Check not already rated
    const existingRating = await client.query(
      `SELECT id FROM order_ratings WHERE order_id = $1 AND customer_id = $2`,
      [order_id, req.user.id]
    );
    if (existingRating.rows.length) {
      await client.query('ROLLBACK');
      return error(res, 'Order already rated', 'ALREADY_RATED', 409);
    }

    await client.query(
      `INSERT INTO order_ratings (order_id, customer_id, driver_id, rating, review_text)
       VALUES ($1,$2,$3,$4,$5)`,
      [order_id, req.user.id, order.driver_id, rating, review_text || null]
    );

    // Update driver average rating
    await client.query(
      `UPDATE drivers SET rating = (
         SELECT ROUND(AVG(rating)::numeric, 2)
         FROM order_ratings WHERE driver_id = $1
       ) WHERE user_id = $1`,
      [order.driver_id]
    );

    await client.query('COMMIT');
    return success(res, { order_id, rating }, 'Rating submitted');
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ─── Price Estimate ───────────────────────────────────────────
const estimatePrice = async (req, res, next) => {
  try {
    const { pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, vehicle_type, priority = 'standard', package_count = 1 } = req.query;

    const distance = calculateDistance(
      parseFloat(pickup_lat), parseFloat(pickup_lng),
      parseFloat(dropoff_lat), parseFloat(dropoff_lng)
    );

    // Get customer tier if logged in
    let tier = 'bronze';
    if (req.user?.role === 'customer') {
      const custRes = await query('SELECT tier FROM customers WHERE user_id = $1', [req.user.id]);
      if (custRes.rows.length) tier = custRes.rows[0].tier;
    }

    const pricing = calculatePrice({ vehicleType: vehicle_type, distanceKm: distance, priority, customerTier: tier, packageCount: parseInt(package_count) });

    return success(res, {
      distance,
      currency: 'LYD',
      ...pricing,
      vehicle_type,
      priority,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createOrder, getOrders, getOrder, updateStatus,
  cancelOrder, generateQR, verifyQR, rateOrder, estimatePrice,
};
