const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { Client } = require('pg');
const { io } = require('socket.io-client');

const backend = path.resolve(__dirname, '../kntr-package/kntr-backend');
const resolveNativePath = () => {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('The bundled verification PostgreSQL requires Linux x64.');
  }
  if (process.env.POSTGRES_NATIVE_PATH) return path.resolve(process.env.POSTGRES_NATIVE_PATH);
  const packageName = '@embedded-postgres/linux-x64';
  try {
    try {
      return path.join(path.dirname(require.resolve(`${packageName}/package.json`)), 'native');
    } catch (err) {
      // The pinned native package exports its dist entry but not package.json.
      if (err.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw err;
      return path.join(path.dirname(path.dirname(require.resolve(packageName))), 'native');
    }
  } catch (err) {
    throw new Error('Install verification dependencies with npm install, or set POSTGRES_NATIVE_PATH to a native directory containing bin/initdb, bin/postgres and lib.', { cause: err });
  }
};
const native = resolveNativePath();
const skipPostGIS = process.env.SKIP_POSTGIS ?? '1';
if (!['0', '1'].includes(skipPostGIS)) throw new Error('SKIP_POSTGIS must be 1 or 0.');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([stopped, delay(4000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await stopped;
  }
}

async function createHarness(label) {
  if (process.getuid?.() === 0) {
    throw new Error('PostgreSQL initdb cannot run as root. Run verification as an ordinary user with write access to this directory; no postgres operating-system account is required.');
  }
  for (const executable of ['initdb', 'postgres']) {
    try { fs.accessSync(path.join(native, 'bin', executable), fs.constants.X_OK); }
    catch (err) { throw new Error(`PostgreSQL ${executable} is missing or not executable in ${native}. Install verification dependencies with install scripts enabled, or correct POSTGRES_NATIVE_PATH.`, { cause: err }); }
  }
  const runDir = fs.mkdtempSync(path.join(__dirname, `${label}-run-`));
  const uploadPath = path.join(runDir, 'uploads');
  const pgData = path.join(runDir, 'pgdata');
  const dbPort = await freePort();
  const appPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`;
  const databaseName = `kntr_${label.replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;
  const secret = crypto.randomBytes(32).toString('hex');
  const refreshSecret = crypto.randomBytes(32).toString('hex');
  const checks = [];
  const sockets = new Set();
  const results = {
    environment: { node: process.version, database: 'PostgreSQL 18.4, fresh isolated data directory', backend, runDir, dbPort, appPort },
    checks,
  };
  let postgres, server, db;
  const h = {
    assert, backend, native, runDir, uploadPath, databaseName, base, secret, refreshSecret, results, delay,
    async test(name, fn) {
      try {
        const evidence = await fn();
        checks.push({ name, status: 'passed', evidence });
        console.log(JSON.stringify({ name, status: 'passed', evidence }));
        return evidence;
      } catch (err) {
        checks.push({ name, status: 'failed', error: err.message, stack: err.stack });
        console.error(JSON.stringify({ name, status: 'failed', error: err.message }));
        throw err;
      }
    },
    async request(url, token, method = 'GET', body) {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const options = { method, headers, signal: AbortSignal.timeout(10000) };
      if (body instanceof FormData) options.body = body;
      else if (body !== undefined) { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
      const response = await fetch(base + '/v1' + url, options);
      const content = await response.text();
      let parsed; try { parsed = JSON.parse(content); } catch { parsed = content; }
      return { status: response.status, body: parsed };
    },
    status(response, expected, context = '') {
      assert.equal(response.status, expected, `${context}: ${JSON.stringify(response)}`);
      return response;
    },
    async register(role, tag, phone) {
      const response = await h.request('/auth/register', null, 'POST', {
        role, email: `${tag}@example.com`, phone, password: 'TestPassw0rd123', full_name_ar: `Test ${tag}`,
      });
      h.status(response, 201, `register ${tag}`);
      return { id: response.body.data.user.id, token: response.body.data.tokens.access_token, refresh: response.body.data.tokens.refresh_token };
    },
    async admin(tag = 'test-admin') {
      const bcrypt = require(path.join(backend, 'node_modules/bcryptjs'));
      const row = (await db.query("INSERT INTO users(role,email,phone,password_hash,full_name_ar) VALUES('admin',$1,$2,$3,'Test Admin') RETURNING *", [`${tag}@example.com`, '+218990000099', await bcrypt.hash('TestPassw0rd123', 4)])).rows[0];
      const jwt = require(path.join(backend, 'node_modules/jsonwebtoken'));
      const token = jwt.sign({ id: row.id, role: row.role, email: row.email, jti: crypto.randomUUID() }, secret, { expiresIn: '24h' });
      await db.query("INSERT INTO sessions(user_id,token,expires_at) VALUES($1,$2,NOW()+INTERVAL '24 hours')", [row.id, token]);
      return { id: row.id, token };
    },
    async fixture(role, tag) {
      const bcrypt = require(path.join(backend, 'node_modules/bcryptjs'));
      const jwt = require(path.join(backend, 'node_modules/jsonwebtoken'));
      const password = 'TestPassw0rd123';
      const email = `${tag}@example.com`;
      const phone = `+21899${crypto.randomInt(10000000, 99999999)}`;
      const user = (await db.query('INSERT INTO users(role,email,phone,password_hash,full_name_ar) VALUES($1,$2,$3,$4,$5) RETURNING *', [role, email, phone, await bcrypt.hash(password, 4), `Test ${tag}`])).rows[0];
      if (role === 'customer') await db.query('INSERT INTO customers(user_id) VALUES($1)', [user.id]);
      if (role === 'driver') await db.query('INSERT INTO drivers(user_id) VALUES($1)', [user.id]);
      await db.query('INSERT INTO wallets(user_id) VALUES($1)', [user.id]);
      const token = jwt.sign({ id: user.id, role, email, jti: crypto.randomUUID() }, secret, { expiresIn: '24h' });
      const refresh = jwt.sign({ id: user.id, type: 'refresh', jti: crypto.randomUUID() }, refreshSecret, { expiresIn: '7d' });
      await db.query("INSERT INTO sessions(user_id,token,refresh_token,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '24 hours')", [user.id, token, refresh]);
      return { id: user.id, token, refresh, email, password };
    },
    async createOrder(customer, payment = 'cash', vehicle = 'car', extras = {}) {
      const response = await h.request('/orders', customer.token, 'POST', {
        pickup: { address: 'Test pickup', lat: 32.88, lng: 13.18 },
        dropoff: { address: 'Test dropoff', lat: 32.89, lng: 13.19 },
        vehicle_type: vehicle, payment_method: payment, ...extras,
      });
      h.status(response, 201, 'create order');
      return response.body.data.order_id;
    },
    async setupDriver(driver, admin, vehicle = 'car') {
      h.status(await h.request('/drivers/vehicles', driver.token, 'POST', { vehicle_type: vehicle, plate_number: `TEST-${driver.id.slice(0, 8)}` }), 201, 'add vehicle');
      h.status(await h.request(`/admin/drivers/${driver.id}/approve`, admin.token, 'POST', {}), 200, 'approve driver');
      h.status(await h.request('/drivers/availability', driver.token, 'PATCH', { status: 'available' }), 200, 'driver available');
    },
    query(sql, params) { return db.query(sql, params); },
    async order(id) { return (await db.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0]; },
    async snapshot(orderId) {
      const order = await h.order(orderId);
      const stats = (await db.query('SELECT user_id,availability,total_trips,total_earnings,current_lat,current_lng FROM drivers ORDER BY user_id')).rows;
      const customers = (await db.query('SELECT user_id,total_orders,total_spent FROM customers ORDER BY user_id')).rows;
      const transactions = (await db.query('SELECT * FROM transactions ORDER BY id')).rows;
      return { order, stats, customers, transactions };
    },
    async socket(token, expectDenied = false) {
      const socket = io(base, { transports: ['websocket'], reconnection: false, autoConnect: false, ...(token === undefined ? {} : { auth: { token } }) });
      sockets.add(socket);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 4000);
        socket.once('connect', () => { clearTimeout(timer); expectDenied ? reject(new Error('Unauthorized socket connected')) : resolve(); });
        socket.once('connect_error', err => { clearTimeout(timer); expectDenied ? resolve() : reject(err); });
        socket.connect();
      });
      if (expectDenied) socket.disconnect();
      return socket;
    },
    async event(socket, name, trigger, timeout = 3000) {
      let timer, listener;
      const observed = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`No socket event ${name}`)), timeout);
        listener = data => { clearTimeout(timer); resolve(data); };
        socket.once(name, listener);
      });
      try {
        const [data] = await Promise.all([observed, Promise.resolve().then(trigger)]);
        return data;
      } finally { clearTimeout(timer); socket.off(name, listener); }
    },
    async noEvent(socket, name, trigger, timeout = 350) {
      let received = false;
      const listener = () => { received = true; };
      socket.on(name, listener);
      try { await trigger(); await delay(timeout); assert.equal(received, false, `Unauthorized ${name} event observed`); }
      finally { socket.off(name, listener); }
    },
    async emitAck(socket, event, payload) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No acknowledgment for ${event}`)), 3000);
        socket.emit(event, payload, response => { clearTimeout(timer); resolve(response); });
      });
    },
    async close(fatal) {
      if (fatal) results.fatal = { message: fatal.message, stack: fatal.stack };
      for (const socket of sockets) socket.disconnect();
      await stopProcess(server);
      if (db) await db.end().catch(() => {});
      await stopProcess(postgres);
      results.summary = { passed: checks.filter(x => x.status === 'passed').length, failed: checks.filter(x => x.status === 'failed').length, success: !fatal && checks.every(x => x.status === 'passed') };
      fs.writeFileSync(path.join(__dirname, `${label}-results.json`), JSON.stringify(results, null, 2));
      console.log(JSON.stringify({ summary: results.summary, runDir }));
    },
  };
  try {
    const pgEnv = { ...process.env, LD_LIBRARY_PATH: path.join(native, 'lib') };
    const initialized = spawnSync(path.join(native, 'bin/initdb'), ['-D', pgData, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--no-locale'], { env: pgEnv, encoding: 'utf8' });
    fs.writeFileSync(path.join(runDir, 'initdb.log'), (initialized.stdout || '') + (initialized.stderr || ''));
    assert.equal(initialized.status, 0, 'initdb failed; see initdb.log');
    const pgLog = fs.openSync(path.join(runDir, 'postgres.log'), 'w');
    postgres = spawn(path.join(native, 'bin/postgres'), ['-D', pgData, '-h', '127.0.0.1', '-p', String(dbPort), '-k', runDir], { env: pgEnv, stdio: ['ignore', pgLog, pgLog] });
    let initial;
    for (let i = 0; i < 60; i++) {
      initial = new Client({ host: '127.0.0.1', port: dbPort, user: 'postgres', database: 'postgres' });
      try { await initial.connect(); break; }
      catch { await initial.end().catch(() => {}); if (i === 59 || postgres.exitCode !== null) throw new Error('Database did not start'); await delay(100); }
    }
    await initial.query(`CREATE DATABASE ${databaseName} TEMPLATE template0 ENCODING 'UTF8'`);
    await initial.end();
    db = new Client({ host: '127.0.0.1', port: dbPort, user: 'postgres', database: databaseName });
    await db.connect();
    const schema = fs.readFileSync(path.join(backend, 'schema.sql'), 'utf8');
    // These gates do not verify PostGIS or geospatial SQL. The native package
    // omits PostGIS; set SKIP_POSTGIS=0 only with a PostGIS-capable native build.
    await db.query(skipPostGIS === '1' ? schema.replace(/^CREATE EXTENSION IF NOT EXISTS "postgis";.*$/m, '') : schema);
    const declaresPostGIS = /^CREATE EXTENSION IF NOT EXISTS \"postgis\";/m.test(schema);
    results.environment.postgis = !declaresPostGIS
      ? 'Current schema requires no PostGIS extension; these tests do not verify PostGIS or geospatial SQL'
      : skipPostGIS === '1'
        ? 'Optional extension omitted (SKIP_POSTGIS=1); these tests do not verify PostGIS or geospatial SQL'
        : 'Schema PostGIS extension loaded (SKIP_POSTGIS=0); these tests do not verify geospatial SQL';
    fs.mkdirSync(uploadPath);
    const appLog = fs.openSync(path.join(runDir, 'server.log'), 'w');
    server = spawn(process.execPath, ['src/app.js'], { cwd: backend, env: {
      ...process.env, NODE_ENV: 'test', PORT: String(appPort), DB_HOST: '127.0.0.1', DB_PORT: String(dbPort),
      DB_NAME: databaseName, DB_USER: 'postgres', DB_PASSWORD: '', JWT_SECRET: secret,
      JWT_REFRESH_SECRET: refreshSecret, UPLOAD_PATH: uploadPath,
    }, stdio: ['ignore', appLog, appLog] });
    for (let i = 0; i < 60; i++) {
      try {
        const health = await (await fetch(base + '/health', { signal: AbortSignal.timeout(1000) })).json();
        assert.equal(health.status, 'ok');
        return h;
      } catch { if (i === 59 || server.exitCode !== null) throw new Error('API failed startup; see server.log'); await delay(100); }
    }
  } catch (err) {
    await h.close(err);
    throw err;
  }
}

module.exports = { createHarness };
