require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../config/database');

async function upgrade() {
  const client = await pool.connect();
  try {
    // A second upgrade process waits; application writes are also guarded by
    // each migration's table locks. Run this with the application stopped.
    await client.query("SELECT pg_advisory_lock(hashtext('kntr_schema_upgrade'))");
    const directory = path.resolve(__dirname, '../../migrations');
    const files = fs.readdirSync(directory).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
    if (!files.length) throw new Error('No upgrade migrations found');
    for (const name of files) {
      try {
        await client.query(fs.readFileSync(path.join(directory, name), 'utf8'));
        console.log(`Applied ${name}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`${name} failed: ${err.message}${err.hint ? '\n' + err.hint : ''}`);
      }
    }
    console.log('Database upgrade complete');
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('kntr_schema_upgrade'))").catch(() => {});
    client.release();
  }
}

upgrade().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
}).finally(() => pool.end());
