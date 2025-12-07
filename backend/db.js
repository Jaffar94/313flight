// backend/db.js
// Postgres (Neon) DB helper using 'pg'

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/**
 * run(sql, params)
 * INSERT / UPDATE / DELETE / CREATE — no return rows
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
 * Return all rows
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
 * Return one row or null
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
