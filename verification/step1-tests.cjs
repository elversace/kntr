const { createHarness } = require('./harness.cjs');

async function main(h) {
  const { assert } = h;
  const A = await h.register('customer', 'owner', '+218910100001');
  const B = await h.register('customer', 'stranger', '+218910100002');
  const D = await h.register('driver', 'assigned', '+218910100003');
  const E = await h.register('driver', 'other-driver', '+218910100004');
  const P = await h.register('driver', 'pending', '+218910100005');
  const R = await h.register('driver', 'rejected', '+218910100006');
  const S = await h.register('driver', 'suspended', '+218910100007');
  const admin = await h.admin();
  const restrictedStaff = [await h.fixture('finance', 'finance-role'), await h.fixture('audit', 'audit-role'), await h.fixture('corporate', 'corporate-role')];
  await h.setupDriver(D, admin);
  await h.setupDriver(E, admin);
  await h.query("UPDATE drivers SET driver_status='rejected',availability='available' WHERE user_id=$1", [R.id]);
  await h.query("UPDATE drivers SET driver_status='suspended',availability='available' WHERE user_id=$1", [S.id]);
  const pending = await h.createOrder(A);

  await h.test('Database role changes remove permissions from stale admin token', async () => {
    await h.query("UPDATE users SET role='customer' WHERE id=$1", [admin.id]);
    try {
      h.status(await h.request('/admin/statistics', admin.token), 403, 'stale admin statistics');
      h.status(await h.request(`/admin/drivers/${P.id}/approve`, admin.token, 'POST', {}), 403, 'stale admin approval');
      assert.equal((await h.query('SELECT driver_status FROM drivers WHERE user_id=$1', [P.id])).rows[0].driver_status, 'pending');
    } finally { await h.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]); }
    return { denied: 2, databaseRoleRespected: true };
  });

  await h.test('REST unauthenticated reads and mutations require authentication', async () => {
    const paths = [['/orders', 'GET'], [`/orders/${pending}`, 'GET'], [`/orders/${pending}/cancel`, 'POST'], [`/orders/${pending}/status`, 'PATCH'], [`/drivers/orders/${pending}/accept`, 'POST']];
    for (const [url, method] of paths) h.status(await h.request(url, null, method, method === 'GET' ? undefined : { status: 'accepted' }), 401, url);
    return { denied: paths.length, http: 401 };
  });
  await h.test('Other customer cannot read, cancel or alter owner order', async () => {
    const before = await h.snapshot(pending);
    for (const [url, method, body] of [[`/orders/${pending}`, 'GET'], [`/orders/${pending}/cancel`, 'POST', { reason: 'attack' }], [`/orders/${pending}/status`, 'PATCH', { status: 'cancelled' }], [`/orders/${pending}/status`, 'PATCH', { status: 'accepted' }]]) {
      h.status(await h.request(url, B.token, method, body), 403, url);
      assert.deepEqual(await h.snapshot(pending), before);
    }
    h.status(await h.request(`/orders/${pending}/status`, A.token, 'PATCH', { status: 'accepted' }), 403, 'customer self-accept');
    assert.deepEqual(await h.snapshot(pending), before);
    return { denied: 5, http: 403, stateUnchanged: true };
  });
  await h.test('Pending, rejected and suspended drivers cannot bypass approval', async () => {
    const before = await h.snapshot(pending);
    for (const actor of [P, R, S]) {
      h.status(await h.request(`/drivers/orders/${pending}/accept`, actor.token, 'POST', {}), 403, 'normal acceptance');
      h.status(await h.request(`/orders/${pending}/status`, actor.token, 'PATCH', { status: 'accepted' }), 403, 'alternative acceptance');
      assert.deepEqual(await h.snapshot(pending), before);
    }
    return { denied: 6, stateUnchanged: true };
  });
  await h.test('Approved driver cannot accept a mismatched vehicle order', async () => {
    const truck = await h.createOrder(A, 'cash', 'truck');
    const before = await h.snapshot(truck);
    h.status(await h.request(`/drivers/orders/${truck}/accept`, E.token, 'POST', {}), 403, 'normal wrong vehicle acceptance');
    h.status(await h.request(`/orders/${truck}/status`, E.token, 'PATCH', { status: 'accepted' }), 403, 'alternative wrong vehicle acceptance');
    assert.deepEqual(await h.snapshot(truck), before);
    return { denied: 2, stateUnchanged: true };
  });
  await h.test('Driver cannot accept using another driver vehicle ID', async () => {
    const vehicle = (await h.query('SELECT id FROM driver_vehicles WHERE driver_id=$1', [D.id])).rows[0];
    const before = await h.snapshot(pending);
    h.status(await h.request(`/drivers/orders/${pending}/accept`, E.token, 'POST', { vehicle_id: vehicle.id }), 403, 'foreign vehicle ID');
    h.status(await h.request(`/orders/${pending}/status`, E.token, 'PATCH', { status: 'accepted', vehicle_id: vehicle.id }), 403, 'alternative foreign vehicle ID');
    assert.deepEqual(await h.snapshot(pending), before);
    return { denied: 2, stateUnchanged: true };
  });
  await h.test('Approved alternative acceptance assigns driver and sets busy', async () => {
    h.status(await h.request(`/orders/${pending}/status`, D.token, 'PATCH', { status: 'accepted' }), 200);
    const order = await h.order(pending);
    assert.equal(order.status, 'accepted'); assert.equal(order.driver_id, D.id); assert.ok(order.accepted_at);
    const driver = (await h.query('SELECT availability FROM drivers WHERE user_id=$1', [D.id])).rows[0];
    assert.equal(driver.availability, 'busy');
    return { order: pending, status: order.status, driverBusy: true };
  });
  await h.test('Only assigned driver can read, start or cancel assigned order', async () => {
    const before = await h.snapshot(pending);
    for (const [actor, url, method, body] of [[E, `/orders/${pending}`, 'GET'], [E, `/orders/${pending}/status`, 'PATCH', { status: 'in_transit' }], [E, `/orders/${pending}/cancel`, 'POST', { reason: 'attack' }], [E, `/orders/${pending}/status`, 'PATCH', { status: 'cancelled' }], [B, `/orders/${pending}/status`, 'PATCH', { status: 'in_transit' }], [A, `/orders/${pending}/status`, 'PATCH', { status: 'in_transit' }]]) {
      h.status(await h.request(url, actor.token, method, body), 403, url);
      assert.deepEqual(await h.snapshot(pending), before);
    }
    h.status(await h.request(`/orders/${pending}`, D.token), 200);
    h.status(await h.request(`/orders/${pending}/status`, D.token, 'PATCH', { status: 'in_transit' }), 200);
    assert.equal((await h.order(pending)).status, 'in_transit');
    return { denied: 6, authorizedReadAndStart: true };
  });
  await h.test('Correct QR cannot be used by unrelated customer or driver', async () => {
    const generated = await h.request(`/orders/${pending}/generate-qr`, D.token, 'POST', {});
    h.status(generated, 200, 'assigned driver QR generation');
    const qr = generated.body.data.qr_code;
    assert.ok(qr);
    const before = await h.snapshot(pending);
    for (const actor of [B, E]) {
      h.status(await h.request(`/orders/${pending}/generate-qr`, actor.token, 'POST', {}), 403, 'unauthorized QR generation');
      h.status(await h.request(`/orders/${pending}/verify-qr`, actor.token, 'POST', { qr_code: qr }), 403, 'unauthorized QR confirmation');
      assert.deepEqual(await h.snapshot(pending), before);
    }
    return { denied: 4, realCorrectQRCode: true, stateUnchanged: true };
  });
  await h.test('Finance, audit and corporate roles cannot mutate another order', async () => {
    const before = await h.snapshot(pending);
    for (const actor of restrictedStaff) {
      for (const [url, method, body] of [[`/orders/${pending}/status`, 'PATCH', { status: 'in_transit' }], [`/orders/${pending}/status`, 'PATCH', { status: 'cancelled' }], [`/orders/${pending}/cancel`, 'POST', { reason: 'unauthorized staff cancellation' }], [`/drivers/orders/${pending}/accept`, 'POST', {}]]) {
        h.status(await h.request(url, actor.token, method, body), 403, url);
        assert.deepEqual(await h.snapshot(pending), before);
      }
    }
    return { denied: 12, stateUnchanged: true };
  });
  await h.test('Busy driver cannot take another order or set available while active', async () => {
    const extra = await h.createOrder(A);
    h.status(await h.request(`/drivers/orders/${extra}/accept`, D.token, 'POST', {}), 400);
    h.status(await h.request(`/orders/${extra}/status`, D.token, 'PATCH', { status: 'accepted' }), 400);
    const change = await h.request('/drivers/availability', D.token, 'PATCH', { status: 'available' });
    assert.ok([400, 409].includes(change.status), `Active driver reset accepted: ${JSON.stringify(change)}`);
    assert.equal((await h.order(extra)).status, 'pending');
    assert.equal((await h.query('SELECT availability FROM drivers WHERE user_id=$1', [D.id])).rows[0].availability, 'busy');
    return { extra, rejectedAdditionalAccepts: 2, preventedManualAvailabilityBypass: true };
  });
  await h.test('Socket no token and invalid token connections are rejected', async () => {
    await h.socket(undefined, true); await h.socket('invalid-token', true);
    return { rejectedConnections: 2 };
  });
  let ownerSocket = await h.socket(A.token);
  const driverSocket = await h.socket(D.token);
  const strangerSocket = await h.socket(B.token);
  const otherDriverSocket = await h.socket(E.token);
  const pendingDriverSocket = await h.socket(P.token);
  await h.test('Owner and assigned driver can track; other accounts cannot', async () => {
    assert.equal((await h.event(ownerSocket, 'tracking_started', () => ownerSocket.emit('track_order', { order_id: pending }))).order_id, pending);
    assert.equal((await h.event(driverSocket, 'tracking_started', () => driverSocket.emit('track_order', { order_id: pending }))).order_id, pending);
    await h.noEvent(strangerSocket, 'tracking_started', () => strangerSocket.emit('track_order', { order_id: pending }));
    await h.noEvent(otherDriverSocket, 'tracking_started', () => otherDriverSocket.emit('track_order', { order_id: pending }));
    return { allowed: 2, denied: 2 };
  });
  await h.test('Cross-user chat and cross-driver location cannot reach order room', async () => {
    const before = (await h.query('SELECT current_lat,current_lng FROM drivers WHERE user_id=$1', [E.id])).rows[0];
    await h.noEvent(ownerSocket, 'chat_message', () => strangerSocket.emit('chat_message', { order_id: pending, message: 'unauthorized customer' }));
    await h.noEvent(ownerSocket, 'chat_message', () => otherDriverSocket.emit('chat_message', { order_id: pending, message: 'unauthorized driver' }));
    await h.noEvent(ownerSocket, 'driver_location_update', () => otherDriverSocket.emit('driver_location', { order_id: pending, lat: 32.9, lng: 13.2 }));
    assert.deepEqual((await h.query('SELECT current_lat,current_lng FROM drivers WHERE user_id=$1', [E.id])).rows[0], before);
    return { denied: 3, wrongDriverLocationUnchanged: true };
  });
  await h.test('Assigned driver broadcasts location and owner can chat', async () => {
    const location = await h.event(ownerSocket, 'driver_location_update', () => driverSocket.emit('driver_location', { order_id: pending, lat: 32.9, lng: 13.2 }));
    assert.equal(location.driver_id, D.id); assert.equal(Number(location.lat), 32.9);
    const chat = await h.event(driverSocket, 'chat_message', () => ownerSocket.emit('chat_message', { order_id: pending, message: 'authorized message' }));
    assert.equal(chat.from, A.id); assert.equal(chat.message, 'authorized message');
    return { driverLocationReceived: true, ownerChatReceived: true };
  });
  await h.test('Vehicle feeds reject wrong type, customers and pending drivers', async () => {
    await h.noEvent(otherDriverSocket, 'joined_room', () => otherDriverSocket.emit('join_driver_room', { vehicle_type: 'truck' }));
    await h.noEvent(strangerSocket, 'joined_room', () => strangerSocket.emit('join_driver_room', { vehicle_type: 'car' }));
    await h.noEvent(pendingDriverSocket, 'joined_room', () => pendingDriverSocket.emit('join_driver_room', { vehicle_type: 'car' }));
    const joined = await h.event(otherDriverSocket, 'joined_room', () => otherDriverSocket.emit('join_driver_room', { vehicle_type: 'car' }));
    assert.equal(joined.room, 'drivers:car');
    const newOrder = await h.event(otherDriverSocket, 'new_order', () => h.createOrder(A));
    assert.equal(newOrder.vehicle_type, 'car');
    h.status(await h.request('/drivers/orders?vehicle_type=truck', E.token), 403, 'REST wrong vehicle feed');
    return { deniedSocketJoins: 3, approvedVehicleFeedWorks: true, deniedWrongRESTVehicleFeed: true };
  });
  await h.test('Malformed socket inputs cannot crash server or mutate location', async () => {
    const before = (await h.query('SELECT current_lat,current_lng FROM drivers WHERE user_id=$1', [D.id])).rows[0];
    for (const event of ['track_order', 'join_driver_room', 'driver_location', 'chat_message']) {
      for (const payload of [null, 'invalid', [], {}, { order_id: {} }, { order_id: pending, lat: 999, lng: 999 }]) driverSocket.emit(event, payload);
    }
    await h.delay(250);
    assert.equal((await (await fetch(h.base + '/health')).json()).status, 'ok');
    assert.deepEqual((await h.query('SELECT current_lat,current_lng FROM drivers WHERE user_id=$1', [D.id])).rows[0], before);
    assert.equal(driverSocket.connected, true);
    return { malformedPayloads: 24, serverHealthy: true, locationUnchanged: true };
  });
  await h.test('Concurrent refresh has one winner, rotates token and disconnects idle socket', async () => {
    const originalToken = A.token;
    let response;
    await h.event(ownerSocket, 'disconnect', async () => {
      const replies = await Promise.all([1, 2].map(() => h.request('/auth/refresh-token', null, 'POST', { refresh_token: A.refresh })));
      assert.deepEqual(replies.map(r => r.status).sort(), [200, 401]);
      response = replies.find(r => r.status === 200);
      h.status(response, 200, 'refresh current session');
    });
    A.token = response.body.data.access_token; A.refresh = response.body.data.refresh_token;
    assert.notEqual(A.token, originalToken);
    h.status(await h.request('/auth/me', originalToken), 401, 'old access token');
    await h.socket(originalToken, true);
    ownerSocket = await h.socket(A.token);
    await h.event(ownerSocket, 'tracking_started', () => ownerSocket.emit('track_order', { order_id: pending }));
    return { concurrentResponses: [200, 401], tokenRotated: true, oldSocketDisconnected: true, oldTokenRevoked: true, freshSocketTrackingWorks: true };
  });
  await h.test('Password change revokes other sessions and disconnects their idle sockets', async () => {
    const login = await h.request('/auth/login', null, 'POST', { email: 'owner@example.com', password: 'TestPassw0rd123' });
    h.status(login, 200, 'second owner login');
    const otherToken = login.body.data.tokens.access_token;
    assert.notEqual(otherToken, A.token);
    const otherSessionSocket = await h.socket(otherToken);
    await h.event(otherSessionSocket, 'tracking_started', () => otherSessionSocket.emit('track_order', { order_id: pending }));
    await h.event(otherSessionSocket, 'disconnect', async () => h.status(await h.request('/auth/change-password', A.token, 'PUT', { current_password: 'TestPassw0rd123', new_password: 'NewPassw0rd456' }), 200));
    h.status(await h.request('/auth/me', otherToken), 401, 'revoked other session');
    await h.socket(otherToken, true);
    h.status(await h.request('/auth/me', A.token), 200, 'preserved current session');
    assert.equal(ownerSocket.connected, true);
    return { otherSessionDisconnectedAndRevoked: true, currentSessionPreserved: true };
  });
  await h.test('Generic cancel follows cancellation fields, fee and driver release', async () => {
    h.status(await h.request(`/orders/${pending}/status`, A.token, 'PATCH', { status: 'cancelled', reason: 'owner cancellation' }), 200);
    const order = await h.order(pending);
    assert.equal(order.status, 'cancelled'); assert.equal(order.cancelled_by, A.id); assert.ok(order.cancelled_at);
    assert.equal(order.cancellation_reason, 'owner cancellation'); assert.equal(Number(order.cancellation_fee), 5);
    assert.equal((await h.query('SELECT availability FROM drivers WHERE user_id=$1', [D.id])).rows[0].availability, 'available');
    const ownPending = await h.createOrder(A);
    h.status(await h.request(`/orders/${ownPending}/cancel`, A.token, 'POST', { reason: 'pending cancellation' }), 200);
    const own = await h.order(ownPending); assert.equal(own.cancelled_by, A.id); assert.equal(Number(own.cancellation_fee), 0);
    return { genericCancelOrder: pending, acceptedFee: 5, pendingFee: 0, driverReleased: true };
  });
  await h.test('Same driver simultaneous accepts assign at most one order', async () => {
    const orders = [await h.createOrder(A), await h.createOrder(A)];
    const replies = await Promise.all(orders.map(id => h.request(`/drivers/orders/${id}/accept`, D.token, 'POST', {})));
    assert.equal(replies.filter(r => r.status === 200).length, 1, JSON.stringify(replies));
    assert.ok(replies.filter(r => r.status !== 200).every(r => [400, 409].includes(r.status)), JSON.stringify(replies));
    const rows = (await h.query('SELECT id,status,driver_id FROM orders WHERE id=ANY($1::varchar[]) ORDER BY id', [orders])).rows;
    assert.equal(rows.filter(r => r.driver_id === D.id && r.status === 'accepted').length, 1);
    const accepted = rows.find(r => r.status === 'accepted');
    h.status(await h.request(`/orders/${accepted.id}/cancel`, D.token, 'POST', { reason: 'driver cancel' }), 200);
    assert.equal((await h.order(accepted.id)).cancelled_by, D.id);
    return { responseStatuses: replies.map(r => r.status), acceptedCount: 1, assignedDriverCancellationWorks: true };
  });
  await h.test('Two drivers simultaneously accepting one order produce one winner', async () => {
    const order = await h.createOrder(A);
    const actors = [D, E];
    const replies = await Promise.all(actors.map(actor => h.request(`/drivers/orders/${order}/accept`, actor.token, 'POST', {})));
    assert.equal(replies.filter(reply => reply.status === 200).length, 1, JSON.stringify(replies));
    assert.equal(replies.filter(reply => reply.status === 409).length, 1, JSON.stringify(replies));
    const winningActor = actors[replies.findIndex(reply => reply.status === 200)];
    const losingActor = actors.find(actor => actor.id !== winningActor.id);
    assert.equal((await h.order(order)).driver_id, winningActor.id);
    assert.equal((await h.query('SELECT availability FROM drivers WHERE user_id=$1', [losingActor.id])).rows[0].availability, 'available');
    h.status(await h.request(`/orders/${order}/cancel`, winningActor.token, 'POST', { reason: 'cleanup race winner' }), 200);
    return { responseStatuses: replies.map(reply => reply.status), oneWinningDriver: true, losingDriverStillAvailable: true };
  });
  await h.test('Logout disconnects an idle subscribed socket and revokes its token', async () => {
    const order = await h.createOrder(B);
    await h.event(strangerSocket, 'tracking_started', () => strangerSocket.emit('track_order', { order_id: order }));
    await h.event(strangerSocket, 'disconnect', async () => h.status(await h.request('/auth/logout', B.token, 'POST', {}), 200));
    assert.equal(strangerSocket.connected, false);
    h.status(await h.request('/orders', B.token), 401, 'revoked logout token');
    await h.socket(B.token, true);
    return { idleSubscribedSocketDisconnected: true, RESTAndSocketTokenRevoked: true };
  });
  await h.test('Acceptance revokes vehicle feed; suspension disconnects idle tracking socket', async () => {
    const order = await h.createOrder(A);
    h.status(await h.request(`/drivers/orders/${order}/accept`, E.token, 'POST', {}), 200);
    await h.noEvent(otherDriverSocket, 'new_order', () => h.createOrder(A));
    await h.event(otherDriverSocket, 'tracking_started', () => otherDriverSocket.emit('track_order', { order_id: order }));
    await h.event(otherDriverSocket, 'disconnect', async () => h.status(await h.request(`/admin/users/${E.id}/status`, admin.token, 'PATCH', { status: 'suspended' }), 200));
    assert.equal(otherDriverSocket.connected, false);
    await h.socket(E.token, true);
    const suspendedMutation = await h.request(`/orders/${order}/status`, E.token, 'PATCH', { status: 'in_transit' });
    h.status(suspendedMutation, 401, 'suspended user session revoked');
    assert.equal(suspendedMutation.body.error.code, 'SESSION_EXPIRED');
    assert.equal((await h.order(order)).status, 'accepted');
    return { busyDriverFeedRevoked: true, idleSubscribedSocketDisconnected: true, suspendedUserBlocked: true };
  });
  await h.test('Driver rejection disconnects idle subscribed socket and denies further mutation', async () => {
    const order = await h.createOrder(A);
    h.status(await h.request(`/drivers/orders/${order}/accept`, D.token, 'POST', {}), 200);
    await h.event(driverSocket, 'tracking_started', () => driverSocket.emit('track_order', { order_id: order }));
    await h.event(driverSocket, 'disconnect', async () => h.status(await h.request(`/admin/drivers/${D.id}/reject`, admin.token, 'POST', { reason: 'regression fixture' }), 200));
    assert.equal(driverSocket.connected, false);
    h.status(await h.request(`/orders/${order}/status`, D.token, 'PATCH', { status: 'in_transit' }), 403, 'rejected driver mutation');
    assert.equal((await h.order(order)).status, 'accepted');
    const rejectedSocket = await h.socket(D.token);
    const ack = await h.emitAck(rejectedSocket, 'track_order', { order_id: order });
    assert.equal(ack.success, false); assert.equal(ack.error.code, 'FORBIDDEN');
    return { idleSubscribedSocketDisconnected: true, rejectedDriverRESTAndTrackingDenied: true };
  });
}

let harness;
createHarness('step1').then(async h => { harness = h; await main(h); })
  .catch(err => { process.exitCode = 1; if (harness) harness.fatal = err; console.error(err.stack); })
  .finally(async () => { if (harness) await harness.close(harness.fatal); });
