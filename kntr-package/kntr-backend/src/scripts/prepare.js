const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '../..');
const CORE_TABLES = [
  'users', 'sessions', 'password_resets', 'customers', 'drivers',
  'driver_documents', 'driver_vehicles', 'orders', 'order_ratings',
  'order_counter_offers', 'driver_payouts', 'wallets', 'transactions',
  'refunds', 'support_tickets', 'ticket_messages', 'corporate_accounts',
  'corporate_users', 'corporate_invoices', 'notifications', 'audit_logs',
  'system_settings', 'prohibited_items',
];
const READY_TABLES = [...CORE_TABLES, 'payout_items', 'driver_document_archive'];

function failure(message, code = 'DATABASE_NOT_READY') {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function tableNames(client) {
  const result = await client.query(`SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`);
  return new Set(result.rows.map(row => row.relname));
}

async function validateDatabaseReadiness(client) {
  const tables = await tableNames(client);
  const missing = READY_TABLES.filter(name => !tables.has(name));
  if (missing.length) throw failure(`Database is missing required tables: ${missing.join(', ')}`);

  // Keep the check aligned with the shipped schema without executing CREATE
  // statements against an existing database or guessing missing columns.
  const expectedColumns = new Map();
  const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  for (const match of schema.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(\n([\s\S]*?)^\);/gm)) {
    expectedColumns.set(match[1], [...match[2].matchAll(/^  ([a-z][a-z0-9_]*)\s/gm)].map(column => column[1]));
  }
  if (expectedColumns.size !== READY_TABLES.length) throw failure('Shipped schema readiness definition is incomplete');
  const columnResult = await client.query(`SELECT table_name, column_name
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, [READY_TABLES]);
  const columns = new Set(columnResult.rows.map(row => `${row.table_name}.${row.column_name}`));
  const missingColumns = [];
  for (const [table, names] of expectedColumns) {
    for (const name of names) if (!columns.has(`${table}.${name}`)) missingColumns.push(`${table}.${name}`);
  }
  if (missingColumns.length) throw failure(`Database is missing required columns: ${missingColumns.join(', ')}`);

  const constraints = await client.query(`SELECT c.conname, c.convalidated, c.contype
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND
      ((t.relname = 'wallets' AND c.conname IN ('wallets_balance_nonnegative', 'wallets_currency_valid'))
       OR (t.relname = 'driver_documents' AND c.conname = 'driver_documents_driver_type_unique')
       OR (t.relname = 'payout_items' AND c.conname IN ('payout_items_amount_positive', 'payout_items_currency_valid')))`);
  const requiredConstraints = {
    wallets_balance_nonnegative: 'c', wallets_currency_valid: 'c',
    driver_documents_driver_type_unique: 'u', payout_items_amount_positive: 'c',
    payout_items_currency_valid: 'c',
  };
  for (const [name, type] of Object.entries(requiredConstraints)) {
    if (!constraints.rows.some(row => row.conname === name && row.contype === type && row.convalidated)) {
      throw failure(`Database integrity constraint is missing or unvalidated: ${name}`);
    }
  }
  const notNull = await client.query(`SELECT t.relname, a.attname, a.attnotnull
    FROM pg_attribute a JOIN pg_class t ON t.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND
      ((t.relname = 'wallets' AND a.attname IN ('balance', 'currency'))
       OR (t.relname = 'driver_documents' AND a.attname = 'driver_id'))`);
  if (notNull.rows.length !== 3 || notNull.rows.some(row => !row.attnotnull)) {
    throw failure('Wallet and document NOT NULL protections are missing');
  }
  const ledgerIndex = await client.query(`SELECT i.indisunique, i.indisvalid,
      pg_get_expr(i.indpred, i.indrelid) AS predicate,
      (SELECT array_agg(a.attname::text ORDER BY k.position)
       FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(number, position)
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.number) AS columns
    FROM pg_index i JOIN pg_class ix ON ix.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'transactions'
      AND ix.relname = 'idx_transactions_completed_order_event'`);
  const index = ledgerIndex.rows[0];
  if (!index?.indisunique || !index.indisvalid || JSON.stringify(index.columns) !== JSON.stringify(['order_id', 'type'])
      || !index.predicate?.includes('order_id IS NOT NULL') || !index.predicate.includes("'completed'")
      || !index.predicate.includes("'order_payment'") || !index.predicate.includes("'order_refund'")) {
    throw failure('Completed order payment/refund uniqueness protection is missing');
  }
  const settings = await client.query("SELECT key FROM public.system_settings WHERE key IN ('pricing', 'customer_tiers')");
  if (settings.rows.length !== 2) throw failure('Required pricing or customer tier settings are missing');
  return { ready: true, tables: READY_TABLES.length };
}

async function publicSchemaHasObjects(client) {
  const result = await client.query(`SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
    UNION ALL
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
    UNION ALL
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  ) AS populated`);
  return result.rows[0].populated;
}

function migrationBody(source, name) {
  const lines = source.split(/\r?\n/);
  const begin = lines.findIndex(line => /^\s*BEGIN;\s*$/.test(line));
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end--;
  if (begin < 0 || !/^\s*COMMIT;\s*$/.test(lines[end])
      || lines.slice(0, begin).some(line => line.trim() && !line.trim().startsWith('--'))) {
    throw failure(`Migration ${name} must contain one explicit outer transaction`, 'DATABASE_MIGRATION_INVALID');
  }
  return lines.slice(begin + 1, end).join('\n');
}

async function prepareDatabase(pool) {
  const client = await pool.connect();
  let locked = false;
  try {
    const version = await client.query('SHOW server_version_num');
    if (Number(version.rows[0].server_version_num) < 130000) throw failure('PostgreSQL 13 or newer is required');
    await client.query("SELECT pg_advisory_lock(hashtext('kntr_schema_upgrade'))");
    locked = true;
    await client.query('SET search_path TO public, pg_catalog');
    const tables = await tableNames(client);
    let initialized = false;
    if (!tables.has('users')) {
      if (await publicSchemaHasObjects(client)) {
        throw failure('Public schema is nonempty but has no users table; refusing automatic initialization', 'DATABASE_PARTIAL_SCHEMA');
      }
      try {
        await client.query('BEGIN');
        await client.query(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));
        await client.query('COMMIT');
        initialized = true;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } else {
      const missing = CORE_TABLES.filter(name => !tables.has(name));
      if (missing.length) throw failure(`Existing schema is incomplete; missing tables: ${missing.join(', ')}`, 'DATABASE_PARTIAL_SCHEMA');
    }

    await client.query(`CREATE TABLE IF NOT EXISTS public.kntr_schema_migrations (
      name VARCHAR(255) PRIMARY KEY, checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const directory = path.join(ROOT, 'migrations');
    const files = fs.readdirSync(directory).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
    if (!files.length) throw failure('No database migrations found', 'DATABASE_MIGRATION_INVALID');
    const history = await client.query('SELECT name, checksum FROM public.kntr_schema_migrations ORDER BY name');
    const recorded = new Map(history.rows.map(row => [row.name, row.checksum]));
    if (history.rows.some(row => !files.includes(row.name))) {
      throw failure('Database migration history is newer than the shipped application; refusing downgrade', 'DATABASE_MIGRATION_INVALID');
    }
    const applied = [];
    for (const name of files) {
      const source = fs.readFileSync(path.join(directory, name), 'utf8');
      const checksum = createHash('sha256').update(source).digest('hex');
      if (recorded.has(name)) {
        if (recorded.get(name) !== checksum) throw failure(`Applied migration changed: ${name}`, 'DATABASE_MIGRATION_INVALID');
        continue;
      }
      if (history.rows.some(row => row.name > name)) throw failure(`Migration history has an out-of-order gap: ${name}`, 'DATABASE_MIGRATION_INVALID');
      try {
        await client.query('BEGIN');
        await client.query(migrationBody(source, name));
        await client.query('INSERT INTO public.kntr_schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
        await client.query('COMMIT');
        applied.push(name);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error.code?.startsWith('DATABASE_')) throw error;
        throw failure(`Migration ${name} failed; database preparation stopped`, 'DATABASE_MIGRATION_FAILED');
      }
    }
    const readiness = await validateDatabaseReadiness(client);
    return { ...readiness, initialized, applied };
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('kntr_schema_upgrade'))").catch(() => {});
    client.release();
  }
}

if (require.main === module) {
  require('dotenv').config();
  let pool;
  Promise.resolve().then(async () => {
    pool = require('../config/database').pool;
    const result = await prepareDatabase(pool);
    console.log(`Database ready: ${result.initialized ? 'initialized' : 'existing'} schema; ${result.applied.length} migrations applied`);
  }).catch(error => {
    console.error(`Database preparation failed (${error.code || 'DATABASE_ERROR'})`);
    process.exitCode = 1;
  }).finally(async () => { if (pool) await pool.end(); });
}

module.exports = { prepareDatabase, validateDatabaseReadiness, CORE_TABLES, READY_TABLES };
