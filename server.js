const express = require('express');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from .env if present
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Helper function to get masked DB config
function getDbConfig() {
  const dbType = (process.env.DB_TYPE || 'postgres').toLowerCase();
  let defaultPort = '5432';
  if (dbType === 'mysql') defaultPort = '3306';
  else if (dbType === 'mssql' || dbType === 'sqlsrv') defaultPort = '1433';

  return {
    type: process.env.DB_TYPE || 'not configured (defaults to postgres)',
    host: process.env.DB_HOST || 'not configured',
    port: process.env.DB_PORT || defaultPort,
    user: process.env.DB_USER || 'not configured',
    database: process.env.DB_NAME || 'not configured',
    passwordProvided: !!process.env.DB_PASS
  };
}

// Basic health check endpoint
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// Endpoint to fetch current DB configuration and test connection (READ test)
app.get('/api/db-status', async (req, res) => {
  const config = getDbConfig();
  const dbType = (process.env.DB_TYPE || 'postgres').toLowerCase();
  
  if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_PASS || !process.env.DB_NAME) {
    return res.json({
      status: 'unconfigured',
      config,
      message: 'Database environment variables are missing.'
    });
  }

  const startTime = Date.now();
  let connectionError = null;
  let queryResult = null;
  let latencyMs = 0;

  if (dbType === 'postgres') {
    const { Client } = require('pg');
    const client = new Client({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      connectionTimeoutMillis: 5000, // 5s timeout to fail fast on network blocks
    });

    try {
      await client.connect();
      const dbRes = await client.query('SELECT NOW() AS current_time, version();');
      queryResult = {
        time: dbRes.rows[0].current_time,
        version: dbRes.rows[0].version
      };
      latencyMs = Date.now() - startTime;
      await client.end();
    } catch (err) {
      connectionError = {
        message: err.message,
        code: err.code,
        hint: err.hint || null,
        stack: err.stack
      };
      try { await client.end(); } catch (e) {}
    }
  } else if (dbType === 'mysql') {
    const mysql = require('mysql2/promise');
    let connection;
    try {
      connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '3306', 10),
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        connectTimeout: 5000, // 5s timeout
      });

      const [rows] = await connection.query('SELECT NOW() AS current_time, @@version AS version;');
      queryResult = {
        time: rows[0].current_time,
        version: rows[0].version
      };
      latencyMs = Date.now() - startTime;
      await connection.end();
    } catch (err) {
      connectionError = {
        message: err.message,
        code: err.code,
        errno: err.errno,
        sqlState: err.sqlState,
        stack: err.stack
      };
      if (connection) {
        try { await connection.end(); } catch (e) {}
      }
    }
  } else if (dbType === 'mssql' || dbType === 'sqlsrv') {
    const sql = require('mssql');
    const dbConfig = {
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      server: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '1433', 10),
      database: process.env.DB_NAME,
      options: {
        encrypt: true,
        trustServerCertificate: true,
      },
      connectionTimeout: 5000,
    };

    let pool;
    try {
      pool = await sql.connect(dbConfig);
      const dbRes = await pool.request().query('SELECT GETDATE() AS db_time, @@VERSION AS version;');
      queryResult = {
        time: dbRes.recordset[0].db_time,
        version: dbRes.recordset[0].version
      };
      latencyMs = Date.now() - startTime;
      await pool.close();
    } catch (err) {
      connectionError = {
        message: err.message,
        code: err.code,
        stack: err.stack
      };
      if (pool) {
        try { await pool.close(); } catch (e) {}
      }
    }
  } else {
    return res.status(400).json({
      status: 'error',
      config,
      message: `Unsupported DB_TYPE: "${dbType}". Supported types are "postgres", "mysql", or "mssql" / "sqlsrv".`
    });
  }

  if (connectionError) {
    return res.status(500).json({
      status: 'error',
      config,
      error: connectionError,
      message: 'Failed to connect to the database. Check your private connection configuration.'
    });
  }

  return res.json({
    status: 'connected',
    config,
    latencyMs,
    queryResult,
    message: 'Successfully connected and executed query privately!'
  });
});

