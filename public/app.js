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

  const btnPing = document.getElementById('btn-ping');
  const btnWrite = document.getElementById('btn-write');
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
    log('Contacting API to deploy dynamic schema...', 'system');

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
          } else if (msg.includes('successfully') || msg.includes('Passed') || msg.includes('Successfully')) {
            log(msg, 'success');
          } else {
            log(msg, 'system');
          }
        });
      }

      if (response.ok && data.success) {
        log(`Lifecycle write check passed! Total Duration: ${data.durationMs}ms`, 'success');
        setStatus('connected', 'Connected');
      } else {
        throw new Error(data.error || 'Write test failed');
      }
    } catch (error) {
      log(`Write lifecycle test failed: ${error.message}`, 'error');
      log('Check your database user permissions. The user needs CREATE, INSERT, SELECT, and DROP privileges in the database.', 'warning');
      setStatus('error', 'Connection Error');
    } finally {
      setButtonsDisabled(false);
    }
  }

  // Event Listeners
  btnPing.addEventListener('click', () => checkConnection(true));
  btnWrite.addEventListener('click', runWriteTest);

  // Initialize
  checkConnection(false);
});
