const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createHarness } = require('./harness.cjs');

async function main(h) {
  const { assert } = h;
  h.results.scope = 'Real isolated PostgreSQL, HTTP server and Chromium; production HTML routes with no API or HTML mocking. Not the user Codespace or a native build.';
  h.results.source_sha256 = Object.fromEntries([
    'kntr-package/kntr-backend/src/app.js',
    'kntr-package/frontend/kntr-app.html',
    'kntr-package/frontend/kntr-admin-dashboard.html',
    'kntr-mobile/www/index.html',
    'kntr-mobile/android/app/src/main/assets/public/index.html',
    'kntr-mobile/ios/App/App/public/index.html',
  ].map(filename => [filename, crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname, '..', filename))).digest('hex')]));

  await h.test('Public application aliases and administrator document are served with scoped CSP and no cache', async () => {
    for (const [route, filename] of [['/', 'kntr-app.html'], ['/app', 'kntr-app.html'], ['/admin', 'kntr-admin-dashboard.html']]) {
      const response = await fetch(h.base + route);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /^text\/html/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), fs.readFileSync(path.resolve(h.backend, '../frontend', filename), 'utf8'));
      const policy = response.headers.get('content-security-policy');
      assert.match(policy, /script-src 'self' 'unsafe-inline'/);
      assert.match(policy, /frame-ancestors 'none'/);
      assert.match(policy, /object-src 'none'/);
    }
    const health = await fetch(h.base + '/health');
    assert.doesNotMatch(health.headers.get('content-security-policy'), /script-src[^;]*unsafe-inline/);
    return { aliases: ['/', '/app', '/admin'], APIHelmetPolicyPreserved: true };
  });

  await h.test('HTML serving does not expose repository files, environment files or uploads', async () => {
    for (const route of ['/.env', '/.devcontainer/app.env', '/schema.sql', '/src/app.js', '/uploads/private-test.pdf', '/kntr-app.html']) {
      const response = await fetch(h.base + route);
      assert.equal(response.status, 404, route);
      assert.equal((await response.json()).success, false);
    }
    return { protectedPathsChecked: 6 };
  });

  const admin = await h.admin('hosted-login-admin');
  await h.test('Chromium registers customers and pending drivers, logs in and revokes logout sessions through served pages', async () => {
    const config = path.join(h.runDir, 'hosted-auth-browser-config.json');
    fs.writeFileSync(config, JSON.stringify({ base: h.base, admin: { id: admin.id, email: 'hosted-login-admin@example.com', password: 'TestPassw0rd123' } }), { mode: 0o600 });
    const log = fs.openSync(path.join(h.runDir, 'hosted-auth-browser.log'), 'w');
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(process.env.PYTHON_PATH || 'python3', [path.join(__dirname, 'hosted-auth-browser-tests.py'), config], { cwd: __dirname, env: process.env, stdio: ['ignore', log, log] });
        const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Hosted authentication browser timed out; see private run log')); }, 120000);
        child.once('error', err => { clearTimeout(timer); reject(err); });
        child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Hosted authentication browser failed (${code}); see ${path.join(h.runDir, 'hosted-auth-browser.log')}`)); });
      });
    } finally { fs.closeSync(log); fs.rmSync(config, { force: true }); }
    const report = JSON.parse(fs.readFileSync(path.join(__dirname, 'hosted-auth-browser-results.json'), 'utf8'));
    assert.equal(report.summary.success, true);
    assert.equal(report.apiMocked, false);
    assert.equal(report.htmlMocked, false);
    assert.equal(report.page_errors.length, 0);
    return { checks: report.checks.length, realBackend: true, realHTMLRoutes: true, browser_version: report.browser_version, native: false };
  });
}

let harness;
createHarness('hosted-auth').then(async h => { harness = h; await main(h); })
  .catch(err => { process.exitCode = 1; if (harness) harness.fatal = err; console.error(err.stack); })
  .finally(async () => { if (harness) await harness.close(harness.fatal); });