// Endpoint to run a complete READ/WRITE lifecycle test
app.post('/api/db-test-write', async (req, res) => {
  const dbType = (process.env.DB_TYPE || 'postgres').toLowerCase();

  if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_PASS || !process.env.DB_NAME) {
    return res.status(400).json({
      success: false,
      message: 'Database environment variables are missing.'
    });
  }

  const startTime = Date.now();
  const tableName = `cloud_run_test_${Math.floor(Math.random() * 1000000)}`;
  const logs = [];

  logs.push(`Starting write test on dynamic table: ${tableName}`);

  if (dbType === 'postgres') {
    const { Client } = require('pg');
    const client = new Client({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      connectionTimeoutMillis: 5000,
    });

    try {
      logs.push('Connecting to PostgreSQL database...');
      await client.connect();

      logs.push('Creating test table...');
      await client.query(`
        CREATE TABLE ${tableName} (
          id SERIAL PRIMARY KEY,
          message VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      logs.push('Inserting record into test table...');
      const insertRes = await client.query(
        `INSERT INTO ${tableName} (message) VALUES ($1) RETURNING id, message, created_at;`,
        ['Hello from Cloud Run private network!']
      );
      const insertedRow = insertRes.rows[0];
      logs.push(`Inserted row ID: ${insertedRow.id}, Message: "${insertedRow.message}"`);

      logs.push('Querying the inserted record back...');
      const selectRes = await client.query(`SELECT * FROM ${tableName} WHERE id = $1;`, [insertedRow.id]);
      const fetchedRow = selectRes.rows[0];
      logs.push(`Successfully fetched row: ID ${fetchedRow.id}, Message: "${fetchedRow.message}"`);

      logs.push('Cleaning up: Dropping test table...');
      await client.query(`DROP TABLE ${tableName};`);
      logs.push('Test table cleaned up successfully.');

      await client.end();
      const durationMs = Date.now() - startTime;
      
      return res.json({
        success: true,
        durationMs,
        logs,
        message: 'Write and Read cycle test passed completely!'
      });
    } catch (err) {
      logs.push(`ERROR: ${err.message}`);
      try {
        logs.push(`Attempting clean up: dropping table ${tableName} if it exists...`);
        await client.query(`DROP TABLE IF EXISTS ${tableName};`);
      } catch (cleanupErr) {}
      try { await client.end(); } catch (e) {}

      return res.status(500).json({
        success: false,
        durationMs: Date.now() - startTime,
        logs,
        error: err.message
      });
    }
  } else if (dbType === 'mysql') {
    const mysql = require('mysql2/promise');
    let connection;
    try {
      logs.push('Connecting to MySQL database...');
      connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT || '3306', 10),
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        connectTimeout: 5000,
      });

      logs.push('Creating test table...');
      await connection.query(`
        CREATE TABLE ${tableName} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          message VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      logs.push('Inserting record into test table...');
      const [insertRes] = await connection.query(
        `INSERT INTO ${tableName} (message) VALUES (?);`,
        ['Hello from Cloud Run private network!']
      );
      const insertedId = insertRes.insertId;
      logs.push(`Inserted row ID: ${insertedId}`);

      logs.push('Querying the inserted record back...');
      const [selectRes] = await connection.query(`SELECT * FROM ${tableName} WHERE id = ?;`, [insertedId]);
      const fetchedRow = selectRes[0];
      logs.push(`Successfully fetched row: ID ${fetchedRow.id}, Message: "${fetchedRow.message}"`);

      logs.push('Cleaning up: Dropping test table...');
      await connection.query(`DROP TABLE ${tableName};`);
      logs.push('Test table cleaned up successfully.');

      await connection.end();
      const durationMs = Date.now() - startTime;

      return res.json({
        success: true,
        durationMs,
        logs,
        message: 'Write and Read cycle test passed completely!'
      });
    } catch (err) {
      logs.push(`ERROR: ${err.message}`);
      if (connection) {
        try {
          logs.push(`Attempting clean up: dropping table ${tableName} if it exists...`);
          await connection.query(`DROP TABLE IF EXISTS ${tableName};`);
        } catch (cleanupErr) {}
        try { await connection.end(); } catch (e) {}
      }

      return res.status(500).json({
        success: false,
        durationMs: Date.now() - startTime,
        logs,
        error: err.message
      });
    }
  } else if (dbType === 'mssql' || dbType === 'sqlsrv') {
    const sql = require('mssql');
    const dbConfig = {
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      server: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '1433', 10),
      database: process.env.DB_NAME,
      options: {
        encrypt: true,
        trustServerCertificate: true,
      },
      connectionTimeout: 5000,
    };

    let pool;
    try {
      logs.push('Connecting to MSSQL database...');
      pool = await sql.connect(dbConfig);

      logs.push('Creating test table...');
      await pool.request().query(`
        CREATE TABLE ${tableName} (
          id INT IDENTITY(1,1) PRIMARY KEY,
          message VARCHAR(255) NOT NULL,
          created_at DATETIME DEFAULT GETDATE()
        );
      `);

      logs.push('Inserting record into test table...');
      const insertRes = await pool.request()
        .input('msg', sql.VarChar, 'Hello from Cloud Run private network!')
        .query(`INSERT INTO ${tableName} (message) VALUES (@msg); SELECT SCOPE_IDENTITY() AS id;`);
      
      const insertedId = insertRes.recordset[0].id;
      logs.push(`Inserted row ID: ${insertedId}`);

      logs.push('Querying the inserted record back...');
      const selectRes = await pool.request()
        .input('id', sql.Int, insertedId)
        .query(`SELECT * FROM ${tableName} WHERE id = @id;`);
      
      const fetchedRow = selectRes.recordset[0];
      logs.push(`Successfully fetched row: ID ${fetchedRow.id}, Message: "${fetchedRow.message}"`);

      logs.push('Cleaning up: Dropping test table...');
      await pool.request().query(`DROP TABLE ${tableName};`);
      logs.push('Test table cleaned up successfully.');

      await pool.close();
      const durationMs = Date.now() - startTime;

      return res.json({
        success: true,
        durationMs,
        logs,
        message: 'Write and Read cycle test passed completely!'
      });
    } catch (err) {
      logs.push(`ERROR: ${err.message}`);
      if (pool) {
        try {
          logs.push(`Attempting clean up: dropping table ${tableName} if it exists...`);
          await pool.request().query(`IF OBJECT_ID('${tableName}', 'U') IS NOT NULL DROP TABLE ${tableName};`);
        } catch (cleanupErr) {}
        try { await pool.close(); } catch (e) {}
      }

      return res.status(500).json({
        success: false,
        durationMs: Date.now() - startTime,
        logs,
        error: err.message
      });
    }
  } else {
    return res.status(400).json({
      success: false,
      message: `Unsupported DB_TYPE: "${dbType}"`
    });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
