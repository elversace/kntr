const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { spawn } = require('node:child_process');
const { createHarness } = require('./harness.cjs');

async function main(h) {
  const { assert } = h;
  const A = await h.register('customer', 'wallet-owner', '+218910300001');
  const B = await h.register('customer', 'wallet-other', '+218910300002');
  const D = await h.register('driver', 'wallet-driver', '+218910300003');
  const P = await h.fixture('driver', 'payout-driver');
  const admin = await h.admin();
  const finance = await h.fixture('finance', 'payout-finance');
  await h.setupDriver(D, admin); await h.setupDriver(P, admin);
  const body = payment => ({
    pickup: { address: 'Payment pickup', lat: 32.88, lng: 13.18 },
    dropoff: { address: 'Payment dropoff', lat: 32.89, lng: 13.19 },
    vehicle_type: 'car', payment_method: payment,
  });
  const cents = amount => Math.round(Number(amount) * 100);
  async function wallet(user = A) { return (await h.query('SELECT * FROM wallets WHERE user_id=$1', [user.id])).rows[0]; }
  async function fund(amount, currency = 'LYD', user = A) { await h.query('UPDATE wallets SET balance=$1,currency=$2 WHERE user_id=$3', [amount, currency, user.id]); }
  async function financialState() {
    return {
      wallets: (await h.query('SELECT * FROM wallets ORDER BY user_id')).rows,
      orders: (await h.query('SELECT * FROM orders ORDER BY id')).rows,
      transactions: (await h.query('SELECT * FROM transactions ORDER BY id')).rows,
      refunds: (await h.query('SELECT * FROM refunds ORDER BY id')).rows,
      payouts: (await h.query('SELECT * FROM driver_payouts ORDER BY id')).rows,
      allocations: (await h.query('SELECT * FROM payout_items ORDER BY order_id')).rows,
    };
  }
  async function start(id) {
    h.status(await h.request(`/drivers/orders/${id}/accept`, D.token, 'POST', {}), 200);
    h.status(await h.request(`/orders/${id}/status`, D.token, 'PATCH', { status: 'in_transit' }), 200);
    const result = await h.request(`/orders/${id}/generate-qr`, D.token, 'POST', {}); h.status(result, 200);
    return result.body.data.qr_code;
  }
  async function confirm(id, code) { return h.request(`/orders/${id}/verify-qr`, A.token, 'POST', { qr_code: code, received: true }); }
  async function completeWallet() {
    const id = await h.createOrder(A, 'wallet'); const code = await start(id);
    h.status(await confirm(id, code), 200); return id;
  }
  async function payoutState() {
    return {
      payouts: (await h.query('SELECT * FROM driver_payouts ORDER BY id')).rows,
      items: (await h.query('SELECT * FROM payout_items ORDER BY order_id')).rows,
    };
  }
  async function payout(startDate, endDate, actor = finance) {
    return h.request('/admin/payouts', actor.token, 'POST', { driver_id: P.id, period_start: startDate, period_end: endDate });
  }
  async function earningFixture({ date = '2026-10-08T12:00:00Z', status = 'delivered', paid = true, ledger = true, ledgerUser = A, amountDelta = 0, ledgerCurrency = 'LYD', ledgerMethod = 'cash', tip = 0 } = {}) {
    const id = await h.createOrder(A, 'cash');
    await h.query('UPDATE orders SET driver_id=$1,status=$2,payment_status=$3,delivered_at=$4,tip_amount=$5 WHERE id=$6', [P.id, status, paid ? 'paid' : 'pending', date, tip, id]);
    const order = await h.order(id);
    if (ledger) await h.query("INSERT INTO transactions(user_id,order_id,type,amount,currency,payment_method,status) VALUES($1,$2,'order_payment',$3,$4,$5,'completed')", [ledgerUser.id, id, (cents(order.final_price) + amountDelta) / 100, ledgerCurrency, ledgerMethod]);
    return id;
  }

  await h.test('Pricing conserves every cent across all configured vehicles and pricing combinations', async () => {
    const { calculatePrice } = require(path.join(h.backend, 'src/utils/helpers'));
    const oldVAT = process.env.VAT_RATE, oldCommission = process.env.COMMISSION_RATE;
    process.env.VAT_RATE = '0.10'; process.env.COMMISSION_RATE = '0.18';
    let combinations = 0;
    try {
      for (const vehicleType of ['motorcycle', 'car', 'van', 'truck']) for (const distanceKm of [5, 15, 30, 60, 101]) for (const priority of ['standard', 'priority', 'urgent']) for (const customerTier of ['bronze', 'silver', 'gold']) {
        const first = calculatePrice({ vehicleType, distanceKm, priority, customerTier, packageCount: 1 });
        assert.deepEqual(calculatePrice({ vehicleType, distanceKm, priority, customerTier, packageCount: 2 }), first, 'Configured zero discount for two packages was overwritten');
        for (let packageCount = 1; packageCount <= 8; packageCount++) {
          const price = calculatePrice({ vehicleType, distanceKm, priority, customerTier, packageCount });
          for (const [key, value] of Object.entries(price)) assert.ok(Number.isFinite(value) && value >= 0 && Number.isSafeInteger(cents(value)), `${key}: ${value}`);
          assert.equal(cents(price.driverEarnings) + cents(price.commissionAmount) + cents(price.vatAmount), cents(price.finalPrice));
          assert.equal(cents(price.basePrice) - cents(price.customerDiscount) + cents(price.vatAmount), cents(price.finalPrice));
          assert.equal(cents(price.totalPrice), cents(price.finalPrice)); combinations++;
        }
      }
      for (const variable of ['VAT_RATE', 'COMMISSION_RATE']) for (const value of ['NaN', 'Infinity', '-0.01', '1.001', '0.1invalid']) {
        const original = process.env[variable]; process.env[variable] = value;
        assert.throws(() => calculatePrice({ vehicleType: 'car', distanceKm: 5 })); process.env[variable] = original;
      }
      process.env.VAT_RATE = '0.7'; process.env.COMMISSION_RATE = '0.7';
      const halfUp = calculatePrice({ vehicleType: 'car', distanceKm: 5, customerTier: 'gold', packageCount: 6 });
      assert.equal(cents(halfUp.basePrice) - cents(halfUp.customerDiscount), 675);
      assert.equal(cents(halfUp.vatAmount), 473, 'Exact 472.5 cents VAT must round half up');
      assert.equal(cents(halfUp.commissionAmount), 473, 'Exact 472.5 cents commission must round half up');
      assert.equal(cents(halfUp.driverEarnings), 202); assert.equal(cents(halfUp.finalPrice), 1148);
    } finally {
      if (oldVAT === undefined) delete process.env.VAT_RATE; else process.env.VAT_RATE = oldVAT;
      if (oldCommission === undefined) delete process.env.COMMISSION_RATE; else process.env.COMMISSION_RATE = oldCommission;
    }
    return { combinations, bothCentConservationIdentities: true, twoPackageZeroDiscountPreserved: true, invalidRatesRejected: 10, exactHalfUp675CentsAt70Percent: 473 };
  });
  await h.test('Unimplemented card and bank payments cannot create falsely paid orders', async () => {
    const before = await financialState();
    for (const method of ['card', 'bank_transfer']) {
      const response = await h.request('/orders', A.token, 'POST', body(method)); h.status(response, 409);
      assert.equal(response.body.error.code, 'PAYMENT_UNAVAILABLE'); assert.deepEqual(await financialState(), before);
    }
    return { blockedMethods: ['card', 'bank_transfer'], noOrderOrLedgerMutation: true };
  });
  await h.test('Zero or missing wallet funds cannot create an order', async () => {
    const before = await financialState();
    const noFunds = await h.request('/orders', A.token, 'POST', body('wallet')); h.status(noFunds, 409); assert.equal(noFunds.body.error.code, 'INSUFFICIENT_BALANCE');
    assert.deepEqual(await financialState(), before);
    await h.query('DELETE FROM wallets WHERE user_id=$1', [B.id]);
    const noWalletBefore = await financialState();
    const missing = await h.request('/orders', B.token, 'POST', body('wallet')); h.status(missing, 409); assert.equal(missing.body.error.code, 'INSUFFICIENT_BALANCE');
    assert.deepEqual(await financialState(), noWalletBefore);
    await h.query('INSERT INTO wallets(user_id) VALUES($1)', [B.id]);
    return { rejectedZeroFundsAndMissingWallet: true, financialStateUnchanged: true };
  });
  await h.test('Wallet currency mismatch preserves balance, orders and ledger', async () => {
    await fund('100.00', 'USD'); const before = await financialState();
    const response = await h.request('/orders', A.token, 'POST', body('wallet')); h.status(response, 409); assert.equal(response.body.error.code, 'PAYMENT_MISMATCH');
    assert.deepEqual(await financialState(), before); await fund('100.00');
    return { mismatchedCurrencyRejected: true, financialStateUnchanged: true };
  });
  await h.test('Wallet creation debits exactly once and records matching completed payment', async () => {
    await fund('100.00'); const before = await wallet();
    const response = await h.request('/orders', A.token, 'POST', body('wallet')); h.status(response, 201);
    const id = response.body.data.order_id; const order = await h.order(id); const after = await wallet();
    assert.equal(order.payment_status, 'paid'); assert.equal(response.body.data.payment_status, 'paid'); assert.equal(response.body.data.payment_method, 'wallet');
    assert.equal(cents(before.balance) - cents(after.balance), cents(order.final_price));
    assert.equal(response.body.data.wallet_balance, after.balance);
    const rows = (await h.query("SELECT * FROM transactions WHERE order_id=$1 AND type='order_payment' AND status='completed'", [id])).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].user_id, A.id); assert.equal(rows[0].amount, order.final_price); assert.equal(rows[0].currency, 'LYD'); assert.equal(rows[0].payment_method, 'wallet');
    assert.equal(response.body.data.payment_transaction_id, rows[0].id);
    const beforeDelivery = await wallet(); const code = await start(id); h.status(await confirm(id, code), 200);
    assert.deepEqual(await wallet(), beforeDelivery); assert.equal((await h.query("SELECT count(*) FROM transactions WHERE order_id=$1 AND type='order_payment' AND status='completed'", [id])).rows[0].count, '1');
    return { exactDebitCents: cents(order.final_price), oneMatchingLedgerEntry: true, deliveryDidNotDebitAgain: true };
  });
  await h.test('Two concurrent wallet orders cannot overdraw one-order balance', async () => {
    await fund('11.00');
    const replies = await Promise.all([1, 2].map(() => h.request('/orders', A.token, 'POST', body('wallet'))));
    assert.equal(replies.filter(r => r.status === 201).length, 1, JSON.stringify(replies));
    assert.equal(replies.filter(r => r.status === 409 && r.body.error.code === 'INSUFFICIENT_BALANCE').length, 1, JSON.stringify(replies));
    assert.equal(cents((await wallet()).balance), 0);
    const id = replies.find(r => r.status === 201).body.data.order_id;
    assert.equal((await h.query("SELECT count(*) FROM transactions WHERE order_id=$1 AND type='order_payment' AND status='completed'", [id])).rows[0].count, '1');
    h.status(await h.request(`/orders/${id}/cancel`, A.token, 'POST', { reason: 'concurrent debit fixture cleanup' }), 200);
    assert.equal(cents((await wallet()).balance), 1100);
    return { responseStatuses: replies.map(r => r.status), walletNeverNegative: true, onePayment: true };
  });
  await h.test('Forced wallet ledger failure rolls back debit and new order atomically', async () => {
    await fund('100.00'); const before = await financialState();
    await h.query(`CREATE FUNCTION verification_wallet_ledger_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${A.id}'::uuid AND NEW.type='order_payment' AND NEW.payment_method='wallet' THEN RAISE EXCEPTION 'forced wallet ledger failure'; END IF; RETURN NEW; END $$`);
    await h.query('CREATE TRIGGER verification_wallet_ledger_failure BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION verification_wallet_ledger_failure()');
    try { h.status(await h.request('/orders', A.token, 'POST', body('wallet')), 500); assert.deepEqual(await financialState(), before); }
    finally { await h.query('DROP TRIGGER verification_wallet_ledger_failure ON transactions'); await h.query('DROP FUNCTION verification_wallet_ledger_failure()'); }
    return { walletOrderAndLedgerRolledBack: true };
  });
  await h.test('Wallet cancellation through both APIs refunds the full payment once with zero fee', async () => {
    for (const generic of [false, true]) {
      await fund('100.00'); const id = await h.createOrder(A, 'wallet'); await start(id);
      const response = await h.request(generic ? `/orders/${id}/status` : `/orders/${id}/cancel`, A.token, generic ? 'PATCH' : 'POST', { status: 'cancelled', reason: 'wallet refund' }); h.status(response, 200);
      const order = await h.order(id); assert.equal(order.status, 'cancelled'); assert.equal(order.payment_status, 'refunded'); assert.equal(cents(order.cancellation_fee), 0); assert.equal(cents((await wallet()).balance), 10000);
      const refunds = (await h.query("SELECT * FROM transactions WHERE order_id=$1 AND type='order_refund' AND status='completed'", [id])).rows;
      assert.equal(refunds.length, 1); assert.equal(refunds[0].amount, order.final_price); assert.equal(refunds[0].user_id, A.id); assert.equal(refunds[0].currency, 'LYD'); assert.equal(refunds[0].payment_method, 'wallet');
      assert.equal(Number((await h.query('SELECT count(*) FROM refunds WHERE order_id=$1', [id])).rows[0].count), 1);
      const before = await financialState(); h.status(await h.request(`/orders/${id}/cancel`, A.token, 'POST', {}), 400); assert.deepEqual(await financialState(), before);
    }
    return { bothCancellationRoutesRefundExactlyOnce: true, fullRefundWithZeroFee: true, replayUnchanged: true };
  });
  await h.test('Concurrent wallet cancellation creates one refund and one wallet credit', async () => {
    await fund('100.00'); const id = await h.createOrder(A, 'wallet');
    const replies = await Promise.all(Array.from({ length: 6 }, (_, i) => h.request(i % 2 ? `/orders/${id}/status` : `/orders/${id}/cancel`, A.token, i % 2 ? 'PATCH' : 'POST', { status: 'cancelled', reason: 'refund race' })));
    assert.equal(replies.filter(r => r.status === 200).length, 1, JSON.stringify(replies)); assert.equal(replies.filter(r => r.status === 400).length, 5, JSON.stringify(replies));
    assert.equal(cents((await wallet()).balance), 10000); assert.equal(Number((await h.query("SELECT count(*) FROM transactions WHERE order_id=$1 AND type='order_refund' AND status='completed'", [id])).rows[0].count), 1);
    assert.equal(Number((await h.query('SELECT count(*) FROM refunds WHERE order_id=$1', [id])).rows[0].count), 1);
    return { responseStatuses: replies.map(r => r.status), oneRefundAndOneCredit: true };
  });
  await h.test('Wallet refund racing delivery commits only the winning operation', async () => {
    await fund('100.00'); const id = await h.createOrder(A, 'wallet'); const code = await start(id);
    const beforeDriver = (await h.query('SELECT total_trips,total_earnings FROM drivers WHERE user_id=$1', [D.id])).rows[0];
    const beforeCustomer = (await h.query('SELECT total_orders,total_spent FROM customers WHERE user_id=$1', [A.id])).rows[0];
    const replies = await Promise.all([confirm(id, code), h.request(`/orders/${id}/cancel`, A.token, 'POST', { reason: 'delivery refund race' })]);
    assert.equal(replies.filter(r => r.status === 200).length, 1, JSON.stringify(replies)); assert.ok(replies.filter(r => r.status !== 200).every(r => [400, 409].includes(r.status)), JSON.stringify(replies));
    const order = await h.order(id); const refunded = order.status === 'cancelled'; assert.ok(['cancelled', 'delivered'].includes(order.status));
    assert.equal(cents((await wallet()).balance), refunded ? 10000 : 10000 - cents(order.final_price));
    assert.equal(Number((await h.query("SELECT count(*) FROM transactions WHERE order_id=$1 AND type='order_payment' AND status='completed'", [id])).rows[0].count), 1);
    assert.equal(Number((await h.query("SELECT count(*) FROM transactions WHERE order_id=$1 AND type='order_refund' AND status='completed'", [id])).rows[0].count), refunded ? 1 : 0);
    const afterDriver = (await h.query('SELECT total_trips,total_earnings,availability FROM drivers WHERE user_id=$1', [D.id])).rows[0];
    const afterCustomer = (await h.query('SELECT total_orders,total_spent FROM customers WHERE user_id=$1', [A.id])).rows[0];
    assert.equal(afterDriver.total_trips, beforeDriver.total_trips + (refunded ? 0 : 1)); assert.equal(cents(afterDriver.total_earnings), cents(beforeDriver.total_earnings) + (refunded ? 0 : cents(order.driver_earnings)));
    assert.equal(afterCustomer.total_orders, beforeCustomer.total_orders + (refunded ? 0 : 1)); assert.equal(cents(afterCustomer.total_spent), cents(beforeCustomer.total_spent) + (refunded ? 0 : cents(order.final_price))); assert.equal(afterDriver.availability, 'available');
    return { responseStatuses: replies.map(r => r.status), winningState: order.status, noDoubleDeliveryOrRefund: true };
  });
  await h.test('Legacy refunded wallet orders cannot confirm delivery or change accounting', async () => {
    for (const source of ['completed_ledger', 'processed_refund_record']) {
      await fund('100.00'); const id = await h.createOrder(A, 'wallet'); const code = await start(id); const order = await h.order(id);
      if (source === 'completed_ledger') {
        await h.query("INSERT INTO transactions(user_id,order_id,type,amount,currency,payment_method,status) VALUES($1,$2,'order_refund',$3,'LYD','wallet','completed')", [A.id, id, order.final_price]);
      } else {
        await h.query("INSERT INTO refunds(order_id,amount,reason,approved_by,processed_at) VALUES($1,$2,'legacy prior refund claim',$3,NOW())", [id, order.final_price, admin.id]);
      }
      const before = await financialState(), beforeCounters = await h.snapshot(id);
      const response = await confirm(id, code); h.status(response, 409); assert.equal(response.body.error.code, 'PAYMENT_MISMATCH');
      assert.deepEqual(await financialState(), before); assert.deepEqual(await h.snapshot(id), beforeCounters);
      // Isolate the deliberately inconsistent legacy fixture without changing
      // its wallet, refund claim, payment ledger or counters.
      await h.query("UPDATE orders SET status='cancelled',cancelled_at=NOW(),cancellation_reason='verification legacy refund isolation' WHERE id=$1", [id]);
      await h.query("UPDATE drivers SET availability='available' WHERE user_id=$1", [D.id]);
    }
    return { completedRefundLedgerBlocked: true, processedRefundRecordBlocked: true, balancesCountersAndFinancialHistoryUnchanged: true };
  });

  await h.test('Payout dates and permissions reject invalid requests without reservations', async () => {
    const before = await payoutState();
    for (const [startDate, endDate] of [['2026-10-10', '2026-10-09'], ['2026-02-30', '2026-03-01'], ['2026-10-08T12:00:00Z', '2026-10-09'], ['bad-date', '2026-10-09']]) {
      const response = await payout(startDate, endDate); h.status(response, 400); assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    }
    h.status(await payout('2026-10-08', '2026-10-08', A), 403); h.status(await payout('2026-10-08', '2026-10-08', D), 403);
    h.status(await h.request('/admin/payouts', null, 'POST', { driver_id: P.id, period_start: '2026-10-08', period_end: '2026-10-08' }), 401);
    assert.deepEqual(await payoutState(), before); return { invalidDatePairs: 4, forbiddenActors: 3, noReservations: true };
  });
  let eligible, firstPayout;
  await h.test('Payout reserves only matching paid delivered orders, includes entire end date and excludes unfunded tips', async () => {
    eligible = [await earningFixture(), await earningFixture({ date: '2026-10-08T23:59:59.999Z', tip: 999 })];
    await earningFixture({ date: '2026-10-09T00:00:00Z' });
    await earningFixture({ paid: false, ledger: false }); await earningFixture({ status: 'accepted' }); await earningFixture({ status: 'cancelled' });
    await earningFixture({ ledgerUser: B }); await earningFixture({ amountDelta: -1 }); await earningFixture({ ledgerCurrency: 'USD' }); await earningFixture({ ledgerMethod: 'card' });
    const ledgerRefunded = await earningFixture(); const recordRefunded = await earningFixture();
    const ledgerRefundedOrder = await h.order(ledgerRefunded), recordRefundedOrder = await h.order(recordRefunded);
    await h.query("INSERT INTO transactions(user_id,order_id,type,amount,currency,payment_method,status) VALUES($1,$2,'order_refund',$3,'LYD','cash','completed')", [A.id, ledgerRefunded, ledgerRefundedOrder.final_price]);
    await h.query("INSERT INTO refunds(order_id,amount,reason,approved_by,processed_at) VALUES($1,$2,'legacy processed refund',$3,NOW())", [recordRefunded, recordRefundedOrder.final_price, admin.id]);
    const response = await payout('2026-10-08', '2026-10-08'); h.status(response, 201);
    assert.equal(response.body.data.status, 'pending'); assert.equal(typeof response.body.data.amount, 'string'); assert.equal(response.body.data.trips, 2);
    firstPayout = response.body.data.payout_id;
    const items = (await h.query('SELECT * FROM payout_items WHERE payout_id=$1 ORDER BY order_id', [firstPayout])).rows;
    assert.deepEqual(items.map(item => item.order_id).sort(), eligible.sort()); assert.ok(items.every(item => item.currency === 'LYD'));
    const earnings = (await h.query('SELECT driver_earnings FROM orders WHERE id=ANY($1::varchar[])', [eligible])).rows.reduce((sum, row) => sum + cents(row.driver_earnings), 0);
    assert.equal(cents(response.body.data.amount), earnings); assert.equal(items.reduce((sum, row) => sum + cents(row.amount), 0), earnings);
    const row = (await h.query('SELECT * FROM driver_payouts WHERE id=$1', [firstPayout])).rows[0]; assert.equal(row.status, 'pending'); assert.equal(row.processed_at, null); assert.equal(row.bank_reference, null);
    return { allocatedOrders: eligible, pendingOnly: true, includedEndDate235959: true, exactAmountWithoutUnfundedTip: row.total_earnings, mismatchedPaymentsExcluded: true, completedLedgerAndProcessedRecordRefundsExcluded: true };
  });
  await h.test('Repeated and overlapping payout periods never reserve an order twice', async () => {
    const before = await payoutState();
    for (const dates of [['2026-10-08', '2026-10-08'], ['2026-10-07', '2026-10-08']]) {
      const response = await payout(...dates); h.status(response, 400); assert.equal(response.body.error.code, 'NO_EARNINGS'); assert.deepEqual(await payoutState(), before);
    }
    let duplicate;
    try { await h.query('INSERT INTO payout_items(order_id,payout_id,amount,currency) VALUES($1,$2,1,\'LYD\')', [eligible[0], firstPayout]); } catch (err) { duplicate = err; }
    assert.equal(duplicate?.code, '23505'); assert.deepEqual(await payoutState(), before);
    return { repeatedAndOverlappingPeriodsBlocked: true, orderAllocationUniqueSQLCode: duplicate.code };
  });
  await h.test('Concurrent payout requests create one pending reservation for one order', async () => {
    const id = await earningFixture({ date: '2026-10-10T12:00:00Z' });
    const replies = await Promise.all(Array.from({ length: 5 }, () => payout('2026-10-10', '2026-10-10')));
    assert.equal(replies.filter(r => r.status === 201).length, 1, JSON.stringify(replies)); assert.equal(replies.filter(r => r.status === 400 && r.body.error.code === 'NO_EARNINGS').length, 4, JSON.stringify(replies));
    assert.equal(Number((await h.query('SELECT count(*) FROM payout_items WHERE order_id=$1', [id])).rows[0].count), 1);
    const row = (await h.query('SELECT p.* FROM driver_payouts p JOIN payout_items i ON i.payout_id=p.id WHERE i.order_id=$1', [id])).rows[0]; assert.equal(row.status, 'pending'); assert.equal(row.processed_at, null);
    return { responseStatuses: replies.map(r => r.status), onePendingPayout: true, oneAllocation: true };
  });
  await h.test('Forced payout allocation failure rolls back payout and every allocation', async () => {
    const id = await earningFixture({ date: '2026-10-11T12:00:00Z' }); const before = await payoutState();
    await h.query(`CREATE FUNCTION verification_payout_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.order_id='${id}' THEN RAISE EXCEPTION 'forced payout allocation failure'; END IF; RETURN NEW; END $$`);
    await h.query('CREATE TRIGGER verification_payout_failure BEFORE INSERT ON payout_items FOR EACH ROW EXECUTE FUNCTION verification_payout_failure()');
    try { h.status(await payout('2026-10-11', '2026-10-11'), 500); assert.deepEqual(await payoutState(), before); }
    finally { await h.query('DROP TRIGGER verification_payout_failure ON payout_items'); await h.query('DROP FUNCTION verification_payout_failure()'); }
    const retry = await payout('2026-10-11', '2026-10-11'); h.status(retry, 201); assert.equal(retry.body.data.status, 'pending');
    return { failedReservationFullyRolledBack: true, retrySuccessful: true };
  });
  await h.test('Historical unallocated payout blocks new periods until accounting reconciliation', async () => {
    await earningFixture({ date: '2026-10-12T12:00:00Z' });
    await h.query("INSERT INTO driver_payouts(driver_id,period_start,period_end,total_earnings,total_trips,status,processed_by,processed_at) VALUES($1,'2025-01-01','2025-01-01',1,1,'completed',$2,NOW())", [P.id, admin.id]);
    const before = await payoutState(); const response = await payout('2026-10-12', '2026-10-12'); h.status(response, 409); assert.equal(response.body.error.code, 'PAYOUT_RECONCILIATION_REQUIRED'); assert.deepEqual(await payoutState(), before);
    return { unrelatedLegacyPeriodStillBlocksUnsafeReallocation: true, financialHistoryPreserved: true };
  });
  await h.test('Financial overview excludes unfunded and refunded delivery revenue and counts only processed refunds', async () => {
    const overview = async () => { const response = await h.request('/admin/finance?period=year', finance.token); h.status(response, 200); return response.body.data; };
    const before = await overview(); const date = new Date().toISOString();
    const unpaid = await earningFixture({ date, paid: false, ledger: false }); await earningFixture({ date, paid: true, ledger: false });
    await h.query("INSERT INTO refunds(order_id,amount,reason,approved_by) VALUES($1,99,'unprocessed fixture refund',$2)", [unpaid, admin.id]);
    const ledgerRefunded = await earningFixture({ date }), recordRefunded = await earningFixture({ date });
    const ledgerOrder = await h.order(ledgerRefunded), recordOrder = await h.order(recordRefunded);
    await h.query("INSERT INTO transactions(user_id,order_id,type,amount,currency,payment_method,status) VALUES($1,$2,'order_refund',$3,'LYD','cash','completed')", [A.id, ledgerRefunded, ledgerOrder.final_price]);
    await h.query("INSERT INTO refunds(order_id,amount,reason,approved_by,processed_at) VALUES($1,$2,'processed fixture refund',$3,NOW())", [recordRefunded, recordOrder.final_price, admin.id]);
    const excluded = await overview(); assert.deepEqual(excluded.revenue, before.revenue);
    assert.equal(excluded.refunds.count, before.refunds.count + 1); assert.equal(cents(excluded.refunds.total), cents(before.refunds.total) + cents(recordOrder.final_price));
    const funded = await earningFixture({ date }); const fundedOrder = await h.order(funded); const after = await overview();
    assert.equal(after.revenue.orders, before.revenue.orders + 1);
    assert.equal(cents(after.revenue.total), cents(before.revenue.total) + cents(fundedOrder.final_price));
    assert.equal(cents(after.revenue.vat), cents(before.revenue.vat) + cents(fundedOrder.vat_amount));
    assert.equal(cents(after.revenue.commission), cents(before.revenue.commission) + cents(fundedOrder.commission_amount));
    assert.deepEqual(after.refunds, excluded.refunds);
    return { unfundedAndRefundedRevenueExcluded: true, onlyProcessedRefundCounted: true, oneFundedOrderAddsExactRevenueVATAndCommission: true };
  });
  await h.test('Legacy migrations001 and002 are repeatable and reject null or negative balances without altering history', async () => {
    const schema = fs.readFileSync(path.join(__dirname, 'fixtures/legacy-schema.sql'), 'utf8').replace(/^CREATE EXTENSION IF NOT EXISTS "postgis";.*$/m, '');
    const migration1 = fs.readFileSync(path.join(h.backend, 'migrations/001_delivery_integrity.sql'), 'utf8');
    const migration2 = fs.readFileSync(path.join(h.backend, 'migrations/002_payment_integrity.sql'), 'utf8');
    const createLegacy = async suffix => {
      const database = `${h.databaseName}_${suffix}`; await h.query(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8'`);
      const client = new Client({ host: '127.0.0.1', port: h.results.environment.dbPort, user: 'postgres', database }); await client.connect(); await client.query(schema);
      await client.query("INSERT INTO users(id,role,email,phone,password_hash,full_name_ar) VALUES($1,'customer','migration@example.com','+218990300001','fixture','Migration Customer')", [A.id]);
      return client;
    };
    const clean = await createLegacy('upgrade');
    try {
      await clean.query("INSERT INTO wallets(user_id,balance,currency) VALUES($1,100,'LYD')", [A.id]);
      for (let attempt = 0; attempt < 2; attempt++) { await clean.query(migration1); await clean.query(migration2); }
      assert.equal((await clean.query("SELECT to_regclass('public.payout_items') IS NOT NULL AS installed")).rows[0].installed, true);
      assert.equal((await clean.query('SELECT balance FROM wallets WHERE user_id=$1', [A.id])).rows[0].balance, '100.00');
    } finally { await clean.end(); }
    const corrupt = await createLegacy('invalid');
    try {
      await corrupt.query(migration1);
      await corrupt.query("INSERT INTO wallets(user_id,balance,currency) VALUES($1,NULL,'LYD')", [A.id]);
      for (const value of [null, '-1.00']) {
        await corrupt.query('UPDATE wallets SET balance=$1 WHERE user_id=$2', [value, A.id]);
        const before = (await corrupt.query('SELECT * FROM wallets ORDER BY user_id')).rows;
        let blocked; try { await corrupt.query(migration2); } catch (err) { blocked = err; await corrupt.query('ROLLBACK'); }
        assert.ok(blocked, `Migration accepted invalid balance ${value}`); assert.deepEqual((await corrupt.query('SELECT * FROM wallets ORDER BY user_id')).rows, before);
        assert.equal((await corrupt.query("SELECT to_regclass('public.payout_items') IS NULL AS absent")).rows[0].absent, true);
      }
    } finally { await corrupt.end(); }
    return { originalSchemaUpgradedTwice: true, payoutAllocationTableInstalled: true, nullAndNegativeBalancesBlocked: true, failedUpgradePreservedBalancesAndSchema: true };
  });
  await h.test('Actual upgrade command upgrades legacy database twice and stops before002 on duplicate001 history', async () => {
    const schema = fs.readFileSync(path.join(__dirname, 'fixtures/legacy-schema.sql'), 'utf8').replace(/^CREATE EXTENSION IF NOT EXISTS "postgis";.*$/m, '');
    const setup = async suffix => {
      const database = `${h.databaseName}_${suffix}`; await h.query(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8'`);
      const client = new Client({ host: '127.0.0.1', port: h.results.environment.dbPort, user: 'postgres', database }); await client.connect(); await client.query(schema);
      await client.query("INSERT INTO users(id,role,email,phone,password_hash,full_name_ar) VALUES($1,'customer','upgrade@example.com','+218990300002','fixture','Upgrade Customer')", [A.id]);
      await client.query("INSERT INTO wallets(user_id,balance,currency) VALUES($1,100,'LYD')", [A.id]); return { database, client };
    };
    const run = async database => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['src/scripts/upgrade.js'], { cwd: h.backend, env: {
        ...process.env, NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: String(h.results.environment.dbPort), DB_NAME: database, DB_USER: 'postgres', DB_PASSWORD: '',
        LD_LIBRARY_PATH: [path.join(h.native, 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
      }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Upgrade command timed out')); }, 15000);
      child.once('error', err => { clearTimeout(timer); reject(err); }); child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
    });
    const clean = await setup('runner_clean');
    try {
      for (let attempt = 0; attempt < 2; attempt++) { const result = await run(clean.database); assert.equal(result.code, 0, result.output); assert.match(result.output, /Applied 001_delivery_integrity.sql/); assert.match(result.output, /Applied 002_payment_integrity.sql/); }
      assert.equal((await clean.client.query("SELECT to_regclass('public.payout_items') IS NOT NULL AS installed")).rows[0].installed, true);
      assert.equal((await clean.client.query('SELECT balance FROM wallets WHERE user_id=$1', [A.id])).rows[0].balance, '100.00');
    } finally { await clean.client.end(); }
    const corrupt = await setup('runner_duplicate');
    try {
      await corrupt.client.query('INSERT INTO customers(user_id) VALUES($1)', [A.id]);
      await corrupt.client.query("INSERT INTO orders(id,customer_id,pickup_address,pickup_lat,pickup_lng,dropoff_address,dropoff_lat,dropoff_lng,distance,vehicle_type,base_price,vat_amount,total_price,final_price,payment_method) VALUES('ORD-99003',$1,'Upgrade pickup',32,13,'Upgrade dropoff',32.1,13.1,5,'car',10,1,11,11,'cash')", [A.id]);
      for (let duplicate = 0; duplicate < 2; duplicate++) await corrupt.client.query("INSERT INTO transactions(user_id,order_id,type,amount,currency,payment_method,status) VALUES($1,'ORD-99003','order_payment',11,'LYD','cash','completed')", [A.id]);
      const before = (await corrupt.client.query('SELECT * FROM transactions ORDER BY id')).rows;
      const result = await run(corrupt.database); assert.notEqual(result.code, 0); assert.match(result.output, /001_delivery_integrity.sql failed/); assert.equal(result.output.includes('Applied 002_payment_integrity.sql'), false);
      assert.deepEqual((await corrupt.client.query('SELECT * FROM transactions ORDER BY id')).rows, before);
      assert.equal((await corrupt.client.query("SELECT to_regclass('public.payout_items') IS NULL AS absent")).rows[0].absent, true);
      assert.equal((await corrupt.client.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='wallets' AND column_name='balance'")).rows[0].is_nullable, 'YES');
    } finally { await corrupt.client.end(); }
    return { actualUpgradeCommandRepeatedSuccessfully: true, duplicate001HistoryStops002: true, historicalLedgerAndLegacyBalanceSchemaPreserved: true };
  });
}

let harness;
createHarness('step3').then(async h => { harness = h; await main(h); })
  .catch(err => { process.exitCode = 1; if (harness) harness.fatal = err; console.error(err.stack); })
  .finally(async () => { if (harness) await harness.close(harness.fatal); });
