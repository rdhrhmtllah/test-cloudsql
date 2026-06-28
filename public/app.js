document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const cfgType = document.getElementById('cfg-type');
  const cfgHost = document.getElementById('cfg-host');
  const cfgPort = document.getElementById('cfg-port');
  const cfgDatabase = document.getElementById('cfg-database');
  const cfgUser = document.getElementById('cfg-user');
  const cfgPassword = document.getElementById('cfg-password');

  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const latencyText = document.getElementById('latency-text');

  const internetDot = document.getElementById('internet-dot');
  const internetText = document.getElementById('internet-text');
  const internetLatency = document.getElementById('internet-latency');

  const btnPing = document.getElementById('btn-ping');
  const btnWrite = document.getElementById('btn-write');
  const btnInternet = document.getElementById('btn-internet');
  const btnClearConsole = document.getElementById('btn-clear-console');
  const terminalScreen = document.getElementById('terminal-screen');

  // Helper: Log message to UI terminal
  function log(message, type = 'system') {
    const line = document.createElement('div');
    line.className = `line ${type}-line`;
    
    // Prefix based on type
    let prefix = '';
    if (type === 'system') prefix = '[SYSTEM] ';
    if (type === 'success') prefix = '[SUCCESS] ';
    if (type === 'error') prefix = '[ERROR] ';
    if (type === 'warning') prefix = '[WARN] ';
    if (type === 'input') prefix = '$ ';

    line.textContent = `${prefix}${message}`;
    terminalScreen.appendChild(line);
    terminalScreen.scrollTop = terminalScreen.scrollHeight;
  }

  // Helper: Clear terminal
  btnClearConsole.addEventListener('click', () => {
    terminalScreen.innerHTML = '';
    log('Console cleared.', 'system');
  });

  // Set visual status indicator
  function setStatus(status, label) {
    statusDot.className = 'status-dot'; // Reset
    if (status === 'connected') {
      statusDot.classList.add('status-connected');
    } else if (status === 'unconfigured') {
      statusDot.classList.add('status-unconfigured');
    } else if (status === 'error') {
      statusDot.classList.add('status-error');
    } else {
      statusDot.classList.add('status-checking');
    }
    statusText.textContent = label;
  }

  // Disable/Enable interactive buttons
  function setButtonsDisabled(disabled) {
    btnPing.disabled = disabled;
    btnWrite.disabled = disabled;
    btnInternet.disabled = disabled;
  }

  // Load status and check connection (READ test)
  async function checkConnection(isManual = false) {
    setButtonsDisabled(true);
    if (isManual) {
      log('Triggered connectivity check...', 'input');
    } else {
      log('Autostart connection test initiated...', 'system');
    }

    setStatus('checking', 'Connecting...');
    latencyText.textContent = '-- ms';

    try {
      const response = await fetch('/api/db-status');
      const data = await response.json();

      // Display config info (even if unconfigured)
      cfgType.textContent = (data.config.type || 'postgres').toUpperCase();
      cfgHost.textContent = data.config.host;
      cfgPort.textContent = data.config.port;
      cfgDatabase.textContent = data.config.database;
      cfgUser.textContent = data.config.user;
      cfgPassword.textContent = data.config.passwordProvided ? 'Provided (Yes)' : 'Not Configured (No)';

      if (data.status === 'unconfigured') {
        setStatus('unconfigured', 'Unconfigured');
        log('Database environment variables are missing. Please define DB_HOST, DB_USER, DB_PASS, and DB_NAME.', 'warning');
      } else if (data.status === 'connected') {
        setStatus('connected', 'Connected');
        latencyText.textContent = `${data.latencyMs} ms`;
        log(`Connected successfully! Ping query returned time: ${data.queryResult.time}`, 'success');
        log(`Database Version: ${data.queryResult.version}`, 'system');
      } else {
        // Fallback for API error return without throwing
        throw new Error(data.message || 'Unknown server response');
      }
    } catch (error) {
      setStatus('error', 'Connection Error');
      log('Database connection failed.', 'error');
      
      // Attempt to retrieve detailed API error if response was JSON
      try {
        // If we received an actual server error structure with logs/details
        const errResp = await fetch('/api/db-status');
        if (!errResp.ok) {
          const errData = await errResp.json();
          if (errData.error) {
            log(`Message: ${errData.error.message}`, 'error');
            if (errData.error.code) log(`Code: ${errData.error.code}`, 'error');
            if (errData.error.hint) log(`Hint: ${errData.error.hint}`, 'warning');
            if (errData.error.stack) {
              log('Stack trace summary:', 'system');
              log(errData.error.stack.split('\n')[0], 'system');
            }
            return;
          }
        }
      } catch (innerErr) {}
      
      log(`${error.message}`, 'error');
      log('Troubleshooting tips: Ensure your Cloud Run service is connected to a Serverless VPC Connector or has Direct VPC egress enabled, and that your SQL Instance accepts connections from that network (or has its private IP configured correctly).', 'warning');
    } finally {
      setButtonsDisabled(false);
    }
  }

  // Execute full cycle write test
  async function runWriteTest() {
    setButtonsDisabled(true);
    log('Triggered read/write lifecycle test...', 'input');
    log('Contacting API to execute database write test...', 'system');

    try {
      const response = await fetch('/api/db-test-write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();

      // Print server logs line by line
      if (data.logs && Array.isArray(data.logs)) {
        data.logs.forEach(msg => {
          if (msg.startsWith('ERROR:')) {
            log(msg, 'error');
          } else if (msg.includes('successfully') || msg.includes('Passed') || msg.includes('Successfully') || msg.includes('succeeded')) {
            log(msg, 'success');
          } else {
            log(msg, 'system');
          }
        });
      }

      if (response.ok && data.success) {
        log(`Write lifecycle check passed! Total Duration: ${data.durationMs}ms`, 'success');
        if (data.totalRecords !== undefined) {
          log(`Total records in table 'cloud_run_connection_logs': ${data.totalRecords}`, 'success');
        }
        if (data.history && Array.isArray(data.history)) {
          log('--- Last 5 entries currently in table ---', 'system');
          data.history.forEach(row => {
            log(`[ID: ${row.id}] ${row.message} (${new Date(row.created_at).toLocaleString('id-ID')})`, 'system');
          });
          log('----------------------------------------', 'system');
        }
        setStatus('connected', 'Connected');
      } else {
        throw new Error(data.error || 'Write test failed');
      }
    } catch (error) {
      log(`Write lifecycle test failed: ${error.message}`, 'error');
      log('Check your database user permissions. The user needs CREATE TABLE, INSERT, and SELECT privileges in the database.', 'warning');
      setStatus('error', 'Connection Error');
    } finally {
      setButtonsDisabled(false);
    }
  }

  // Test internet egress connectivity
  async function testInternetEgress(isManual = false) {
    setButtonsDisabled(true);
    if (isManual) {
      log('Triggered internet egress check to google.com...', 'input');
    } else {
      log('Autostart internet egress test (google.com) initiated...', 'system');
    }

    // Set checking state
    internetDot.className = 'status-dot status-checking';
    internetText.textContent = 'Testing Egress...';
    internetLatency.textContent = '-- ms';

    try {
      const response = await fetch('/api/internet-status');
      const data = await response.json();

      if (data.status === 'connected') {
        internetDot.className = 'status-dot status-connected';
        internetText.textContent = 'Connected';
        internetLatency.textContent = `${data.latencyMs} ms`;
        log(`Internet Egress Test Passed! Successfully reached google.com (Latency: ${data.latencyMs}ms)`, 'success');
      } else {
        throw new Error(data.message || 'Egress check returned offline');
      }
    } catch (error) {
      internetDot.className = 'status-dot status-error';
      internetText.textContent = 'Blocked';
      internetLatency.textContent = '-- ms';

      log('Internet egress to google.com is blocked!', 'error');
      
      // Try to fetch error logs from backend response
      try {
        const errResp = await fetch('/api/internet-status');
        if (!errResp.ok) {
          const errData = await errResp.json();
          if (errData.error) {
            log(`Message: ${errData.error.message}`, 'error');
          }
        }
      } catch (e) {}

      log('Troubleshooting tips: Since your Cloud Run is connected to a VPC, and if you configured "--vpc-egress=all-traffic", you MUST set up a Cloud NAT in your VPC Network. Without Cloud NAT, any outbound request to the public internet will fail.', 'warning');
    } finally {
      setButtonsDisabled(false);
    }
  }

  // --- DATABASE EXPLORER CLIENT-SIDE SCRIPTING ---

  // Bindings
  const btnCreateSample = document.getElementById('btn-create-sample');
  const tablesSelect = document.getElementById('tables-select');
  const btnRefreshTables = document.getElementById('btn-refresh-tables');

  const explorerWelcome = document.getElementById('explorer-welcome');
  const explorerContent = document.getElementById('explorer-content');
  const rowsCount = document.getElementById('rows-count');
  const btnAddRow = document.getElementById('btn-add-row');

  const explorerGrid = document.getElementById('explorer-grid');
  const gridHeaderRow = document.getElementById('grid-header-row');
  const gridBody = document.getElementById('grid-body');

  const crudModal = document.getElementById('crud-modal');
  const modalTitle = document.getElementById('modal-title');
  const btnCloseModal = document.getElementById('btn-close-modal');
  const btnCancelModal = document.getElementById('btn-cancel-modal');
  const btnSaveModal = document.getElementById('btn-save-modal');
  const crudForm = document.getElementById('crud-form');
  const modalPkVal = document.getElementById('modal-pk-val');

  // State
  let activeTableName = '';
  let activeTableColumns = [];
  let activePrimaryKey = null;

  // A. Fetch and load tables list
  async function loadTablesList() {
    log('Fetching list of tables in database...', 'system');
    try {
      const response = await fetch('/api/explorer/tables');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to fetch tables list');

      // Populate select list
      const previousSelection = tablesSelect.value;
      tablesSelect.innerHTML = '<option value="">Select a table...</option>';
      
      if (data.tables && data.tables.length > 0) {
        data.tables.forEach(tbl => {
          const opt = document.createElement('option');
          opt.value = tbl;
          opt.textContent = tbl;
          tablesSelect.appendChild(opt);
        });
        
        // Restore previous selection if still exists
        if (data.tables.includes(previousSelection)) {
          tablesSelect.value = previousSelection;
        }
        log(`Loaded ${data.tables.length} tables from the database.`, 'success');
      } else {
        log('No custom tables found in this database. Click "Create Sample Table" to start.', 'warning');
      }
    } catch (err) {
      log(`Failed to list tables: ${err.message}`, 'error');
    }
  }

  // B. Load selected table metadata and rows
  async function loadTableData(tableName) {
    if (!tableName) {
      explorerContent.style.display = 'none';
      explorerWelcome.style.display = 'block';
      return;
    }

    log(`Loading structure and rows for table "${tableName}"...`, 'system');
    activeTableName = tableName;

    try {
      const response = await fetch(`/api/explorer/table/${tableName}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to fetch table data');

      activeTableColumns = data.columns || [];
      activePrimaryKey = data.primaryKey;
      log(`Primary key identified: ${activePrimaryKey || 'None (Read-Only)'}`, 'system');

      // Render Table Headers
      gridHeaderRow.innerHTML = '';
      
      // First column is always Actions if Primary Key is found
      const actionsTh = document.createElement('th');
      actionsTh.textContent = 'Actions';
      actionsTh.style.width = '120px';
      gridHeaderRow.appendChild(actionsTh);

      activeTableColumns.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col.column_name;
        gridHeaderRow.appendChild(th);
      });

      // Render Table Rows
      gridBody.innerHTML = '';
      if (data.rows && data.rows.length > 0) {
        rowsCount.textContent = `Showing ${data.rows.length} rows (limit 100)`;
        
        data.rows.forEach(row => {
          const tr = document.createElement('tr');
          
          // Action buttons cell
          const actionTd = document.createElement('td');
          const pkVal = activePrimaryKey ? row[activePrimaryKey] : null;

          if (activePrimaryKey && pkVal !== null) {
            const btnWrap = document.createElement('div');
            btnWrap.className = 'action-buttons-wrap';

            const editBtn = document.createElement('button');
            editBtn.className = 'btn btn-secondary btn-sm';
            editBtn.textContent = '✏️';
            editBtn.title = 'Edit Row';
            editBtn.addEventListener('click', () => openCrudModal(row));

            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-danger-sm btn-sm';
            delBtn.textContent = '🗑️';
            delBtn.title = 'Delete Row';
            delBtn.addEventListener('click', () => deleteRecord(pkVal));

            btnWrap.appendChild(editBtn);
            btnWrap.appendChild(delBtn);
            actionTd.appendChild(btnWrap);
          } else {
            actionTd.textContent = 'N/A';
          }
          tr.appendChild(actionTd);

          // Data cells
          activeTableColumns.forEach(col => {
            const td = document.createElement('td');
            const val = row[col.column_name];
            
            if (val === null) {
              td.innerHTML = '<em style="color:#6b7280;">NULL</em>';
            } else if (typeof val === 'object') {
              td.textContent = JSON.stringify(val);
            } else {
              td.textContent = val;
            }
            tr.appendChild(td);
          });
          gridBody.appendChild(tr);
        });
      } else {
        rowsCount.textContent = 'Table is empty';
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = activeTableColumns.length + 1;
        td.style.textAlign = 'center';
        td.style.padding = '2rem';
        td.innerHTML = '<em style="color:#6b7280;">No records found. Click "Add New Row" to insert.</em>';
        tr.appendChild(td);
        gridBody.appendChild(tr);
      }

      // Toggle display
      explorerWelcome.style.display = 'none';
      explorerContent.style.display = 'block';
      log(`Rendered data for table "${tableName}" successfully.`, 'success');
    } catch (err) {
      log(`Failed to load table details: ${err.message}`, 'error');
    }
  }

  // C. Open Add/Edit Modal
  function openCrudModal(row = null) {
    crudForm.innerHTML = '';
    
    if (row === null) {
      // INSERT Mode
      modalTitle.textContent = `Insert into ${activeTableName}`;
      modalPkVal.value = '';
      
      activeTableColumns.forEach(col => {
        // Skip auto-generating serial/identity ID columns from form
        const isAutoId = col.column_name.toLowerCase() === 'id' && (col.data_type.includes('serial') || col.data_type.includes('int'));
        if (isAutoId) return;

        createFormField(col.column_name, col.data_type, '');
      });
    } else {
      // UPDATE Mode
      const pkVal = row[activePrimaryKey];
      modalTitle.textContent = `Edit row in ${activeTableName} (${activePrimaryKey} = ${pkVal})`;
      modalPkVal.value = pkVal;

      activeTableColumns.forEach(col => {
        // Render PK as read-only, others as editable
        const isPk = col.column_name === activePrimaryKey;
        createFormField(col.column_name, col.data_type, row[col.column_name], isPk);
      });
    }

    crudModal.style.display = 'flex';
  }

  // Helper to generate dynamic inputs inside modal
  function createFormField(name, type, val, readOnly = false) {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.textContent = `${name} (${type})`;
    group.appendChild(label);

    const input = document.createElement('input');
    input.name = name;
    input.id = `field-${name}`;
    input.className = 'form-input';
    input.value = val !== null ? val : '';
    
    // Choose input type
    const lowType = type.toLowerCase();
    if (lowType.includes('int') || lowType.includes('number') || lowType.includes('numeric')) {
      input.type = 'number';
    } else if (lowType.includes('date') || lowType.includes('time')) {
      input.type = 'datetime-local';
      // Format ISO string to match datetime-local format (YYYY-MM-DDThh:mm)
      if (val) {
        try {
          const dateObj = new Date(val);
          input.value = dateObj.toISOString().slice(0, 16);
        } catch (e) {}
      }
    } else {
      input.type = 'text';
    }

    if (readOnly) {
      input.readOnly = true;
      input.style.opacity = '0.5';
    }

    group.appendChild(input);
    crudForm.appendChild(group);
  }

  // D. Save Modal Form (Insert / Update)
  async function saveRecord() {
    const inputs = crudForm.querySelectorAll('.form-input');
    const rowData = {};
    
    inputs.forEach(input => {
      if (input.readOnly) return; // Skip read-only/primary key
      rowData[input.name] = input.value === '' ? null : input.value;
    });

    const pkVal = modalPkVal.value;
    const isUpdate = pkVal !== '';
    const url = `/api/explorer/table/${activeTableName}/${isUpdate ? 'update' : 'insert'}`;
    const payload = isUpdate 
      ? { primaryKey: activePrimaryKey, pkVal, rowData } 
      : rowData;

    log(`Saving record to table "${activeTableName}"...`, 'system');
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to save record');

      log(data.message || 'Saved successfully.', 'success');
      crudModal.style.display = 'none';
      await loadTableData(activeTableName);
    } catch (err) {
      log(`Failed to save record: ${err.message}`, 'error');
    }
  }

  // E. Delete Record
  async function deleteRecord(pkVal) {
    if (!confirm(`Are you sure you want to delete this row (where ${activePrimaryKey} = ${pkVal})?`)) return;

    log(`Deleting row from table "${activeTableName}"...`, 'system');
    try {
      const response = await fetch(`/api/explorer/table/${activeTableName}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryKey: activePrimaryKey, pkVal })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to delete record');

      log(data.message || 'Row deleted.', 'success');
      await loadTableData(activeTableName);
    } catch (err) {
      log(`Failed to delete record: ${err.message}`, 'error');
    }
  }

  // F. Create Sample Table
  async function createSampleTable() {
    log('Requesting backend to deploy sample table "test_crud_table"...', 'system');
    try {
      const response = await fetch('/api/explorer/create-sample', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to create sample table');

      log(data.message || 'Sample table created successfully!', 'success');
      await loadTablesList();
      tablesSelect.value = 'test_crud_table';
      await loadTableData('test_crud_table');
    } catch (err) {
      log(`Failed to create sample table: ${err.message}`, 'error');
    }
  }

  // Event Listeners for Explorer
  btnRefreshTables.addEventListener('click', loadTablesList);
  tablesSelect.addEventListener('change', (e) => loadTableData(e.target.value));
  btnCreateSample.addEventListener('click', createSampleTable);
  btnAddRow.addEventListener('click', () => openCrudModal(null));

  // Modal Closers
  btnCloseModal.addEventListener('click', () => crudModal.style.display = 'none');
  btnCancelModal.addEventListener('click', () => crudModal.style.display = 'none');
  btnSaveModal.addEventListener('click', saveRecord);

  // Close modal when clicking outside overlay
  window.addEventListener('click', (e) => {
    if (e.target === crudModal) crudModal.style.display = 'none';
  });

  // Event Listeners for diagnostics
  btnPing.addEventListener('click', () => checkConnection(true));
  btnWrite.addEventListener('click', runWriteTest);
  btnInternet.addEventListener('click', () => testInternetEgress(true));

  // Initialize
  checkConnection(false);
  testInternetEgress(false);
  loadTablesList();
});
