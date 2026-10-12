// Wallet funding/refunds are part of the caller's order transaction. Amounts
// remain PostgreSQL NUMERIC values throughout; no floating point totals are used.
class PaymentError extends Error {
  constructor(message, code, status = 409) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.status = status;
  }
}

const paymentMismatch = () => new PaymentError(
  'Payment records require reconciliation before this operation', 'PAYMENT_MISMATCH'
);

const fundOrder = async (client, order) => {
  if (['card', 'bank_transfer'].includes(order.payment_method)) {
    throw new PaymentError('This payment method requires a configured payment provider', 'PAYMENT_UNAVAILABLE');
  }
  if (order.payment_method === 'cash') {
    return { payment_status: 'pending', payment_transaction_id: null, wallet_balance: null };
  }
  if (order.payment_method !== 'wallet') throw paymentMismatch();

  // The conditional UPDATE serializes concurrent debits and cannot overdraw.
  const debit = await client.query(
    `UPDATE wallets SET balance = balance - $1::numeric, updated_at = clock_timestamp()
     WHERE user_id = $2 AND currency = $3 AND balance >= $1::numeric
       AND $1::numeric > 0 AND $1::numeric <> 'NaN'::numeric
     RETURNING balance`,
    [order.final_price, order.customer_id, order.currency]
  );
  if (debit.rowCount !== 1) {
    const wallet = await client.query('SELECT currency FROM wallets WHERE user_id = $1', [order.customer_id]);
    if (wallet.rows.length && wallet.rows[0].currency !== order.currency) throw paymentMismatch();
    throw new PaymentError('Wallet balance is insufficient for this order', 'INSUFFICIENT_BALANCE');
  }
  const transaction = await client.query(
    `INSERT INTO transactions (user_id, order_id, type, amount, currency, payment_method, status)
     VALUES ($1,$2,'order_payment',$3,$4,'wallet','completed') RETURNING id`,
    [order.customer_id, order.id, order.final_price, order.currency]
  );
  await client.query(
    `UPDATE orders SET payment_status = 'paid', payment_transaction_id = $1,
       updated_at = clock_timestamp() WHERE id = $2`,
    [transaction.rows[0].id, order.id]
  );
  return {
    payment_status: 'paid', payment_transaction_id: transaction.rows[0].id,
    wallet_balance: debit.rows[0].balance,
  };
};

// The caller holds the order lock, so cancellation and delivery cannot both win.
const refundOrderForCancellation = async (client, order, actorId, reason) => {
  const ledger = await client.query(
    `SELECT id, type,
            (user_id = $2 AND amount = $3::numeric AND currency = $4
             AND payment_method = $5::payment_method) AS matches_order
     FROM transactions
     WHERE order_id = $1 AND status = 'completed'
       AND type IN ('order_payment','order_refund')
     FOR UPDATE`,
    [order.id, order.customer_id, order.final_price, order.currency, order.payment_method]
  );
  const payments = ledger.rows.filter(entry => entry.type === 'order_payment');
  const refunds = ledger.rows.filter(entry => entry.type === 'order_refund');
  const oldRefunds = await client.query('SELECT id FROM refunds WHERE order_id = $1 FOR UPDATE', [order.id]);
  if (refunds.length || oldRefunds.rows.length) throw paymentMismatch();

  const result = {
    payment_status: order.payment_status, refunded_amount: '0.00',
    wallet_balance: null, refund_transaction_id: null,
  };

  // Existing unfunded orders can be cancelled without inventing a payment or
  // refund. Any other legacy state needs an accounting decision first.
  if (order.payment_status === 'pending' && payments.length === 0) return result;
  if (order.payment_method !== 'wallet' || order.payment_status !== 'paid' ||
      payments.length !== 1 || payments[0].matches_order !== true) {
    throw paymentMismatch();
  }

  const credit = await client.query(
    `UPDATE wallets SET balance = balance + $1::numeric, updated_at = clock_timestamp()
     WHERE user_id = $2 AND currency = $3
       AND $1::numeric > 0 AND $1::numeric <> 'NaN'::numeric
     RETURNING balance`,
    [order.final_price, order.customer_id, order.currency]
  );
  if (credit.rowCount !== 1) throw paymentMismatch();

  const transaction = await client.query(
    `INSERT INTO transactions (user_id, order_id, type, amount, currency, payment_method, status)
     VALUES ($1,$2,'order_refund',$3,$4,'wallet','completed') RETURNING id`,
    [order.customer_id, order.id, order.final_price, order.currency]
  );
  await client.query(
    `INSERT INTO refunds (order_id, amount, reason, approved_by, processed_at)
     VALUES ($1,$2,$3,$4,clock_timestamp())`,
    [order.id, order.final_price, reason || 'Full wallet refund on order cancellation', actorId]
  );
  return {
    payment_status: 'refunded', refunded_amount: order.final_price,
    wallet_balance: credit.rows[0].balance, refund_transaction_id: transaction.rows[0].id,
  };
};

module.exports = { PaymentError, fundOrder, refundOrderForCancellation };
