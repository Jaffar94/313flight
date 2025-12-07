// backend/db.js
// Postgres (Neon) DB helper using 'pg'

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL is not set. Postgres connection will fail.');
}

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Neon uses SSL
  },
});

/**
 * run(sql, params)
 * Use for INSERT/UPDATE/DELETE or DDL statements where you don't need rows back.
 */
async function run(sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query(sql, params);
  } finally {
    client.release();
  }
}

/**
 * all(sql, params)
 * Returns all rows as an array.
 */
async function all(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    client.release();
  }
}

/**
 * get(sql, params)
 * Returns the first row (or null if none).
 */
async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

module.exports = {
  run,
  all,
  get,
};
