const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHarness } = require('./harness.cjs');

const cents = amount => Math.round(Number(amount) * 100);

async function runBrowser(h, customer, driver) {
  const config = path.join(h.runDir, 'browser-config.json');
  fs.writeFileSync(config, JSON.stringify({
    base: h.base,
    customer: { id: customer.id, email: customer.email, password: customer.password },
    driver: { id: driver.id, email: driver.email, password: driver.password },
  }), { mode: 0o600 });
  const log = fs.openSync(path.join(h.runDir, 'browser.log'), 'w');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.env.PYTHON_PATH || 'python3', [path.join(__dirname, 'endtoend-browser-tests.py'), config], {
        cwd: __dirname, env: process.env, stdio: ['ignore', log, log],
      });
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Real browser integration timed out; see browser.log')); }, 180000);
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('exit', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Real browser integration exited ${code}; see ${path.join(h.runDir, 'browser.log')}`));
      });
    });
  } finally {
    fs.closeSync(log);
    fs.rmSync(config, { force: true });
  }
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'endtoend-browser-results.json'), 'utf8'));
}

async function main(h) {
  const { assert } = h;
  const customer = await h.fixture('customer', 'real-browser-customer');
  const driver = await h.fixture('driver', 'real-browser-driver');
  const admin = await h.admin('real-browser-admin');
  await h.setupDriver(driver, admin, 'car');
  await h.query("UPDATE wallets SET balance=100,currency='LYD' WHERE user_id=$1", [customer.id]);
  let browserReport, cash, wallet;

  await h.test('Real Chromium customer and driver complete cash and wallet deliveries through real API', async () => {
    browserReport = await runBrowser(h, customer, driver);
    assert.equal(browserReport.summary.success, true);
    assert.equal(browserReport.actualBackend, true);
    assert.equal(browserReport.apiMocked, false);
    assert.equal(browserReport.flows.length, 2);
    cash = await h.order(browserReport.flows.find(flow => flow.payment_method === 'cash').order_id);
    wallet = await h.order(browserReport.flows.find(flow => flow.payment_method === 'wallet').order_id);
    for (const order of [cash, wallet]) {
      assert.equal(order.customer_id, customer.id); assert.equal(order.driver_id, driver.id);
      assert.equal(order.status, 'delivered'); assert.equal(order.payment_status, 'paid');
      assert.ok(order.qr_scanned_at); assert.ok(order.delivered_at);
    }
    return { actualBackend: true, apiMocked: false, native: false, flows: browserReport.flows,
      browser_version: browserReport.browser_version, realAPIResponses: browserReport.api_responses.length };
  });

  await h.test('Real browser deliveries create exactly one matching payment ledger entry per order', async () => {
    const entries = (await h.query('SELECT * FROM transactions WHERE order_id=ANY($1::varchar[]) ORDER BY order_id', [[cash.id, wallet.id]])).rows;
    assert.equal(entries.length, 2);
    for (const order of [cash, wallet]) {
      const rows = entries.filter(entry => entry.order_id === order.id);
      assert.equal(rows.length, 1);
      const entry = rows[0];
      assert.equal(entry.user_id, customer.id); assert.equal(entry.type, 'order_payment');
      assert.equal(entry.status, 'completed'); assert.equal(entry.currency, 'LYD');
      assert.equal(entry.payment_method, order.payment_method); assert.equal(cents(entry.amount), cents(order.final_price));
      assert.equal(cents(order.final_price), cents(order.driver_earnings) + cents(order.commission_amount) + cents(order.vat_amount));
    }
    const balance = (await h.query('SELECT balance FROM wallets WHERE user_id=$1', [customer.id])).rows[0].balance;
    assert.equal(cents(balance), 10000 - cents(wallet.final_price));
    const cashUI = browserReport.flows.find(flow => flow.payment_method === 'cash');
    const walletUI = browserReport.flows.find(flow => flow.payment_method === 'wallet');
    assert.equal(cents(cashUI.wallet_after_creation), 10000);
    assert.equal(cents(cashUI.wallet_after_delivery), 10000);
    assert.equal(cents(walletUI.wallet_after_creation), cents(balance));
    assert.equal(cents(walletUI.wallet_after_delivery), cents(balance));
    return { oneLedgerEntryEach: true, cashDidNotDebitWallet: true, walletDebitedOnce: true,
      initialWalletCents: 10000, walletChargeCents: cents(wallet.final_price), finalWalletCents: cents(balance) };
  });

  await h.test('Real browser delivery counters and earnings agree exactly with both paid orders', async () => {
    const stats = (await h.query('SELECT total_trips,total_earnings,availability FROM drivers WHERE user_id=$1', [driver.id])).rows[0];
    const totals = (await h.query('SELECT total_orders,total_spent FROM customers WHERE user_id=$1', [customer.id])).rows[0];
    assert.equal(stats.total_trips, 2); assert.equal(stats.availability, 'available');
    assert.equal(cents(stats.total_earnings), cents(cash.driver_earnings) + cents(wallet.driver_earnings));
    assert.equal(totals.total_orders, 2);
    assert.equal(cents(totals.total_spent), cents(cash.final_price) + cents(wallet.final_price));
    assert.equal((await h.query('SELECT COUNT(*) AS count FROM orders')).rows[0].count, '2');
    return { driverTrips: stats.total_trips, driverEarnings: stats.total_earnings,
      customerOrders: totals.total_orders, customerSpent: totals.total_spent, driverAvailable: true };
  });
}

let harness;
createHarness('endtoend').then(async h => { harness = h; await main(h); })
  .catch(err => { process.exitCode = 1; if (harness) harness.fatal = err; console.error(err.stack); })
  .finally(async () => { if (harness) await harness.close(harness.fatal); });
