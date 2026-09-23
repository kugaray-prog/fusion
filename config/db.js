const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

// Managed MySQL hosts (Aiven's free tier among them) require an SSL/TLS
// connection and give you a CA certificate to download -- point DB_SSL_CA
// at that file's path and the connection is verified against it. A plain
// local MySQL (the default) needs neither variable set. DB_SSL=true without
// a CA file trusts Node's built-in CA list instead, for a host whose
// certificate chains to a public CA rather than issuing its own.
//
// config/aiven-ca.pem is this project's Aiven CA certificate, committed on
// purpose (it's public -- it only proves the server is the real Aiven host,
// it grants no access). It's the fallback when DB_SSL_CA points at a path
// that doesn't exist, e.g. a Render Secret File that was never added.
const BUNDLED_CA = path.join(__dirname, 'aiven-ca.pem');

function buildSslConfig() {
  if (process.env.DB_SSL_CA) {
    let caPath = process.env.DB_SSL_CA;
    if (!fs.existsSync(caPath) && fs.existsSync(BUNDLED_CA)) {
      console.warn(`DB_SSL_CA file not found at ${caPath}; using bundled ${BUNDLED_CA}`);
      caPath = BUNDLED_CA;
    }
    return { ca: fs.readFileSync(caPath), rejectUnauthorized: true };
  }
  if (process.env.DB_SSL === 'true') {
    return { rejectUnauthorized: true };
  }
  return undefined;
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'geoattend_pro',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
  ssl: buildSslConfig()
});

pool.getConnection()
  .then(conn => {
    console.log('MySQL connected successfully.');
    conn.release();
  })
  .catch(err => {
    console.error('MySQL connection failed:', err.message);
    console.error('Check your .env DB_* values and that MySQL is running.');
  });

module.exports = pool;
