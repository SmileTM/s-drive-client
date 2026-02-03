const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const waitOn = require('wait-on');
const fs = require('fs');

let mainWindow;
let serverProcess;

const SERVER_PORT = 8000; // Must match server/index.js

// Setup Logging
const LOG_PATH = path.join(app.getPath('userData'), 'app.log');
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function log(msg) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] [Main] ${msg}\n`;
  console.log(msg);
  logStream.write(message);
}

function startServer() {
  const serverPath = path.join(__dirname, '../server/index.js');
  log(`Starting server from: ${serverPath}`);
  
  if (!fs.existsSync(serverPath)) {
      log('CRITICAL: Server file not found!');
      return;
  }

  // Start the server as a child process
  serverProcess = fork(serverPath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { 
      ...process.env, 
      NODE_ENV: 'production',
      USER_DATA_PATH: app.getPath('userData'),
      ELECTRON_LOG_PATH: LOG_PATH
    }
  });

  serverProcess.stdout.on('data', (data) => {
    const msg = `[Server] ${data.toString()}`;
    console.log(msg.trim());
    logStream.write(msg);
  });

  serverProcess.stderr.on('data', (data) => {
    const msg = `[Server ERR] ${data.toString()}`;
    console.error(msg.trim());
    logStream.write(msg);
  });

  serverProcess.on('error', (err) => {
      log(`Server failed to start: ${err.message}`);
  });
  
  serverProcess.on('exit', (code, signal) => {
      log(`Server exited with code ${code} and signal ${signal}`);
  });

  log(`Server started with PID: ${serverProcess.pid}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true // Enable DevTools
    },
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 24, y: 24 }, // Position inside the floating sidebar
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../client/assets/icon.png')
  });

  // Use 127.0.0.1 for reliability
  const url = `http://127.0.0.1:${SERVER_PORT}`;

  // Wait for server to be ready before loading URL
  log(`Waiting for ${url}...`);
  waitOn({ resources: [url], timeout: 20000 })
    .then(() => {
      log('Server is ready, loading window...');
      mainWindow.loadURL(url);
      // mainWindow.webContents.openDevTools(); // Optional: Auto-open devtools for debug
    })
    .catch((err) => {
      log(`Server timeout or error: ${err}`);
      // Load error page
      const errorHtml = `
        <html>
        <body style="font-family: sans-serif; padding: 2rem; text-align: center;">
          <h1 style="color: #ef4444;">Application Failed to Start</h1>
          <p>The internal server could not be reached.</p>
          <p style="background: #f1f5f9; padding: 1rem; border-radius: 8px; text-align: left; font-family: monospace;">
            Error: ${err.message}<br/>
            Log: ${LOG_PATH}
          </p>
          <button onclick="location.reload()" style="padding: 10px 20px; cursor: pointer;">Retry</button>
        </body>
        </html>
      `;
      mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorHtml));
    });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.on('ready', () => {
  startServer();
  createWindow();
});

// Quit when all windows are closed.
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
  if (mainWindow === null) createWindow();
});

// Cleanup server process on exit
app.on('before-quit', () => {
  if (serverProcess) {
    console.log('[Electron] Killing server process...');
    serverProcess.kill();
  }
});
