const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { createHarness } = require('./harness.cjs');

async function main(h) {
  const { assert } = h;
  const A = await h.register('customer', 'receipt-owner', '+218910200001');
  const B = await h.register('customer', 'receipt-stranger', '+218910200002');
  const D = await h.register('driver', 'receipt-assigned', '+218910200003');
  const E = await h.register('driver', 'receipt-other-driver', '+218910200004');
  const admin = await h.admin();
  const finance = await h.fixture('finance', 'receipt-finance');
  await h.setupDriver(D, admin);
  await h.setupDriver(E, admin);
  const proof = code => ({ qr_code: code, received: true, cash_paid: true });
  async function ready(payment = 'cash') {
    const id = await h.createOrder(A, payment === 'card' ? 'cash' : payment);
    // Legacy card orders remain reviewable after new unimplemented card charges
    // are disabled. This fixture does not pretend a gateway is available.
    if (payment === 'card') await h.query("UPDATE orders SET payment_method='card' WHERE id=$1", [id]);
    h.status(await h.request(`/drivers/orders/${id}/accept`, D.token, 'POST', {}), 200, 'accept delivery');
    h.status(await h.request(`/orders/${id}/status`, D.token, 'PATCH', { status: 'in_transit' }), 200, 'start delivery');
    const generated = await h.request(`/orders/${id}/generate-qr`, D.token, 'POST', {});
    h.status(generated, 200, 'generate delivery QR');
    assert.match(generated.body.data.qr_code, /^[A-F0-9]{32}$/);
    return { id, code: generated.body.data.qr_code, generated: generated.body.data };
  }
  async function cancel(id) { h.status(await h.request(`/orders/${id}/cancel`, A.token, 'POST', { reason: 'verification cleanup' }), 200); }
  async function deniedUnchanged(id, actor, body, expected, code) {
    const before = await h.snapshot(id);
    const response = await h.request(`/orders/${id}/verify-qr`, actor.token, 'POST', body);
    h.status(response, expected);
    if (code) assert.equal(response.body.error.code, code);
    assert.deepEqual(await h.snapshot(id), before);
    return response;
  }
  async function counters() {
    return {
      driver: (await h.query('SELECT total_trips,total_earnings,availability FROM drivers WHERE user_id=$1', [D.id])).rows[0],
      customer: (await h.query('SELECT total_orders,total_spent FROM customers WHERE user_id=$1', [A.id])).rows[0],
    };
  }
  async function assertCompletedExactlyOnce(orderId, before) {
    const order = await h.order(orderId);
    const after = await counters();
    assert.equal(order.status, 'delivered'); assert.equal(order.payment_status, 'paid');
    assert.ok(order.qr_scanned_at); assert.ok(order.delivered_at);
    assert.equal(after.driver.total_trips, before.driver.total_trips + 1);
    assert.equal(Number(after.driver.total_earnings), Number((Number(before.driver.total_earnings) + Number(order.driver_earnings)).toFixed(2)));
    assert.equal(after.driver.availability, 'available');
    assert.equal(after.customer.total_orders, before.customer.total_orders + 1);
    assert.equal(Number(after.customer.total_spent), Number((Number(before.customer.total_spent) + Number(order.final_price)).toFixed(2)));
    const payments = (await h.query("SELECT * FROM transactions WHERE order_id=$1 AND type='order_payment' AND status='completed'", [orderId])).rows;
    assert.equal(payments.length, 1); assert.equal(payments[0].user_id, A.id);
    assert.equal(payments[0].amount, order.final_price); assert.equal(payments[0].currency, order.currency); assert.equal(payments[0].payment_method, order.payment_method);
    return { oneTrip: true, oneCustomerOrder: true, oneCompletedPayment: true, earningsExact: true, driverAvailable: true };
  }

  await h.test('Pending, accepted and cancelled orders cannot be confirmed or regenerate QR', async () => {
    const id = await h.createOrder(A);
    const legacyCode = '0123456789ABCDEF0123456789ABCDEF';
    await h.query('UPDATE orders SET qr_code=$1,qr_generated_at=NOW() WHERE id=$2', [legacyCode, id]);
    await deniedUnchanged(id, A, proof(legacyCode), 409);
    h.status(await h.request(`/orders/${id}/generate-qr`, D.token, 'POST', {}), 403, 'unassigned pending QR');
    h.status(await h.request(`/drivers/orders/${id}/accept`, D.token, 'POST', {}), 200);
    const accepted = await h.snapshot(id);
    h.status(await h.request(`/orders/${id}/generate-qr`, D.token, 'POST', {}), 409, 'accepted QR');
    assert.deepEqual(await h.snapshot(id), accepted);
    await deniedUnchanged(id, A, proof(legacyCode), 409);
    await cancel(id);
    const cancelled = await h.snapshot(id);
    h.status(await h.request(`/orders/${id}/generate-qr`, D.token, 'POST', {}), 409, 'cancelled QR');
    assert.deepEqual(await h.snapshot(id), cancelled);
    await deniedUnchanged(id, A, proof(legacyCode), 409);
    return { statesRejected: ['pending', 'accepted', 'cancelled'], stateUnchanged: true };
  });

  const delivery = await ready();
  await h.test('Only assigned driver generates QR; only owning customer confirms it', async () => {
    const before = await h.snapshot(delivery.id);
    for (const actor of [A, B, E, admin, finance]) {
      h.status(await h.request(`/orders/${delivery.id}/generate-qr`, actor.token, 'POST', {}), 403, 'unauthorized generator');
      assert.deepEqual(await h.snapshot(delivery.id), before);
    }
    for (const actor of [B, D, E, admin, finance]) await deniedUnchanged(delivery.id, actor, proof(delivery.code), 403);
    return { deniedGenerators: 5, deniedConfirmers: 5, assignedDriverCannotSelfConfirm: true, stateUnchanged: true };
  });
  await h.test('Ordinary order reads, lists and pending feeds never expose QR secrets', async () => {
    const feedId = await h.createOrder(A);
    const feedSecret = 'FEDCBA9876543210FEDCBA9876543210';
    await h.query('UPDATE orders SET qr_code=$1,qr_generated_at=NOW() WHERE id=$2', [feedSecret, feedId]);
    const requests = [
      [`/orders/${delivery.id}`, A], [`/orders/${delivery.id}`, D], [`/orders/${delivery.id}`, admin],
      ['/orders', A], ['/orders', D], ['/orders', admin], ['/drivers/orders', E],
    ];
    for (const [url, actor] of requests) {
      const response = await h.request(url, actor.token); h.status(response, 200, url);
      const serialized = JSON.stringify(response.body);
      assert.equal(serialized.includes(delivery.code), false, `${url} exposes active QR`);
      assert.equal(serialized.includes(feedSecret), false, `${url} exposes legacy pending QR`);
    }
    await cancel(feedId);
    return { verifiedResponses: requests.length, activeAndLegacyPendingSecretsHidden: true };
  });
  await h.test('Unexpired QR generation retry returns same token and timestamps', async () => {
    const before = await h.snapshot(delivery.id);
    const retry = await h.request(`/orders/${delivery.id}/generate-qr`, D.token, 'POST', {}); h.status(retry, 200);
    assert.equal(retry.body.data.qr_code, delivery.code);
    assert.equal(retry.body.data.generated_at, delivery.generated.generated_at);
    assert.equal(retry.body.data.expires_at, delivery.generated.expires_at);
    assert.deepEqual(await h.snapshot(delivery.id), before);
    return { sameToken: true, sameLifetime: true, noMutation: true };
  });
  await h.test('Malformed and wrong QR codes fail without changing delivery or accounting', async () => {
    const wrong = delivery.code === 'F'.repeat(32) ? 'A'.repeat(32) : 'F'.repeat(32);
    for (const value of [undefined, null, 123, [], {}, '', 'bad-code', wrong]) await deniedUnchanged(delivery.id, A, proof(value), 400);
    return { rejectedInputs: 8, stateUnchanged: true };
  });
  await h.test('Receipt and cash confirmation require explicit boolean true', async () => {
    for (const received of [undefined, false, null, 'true']) await deniedUnchanged(delivery.id, A, { qr_code: delivery.code, received, cash_paid: true }, 400);
    for (const cashPaid of [undefined, false, null, 'true']) await deniedUnchanged(delivery.id, A, { qr_code: delivery.code, received: true, cash_paid: cashPaid }, 400);
    const noReceipt = await deniedUnchanged(delivery.id, A, { qr_code: delivery.code, cash_paid: true }, 400, 'RECEIPT_REQUIRED');
    const noCash = await deniedUnchanged(delivery.id, A, { qr_code: delivery.code, received: true }, 400, 'CASH_CONFIRMATION_REQUIRED');
    return { rejectedInputs: 10, receiptCode: noReceipt.body.error.code, cashCode: noCash.body.error.code, stateUnchanged: true };
  });
  await h.test('Missing, future and expired generation times cannot confirm delivery', async () => {
    const original = (await h.order(delivery.id)).qr_generated_at;
    for (const sql of ['NULL', "NOW()+INTERVAL '1 minute'", "NOW()-INTERVAL '2 hours'"]) {
      await h.query(`UPDATE orders SET qr_generated_at=${sql} WHERE id=$1`, [delivery.id]);
      await deniedUnchanged(delivery.id, A, proof(delivery.code), 400, 'QR_EXPIRED');
    }
    await h.query('UPDATE orders SET qr_generated_at=$1 WHERE id=$2', [original, delivery.id]);
    return { invalidGenerationTimesRejected: 3, stateUnchanged: true };
  });
  await h.test('Direct delivered status cannot bypass customer QR confirmation', async () => {
    const before = await h.snapshot(delivery.id);
    for (const actor of [A, B, D, E, admin, finance]) {
      const response = await h.request(`/orders/${delivery.id}/status`, actor.token, 'PATCH', { status: 'delivered', ...proof(delivery.code) });
      h.status(response, actor === D || actor === admin ? 409 : 403);
      assert.deepEqual(await h.snapshot(delivery.id), before);
    }
    return { deniedBypasses: 6, stateUnchanged: true };
  });
  await h.test('Customer confirms cash delivery once; sequential replay changes nothing', async () => {
    const before = await counters();
    h.status(await h.request(`/orders/${delivery.id}/verify-qr`, A.token, 'POST', proof(delivery.code)), 200);
    const exact = await assertCompletedExactlyOnce(delivery.id, before);
    await deniedUnchanged(delivery.id, A, proof(delivery.code), 409);
    h.status(await h.request(`/orders/${delivery.id}/generate-qr`, D.token, 'POST', {}), 409);
    return { ...exact, sequentialReplayRejected: true, deliveredRegenerationRejected: true };
  });
  await h.test('Eight simultaneous confirmations commit exactly one delivery and payment', async () => {
    const item = await ready(); const before = await counters();
    const replies = await Promise.all(Array.from({ length: 8 }, () => h.request(`/orders/${item.id}/verify-qr`, A.token, 'POST', proof(item.code))));
    assert.equal(replies.filter(r => r.status === 200).length, 1, JSON.stringify(replies));
    assert.equal(replies.filter(r => r.status === 409).length, 7, JSON.stringify(replies));
    return { responseStatuses: replies.map(r => r.status), ...await assertCompletedExactlyOnce(item.id, before) };
  });
  await h.test('QR generation racing confirmation cannot rotate or double-confirm delivery', async () => {
    const item = await ready(); const before = await counters();
    const [generation, confirmation] = await Promise.all([
      h.request(`/orders/${item.id}/generate-qr`, D.token, 'POST', {}),
      h.request(`/orders/${item.id}/verify-qr`, A.token, 'POST', proof(item.code)),
    ]);
    h.status(confirmation, 200, 'confirmation racing QR retry');
    assert.ok([200, 409].includes(generation.status), JSON.stringify(generation));
    if (generation.status === 200) assert.equal(generation.body.data.qr_code, item.code);
    await deniedUnchanged(item.id, A, proof(item.code), 409);
    return { generationHttp: generation.status, confirmationHttp: confirmation.status, ...await assertCompletedExactlyOnce(item.id, before) };
  });
  await h.test('Confirmation racing cash cancellation has one winner and no double accounting or refund', async () => {
    const outcomes = [];
    for (let race = 0; race < 3; race++) {
      const item = await ready(); const before = await counters();
      const actions = [
        () => h.request(`/orders/${item.id}/verify-qr`, A.token, 'POST', proof(item.code)),
        () => h.request(`/orders/${item.id}/cancel`, A.token, 'POST', { reason: 'concurrent cash cancellation' }),
      ];
      if (race % 2) actions.reverse();
      const replies = await Promise.all(actions.map(action => action()));
      assert.equal(replies.filter(reply => reply.status === 200).length, 1, JSON.stringify(replies));
      assert.ok(replies.filter(reply => reply.status !== 200).every(reply => [400, 409].includes(reply.status)), JSON.stringify(replies));
      const order = await h.order(item.id);
      if (order.status === 'delivered') await assertCompletedExactlyOnce(item.id, before);
      else {
        assert.equal(order.status, 'cancelled'); assert.equal(order.cancelled_by, A.id); assert.ok(order.cancelled_at);
        const after = await counters();
        assert.equal(after.driver.total_trips, before.driver.total_trips);
        assert.equal(after.driver.total_earnings, before.driver.total_earnings);
        assert.equal(after.driver.availability, 'available');
        assert.deepEqual(after.customer, before.customer);
        assert.equal(Number((await h.query('SELECT count(*) FROM transactions WHERE order_id=$1', [item.id])).rows[0].count), 0);
      }
      assert.equal(Number((await h.query("SELECT count(*) FROM transactions WHERE order_id=$1 AND type='order_refund'", [item.id])).rows[0].count), 0);
      assert.equal(Number((await h.query('SELECT count(*) FROM refunds WHERE order_id=$1', [item.id])).rows[0].count), 0);
      outcomes.push({ state: order.status, responseStatuses: replies.map(reply => reply.status) });
    }
    return { races: outcomes, exactlyOneWinnerPerRace: true, noCashRefund: true };
  });
  await h.test('QR expiry is checked after the delivery row lock wait', async () => {
    const item = await ready();
    const blocker = new Client({ host: '127.0.0.1', port: h.results.environment.dbPort, user: 'postgres', database: h.databaseName });
    await blocker.connect();
    let waiting;
    try {
      await h.query("UPDATE orders SET qr_generated_at=clock_timestamp()-INTERVAL '60 minutes'+INTERVAL '250 milliseconds' WHERE id=$1", [item.id]);
      const before = await h.snapshot(item.id);
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [item.id]);
      const remaining = (await blocker.query("SELECT EXTRACT(EPOCH FROM (qr_generated_at+INTERVAL '60 minutes'-clock_timestamp()))*1000 AS milliseconds FROM orders WHERE id=$1", [item.id])).rows[0];
      assert.ok(Number(remaining.milliseconds) > 0, 'Expiry fixture must still be valid before the HTTP request begins');
      let completed = false;
      waiting = h.request(`/orders/${item.id}/verify-qr`, A.token, 'POST', proof(item.code)).then(response => { completed = true; return response; });
      let observedBlockedQuery = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const locks = (await h.query("SELECT count(*) FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%FROM orders%FOR UPDATE%'", [h.databaseName])).rows[0];
        if (Number(locks.count) > 0) { observedBlockedQuery = true; break; }
        await h.delay(10);
      }
      assert.equal(observedBlockedQuery, true, 'Verification request did not wait on the held order row lock');
      await h.delay(600);
      assert.equal(completed, false, 'Verification returned while order row remained locked');
      await blocker.query('COMMIT');
      const response = await waiting; h.status(response, 400, 'expired after row lock');
      assert.equal(response.body.error.code, 'QR_EXPIRED');
      assert.deepEqual(await h.snapshot(item.id), before);
      await cancel(item.id);
      return { observedVerificationBlockedOnOrderLock: true, lockHeldAcrossExpiry: true, expiredAfterWaitRejected: true, accountingUnchanged: true };
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end();
      if (waiting) await waiting.catch(() => {});
    }
  });
  await h.test('Concurrent confirmation and replay emit each delivered event exactly once', async () => {
    const item = await ready(); const before = await counters();
    const socket = await h.socket(A.token);
    await h.event(socket, 'tracking_started', () => socket.emit('track_order', { order_id: item.id }));
    const events = { delivered: 0, status: 0 };
    const onDelivered = data => { if (data.order_id === item.id) events.delivered++; };
    const onStatus = data => { if (data.order_id === item.id && data.status === 'delivered') events.status++; };
    socket.on('order_delivered', onDelivered); socket.on('order_status_updated', onStatus);
    try {
      const replies = await Promise.all(Array.from({ length: 6 }, () => h.request(`/orders/${item.id}/verify-qr`, A.token, 'POST', proof(item.code))));
      assert.equal(replies.filter(reply => reply.status === 200).length, 1, JSON.stringify(replies));
      assert.equal(replies.filter(reply => reply.status === 409).length, 5, JSON.stringify(replies));
      for (let attempt = 0; attempt < 60 && (!events.delivered || !events.status); attempt++) await h.delay(25);
      await deniedUnchanged(item.id, A, proof(item.code), 409);
      await h.delay(150);
      assert.deepEqual(events, { delivered: 1, status: 1 });
      return { events, authenticatedCustomerTracking: true, replayEmittedNoEvent: true, ...await assertCompletedExactlyOnce(item.id, before) };
    } finally { socket.off('order_delivered', onDelivered); socket.off('order_status_updated', onStatus); socket.disconnect(); }
  });
  await h.test('Noncash paid flag without matching confirmed ledger cannot deliver', async () => {
    const item = await ready('card');
    await h.query("UPDATE orders SET payment_status='paid',payment_transaction_id='unverified-fixture' WHERE id=$1", [item.id]);
    await deniedUnchanged(item.id, A, proof(item.code), 409, 'PAYMENT_REQUIRED');
    const order = await h.order(item.id);
    await h.query("INSERT INTO transactions(user_id,order_id,type,amount,currency,payment_method,status) VALUES($1,$2,'order_payment',$3,'LYD','card','completed')", [B.id, item.id, order.final_price]);
    await deniedUnchanged(item.id, A, proof(item.code), 409, 'PAYMENT_REQUIRED');
    const inconsistent = await h.snapshot(item.id);
    const cancellation = await h.request(`/orders/${item.id}/cancel`, A.token, 'POST', { reason: 'legacy payment needs reconciliation' });
    h.status(cancellation, 409); assert.equal(cancellation.body.error.code, 'PAYMENT_MISMATCH');
    assert.deepEqual(await h.snapshot(item.id), inconsistent);
    // Close the deliberately corrupt legacy fixture without editing its ledger.
    await h.query("UPDATE orders SET status='cancelled',cancelled_at=NOW(),cancellation_reason='verification legacy fixture isolation' WHERE id=$1", [item.id]);
    await h.query("UPDATE drivers SET availability='available' WHERE user_id=$1", [D.id]);
    return { paidFlagAloneRejected: true, wrongCustomerLedgerRejected: true, cashFlagCannotApproveCard: true };
  });
  for (const target of ['ledger', 'customer_stats']) {
    await h.test(`Forced ${target} failure rolls back all delivery and accounting changes`, async () => {
      const item = await ready(); const before = await h.snapshot(item.id); const countsBefore = await counters();
      const functionName = `verification_fail_${target}`;
      const table = target === 'ledger' ? 'transactions' : 'customers';
      const operation = target === 'ledger' ? 'INSERT' : 'UPDATE';
      const condition = target === 'ledger' ? `NEW.order_id = '${item.id}'` : `NEW.user_id = '${A.id}'::uuid AND NEW.total_orders > OLD.total_orders`;
      await h.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'forced verification ${target} failure'; END IF; RETURN NEW; END $$`);
      await h.query(`CREATE TRIGGER ${functionName} BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      try {
        h.status(await h.request(`/orders/${item.id}/verify-qr`, A.token, 'POST', proof(item.code)), 500);
        assert.deepEqual(await h.snapshot(item.id), before);
      } finally {
        await h.query(`DROP TRIGGER IF EXISTS ${functionName} ON ${table}`);
        await h.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      }
      h.status(await h.request(`/orders/${item.id}/verify-qr`, A.token, 'POST', proof(item.code)), 200, 'retry after forced failure');
      return { rollbackLeftEveryFieldUnchanged: true, sameQRRetryWorks: true, ...await assertCompletedExactlyOnce(item.id, countsBefore) };
    });
  }
  await h.test('Schema prevents duplicate completed payment and refund ledger events', async () => {
    const order = await h.order(delivery.id);
    let duplicate;
    try { await h.query("INSERT INTO transactions(user_id,order_id,type,amount,currency,payment_method,status) VALUES($1,$2,'order_payment',$3,'LYD','cash','completed')", [A.id, delivery.id, order.final_price]); }
    catch (err) { duplicate = err; }
    assert.equal(duplicate?.code, '23505');
    await h.query("INSERT INTO transactions(user_id,order_id,type,amount,currency,payment_method,status) VALUES($1,$2,'order_refund',$3,'LYD','cash','completed')", [A.id, delivery.id, order.final_price]);
    let refundDuplicate;
    try { await h.query("INSERT INTO transactions(user_id,order_id,type,amount,currency,payment_method,status) VALUES($1,$2,'order_refund',$3,'LYD','cash','completed')", [A.id, delivery.id, order.final_price]); }
    catch (err) { refundDuplicate = err; }
    assert.equal(refundDuplicate?.code, '23505');
    assert.equal(Number((await h.query("SELECT count(*) FROM transactions WHERE order_id=$1 AND type='order_payment' AND status='completed'", [delivery.id])).rows[0].count), 1);
    return { paymentDuplicateSQLCode: duplicate.code, refundDuplicateSQLCode: refundDuplicate.code };
  });
  await h.test('Migration001 is idempotent and blocks historical duplicate ledger without deleting it', async () => {
    const migration = fs.readFileSync(path.join(h.backend, 'migrations/001_delivery_integrity.sql'), 'utf8');
    const indexName = 'idx_transactions_completed_order_event';
    const database = `${h.databaseName}_migration`;
    await h.query(`CREATE DATABASE ${database} TEMPLATE template0 ENCODING 'UTF8'`);
    const legacy = new Client({ host: '127.0.0.1', port: h.results.environment.dbPort, user: 'postgres', database });
    await legacy.connect();
    try {
      const schema = fs.readFileSync(path.join(__dirname, 'fixtures/legacy-schema.sql'), 'utf8').replace(/^CREATE EXTENSION IF NOT EXISTS "postgis";.*$/m, '');
      await legacy.query(schema);
      assert.equal(Number((await legacy.query('SELECT count(*) FROM pg_indexes WHERE schemaname=\'public\' AND indexname=$1', [indexName])).rows[0].count), 0);
      await legacy.query(migration); await legacy.query(migration);
      assert.equal(Number((await legacy.query('SELECT count(*) FROM pg_indexes WHERE schemaname=\'public\' AND indexname=$1', [indexName])).rows[0].count), 1);
      await legacy.query(`DROP INDEX ${indexName}`);
      await legacy.query("INSERT INTO users(id,role,email,phone,password_hash,full_name_ar) VALUES($1,'customer','legacy@example.com','+218990200001','fixture','Legacy Customer')", [A.id]);
      await legacy.query('INSERT INTO customers(user_id) VALUES($1)', [A.id]);
      await legacy.query("INSERT INTO orders(id,customer_id,pickup_address,pickup_lat,pickup_lng,dropoff_address,dropoff_lat,dropoff_lng,distance,vehicle_type,base_price,vat_amount,total_price,final_price,payment_method,payment_status,status) VALUES('ORD-90001',$1,'Legacy pickup',32,13,'Legacy dropoff',32.1,13.1,5,'car',10,1,11,11,'cash','paid','delivered')", [A.id]);
      for (let i = 0; i < 2; i++) await legacy.query("INSERT INTO transactions(user_id,order_id,type,amount,currency,payment_method,status) VALUES($1,'ORD-90001','order_payment',11,'LYD','cash','completed')", [A.id]);
      const before = (await legacy.query('SELECT * FROM transactions ORDER BY id')).rows;
      let blocked;
      try { await legacy.query(migration); } catch (err) { blocked = err; await legacy.query('ROLLBACK'); }
      assert.ok(blocked, 'Migration silently accepted historical duplicated completed payment');
      assert.match(blocked.message, /duplicate|reconcil/i);
      assert.deepEqual((await legacy.query('SELECT * FROM transactions ORDER BY id')).rows, before);
      assert.equal(Number((await legacy.query('SELECT count(*) FROM pg_indexes WHERE schemaname=\'public\' AND indexname=$1', [indexName])).rows[0].count), 0);
      return { migratedLegacyWithoutIndex: true, repeatedMigrationIdempotent: true, duplicateHistoryBlocked: true, allHistoricalRowsPreserved: before.length, failedMigrationRolledBack: true };
    } finally { await legacy.end(); }
  });
}

let harness;
createHarness('step2').then(async h => { harness = h; await main(h); })
  .catch(err => { process.exitCode = 1; if (harness) harness.fatal = err; console.error(err.stack); })
  .finally(async () => { if (harness) await harness.close(harness.fatal); });
