const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Client, Pool } = require('pg');
const { io } = require('socket.io-client');
const { createHarness } = require('./harness.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const identifier = name => {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error('Invalid verification database identifier');
  return `"${name}"`;
};
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(4000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
function sourceHashes(backend) {
  const files = ['schema.sql', 'src/app.js', 'src/config/runtime.js', 'src/config/database.js',
    'src/config/databaseOptions.js', 'src/scripts/prepare.js', 'src/scripts/createAdmin.js',
    'src/services/socketService.js'];
  for (const file of fs.readdirSync(path.join(backend, 'migrations')).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort()) files.push(`migrations/${file}`);
  return Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(backend, file))).digest('hex')]));
}
function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of ['NODE_ENV', 'PORT', 'TRUST_PROXY', 'ALLOWED_ORIGINS', 'UPLOAD_PATH', 'JWT_SECRET',
    'JWT_REFRESH_SECRET', 'DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
    'DB_SSL', 'DB_SSL_CA_FILE']) delete env[key];
  return env;
}
async function readEndpoint(base, pathname) {
  const response = await fetch(base + pathname, { signal: AbortSignal.timeout(15000) });
  return { status: response.status, body: await response.json() };
}
async function main(h) {
  const { assert } = h;
  const { loadRuntimeConfig, prepareUploadDirectory } = require(path.join(h.backend, 'src/config/runtime'));
  const { buildDatabaseOptions } = require(path.join(h.backend, 'src/config/databaseOptions'));
  const { prepareDatabase, validateDatabaseReadiness, READY_TABLES } = require(path.join(h.backend, 'src/scripts/prepare'));
  const { buildAdminBootstrap, createAdmin } = require(path.join(h.backend, 'src/scripts/createAdmin'));
  h.results.sourceHashes = sourceHashes(h.backend);
  h.results.environment.coverage = 'Actual isolated PostgreSQL, HTTP and WebSocket requests; no API or database mocks';
  const validRuntime = { NODE_ENV: 'production', JWT_SECRET: h.secret, JWT_REFRESH_SECRET: h.refreshSecret,
    UPLOAD_PATH: path.join(h.runDir, 'production-uploads'), ALLOWED_ORIGINS: 'https://localhost,capacitor://localhost,https://app.example.com' };
  const dbOptions = { host: '127.0.0.1', port: h.results.environment.dbPort, user: 'postgres', database: h.databaseName };
  const url = `postgres://postgres@127.0.0.1:${dbOptions.port}/${h.databaseName}?sslmode=disable`;
  const adminPool = new Pool(dbOptions);
  let productionServer;
  const openedSockets = new Set();
  const adminConnection = new Client({ ...dbOptions, database: 'postgres' });
  await adminConnection.connect();
  async function separateDatabase(label, fn) {
    const name = `${h.databaseName}_${label}`;
    await adminConnection.query(`CREATE DATABASE ${identifier(name)} TEMPLATE template0 ENCODING 'UTF8'`);
    const pool = new Pool({ ...dbOptions, database: name });
    try { return await fn(pool, name); }
    finally {
      await pool.end();
      await adminConnection.query(`DROP DATABASE ${identifier(name)} WITH (FORCE)`);
    }
  }
  try {
    await h.test('Runtime defaults and strict production configuration accept explicit native origins', async () => {
      const dev = loadRuntimeConfig({ JWT_SECRET: h.secret, JWT_REFRESH_SECRET: h.refreshSecret });
      assert.equal(dev.port, 3000); assert.equal(dev.trustProxy, 0); assert.equal(dev.production, false); assert.equal(dev.wildcardOrigins, true);
      const config = loadRuntimeConfig({ ...validRuntime, PORT: '65535', TRUST_PROXY: '10',
        ALLOWED_ORIGINS: ' https://localhost/ ,capacitor://localhost,https://localhost, https://app.example.com ' });
      assert.equal(config.port, 65535); assert.equal(config.trustProxy, 10); assert.equal(config.production, true);
      assert.deepEqual(config.allowedOrigins, ['https://localhost', 'capacitor://localhost', 'https://app.example.com']);
      assert.equal(config.wildcardOrigins, false); assert.equal(config.uploadPath, validRuntime.UPLOAD_PATH);
      return { defaultPort: 3000, proxyDefault: 0, exactNormalizedOrigins: config.allowedOrigins, validBounds: true };
    });
    await h.test('Runtime rejects weak secrets, unsafe origins, invalid ports and unbounded proxy trust without echoing secrets', async () => {
      const cases = [
        { JWT_SECRET: undefined }, { JWT_REFRESH_SECRET: undefined }, { JWT_SECRET: 'short' }, { JWT_REFRESH_SECRET: 'short' },
        { JWT_REFRESH_SECRET: h.secret }, { UPLOAD_PATH: undefined }, { UPLOAD_PATH: 'relative/uploads' },
        { ALLOWED_ORIGINS: undefined }, { ALLOWED_ORIGINS: '*' }, { ALLOWED_ORIGINS: 'https://localhost,*' },
        { ALLOWED_ORIGINS: 'https://localhost,' }, { ALLOWED_ORIGINS: 'https://app.example.com/path' },
        { ALLOWED_ORIGINS: 'https://user:password@app.example.com' }, { ALLOWED_ORIGINS: 'https://app.example.com?x=1' },
        { ALLOWED_ORIGINS: 'https://app.example.com#fragment' }, { ALLOWED_ORIGINS: 'file://localhost' },
        { ALLOWED_ORIGINS: 'capacitor://other-host' }, { ALLOWED_ORIGINS: 'http://remote.example.com' },
        ...['0', '-1', '65536', '3000oops', '3.5', ''].map(PORT => ({ PORT })),
        ...['-1', '11', 'true', '1.5', ''].map(TRUST_PROXY => ({ TRUST_PROXY })), { NODE_ENV: 'staging' },
      ];
      for (const override of cases) {
        let error;
        try { loadRuntimeConfig({ ...validRuntime, ...override }); } catch (caught) { error = caught; }
        assert.ok(error, `Invalid runtime setting accepted: ${Object.keys(override).join(',')}`);
        assert.ok(!error.message.includes(h.secret) && !error.message.includes(h.refreshSecret), 'Runtime errors must not include secret values');
      }
      assert.throws(() => loadRuntimeConfig({ JWT_SECRET: h.secret }));
      assert.throws(() => loadRuntimeConfig({ JWT_SECRET: h.secret, JWT_REFRESH_SECRET: h.refreshSecret, ALLOWED_ORIGINS: '*,https://localhost' }));
      return { rejectedConfigurations: cases.length + 2, secretsNotEchoed: true, noBooleanProxyTrust: true, wildcardProductionRejected: true };
    });
    await h.test('Upload startup creates a private writable directory and rejects file or symlink targets', async () => {
      const directory = path.join(h.runDir, 'upload-probe', 'private');
      await prepareUploadDirectory(directory);
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700); assert.deepEqual(fs.readdirSync(directory), []);
      fs.writeFileSync(path.join(directory, 'persistent.pdf'), '%PDF-1.4\n%%EOF\n');
      await prepareUploadDirectory(directory); assert.equal(fs.existsSync(path.join(directory, 'persistent.pdf')), true);
      const file = path.join(h.runDir, 'invalid-upload-file'); fs.writeFileSync(file, 'existing data');
      await assert.rejects(async () => prepareUploadDirectory(file)); assert.equal(fs.readFileSync(file, 'utf8'), 'existing data');
      const link = path.join(h.runDir, 'invalid-upload-link'); fs.symlinkSync(directory, link);
      await assert.rejects(async () => prepareUploadDirectory(link)); assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      return { privateDirectoryMode: '0700', writableProbeCleaned: true, persistentFilePreserved: true, fileAndSymlinkRejected: true };
    });
    await h.test('Database URL takes precedence and connects to the real PostgreSQL database', async () => {
      const options = buildDatabaseOptions({ DATABASE_URL: url, DB_HOST: 'invalid.invalid', DB_PORT: 'not-a-port',
        DB_NAME: 'wrong_database', DB_USER: 'wrong_user', DB_PASSWORD: 'unused-secret' });
      assert.equal(options.host, '127.0.0.1'); assert.equal(options.port, dbOptions.port); assert.equal(options.database, h.databaseName);
      assert.equal(options.user, 'postgres'); assert.equal(options.ssl, false);
      const client = new Client(options); await client.connect();
      try {
        const row = (await client.query('SELECT current_database() AS database,current_user AS username')).rows[0];
        assert.equal(row.database, h.databaseName); assert.equal(row.username, 'postgres');
      } finally { await client.end(); }
      return { urlPrecedence: true, independentDbVariablesIgnored: true, actualConnection: true, sslExplicitlyDisabledForIsolatedTestDatabase: true };
    });
    await h.test('Database configuration rejects malformed ports and TLS downgrade settings without exposing URL credentials', async () => {
      const privateUrl = 'postgres://verification:sensitive-password@db.example.com/kntr';
      const invalid = [
        ...['0', '-1', '65536', '5432abc', '5.4'].map(DB_PORT => ({ DB_PORT })),
        { DATABASE_URL: 'https://db.example.com/kntr' }, { DATABASE_URL: 'postgres://db.example.com/kntr' },
        { DATABASE_URL: 'postgres://verification@db.example.com/' }, { DATABASE_URL: `${privateUrl}#fragment` },
        { DATABASE_URL: `${privateUrl}?sslmode=prefer` }, { DATABASE_URL: `${privateUrl}?sslmode=disable&sslmode=require` },
        { DATABASE_URL: `${privateUrl}?sslmode=require`, DB_SSL: 'disable' },
        { DATABASE_URL: `${privateUrl}?sslmode=disable`, DB_SSL: 'require' },
        { DATABASE_URL: `${privateUrl}?sslmode=require&sslrootcert=/tmp/unverified.pem` },
        { DATABASE_URL: `${privateUrl}?sslmode=require&ssl=false` }, { DB_SSL: 'true' },
        { DB_SSL: 'disable', DB_SSL_CA_FILE: '/not-present.pem' }, { DB_SSL: 'require', DB_SSL_CA_FILE: '/not-present.pem' },
      ];
      for (const env of invalid) {
        let error; try { buildDatabaseOptions(env); } catch (caught) { error = caught; }
        assert.ok(error, 'Invalid database configuration accepted'); assert.equal(error.code, 'DATABASE_CONFIG_INVALID');
        assert.ok(!error.message.includes('sensitive-password'), 'Database validation must not echo credentials');
      }
      for (const sslmode of ['require', 'verify-ca', 'verify-full']) {
        const options = buildDatabaseOptions({ DATABASE_URL: `${privateUrl}?sslmode=${sslmode}` });
        assert.equal(options.ssl.rejectUnauthorized, true);
      }
      assert.equal(buildDatabaseOptions({ DB_SSL: 'require' }).ssl.rejectUnauthorized, true);
      return { rejectedConfigurations: invalid.length, tlsVerificationOptionsValidated: true, tlsHandshakeTested: false, credentialsNotEchoed: true };
    });
    await h.test('Preparing an empty database installs the schema and migrations exactly once and preserves persistent data', async () => separateDatabase('empty', async pool => {
      await prepareDatabase(pool); await validateDatabaseReadiness(pool);
      const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename);
      for (const name of READY_TABLES) assert.ok(tables.includes(name), `Missing ready table ${name}`);
      const ledger = (await pool.query('SELECT name,checksum FROM kntr_schema_migrations ORDER BY name')).rows;
      assert.equal(ledger.length, 3); assert.ok(ledger.every(row => /^[a-f0-9]{64}$/.test(row.checksum)));
      const user = (await pool.query("INSERT INTO users(role,email,phone,password_hash,full_name_ar) VALUES('customer','persistent@example.com','+218910500001','verification-hash','Persistent') RETURNING id")).rows[0];
      await pool.query("INSERT INTO system_settings(key,value) VALUES('verification_persistent', $1)", [{ preserved: true }]);
      const snapshot = async () => ({
        users: (await pool.query('SELECT * FROM users ORDER BY id')).rows,
        settings: (await pool.query('SELECT * FROM system_settings ORDER BY key')).rows,
        prohibited: (await pool.query('SELECT * FROM prohibited_items ORDER BY id')).rows,
        ledger: (await pool.query('SELECT * FROM kntr_schema_migrations ORDER BY name')).rows,
      });
      const before = await snapshot();
      await prepareDatabase(pool); await prepareDatabase(pool); await validateDatabaseReadiness(pool);
      assert.deepEqual(await snapshot(), before); assert.equal(before.prohibited.length, 6);
      return { readyTables: READY_TABLES.length, appliedMigrations: ledger.map(row => row.name), repeatedRuns: 3, persistentUserId: user.id, seedRowsNotDuplicated: true, persistentDataUnchanged: true };
    }));
    await h.test('A partially populated database is rejected without overwriting objects or creating application tables', async () => separateDatabase('partial', async pool => {
      await pool.query('CREATE TABLE verification_partial(id integer PRIMARY KEY,payload text NOT NULL)');
      await pool.query("INSERT INTO verification_partial VALUES(1,'must survive')");
      await assert.rejects(() => prepareDatabase(pool));
      assert.deepEqual((await pool.query('SELECT * FROM verification_partial')).rows, [{ id: 1, payload: 'must survive' }]);
      const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename);
      assert.deepEqual(tables, ['verification_partial']);
      return { preparationRejected: true, originalObjectAndDataPreserved: true, noPartialApplicationSchema: true };
    }));
    await h.test('Recorded migration checksum changes fail closed and leave application data unchanged', async () => separateDatabase('checksum', async pool => {
      await prepareDatabase(pool);
      const row = (await pool.query('SELECT name,checksum FROM kntr_schema_migrations ORDER BY name LIMIT 1')).rows[0];
      await pool.query('UPDATE kntr_schema_migrations SET checksum=$1 WHERE name=$2', ['0'.repeat(64), row.name]);
      const before = (await pool.query('SELECT * FROM system_settings ORDER BY key')).rows;
      await assert.rejects(() => prepareDatabase(pool));
      assert.deepEqual((await pool.query('SELECT * FROM system_settings ORDER BY key')).rows, before);
      assert.equal((await pool.query('SELECT checksum FROM kntr_schema_migrations WHERE name=$1', [row.name])).rows[0].checksum, '0'.repeat(64));
      await pool.query('UPDATE kntr_schema_migrations SET checksum=$1 WHERE name=$2', [row.checksum, row.name]);
      await prepareDatabase(pool); await validateDatabaseReadiness(pool);
      return { alteredLedgerRejected: true, settingsUnchanged: true, checksumNotSilentlyRewritten: true, restoredLedgerReady: true };
    }));
    const bootstrap = { ADMIN_BOOTSTRAP_EMAIL: ' Startup.Admin@Example.com ', ADMIN_BOOTSTRAP_PHONE: '+218910500002',
      ADMIN_BOOTSTRAP_PASSWORD: 'StartupTestPass123!', ADMIN_BOOTSTRAP_NAME: 'Startup Admin' };
    await h.test('Administrator bootstrap requires explicit strong credentials and rejects invalid inputs without echoing passwords', async () => {
      const input = buildAdminBootstrap(bootstrap); assert.equal(input.email, 'startup.admin@example.com');
      const cases = [
        { ADMIN_BOOTSTRAP_EMAIL: undefined }, { ADMIN_BOOTSTRAP_PHONE: undefined }, { ADMIN_BOOTSTRAP_PASSWORD: undefined },
        { ADMIN_BOOTSTRAP_NAME: undefined }, { ADMIN_BOOTSTRAP_EMAIL: 'not-an-email' }, { ADMIN_BOOTSTRAP_PHONE: '+123' },
        { ADMIN_BOOTSTRAP_PASSWORD: 'weak' }, { ADMIN_BOOTSTRAP_PASSWORD: 'abcdefghijklmnop' },
        { ADMIN_BOOTSTRAP_PASSWORD: 'Password12345' }, { ADMIN_BOOTSTRAP_PASSWORD: 'Password!'.repeat(9) },
        { ADMIN_BOOTSTRAP_NAME: 'bad\nname' },
      ];
      for (const override of cases) {
        let error; try { buildAdminBootstrap({ ...bootstrap, ...override }); } catch (caught) { error = caught; }
        assert.ok(error, 'Invalid administrator bootstrap accepted'); assert.equal(error.code, 'BOOTSTRAP_CONFIG_INVALID');
        assert.ok(!error.message.includes(bootstrap.ADMIN_BOOTSTRAP_PASSWORD), 'Bootstrap validation must not expose credentials');
      }
      return { normalizedEmail: input.email, rejectedConfigurations: cases.length, credentialsNotEchoed: true };
    });
    await h.test('Administrator bootstrap creates a usable account; duplicates preserve the existing account and cannot promote a customer', async () => {
      const created = await createAdmin(adminPool, bootstrap); assert.equal(created.role, 'admin');
      const before = (await h.query('SELECT * FROM users WHERE id=$1', [created.id])).rows[0];
      const bcrypt = require(path.join(h.backend, 'node_modules/bcryptjs'));
      assert.ok(await bcrypt.compare(bootstrap.ADMIN_BOOTSTRAP_PASSWORD, before.password_hash)); assert.notEqual(before.password_hash, bootstrap.ADMIN_BOOTSTRAP_PASSWORD);
      const login = h.status(await h.request('/auth/login', null, 'POST', { email: created.email, password: bootstrap.ADMIN_BOOTSTRAP_PASSWORD }), 200);
      assert.equal(login.body.data.user.role, 'admin'); assert.equal(login.body.data.user.id, created.id);
      const afterLogin = (await h.query('SELECT * FROM users WHERE id=$1', [created.id])).rows[0];
      await assert.rejects(() => createAdmin(adminPool, { ...bootstrap, ADMIN_BOOTSTRAP_PASSWORD: 'ChangedPassword123!' }), { code: 'ADMIN_BOOTSTRAP_DUPLICATE' });
      assert.deepEqual((await h.query('SELECT * FROM users WHERE id=$1', [created.id])).rows[0], afterLogin);
      const customer = await h.fixture('customer', 'bootstrap-customer');
      const customerBefore = (await h.query('SELECT * FROM users WHERE id=$1', [customer.id])).rows[0];
      await assert.rejects(() => createAdmin(adminPool, { ...bootstrap, ADMIN_BOOTSTRAP_EMAIL: customer.email, ADMIN_BOOTSTRAP_PHONE: '+218910500003' }), { code: 'ADMIN_BOOTSTRAP_DUPLICATE' });
      await assert.rejects(() => createAdmin(adminPool, { ...bootstrap, ADMIN_BOOTSTRAP_EMAIL: 'other-admin@example.com', ADMIN_BOOTSTRAP_PHONE: customerBefore.phone }), { code: 'ADMIN_BOOTSTRAP_DUPLICATE' });
      assert.deepEqual((await h.query('SELECT * FROM users WHERE id=$1', [customer.id])).rows[0], customerBefore);
      return { accountCreatedWithHashedPassword: true, actualLoginSucceeded: true, duplicateDidNotResetPassword: true, customerEmailAndPhoneCollisionsCannotPromoteRole: true };
    });
    await h.test('Gmail administrator aliases use the public login normalization and cannot create or overwrite a duplicate canonical account', async () => {
      const aliasedBootstrap = { ...bootstrap, ADMIN_BOOTSTRAP_EMAIL: ' Startup.Admin+deploy@GoogleMail.com ', ADMIN_BOOTSTRAP_PHONE: '+218910500004' };
      const created = await createAdmin(adminPool, aliasedBootstrap);
      assert.equal(created.email, 'startupadmin@gmail.com'); assert.equal(created.role, 'admin');
      for (const email of ['Startup.Admin+deploy@GoogleMail.com', created.email]) {
        const login = h.status(await h.request('/auth/login', null, 'POST', { email, password: aliasedBootstrap.ADMIN_BOOTSTRAP_PASSWORD }), 200);
        assert.equal(login.body.data.user.id, created.id); assert.equal(login.body.data.user.role, 'admin');
      }
      const before = (await h.query('SELECT * FROM users WHERE id=$1', [created.id])).rows[0];
      await assert.rejects(() => createAdmin(adminPool, { ...aliasedBootstrap,
        ADMIN_BOOTSTRAP_EMAIL: 'start.upadmin+duplicate@gmail.com', ADMIN_BOOTSTRAP_PHONE: '+218910500005',
        ADMIN_BOOTSTRAP_PASSWORD: 'ChangedPassword123!' }), { code: 'ADMIN_BOOTSTRAP_DUPLICATE' });
      assert.deepEqual((await h.query('SELECT * FROM users WHERE id=$1', [created.id])).rows[0], before);
      assert.equal(Number((await h.query('SELECT count(*) FROM users WHERE email=$1', [created.email])).rows[0].count), 1);
      assert.equal(Number((await h.query('SELECT count(*) FROM users WHERE phone=$1', ['+218910500005'])).rows[0].count), 0);
      return { canonicalEmail: created.email, actualAliasAndCanonicalLoginsSucceeded: 2, duplicateAliasRejected: true, existingAccountUnchanged: true, noDuplicateUser: true };
    });
    await adminPool.end();
    await h.test('Production rejects incomplete configuration before it listens and does not print provided secrets', async () => {
      const port = await freePort(); let output = '';
      const env = { ...cleanEnvironment(), ...validRuntime, PORT: String(port), DATABASE_URL: url };
      delete env.JWT_SECRET;
      const child = spawn(process.execPath, ['src/app.js'], { cwd: h.backend, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
      try {
        await Promise.race([once(child, 'exit'), delay(5000)]);
        assert.ok(child.exitCode !== null, 'Invalid production startup did not exit'); assert.notEqual(child.exitCode, 0);
        assert.ok(!output.includes(h.refreshSecret) && !output.includes(h.secret), 'Startup logs exposed provided JWT secrets');
        await assert.rejects(() => fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }));
      } finally { await stopProcess(child); }
      return { nonzeroExitBeforeListen: true, healthEndpointUnreachable: true, secretsNotPrinted: true };
    });
    const port = await freePort(), productionBase = `http://127.0.0.1:${port}`;
    const logfile = fs.openSync(path.join(h.runDir, 'production-server.log'), 'w');
    productionServer = spawn(process.execPath, ['src/app.js'], { cwd: h.backend, env: {
      ...cleanEnvironment(), ...validRuntime, PORT: String(port), DATABASE_URL: url, TRUST_PROXY: '1',
    }, stdio: ['ignore', logfile, logfile] });
    fs.closeSync(logfile);
    for (let attempt = 0; attempt < 100; attempt++) {
      try { assert.equal((await readEndpoint(productionBase, '/health')).status, 200); break; }
      catch (error) { if (attempt === 99 || productionServer.exitCode !== null) throw new Error('Configured production server failed startup; inspect production-server.log'); await delay(100); }
    }
    await h.test('Configured production serves liveness and real schema readiness without leaking database details', async () => {
      const health = await readEndpoint(productionBase, '/health'), ready = await readEndpoint(productionBase, '/ready');
      assert.equal(health.status, 200); assert.equal(health.body.status, 'ok'); assert.equal(ready.status, 200); assert.equal(ready.body.status, 'ok');
      const text = JSON.stringify(ready.body); assert.ok(!text.includes(h.secret) && !text.includes(h.refreshSecret) && !text.includes(url));
      return { productionStarted: true, healthStatus: health.status, readinessStatus: ready.status, actualDatabaseSchemaChecked: true };
    });
    await h.test('Production HTTP preflight admits only configured Android, iOS and web origins with credentials', async () => {
      const origins = ['https://localhost', 'capacitor://localhost', 'https://app.example.com'];
      for (const origin of origins) {
        const response = await fetch(`${productionBase}/v1/auth/login`, { method: 'OPTIONS',
          headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,authorization' }, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), origin);
        assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
      }
      for (const origin of ['https://attacker.example.com', 'null', 'https://localhost/extra']) {
        const response = await fetch(`${productionBase}/v1/auth/login`, { method: 'OPTIONS',
          headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' }, signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'ORIGIN_NOT_ALLOWED');
        assert.equal(response.headers.get('access-control-allow-origin'), null);
      }
      return { exactAllowedOrigins: origins, rejectedOrigins: 3, credentialedNativePreflight: true };
    });
    const socketCustomer = await h.fixture('customer', 'startup-socket-customer');
    async function socketConnection(origin, token, expectAllowed) {
      const socket = io(productionBase, { transports: ['websocket'], reconnection: false, autoConnect: false,
        extraHeaders: { Origin: origin }, ...(token ? { auth: { token } } : {}) });
      openedSockets.add(socket);
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Production WebSocket fixture timed out')), 5000);
          socket.once('connect', () => { clearTimeout(timer); expectAllowed ? resolve() : reject(new Error('Denied production WebSocket connected')); });
          socket.once('connect_error', () => { clearTimeout(timer); expectAllowed ? reject(new Error('Allowed authenticated production WebSocket was denied')) : resolve(); });
          socket.connect();
        });
      } finally { socket.disconnect(); openedSockets.delete(socket); }
    }
    await h.test('Production applies native origin restrictions to actual WebSocket upgrades and still requires a valid session', async () => {
      for (const origin of ['https://localhost', 'capacitor://localhost']) await socketConnection(origin, socketCustomer.token, true);
      for (const origin of ['https://attacker.example.com', 'null']) await socketConnection(origin, socketCustomer.token, false);
      await socketConnection('https://localhost', undefined, false);
      return { allowedAuthenticatedNativeUpgrades: 2, forbiddenOriginUpgradesDenied: 2, anonymousAllowedOriginDenied: true, actualWebSocketTransport: true };
    });
    await h.test('Readiness detects a missing application table, leaves liveness up and recovers when the schema is restored', async () => {
      await h.query('ALTER TABLE users RENAME TO verification_users_outage');
      try {
        const ready = await readEndpoint(productionBase, '/ready'), health = await readEndpoint(productionBase, '/health');
        assert.equal(ready.status, 503); assert.equal(ready.body.status, 'unavailable'); assert.equal(health.status, 200);
        assert.ok(!JSON.stringify(ready.body).includes('verification_users_outage'), 'Readiness response exposed internal schema details');
      } finally { await h.query('ALTER TABLE verification_users_outage RENAME TO users'); }
      assert.equal((await readEndpoint(productionBase, '/ready')).status, 200);
      return { missingSchemaReady503: true, liveness200DuringOutage: true, schemaRecoveryReady200: true };
    });
    await h.test('Database connection loss produces readiness 503 while liveness stays 200 and both servers recover without restart', async () => {
      const ownPid = (await h.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await adminConnection.query(`ALTER DATABASE ${identifier(h.databaseName)} ALLOW_CONNECTIONS false`);
      try {
        await h.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>$2', [h.databaseName, ownPid]);
        await delay(150);
        for (const base of [productionBase, h.base]) {
          const ready = await readEndpoint(base, '/ready'), health = await readEndpoint(base, '/health');
          assert.equal(ready.status, 503); assert.equal(ready.body.status, 'unavailable'); assert.equal(health.status, 200);
        }
        assert.equal(productionServer.exitCode, null, 'Idle PostgreSQL connection loss killed production server');
      } finally { await adminConnection.query(`ALTER DATABASE ${identifier(h.databaseName)} ALLOW_CONNECTIONS true`); }
      for (const base of [productionBase, h.base]) assert.equal((await readEndpoint(base, '/ready')).status, 200);
      return { databaseConnectionsActuallyTerminated: true, readiness503WhileUnavailable: true, liveness200DuringLoss: true, productionAndTestServersRecoveredReady200: true, noRestartRequired: true };
    });
    assert.deepEqual(sourceHashes(h.backend), h.results.sourceHashes, 'Application sources changed during verification');
  } finally {
    for (const socket of openedSockets) socket.disconnect();
    await stopProcess(productionServer);
    await adminPool.end().catch(() => {});
    await adminConnection.end().catch(() => {});
  }
}

(async () => {
  let h, fatal;
  try { h = await createHarness('startup'); await main(h); }
  catch (error) { fatal = error; console.error(error.stack); process.exitCode = 1; }
  finally { if (h) await h.close(fatal); }
})();
