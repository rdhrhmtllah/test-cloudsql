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

// Endpoint to test internet egress (external traffic lookup)
app.get('/api/internet-status', async (req, res) => {
  const startTime = Date.now();
  let status = 'connected';
  let message = 'Internet egress is fully operational!';
  let error = null;

  try {
    const response = await fetch('https://www.google.com', {
      signal: AbortSignal.timeout(5000)
    });
    // If we get any response (even error code from Google), the connection was made!
    if (!response.ok && response.status >= 500) {
      throw new Error(`Google responded with status: ${response.status}`);
    }
  } catch (err) {
    status = 'disconnected';
    message = 'Internet egress is blocked (Could be missing Cloud NAT).';
    error = {
      message: err.message,
      stack: err.stack
    };
  }

  const latencyMs = Date.now() - startTime;
  res.json({
    status,
    latencyMs,
    message,
    error
  });
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
  const logs = [];
  const targetTable = 'cloud_run_connection_logs';

  logs.push(`Starting persistent write test on table: ${targetTable}`);

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

      logs.push(`Ensuring table "${targetTable}" exists...`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${targetTable} (
          id SERIAL PRIMARY KEY,
          message VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      const testMsg = `Connection test write at ${new Date().toLocaleString('id-ID')}`;
      logs.push(`Inserting test record: "${testMsg}"`);
      const insertRes = await client.query(
        `INSERT INTO ${targetTable} (message) VALUES ($1) RETURNING id, message, created_at;`,
        [testMsg]
      );
      const insertedRow = insertRes.rows[0];
      logs.push(`Inserted row ID: ${insertedRow.id}`);

      logs.push('Fetching last 5 entries from the database...');
      const historyRes = await client.query(`SELECT id, message, created_at FROM ${targetTable} ORDER BY id DESC LIMIT 5;`);
      const countRes = await client.query(`SELECT COUNT(*) AS total FROM ${targetTable};`);

      await client.end();
      const durationMs = Date.now() - startTime;
      
      return res.json({
        success: true,
        durationMs,
        logs,
        totalRecords: parseInt(countRes.rows[0].total, 10),
        history: historyRes.rows,
        message: 'Write operation succeeded and persisted in PostgreSQL!'
      });
    } catch (err) {
      logs.push(`ERROR: ${err.message}`);
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

      logs.push(`Ensuring table "${targetTable}" exists...`);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS ${targetTable} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          message VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      const testMsg = `Connection test write at ${new Date().toLocaleString('id-ID')}`;
      logs.push(`Inserting test record: "${testMsg}"`);
      const [insertRes] = await connection.query(
        `INSERT INTO ${targetTable} (message) VALUES (?);`,
        [testMsg]
      );
      const insertedId = insertRes.insertId;
      logs.push(`Inserted row ID: ${insertedId}`);

      logs.push('Fetching last 5 entries from the database...');
      const [historyRows] = await connection.query(`SELECT id, message, created_at FROM ${targetTable} ORDER BY id DESC LIMIT 5;`);
      const [countRows] = await connection.query(`SELECT COUNT(*) AS total FROM ${targetTable};`);

      await connection.end();
      const durationMs = Date.now() - startTime;

      return res.json({
        success: true,
        durationMs,
        logs,
        totalRecords: parseInt(countRows[0].total, 10),
        history: historyRows,
        message: 'Write operation succeeded and persisted in MySQL!'
      });
    } catch (err) {
      logs.push(`ERROR: ${err.message}`);
      if (connection) {
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

      logs.push(`Ensuring table "${targetTable}" exists...`);
      await pool.request().query(`
        IF OBJECT_ID('${targetTable}', 'U') IS NULL 
        CREATE TABLE ${targetTable} (
          id INT IDENTITY(1,1) PRIMARY KEY,
          message VARCHAR(255) NOT NULL,
          created_at DATETIME DEFAULT GETDATE()
        );
      `);

      const testMsg = `Connection test write at ${new Date().toLocaleString('id-ID')}`;
      logs.push(`Inserting test record: "${testMsg}"`);
      const insertRes = await pool.request()
        .input('msg', sql.VarChar, testMsg)
        .query(`INSERT INTO ${targetTable} (message) VALUES (@msg); SELECT SCOPE_IDENTITY() AS id;`);
      
      const insertedId = insertRes.recordset[0].id;
      logs.push(`Inserted row ID: ${insertedId}`);

      logs.push('Fetching last 5 entries from the database...');
      const historyRes = await pool.request().query(`SELECT TOP 5 id, message, created_at FROM ${targetTable} ORDER BY id DESC;`);
      const countRes = await pool.request().query(`SELECT COUNT(*) AS total FROM ${targetTable};`);

      await pool.close();
      const durationMs = Date.now() - startTime;

      return res.json({
        success: true,
        durationMs,
        logs,
        totalRecords: countRes.recordset[0].total,
        history: historyRes.recordset,
        message: 'Write operation succeeded and persisted in SQL Server!'
      });
    } catch (err) {
      logs.push(`ERROR: ${err.message}`);
      if (pool) {
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

// --- DATABASE EXPLORER API ROUTE HANDLERS ---

function sanitizeIdentifier(name) {
  if (!name || typeof name !== 'string') return null;
  const sanitized = name.replace(/[^a-zA-Z0-9_]/g, '');
  return sanitized.length > 0 ? sanitized : null;
}

// Get helper function for DB connections
function getExplorerConfig() {
  return {
    type: (process.env.DB_TYPE || 'postgres').toLowerCase(),
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
  };
}

// 1. GET List of Tables
app.get('/api/explorer/tables', async (req, res) => {
  const conf = getExplorerConfig();
  if (!conf.host || !conf.user || !conf.password || !conf.database) {
    return res.status(400).json({ error: 'Database environment variables are missing.' });
  }

  if (conf.type === 'postgres') {
    const { Client } = require('pg');
    const client = new Client(conf);
    try {
      await client.connect();
      const dbRes = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name;
      `);
      await client.end();
      return res.json({ tables: dbRes.rows.map(r => r.table_name) });
    } catch (err) {
      try { await client.end(); } catch (e) {}
      return res.status(500).json({ error: err.message });
    }
  } else if (conf.type === 'mysql') {
    const mysql = require('mysql2/promise');
    try {
      const conn = await mysql.createConnection(conf);
      const [rows] = await conn.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
        ORDER BY table_name;
      `);
      await conn.end();
      return res.json({ tables: rows.map(r => r.table_name) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else if (conf.type === 'mssql' || conf.type === 'sqlsrv') {
    const sql = require('mssql');
    const mssqlConfig = {
      user: conf.user, password: conf.password, server: conf.host,
      port: conf.port || 1433, database: conf.database,
      options: { encrypt: true, trustServerCertificate: true },
      connectionTimeout: 5000
    };
    try {
      const pool = await sql.connect(mssqlConfig);
      const dbRes = await pool.request().query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_type = 'BASE TABLE' AND table_schema = 'dbo'
        ORDER BY table_name;
      `);
      await pool.close();
      return res.json({ tables: dbRes.recordset.map(r => r.table_name) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    return res.status(400).json({ error: `Unsupported DB_TYPE: "${conf.type}"` });
  }
});

// 2. GET Table columns and data rows
app.get('/api/explorer/table/:table', async (req, res) => {
  const conf = getExplorerConfig();
  const table = sanitizeIdentifier(req.params.table);
  if (!table) return res.status(400).json({ error: 'Invalid table name identifier.' });

  if (conf.type === 'postgres') {
    const { Client } = require('pg');
    const client = new Client(conf);
    try {
      await client.connect();
      // Get columns
      const colsRes = await client.query(`
        SELECT column_name, data_type, is_nullable 
        FROM information_schema.columns 
        WHERE table_name = $1 AND table_schema = 'public'
        ORDER BY ordinal_position;
      `, [table]);

      // Get Primary Key
      const pkRes = await client.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1 AND tc.table_schema = 'public';
      `, [table]);
      const primaryKey = pkRes.rows[0] ? pkRes.rows[0].column_name : null;

      // Get rows
      const dataRes = await client.query(`SELECT * FROM ${table} LIMIT 100;`);
      await client.end();

      return res.json({
        columns: colsRes.rows,
        primaryKey,
        rows: dataRes.rows
      });
    } catch (err) {
      try { await client.end(); } catch (e) {}
      return res.status(500).json({ error: err.message });
    }
  } else if (conf.type === 'mysql') {
    const mysql = require('mysql2/promise');
    try {
      const conn = await mysql.createConnection(conf);
      const [cols] = await conn.query(`
        SELECT column_name, data_type, is_nullable 
        FROM information_schema.columns 
        WHERE table_name = ? AND table_schema = DATABASE()
        ORDER BY ordinal_position;
      `, [table]);

      const [pkRows] = await conn.query(`
        SELECT column_name
        FROM information_schema.key_column_usage
        WHERE table_name = ? AND constraint_name = 'PRIMARY' AND table_schema = DATABASE();
      `, [table]);
      const primaryKey = pkRows[0] ? pkRows[0].column_name : null;

      const [rows] = await conn.query(`SELECT * FROM ${table} LIMIT 100;`);
      await conn.end();

      return res.json({
        columns: cols,
        primaryKey,
        rows
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else if (conf.type === 'mssql' || conf.type === 'sqlsrv') {
    const sql = require('mssql');
    const mssqlConfig = {
      user: conf.user, password: conf.password, server: conf.host,
      port: conf.port || 1433, database: conf.database,
      options: { encrypt: true, trustServerCertificate: true },
      connectionTimeout: 5000
    };
    try {
      const pool = await sql.connect(mssqlConfig);
      // Fetch columns
      const colsRes = await pool.request()
        .input('table', sql.VarChar, table)
        .query(`
          SELECT column_name, data_type, is_nullable 
          FROM information_schema.columns 
          WHERE table_name = @table AND table_schema = 'dbo'
          ORDER BY ordinal_position;
        `);

      // Fetch primary key
      const pkRes = await pool.request()
        .input('table', sql.VarChar, table)
        .query(`
          SELECT col.name AS column_name
          FROM sys.indexes idx
          JOIN sys.index_columns idxCol ON idx.object_id = idxCol.object_id AND idx.index_id = idxCol.index_id
          JOIN sys.columns col ON idxCol.object_id = col.object_id AND idxCol.column_id = col.column_id
          WHERE idx.is_primary_key = 1 AND idx.object_id = OBJECT_ID(@table);
        `);
      const primaryKey = pkRes.recordset[0] ? pkRes.recordset[0].column_name : null;

      // Fetch rows
      const dataRes = await pool.request().query(`SELECT TOP 100 * FROM ${table};`);
      await pool.close();

      return res.json({
        columns: colsRes.recordset,
        primaryKey,
        rows: dataRes.recordset
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
});

// 3. POST Insert Row into Table
app.post('/api/explorer/table/:table/insert', async (req, res) => {
  const conf = getExplorerConfig();
  const table = sanitizeIdentifier(req.params.table);
  const rowData = req.body;
  if (!table) return res.status(400).json({ error: 'Invalid table name identifier.' });

  const columns = Object.keys(rowData).filter(c => sanitizeIdentifier(c) !== null);
  const values = columns.map(c => rowData[c]);

  if (columns.length === 0) {
    return res.status(400).json({ error: 'No data columns provided to insert.' });
  }

  if (conf.type === 'postgres') {
    const { Client } = require('pg');
    const client = new Client(conf);
    try {
      await client.connect();
      const placeHolders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const queryStr = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeHolders});`;
      await client.query(queryStr, values);
      await client.end();
      return res.json({ success: true, message: 'Row inserted successfully!' });
    } catch (err) {
      try { await client.end(); } catch (e) {}
      return res.status(500).json({ error: err.message });
    }
  } else if (conf.type === 'mysql') {
    const mysql = require('mysql2/promise');
    try {
      const conn = await mysql.createConnection(conf);
      const placeHolders = columns.map(() => '?').join(', ');
      const queryStr = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeHolders});`;
      await conn.query(queryStr, values);
      await conn.end();
      return res.json({ success: true, message: 'Row inserted successfully!' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else if (conf.type === 'mssql' || conf.type === 'sqlsrv') {
    const sql = require('mssql');
    const mssqlConfig = {
      user: conf.user, password: conf.password, server: conf.host,
      port: conf.port || 1433, database: conf.database,
      options: { encrypt: true, trustServerCertificate: true },
      connectionTimeout: 5000
    };
    try {
      const pool = await sql.connect(mssqlConfig);
      const request = pool.request();
      
      const placeHolders = columns.map(c => {
        request.input(c, rowData[c]);
        return `@${c}`;
      }).join(', ');

      const queryStr = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeHolders});`;
      await request.query(queryStr);
      await pool.close();
      return res.json({ success: true, message: 'Row inserted successfully!' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
});

// 4. POST Update Row in Table
app.post('/api/explorer/table/:table/update', async (req, res) => {
  const conf = getExplorerConfig();
  const table = sanitizeIdentifier(req.params.table);
  const { primaryKey, pkVal, rowData } = req.body;
  
  if (!table || !primaryKey || pkVal === undefined) {
    return res.status(400).json({ error: 'Missing table identity, primary key column, or row ID value.' });
  }

  const columns = Object.keys(rowData).filter(c => sanitizeIdentifier(c) !== null && c !== primaryKey);
  const values = columns.map(c => rowData[c]);

  if (columns.length === 0) {
    return res.status(400).json({ error: 'No update columns provided.' });
  }

  if (conf.type === 'postgres') {
    const { Client } = require('pg');
    const client = new Client(conf);
    try {
      await client.connect();
      const sets = columns.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const queryStr = `UPDATE ${table} SET ${sets} WHERE ${primaryKey} = $${columns.length + 1};`;
      await client.query(queryStr, [...values, pkVal]);
      await client.end();
      return res.json({ success: true, message: 'Row updated successfully!' });
    } catch (err) {
      try { await client.end(); } catch (e) {}
      return res.status(500).json({ error: err.message });
    }
  } else if (conf.type === 'mysql') {
    const mysql = require('mysql2/promise');
    try {
      const conn = await mysql.createConnection(conf);
      const sets = columns.map(c => `${c} = ?`).join(', ');
      const queryStr = `UPDATE ${table} SET ${sets} WHERE ${primaryKey} = ?;`;
      await conn.query(queryStr, [...values, pkVal]);
      await conn.end();
      return res.json({ success: true, message: 'Row updated successfully!' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else if (conf.type === 'mssql' || conf.type === 'sqlsrv') {
    const sql = require('mssql');
    const mssqlConfig = {
      user: conf.user, password: conf.password, server: conf.host,
      port: conf.port || 1433, database: conf.database,
      options: { encrypt: true, trustServerCertificate: true },
      connectionTimeout: 5000
    };
    try {
      const pool = await sql.connect(mssqlConfig);
      const request = pool.request();

      const sets = columns.map(c => {
        request.input(`val_${c}`, rowData[c]);
        return `${c} = @val_${c}`;
      }).join(', ');

      request.input('pk_val', pkVal);
      const queryStr = `UPDATE ${table} SET ${sets} WHERE ${primaryKey} = @pk_val;`;
      await request.query(queryStr);
      await pool.close();
      return res.json({ success: true, message: 'Row updated successfully!' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
});

// 5. POST Delete Row in Table
app.post('/api/explorer/table/:table/delete', async (req, res) => {
  const conf = getExplorerConfig();
  const table = sanitizeIdentifier(req.params.table);
  const { primaryKey, pkVal } = req.body;

  if (!table || !primaryKey || pkVal === undefined) {
    return res.status(400).json({ error: 'Missing table name, primary key identifier, or key value.' });
  }

  if (conf.type === 'postgres') {
    const { Client } = require('pg');
    const client = new Client(conf);
    try {
      await client.connect();
      const queryStr = `DELETE FROM ${table} WHERE ${primaryKey} = $1;`;
      await client.query(queryStr, [pkVal]);
      await client.end();
      return res.json({ success: true, message: 'Row deleted successfully!' });
    } catch (err) {
      try { await client.end(); } catch (e) {}
      return res.status(500).json({ error: err.message });
    }
  } else if (conf.type === 'mysql') {
    const mysql = require('mysql2/promise');
    try {
      const conn = await mysql.createConnection(conf);
      const queryStr = `DELETE FROM ${table} WHERE ${primaryKey} = ?;`;
      await conn.query(queryStr, [pkVal]);
      await conn.end();
      return res.json({ success: true, message: 'Row deleted successfully!' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else if (conf.type === 'mssql' || conf.type === 'sqlsrv') {
    const sql = require('mssql');
    const mssqlConfig = {
      user: conf.user, password: conf.password, server: conf.host,
      port: conf.port || 1433, database: conf.database,
      options: { encrypt: true, trustServerCertificate: true },
      connectionTimeout: 5000
    };
    try {
      const pool = await sql.connect(mssqlConfig);
      const request = pool.request();
      request.input('pk_val', pkVal);
      const queryStr = `DELETE FROM ${table} WHERE ${primaryKey} = @pk_val;`;
      await request.query(queryStr);
      await pool.close();
      return res.json({ success: true, message: 'Row deleted successfully!' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
});

// 6. POST Create Sample Table
app.post('/api/explorer/create-sample', async (req, res) => {
  const conf = getExplorerConfig();
  const sampleTable = 'test_crud_table';

  if (conf.type === 'postgres') {
    const { Client } = require('pg');
    const client = new Client(conf);
    try {
      await client.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${sampleTable} (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          description VARCHAR(255),
          score INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await client.end();
      return res.json({ success: true, message: `Sample table "${sampleTable}" ensured/created successfully!` });
    } catch (err) {
      try { await client.end(); } catch (e) {}
      return res.status(500).json({ error: err.message });
    }
  } else if (conf.type === 'mysql') {
    const mysql = require('mysql2/promise');
    try {
      const conn = await mysql.createConnection(conf);
      await conn.query(`
        CREATE TABLE IF NOT EXISTS ${sampleTable} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          description VARCHAR(255),
          score INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await conn.end();
      return res.json({ success: true, message: `Sample table "${sampleTable}" ensured/created successfully!` });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else if (conf.type === 'mssql' || conf.type === 'sqlsrv') {
    const sql = require('mssql');
    const mssqlConfig = {
      user: conf.user, password: conf.password, server: conf.host,
      port: conf.port || 1433, database: conf.database,
      options: { encrypt: true, trustServerCertificate: true },
      connectionTimeout: 5000
    };
    try {
      const pool = await sql.connect(mssqlConfig);
      await pool.request().query(`
        IF OBJECT_ID('${sampleTable}', 'U') IS NULL 
        CREATE TABLE ${sampleTable} (
          id INT IDENTITY(1,1) PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          description VARCHAR(255),
          score INT DEFAULT 0,
          created_at DATETIME DEFAULT GETDATE()
        );
      `);
      await pool.close();
      return res.json({ success: true, message: `Sample table "${sampleTable}" ensured/created successfully!` });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
