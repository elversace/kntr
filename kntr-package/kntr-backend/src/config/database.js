const { Pool } = require('pg');
const { buildDatabaseOptions } = require('./databaseOptions');

const pool = new Pool(buildDatabaseOptions());

pool.on('error', (err) => {
  // Do not print connection objects or server messages containing credentials.
  console.error('Unexpected PostgreSQL pool connection error');
});

// Helper: run a query
const query = (text, params) => pool.query(text, params);

// Helper: get a client for transactions
const getClient = () => pool.connect();

// Test connection on startup
const testConnection = async () => {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
};

module.exports = { pool, query, getClient, testConnection };
