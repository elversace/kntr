const { query, getClient } = require('../config/database');
const { success, error, paginated, getPagination, buildPagination } = require('../utils/helpers');
const { auditLog } = require('../middleware/errorHandler');
const { disconnectUserSockets } = require('../services/socketService');

// ─── Dashboard Stats ──────────────────────────────────────────
const getStatistics = async (req, res, next) => {
  try {
    const [
      activeOrders,
      todayRevenue,
      totalDrivers,
      activeDrivers,
      pendingApprovals,
      totalCustomers,
      weekRevenue,
      lastWeekRevenue,
    ] = await Promise.all([
      query(`SELECT COUNT(*) FROM orders WHERE status IN ('pending','accepted','in_transit')`),
      query(`SELECT COALESCE(SUM(final_price),0) as rev FROM orders WHERE status='delivered' AND DATE(delivered_at)=CURRENT_DATE`),
      query(`SELECT COUNT(*) FROM drivers`),
      query(`SELECT COUNT(*) FROM drivers WHERE availability != 'offline'`),
      query(`SELECT COUNT(*) FROM drivers WHERE driver_status='pending'`),
      query(`SELECT COUNT(*) FROM customers`),
      query(`SELECT COALESCE(SUM(final_price),0) as rev FROM orders WHERE status='delivered' AND delivered_at >= NOW()-INTERVAL '7 days'`),
      query(`SELECT COALESCE(SUM(final_price),0) as rev FROM orders WHERE status='delivered' AND delivered_at BETWEEN NOW()-INTERVAL '14 days' AND NOW()-INTERVAL '7 days'`),
    ]);

    const todayRev = parseFloat(todayRevenue.rows[0].rev);
    const weekRev  = parseFloat(weekRevenue.rows[0].rev);
    const lastWeekRev = parseFloat(lastWeekRevenue.rows[0].rev);
    const revTrend = lastWeekRev > 0 ? ((weekRev - lastWeekRev) / lastWeekRev * 100).toFixed(1) : 0;

    // Orders by status
    const ordersByStatus = await query(
      `SELECT status, COUNT(*) as count FROM orders GROUP BY status`
    );

    // Revenue last 7 days
    const dailyRevenue = await query(
      `SELECT DATE(delivered_at) as date,
              COALESCE(SUM(final_price),0) as revenue,
              COUNT(*) as orders
       FROM orders
       WHERE status='delivered' AND delivered_at >= NOW()-INTERVAL '7 days'
       GROUP BY DATE(delivered_at)
       ORDER BY date`
    );

    return success(res, {
      active_orders: parseInt(activeOrders.rows[0].count),
      today_revenue: todayRev,
      total_drivers: parseInt(totalDrivers.rows[0].count),
      active_drivers: parseInt(activeDrivers.rows[0].count),
      pending_approvals: parseInt(pendingApprovals.rows[0].count),
      total_customers: parseInt(totalCustomers.rows[0].count),
      week_revenue: weekRev,
      trends: {
        revenue: parseFloat(revTrend),
      },
      orders_by_status: ordersByStatus.rows.reduce((acc, r) => {
        acc[r.status] = parseInt(r.count); return acc;
      }, {}),
      daily_revenue: dailyRevenue.rows,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Live Map Data ────────────────────────────────────────────
const getLiveMap = async (req, res, next) => {
  try {
    const activeDeliveries = await query(
      `SELECT o.id as order_id, o.status,
              o.pickup_address, o.pickup_lat, o.pickup_lng,
              o.dropoff_address, o.dropoff_lat, o.dropoff_lng,
              u_c.full_name_ar as customer_name, u_c.phone as customer_phone,
              u_d.full_name_ar as driver_name, u_d.phone as driver_phone,
              d.current_lat, d.current_lng, d.last_location_update,
              dv.vehicle_type, dv.plate_number
       FROM orders o
       JOIN users u_c ON u_c.id = o.customer_id
       JOIN users u_d ON u_d.id = o.driver_id
       JOIN drivers d ON d.user_id = o.driver_id
       LEFT JOIN driver_vehicles dv ON dv.driver_id = d.user_id AND dv.is_active = true
       WHERE o.status IN ('accepted','in_transit')`
    );

    const availableDrivers = await query(
      `SELECT d.user_id as driver_id, u.full_name_ar as name, u.phone,
              d.availability, d.rating, d.current_lat, d.current_lng,
              dv.vehicle_type, dv.plate_number
       FROM drivers d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN driver_vehicles dv ON dv.driver_id = d.user_id AND dv.is_active = true
       WHERE d.availability = 'available' AND d.driver_status = 'approved'`
    );

    return success(res, {
      active_deliveries: activeDeliveries.rows,
      available_drivers: availableDrivers.rows,
      counts: {
        active_deliveries: activeDeliveries.rows.length,
        available_drivers: availableDrivers.rows.length,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Pending Driver Approvals ─────────────────────────────────
const getPendingDrivers = async (req, res, next) => {
  try {
    const { page, limit } = req.query;
    const { page: p, limit: l, offset } = getPagination(page, limit);

    const countRes = await query(
      `SELECT COUNT(*) FROM drivers WHERE driver_status = 'pending'`
    );

    const driversRes = await query(
      `SELECT u.id, u.full_name_ar, u.full_name_en, u.phone, u.email, u.national_id, u.created_at,
              d.driver_status, d.accepts_intercity,
              json_agg(DISTINCT jsonb_build_object(
                'type', dd.document_type,
                'url', dd.document_url,
                'status', dd.status,
                'expiry_date', dd.expiry_date
              )) FILTER (WHERE dd.id IS NOT NULL) as documents,
              json_agg(DISTINCT jsonb_build_object(
                'type', dv.vehicle_type,
                'plate', dv.plate_number,
                'make', dv.make,
                'model', dv.model
              )) FILTER (WHERE dv.id IS NOT NULL) as vehicles
       FROM users u
       JOIN drivers d ON d.user_id = u.id
       LEFT JOIN driver_documents dd ON dd.driver_id = u.id
       LEFT JOIN driver_vehicles dv ON dv.driver_id = u.id
       WHERE d.driver_status = 'pending'
       GROUP BY u.id, d.driver_status, d.accepts_intercity
       ORDER BY u.created_at ASC
       LIMIT $1 OFFSET $2`,
      [l, offset]
    );

    return paginated(res, driversRes.rows, buildPagination(p, l, parseInt(countRes.rows[0].count)));
  } catch (err) {
    next(err);
  }
};

// ─── Approve Driver ───────────────────────────────────────────
const approveDriver = async (req, res, next) => {
  try {
    const { driver_id } = req.params;
    const { notes } = req.body;

    const result = await query(
      `UPDATE drivers SET
         driver_status = 'approved',
         approved_by = $1,
         approved_at = NOW()
       WHERE user_id = $2 AND driver_status = 'pending'
       RETURNING user_id`,
      [req.user.id, driver_id]
    );

    if (!result.rows.length) {
      return error(res, 'Driver not found or already processed', 'NOT_FOUND', 404);
    }
    disconnectUserSockets(req.app.get('io'), driver_id);

    // Send notification
    await query(
      `INSERT INTO notifications (user_id, type, title_ar, title_en, message_ar, message_en)
       VALUES ($1,'system','تم قبول طلبك','Your application approved',
               'مبروك! تم قبول طلبك كسائق في kntr. يمكنك الآن بدء استلام الطلبات.',
               'Congratulations! Your driver application has been approved.')`,
      [driver_id]
    );

    await auditLog(req.user.id, 'driver_approved', 'driver', driver_id, { notes }, req);

    return success(res, { driver_id, status: 'approved' }, 'Driver approved');
  } catch (err) {
    next(err);
  }
};

// ─── Reject Driver ────────────────────────────────────────────
const rejectDriver = async (req, res, next) => {
  try {
    const { driver_id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return error(res, 'Rejection reason required', 'MISSING_REASON', 400);
    }

    const result = await query(
      `UPDATE drivers SET driver_status = 'rejected' WHERE user_id = $1 RETURNING user_id`,
      [driver_id]
    );

    if (!result.rows.length) {
      return error(res, 'Driver not found', 'NOT_FOUND', 404);
    }
    disconnectUserSockets(req.app.get('io'), driver_id);

    await query(
      `INSERT INTO notifications (user_id, type, title_ar, title_en, message_ar, message_en)
       VALUES ($1,'system','تم رفض طلبك','Application rejected',
               $2, $3)`,
      [driver_id,
       `نأسف لإبلاغك أنه تم رفض طلبك للأسباب التالية: ${reason}`,
       `Your driver application has been rejected: ${reason}`]
    );

    await auditLog(req.user.id, 'driver_rejected', 'driver', driver_id, { reason }, req);

    return success(res, { driver_id, status: 'rejected' }, 'Driver rejected');
  } catch (err) {
    next(err);
  }
};

// ─── Get Users ────────────────────────────────────────────────
const getUsers = async (req, res, next) => {
  try {
    const { role, status, search, page, limit } = req.query;
    const { page: p, limit: l, offset } = getPagination(page, limit);

    let conditions = ['u.deleted_at IS NULL'];
    let params = [];
    let idx = 1;

    if (role)   { conditions.push(`u.role = $${idx++}`);   params.push(role); }
    if (status) { conditions.push(`u.status = $${idx++}`); params.push(status); }
    if (search) {
      conditions.push(`(u.full_name_ar ILIKE $${idx} OR u.email ILIKE $${idx} OR u.phone ILIKE $${idx})`);
      params.push(`%${search}%`); idx++;
    }

    const where = 'WHERE ' + conditions.join(' AND ');
    const countRes = await query(`SELECT COUNT(*) FROM users u ${where}`, params);

    const usersRes = await query(
      `SELECT u.id, u.role, u.email, u.phone, u.full_name_ar, u.full_name_en,
              u.status, u.created_at, u.last_login,
              c.tier, c.total_orders,
              d.driver_status, d.availability, d.rating
       FROM users u
       LEFT JOIN customers c ON c.user_id = u.id
       LEFT JOIN drivers d ON d.user_id = u.id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, l, offset]
    );

    return paginated(res, usersRes.rows, buildPagination(p, l, parseInt(countRes.rows[0].count)));
  } catch (err) {
    next(err);
  }
};

// ─── Update User Status ───────────────────────────────────────
const updateUserStatus = async (req, res, next) => {
  try {
    const { user_id } = req.params;
    const { status, reason } = req.body;

    const valid = ['active', 'suspended'];
    if (!valid.includes(status)) {
      return error(res, `Status must be: ${valid.join(', ')}`, 'INVALID_STATUS', 400);
    }

    const result = await query(
      `UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, status`,
      [status, user_id]
    );

    if (!result.rows.length) {
      return error(res, 'User not found', 'NOT_FOUND', 404);
    }

    // Revoke sessions if suspended
    if (status === 'suspended') {
      await query('DELETE FROM sessions WHERE user_id = $1', [user_id]);
      disconnectUserSockets(req.app.get('io'), user_id);
    }

    await auditLog(req.user.id, status === 'suspended' ? 'driver_suspended' : 'user_created',
      'user', user_id, { status, reason }, req);

    return success(res, { user_id, status });
  } catch (err) {
    next(err);
  }
};

// ─── Financial Overview ───────────────────────────────────────
const getFinancialOverview = async (req, res, next) => {
  try {
    const { period = 'month' } = req.query;
    const periodMap = { today: '1 day', week: '7 days', month: '30 days', year: '365 days' };
    const interval = periodMap[period] || '30 days';

    const [revenue, payouts, pendingPayouts, refunds] = await Promise.all([
      query(`SELECT COALESCE(SUM(final_price),0) as total,
                    COALESCE(SUM(vat_amount),0) as vat,
                    COALESCE(SUM(commission_amount),0) as commission,
                    COUNT(*) as orders
             FROM orders o WHERE status='delivered' AND payment_status='paid'
               AND delivered_at >= NOW()-INTERVAL '${interval}'
               AND EXISTS (SELECT 1 FROM transactions t WHERE t.order_id=o.id
                 AND t.type='order_payment' AND t.status='completed'
                 AND t.user_id=o.customer_id AND t.amount=o.final_price
                 AND t.currency=o.currency AND t.payment_method=o.payment_method)
               AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.order_id=o.id
                 AND t.type='order_refund' AND t.status='completed')
               AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.order_id=o.id AND r.processed_at IS NOT NULL)`),
      query(`SELECT COALESCE(SUM(total_earnings),0) as total, COUNT(*) as count
             FROM driver_payouts WHERE status='completed' AND processed_at >= NOW()-INTERVAL '${interval}'`),
      query(`SELECT COALESCE(SUM(total_earnings),0) as total, COUNT(*) as count
             FROM driver_payouts WHERE status IN ('pending','processing')`),
      query(`SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as count
             FROM refunds WHERE processed_at IS NOT NULL AND processed_at >= NOW()-INTERVAL '${interval}'`),
    ]);

    return success(res, {
      period,
      revenue: {
        total: parseFloat(revenue.rows[0].total),
        vat: parseFloat(revenue.rows[0].vat),
        commission: parseFloat(revenue.rows[0].commission),
        orders: parseInt(revenue.rows[0].orders),
      },
      payouts: {
        completed: parseFloat(payouts.rows[0].total),
        pending: parseFloat(pendingPayouts.rows[0].total),
        pending_count: parseInt(pendingPayouts.rows[0].count),
      },
      refunds: {
        total: parseFloat(refunds.rows[0].total),
        count: parseInt(refunds.rows[0].count),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Process Payout ───────────────────────────────────────────
const processPayout = async (req, res, next) => {
  let client;
  try {
    client = await getClient();
    await client.query('BEGIN');
    const { driver_id, period_start, period_end } = req.body;
    // Serialize allocations for this driver, including requests with overlapping
    // periods. Historical payouts cannot be guessed or silently reallocated.
    const driver = await client.query(
      'SELECT user_id FROM drivers WHERE user_id = $1 FOR UPDATE', [driver_id]
    );
    if (!driver.rowCount) {
      await client.query('ROLLBACK');
      return error(res, 'Driver not found', 'NOT_FOUND', 404);
    }
    const legacy = await client.query(
      `SELECT id FROM driver_payouts p WHERE driver_id = $1
       AND (status IS NULL OR status <> 'failed')
       AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.payout_id = p.id)
       LIMIT 1`, [driver_id]
    );
    if (legacy.rowCount) {
      await client.query('ROLLBACK');
      return error(res, 'Historical payouts require order allocation reconciliation before another payout',
        'PAYOUT_RECONCILIATION_REQUIRED', 409);
    }
    const eligible = await client.query(
      `SELECT o.id FROM orders o
       WHERE o.driver_id = $1 AND o.status = 'delivered' AND o.payment_status = 'paid'
         AND o.currency = 'LYD' AND o.driver_earnings > 0 AND o.driver_earnings <= o.final_price
         AND o.delivered_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
         AND o.delivered_at < (($3::date + INTERVAL '1 day') AT TIME ZONE 'UTC')
         AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.order_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.order_id = o.id
           AND t.type = 'order_refund' AND t.status = 'completed')
         AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = o.id AND r.processed_at IS NOT NULL)
         AND EXISTS (SELECT 1 FROM transactions t WHERE t.order_id = o.id
           AND t.type = 'order_payment' AND t.status = 'completed'
           AND t.user_id = o.customer_id AND t.amount = o.final_price
           AND t.currency = o.currency AND t.payment_method = o.payment_method)
       ORDER BY o.id`, [driver_id, period_start, period_end]
    );
    if (!eligible.rowCount) {
      await client.query('ROLLBACK');
      return error(res, 'No earnings found for this period', 'NO_EARNINGS', 400);
    }
    const orderIds = eligible.rows.map(row => row.id);
    // SUM and allocation amounts use PostgreSQL NUMERIC, without float rounding.
    const payoutRes = await client.query(
      `INSERT INTO driver_payouts (driver_id, period_start, period_end, total_earnings, total_trips, status, processed_by, processed_at)
       SELECT $1,$2::date,$3::date,SUM(driver_earnings),COUNT(*),'pending',$4,NULL
       FROM orders WHERE id = ANY($5::varchar[])
       RETURNING id,total_earnings,total_trips`,
      [driver_id, period_start, period_end, req.user.id, orderIds]
    );
    const payout = payoutRes.rows[0];
    await client.query(
      `INSERT INTO payout_items (order_id,payout_id,amount,currency)
       SELECT id,$1,driver_earnings,currency FROM orders WHERE id = ANY($2::varchar[])`,
      [payout.id, orderIds]
    );
    await client.query('COMMIT');
    client.release();
    client = null;
    await auditLog(req.user.id, 'payout_requested', 'driver', driver_id,
      { payout_id: payout.id, amount: payout.total_earnings, trips: payout.total_trips, order_ids: orderIds }, req);
    return success(res, {
      payout_id: payout.id,
      driver_id,
      amount: payout.total_earnings,
      trips: payout.total_trips,
      status: 'pending',
      processed_at: null,
      period: { start: period_start, end: period_end },
    }, 'Earnings reserved; a confirmed external transfer is required to complete the payout', 201);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
};

// ─── Get/Update System Settings ───────────────────────────────
const getSettings = async (req, res, next) => {
  try {
    const settingsRes = await query('SELECT key, value FROM system_settings');
    const settings = settingsRes.rows.reduce((acc, r) => { acc[r.key] = r.value; return acc; }, {});
    return success(res, settings);
  } catch (err) { next(err); }
};

const updateSettings = async (req, res, next) => {
  try {
    const { key, value } = req.body;
    await query(
      `INSERT INTO system_settings (key, value, updated_by, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_by=$3, updated_at=NOW()`,
      [key, JSON.stringify(value), req.user.id]
    );
    await auditLog(req.user.id, 'settings_changed', 'settings', key, { value }, req);
    return success(res, { key, value }, 'Settings updated');
  } catch (err) { next(err); }
};

module.exports = {
  getStatistics, getLiveMap, getPendingDrivers,
  approveDriver, rejectDriver, getUsers, updateUserStatus,
  getFinancialOverview, processPayout, getSettings, updateSettings,
};
