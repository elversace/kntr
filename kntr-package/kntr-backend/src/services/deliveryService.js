// Delivery and its accounting are committed by the caller's single transaction.
// The caller must hold the order row lock until this operation finishes.
class DeliveryError extends Error {
  constructor(message, code, status = 409) {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
    this.status = status;
  }
}

const qrLifetimeMs = () => {
  const setting = process.env.QR_EXPIRY_MINUTES ?? '60';
  const minutes = Number(setting);
  if (!/^\d+$/.test(setting) || !Number.isSafeInteger(minutes) || minutes <= 0 ||
      !Number.isSafeInteger(minutes * 60000)) {
    throw new Error('QR_EXPIRY_MINUTES must be a positive whole number');
  }
  return minutes * 60000;
};

const qrTiming = (order, now, lifetimeMs) => {
  const generatedAt = order.qr_generated_at == null ? NaN : new Date(order.qr_generated_at).getTime();
  const currentTime = new Date(now).getTime();
  return {
    generatedAt,
    expiresAt: generatedAt + lifetimeMs,
    valid: Number.isFinite(generatedAt) && Number.isFinite(currentTime) &&
      generatedAt <= currentTime && currentTime < generatedAt + lifetimeMs,
  };
};

const completeDelivery = async (client, order, proof) => {
  if (proof.received !== true) {
    throw new DeliveryError('Customer must confirm receipt of the package', 'RECEIPT_REQUIRED', 400);
  }
  if (order.status === 'delivered' || order.qr_scanned_at != null) {
    throw new DeliveryError('This QR code has already been used', 'QR_ALREADY_USED');
  }
  if (order.status !== 'in_transit') {
    throw new DeliveryError('This order is not awaiting delivery confirmation', 'INVALID_TRANSITION');
  }
  if (!order.driver_id) {
    throw new DeliveryError('Order has no assigned driver', 'DRIVER_REQUIRED');
  }

  // Legacy paid flags may be stale after a refund. Neither a completed refund
  // ledger entry nor a processed refund can fund another delivery.
  const refunds = await client.query(
    `SELECT EXISTS (SELECT 1 FROM transactions WHERE order_id = $1
       AND type = 'order_refund' AND status = 'completed')
       OR EXISTS (SELECT 1 FROM refunds WHERE order_id = $1
         AND processed_at IS NOT NULL) AS refunded`, [order.id]
  );
  if (refunds.rows[0].refunded) {
    throw new DeliveryError('Refunded payment records require reconciliation', 'PAYMENT_MISMATCH');
  }

  // Compare all payment facts in PostgreSQL's exact NUMERIC arithmetic.
  const payments = await client.query(
    `SELECT id,
            (user_id = $2 AND amount = $3::numeric AND currency = $4
             AND payment_method = $5::payment_method) AS matches_order
     FROM transactions
     WHERE order_id = $1 AND type = 'order_payment' AND status = 'completed'
     FOR UPDATE`,
    [order.id, order.customer_id, order.final_price, order.currency, order.payment_method]
  );
  const paymentMatches = payments.rows.length === 1 && payments.rows[0].matches_order === true;

  if (order.payment_method === 'cash') {
    if (proof.cash_paid !== true) {
      throw new DeliveryError('Customer must confirm the cash payment', 'CASH_CONFIRMATION_REQUIRED', 400);
    }
    if (payments.rows.length && (!paymentMatches || order.payment_status !== 'paid')) {
      throw new DeliveryError('Payment records need reconciliation', 'PAYMENT_MISMATCH');
    }
    if (!payments.rows.length) {
      if (order.payment_status !== 'pending') {
        throw new DeliveryError('Payment records need reconciliation', 'PAYMENT_MISMATCH');
      }
      await client.query(
        `INSERT INTO transactions (user_id, order_id, type, amount, currency, payment_method, status)
         VALUES ($1,$2,'order_payment',$3,$4,'cash','completed')`,
        [order.customer_id, order.id, order.final_price, order.currency]
      );
    }
  } else if (!['wallet', 'card', 'bank_transfer'].includes(order.payment_method) ||
             order.payment_status !== 'paid' || !paymentMatches) {
    throw new DeliveryError('A confirmed payment is required before delivery', 'PAYMENT_REQUIRED');
  }

  const delivered = await client.query(
    `UPDATE orders SET
       status = 'delivered', qr_scanned_at = clock_timestamp(),
       delivered_at = clock_timestamp(), delivery_lat = $1, delivery_lng = $2,
       delivery_photo_url = $3, delivery_signature = $4,
       payment_status = 'paid', updated_at = clock_timestamp()
     WHERE id = $5 AND status = 'in_transit' AND qr_scanned_at IS NULL
     RETURNING *`,
    [proof.lat ?? null, proof.lng ?? null, proof.delivery_photo_url ?? null,
      proof.signature == null ? null : JSON.stringify(proof.signature), order.id]
  );
  if (delivered.rowCount !== 1) {
    throw new DeliveryError('This QR code has already been used', 'QR_ALREADY_USED');
  }

  const driver = await client.query(
    `UPDATE drivers SET total_trips = COALESCE(total_trips,0) + 1,
       total_earnings = COALESCE(total_earnings,0) + $1,
       availability = (CASE WHEN EXISTS (
         SELECT 1 FROM orders WHERE driver_id = $2 AND id <> $3
           AND status IN ('accepted','in_transit')
       ) THEN 'busy' ELSE 'available' END)::driver_availability
     WHERE user_id = $2`,
    [order.driver_earnings ?? 0, order.driver_id, order.id]
  );
  const customer = await client.query(
    `UPDATE customers SET total_orders = COALESCE(total_orders,0) + 1,
       total_spent = COALESCE(total_spent,0) + $1,
       tier = (CASE WHEN COALESCE(total_orders,0) + 1 >= 51 THEN 'gold'
                    WHEN COALESCE(total_orders,0) + 1 >= 11 THEN 'silver'
                    ELSE 'bronze' END)::customer_tier
     WHERE user_id = $2`,
    [order.final_price, order.customer_id]
  );
  if (driver.rowCount !== 1 || customer.rowCount !== 1) {
    throw new DeliveryError('Order profiles need reconciliation', 'PROFILE_REQUIRED');
  }
  return delivered.rows[0];
};

module.exports = { DeliveryError, qrLifetimeMs, qrTiming, completeDelivery };
