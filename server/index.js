const express = require('express');
const { v2: webdavServer } = require('webdav-server');
const { createClient } = require('webdav');
const SMB2 = require('@marsaud/smb2');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const mime = require('mime-types');
const multer = require('multer');
const util = require('util');
const { promisify } = util;
let sharp;
try {
    sharp = require('sharp');
} catch (e) {
    console.warn('[WARN] Sharp module not found or failed to load. Image processing disabled.', e.message);
}
const { encrypt, decrypt } = require('./utils/crypto');
const { EventEmitter } = require('events');
const { Transform, Readable } = require('stream');

const app = express();
app.use(cors());
app.use(express.json());

const progressEmitter = new EventEmitter();
const activeSmbStreams = new Map(); // stream -> smbPath
// V9.29 The Eternal Lane: Persistent Connection & Global Mutex
const streamingStatCache = new Map(); // path -> { size, mtime, expires }
let streamingRequestLock = Promise.resolve();
let lastPreviewStream = null;

// --- Progress Tracking Helper (V9.6 Smooth-Hyper ported to Node.js) ---
function createProgressStream(taskId, totalSize) {
    if (!taskId) return new Transform({ transform(c, e, cb) { this.push(c); cb(); } });

    let uploaded = 0;
    let lastUpdate = Date.now();
    let lastUploaded = 0;
    let smoothedSpeed = 0;
    let chunkCount = 0;

    const transferStartTime = Date.now();
    return new Transform({
        transform(chunk, encoding, callback) {
            uploaded += chunk.length;
            chunkCount++;
            const now = Date.now();

            // Smoothing logic for progress stream speed calculation
            if (now - lastUpdate >= 1000) {
                const dt = (now - lastUpdate) / 1000;
                const instantSpeed = (uploaded - lastUploaded) / dt;
                const totalDt = (now - transferStartTime) / 1000;
                const avgSpeed = (uploaded / totalDt);

                if (smoothedSpeed === 0) {
                    smoothedSpeed = instantSpeed;
                } else {
                    smoothedSpeed = (smoothedSpeed * 0.7) + (instantSpeed * 0.3);
                }

                const mbps = (instantSpeed / (1024 * 1024)).toFixed(2);
                const avgMbps = (uploaded / (1024 * 1024) / totalDt).toFixed(2);
                // Chunk progress log removed for cleaner console

                progressEmitter.emit('progress', {
                    id: taskId,
                    uploaded,
                    total: totalSize,
                    speed: Math.round(smoothedSpeed)
                });
                lastUpdate = now;
                lastUploaded = uploaded;
            }
            this.push(chunk);
            callback();
        },
        flush(callback) {
            const totalDt = (Date.now() - transferStartTime) / 1000;
            const finalAvgSpeed = (uploaded / totalDt);
            console.log(`[PERF][${taskId}] Completed. 真·全程落地均速: ${Math.round(finalAvgSpeed / (1024 * 1024))} MB/s (耗时: ${Math.round(totalDt)}s)`);
            progressEmitter.emit('progress', {
                id: taskId,
                uploaded,
                total: totalSize,
                speed: 0
            });
            callback();
        }
    });

}

const activeTasks = new Map(); // taskId -> { cancel: Function }

/**
 * TurboSMBReadStream: A high-performance concurrent reading stream for SMB.
 * Bypasses the 10MB/s sequential limit by issuing multiple parallel READ requests.
 */
class TurboSMBReadStream extends Readable {
    constructor(clients, smbPath, fileSize, options = {}) {
        const highWaterMark = 512 * 1024 * 1024; // 512MB Katana Buffer (High Frequency)
        super({ highWaterMark });
        this.clients = Array.isArray(clients) ? clients : [clients]; // Multi-Lane Support
        this.smbPath = smbPath;
        this.fileSize = fileSize;
        this.chunkSize = options.chunkSize || 1024 * 1024; // 1MB Accurate Chunks
        this.concurrency = 128; // Katana Safe Bound
        this.clientIndex = 0; // Round-robin lane selector
        this.startOffset = options.start || 0;
        this.endOffset = (options.end !== undefined) ? options.end : fileSize - 1;

        this.currentReadPos = this.startOffset;
        this.nextPushPos = this.startOffset;
        this.activeRequests = 0;
        this.finished = false;
        this.bufferMap = new Map(); // pos -> buffer
        this.destroyed_flag = false;
        this.fileHandles = []; this.laneInFlight = []; // One handle per client (lane)
        this.opening = false;
        this.currentConcurrency = 24; // V9.20 Katana-Start (3 lanes * 8 reqs)
        this.fetchedInCurrentCycle = 0;

        // Performance metrics (Real-time Delta)
        this.startTime = Date.now();
        this.lastLogTime = Date.now();
        this.lastTotalFetched = 0;
        this.totalFetched = 0;
        this.chunkCount = 0;
        this.inFlightCount = 0; // V9.31: Global IO Tracker
    }

    async _read() {
        if (this.finished || this.destroyed_flag) return;

        // 1. Try to push any buffered data
        this._tryPush();

        // 2. Schedule more fetches
        this._pump();
    }

    async ignite() {
        if (this.opening || this.fileHandles.length > 0 || this.destroyed_flag) return;
        this.opening = true;
        try {
            const results = [];
            for (let i = 0; i < this.clients.length; i++) {
                if (this.destroyed_flag) break;
                const handle = await executeSMBCommand(this.clients[i], () => {
                    console.log(`[${new Date().toLocaleTimeString()}][TURBO][V9.32] [SMB_OPEN] ${path.basename(this.smbPath)}`);
                    return this.clients[i].openP(this.smbPath, 'r');
                }, 20000);
                results.push(handle);
            }
            this.fileHandles = results.filter(h => h !== null);
            this.clients = this.clients.filter((_, idx) => results[idx] !== null);
            if (this.fileHandles.length === 0) throw new Error('All SMB lanes failed to ignite');
        } finally {
            this.opening = false;
        }
    }

    // V9.31: Graceful Shutdown (Wait for IO to drain)
    async shutdown() {
        if (this.destroyed_flag) return;
        this.destroyed_flag = true;
        const shutdownId = Math.random().toString(36).slice(-4);
        console.log(`[${new Date().toLocaleTimeString()}][TURBO][V9.31] [SHUTDOWN_START] ${shutdownId} (In-Flight: ${this.inFlightCount})`);

        // 1. Wait for mid-air IO packets to land (Max 2s timeout)
        const timeout = Date.now() + 2000;
        while (this.inFlightCount > 0 && Date.now() < timeout) {
            await new Promise(r => setTimeout(r, 50));
        }

        if (this.inFlightCount > 0) console.warn(`[TURBO][V9.31] [SHUTDOWN_WARN] Forced shutdown while ${this.inFlightCount} IOs still pending`);

        // 2. Physical Clean up
        await this._physicalCleanup();
        console.log(`[${new Date().toLocaleTimeString()}][TURBO][V9.31] [SHUTDOWN_OK] ${shutdownId}`);
    }

    async _physicalCleanup() {
        this.bufferMap.clear();
        if (this.fileHandles.length > 0) {
            const closePromises = this.fileHandles.map((handle, idx) => {
                const client = this.clients[idx];
                if (client && handle) {
                    console.log(`[${new Date().toLocaleTimeString()}][TURBO][V9.31] [SMB_CLOSE] Handle ${handle}`);
                    return executeSMBCommand(client, () => client.close(handle)).catch(() => { });
                }
            });
            await Promise.all(closePromises);
            this.fileHandles = [];
        }
    }

    _destroy(err, callback) {
        this.destroyed_flag = true;
        this.bufferMap.clear();
        // Fire and forget physical cleanup if not already called via shutdown
        this._physicalCleanup().finally(() => super._destroy(err, callback));
    }

    async _pump() {
        if (this.finished || this.destroyed_flag || this.opening) return;

        try {
            if (this.fileHandles.length === 0) {
                // If not ignited yet, _read will call _pump again, or we wait for manual ignite
                return;
            }
            // Fill pipeline
            let started = 0;
            const maxBuffered = this.concurrency * 2;
            // V9.13: Use currentConcurrency for Ramping
            while (this.activeRequests < this.currentConcurrency &&
                this.bufferMap.size < maxBuffered &&
                this.currentReadPos <= this.endOffset) {
                const pos = this.currentReadPos;
                const size = Math.min(this.chunkSize, this.endOffset - pos + 1);
                this.currentReadPos += size;
                this.activeRequests++;
                started++;

                // Track when this was queued for diagnosis
                const dispatchTime = Date.now();
                this._fetchChunk(pos, size, dispatchTime);
            }
            if (started > 0) {
                // Queue dispatch log silenced
            }
        } catch (err) {
            console.error(`[${new Date().toLocaleTimeString()}][TURBO][ERR-FATAL] _pump fail:`, err);
            this.opening = false;
            this.destroy(err);
        }
    }

    async _fetchChunk(pos, size, dispatchTime) {
        if (this.destroyed_flag) return; // Early exit if stream is destroyed

        const startTime = Date.now();
        const queueTime = startTime - dispatchTime;

        // Select next lane (client) and its corresponding handle
        // Ensure clientIndex wraps around and only selects active lanes
        let laneIdx = -1;
        let client = null;
        let handle = null;

        // Find an active lane
        for (let i = 0; i < this.clients.length; i++) {
            const potentialIdx = (this.clientIndex + i) % this.clients.length;
            if (this.fileHandles[potentialIdx]) {
                laneIdx = potentialIdx;
                client = this.clients[laneIdx];
                handle = this.fileHandles[laneIdx];
                this.clientIndex = (laneIdx + 1) % this.clients.length; // Move to next for round-robin
                break;
            }
        }

        if (!client || !handle) {
            // All lanes are dead or no handles available, this should not happen if _pump checks this.clients.length
            // But as a safeguard, destroy the stream.
            console.error(`[${new Date().toLocaleTimeString()}] [TURBO][ERR] No active SMB lanes available for read at offset ${pos}.`);
            this.activeRequests--;
            this.destroy(new Error('No active SMB lanes available.'));
            return;
        }

        try {
            if (this.chunkCount % 10 === 0) {
                console.log(`[TURBO][V9.32] [IO_START] Pos: ${pos} | Lane: ${laneIdx} | Slot: ${this.activeRequests}/${this.concurrency}`);
            }
            const buf = Buffer.allocUnsafe(size);
            this.inFlightCount++; // TRACK IO
            const bytesRead = await client.readP(handle, buf, 0, size, pos);
            this.inFlightCount--; // LAND IO
            const execTime = Date.now() - startTime; this.laneInFlight[laneIdx]--;
            if (this.destroyed_flag) return;

            const safeBytesRead = bytesRead || 0;
            this.bufferMap.set(pos, (safeBytesRead === size) ? buf : buf.subarray(0, safeBytesRead));
            this.activeRequests--;
            this.totalFetched += safeBytesRead;
            this.chunkCount++;

            if (this.chunkCount % 10 === 0) {
                console.log(`[TURBO][V9.32] [IO_OK] Pos: ${pos} | Bytes: ${safeBytesRead} | Time: ${execTime}ms`);
            }

            // V9.31 Katana ACC Engine
            const rtt = Date.now() - startTime;
            if (rtt > 2500) {
                this.currentConcurrency = Math.max(24, Math.floor(this.currentConcurrency - 8));
            } else if (rtt < 1200) {
                this.fetchedInCurrentCycle++;
                if (this.fetchedInCurrentCycle >= 4) {
                    this.currentConcurrency = Math.min(this.concurrency, this.currentConcurrency + 1);
                    this.fetchedInCurrentCycle = 0;
                }
            }

            const now = Date.now();
            if (now - this.lastLogTime >= 1000) {
                const sessionDt = (now - this.startTime) / 1000;
                const sessionAvg = (this.totalFetched / (1024 * 1024) / sessionDt).toFixed(2);
                const dt = (now - this.lastLogTime) / 1000;
                const instantSpeed = ((this.totalFetched - this.lastTotalFetched) / (1024 * 1024) / dt).toFixed(2);
                if (this.chunkCount % 15 === 0) {
                    console.log(`[${new Date().toLocaleTimeString()}][TURBO][V9.31.1] S: ${instantSpeed}MB/s (均速: ${sessionAvg}MB/s) | Net: ${execTime}ms | P: ${this.currentConcurrency} | Buf: ${this.bufferMap.size}`);
                }

                this.lastLogTime = now;
                this.lastTotalFetched = this.totalFetched;
            }

            this._tryPush();
            this._pump();
        } catch (err) {
            // Silenced closing errors
            if (this.destroyed_flag && (
                err.code === 'STATUS_FILE_CLOSED' ||
                err.message?.includes('STATUS_FILE_CLOSED') ||
                err.code === 'ERR_SOCKET_CLOSED_BEFORE_CONNECTION'
            )) return;

            console.error(`[${new Date().toLocaleTimeString()}][TURBO][IO-ERR] Offset ${pos} (Exec: ${Date.now() - startTime}ms):`, err.message);
            this.activeRequests--;
            if (!this.destroyed_flag) this.destroy(err);
        }
    }

    _tryPush() {
        if (this.destroyed_flag) return;

        let pushedCount = 0;
        while (this.bufferMap.has(this.nextPushPos)) {
            const buffer = this.bufferMap.get(this.nextPushPos);
            this.bufferMap.delete(this.nextPushPos);

            const size = buffer.length;
            this.nextPushPos += size;

            const canContinue = this.push(buffer);
            pushedCount++;

            if (this.nextPushPos > this.endOffset) {
                this.finished = true;
                this.push(null);
                // EOF reached silently
                break;
            }

            if (!canContinue) {
                console.log(`[${new Date().toLocaleTimeString()}] [TURBO][BACKPRESSURE] Local consumer buffer full. Pausing push at ${Math.floor(this.nextPushPos / (1024 * 1024))}MB`);
                break;
            }
        }

        // If we are stuck waiting for a specific chunk
        if (pushedCount === 0 && this.bufferMap.size > 0 && !this.finished) {
            const available = Array.from(this.bufferMap.keys()).sort((a, b) => a - b);
            // console.log(`[${new Date().toLocaleTimeString()}] [TURBO][STATUS] Waiting for offset: ${this.nextPushPos}. Buffers ready: ${available.length} | First ready: ${available[0]}`);
        }
    }

    _destroy(err, callback) {
        this.destroyed_flag = true;
        this.bufferMap.clear();

        // V9.30: Accurate Handle Cleanup with Logs
        if (this.fileHandles.length > 0) {
            this.fileHandles.forEach((handle, idx) => {
                const client = this.clients[idx];
                if (client && handle) {
                    console.log(`[${new Date().toLocaleTimeString()}][TURBO][V9.30] [SMB_CLOSE] Handle ${handle} on Lane ${idx}`);
                    executeSMBCommand(client, () => client.close(handle))
                        .catch(e => console.warn(`[SMB Turbo] Failed to close handle:`, e.message));
                }
            });
            this.fileHandles = [];
        }

        super._destroy(err, callback);
    }
}

app.post('/api/cancel', (req, res) => {
    const { taskId } = req.body;
    if (activeTasks.has(taskId)) {
        console.log(`[API] Cancelling task ${taskId}`);
        const task = activeTasks.get(taskId);
        if (task && typeof task.cancel === 'function') {
            task.cancel();
        }
        activeTasks.delete(taskId);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Task not found or already completed' });
    }
});

const PORT = process.env.PORT || 8000;
const STORAGE_DIR = os.homedir(); // Default to User Home directory
const APP_DATA_DIR = process.env.USER_DATA_PATH || path.join(os.homedir(), '.webdav-client');
const CONFIG_FILE = path.join(APP_DATA_DIR, 'drives.json');

// --- Progress SSE Endpoint ---
app.get('/api/progress-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const onProgress = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    progressEmitter.on('progress', onProgress);

    req.on('close', () => {
        progressEmitter.off('progress', onProgress);
    });
});

// --- Drive Helper: Get Client for Drive ---
const getDriveConfig = async (driveId) => {
    const drives = await fs.readJson(CONFIG_FILE);
    const drive = drives.find(d => d.id === driveId) || drives[0];
    // Decrypt password for internal use
    if (drive.password) {
        drive.password = decrypt(drive.password);
    }
    return drive;
};

const getWebDAVClient = (config) => {
    return createClient(config.url.trim(), {
        username: config.username,
        password: config.password, // Config already has decrypted password
        headers: {
            // Jianguoyun and some other WebDAV servers block unknown/empty User-Agents
            // Mimic a standard client or just be explicit
            'User-Agent': 'WebDavClient/1.0.0 (Electron)'
        }
    });
};

// Global SMB Cache
const smbClients = new Map();

const getSMBClient = (config, options = {}) => {
    // config.address: "192.168.1.100" or "192.168.1.100:445"
    // config.share: "Public"
    let address = config.address;
    let port = config.port;

    // Extract port from address if present (e.g. "192.168.1.100:4455")
    if (!port && typeof address === 'string' && address.includes(':')) {
        const parts = address.split(':');
        if (parts.length === 2 && !isNaN(parseInt(parts[1], 10))) {
            address = parts[0];
            port = parseInt(parts[1], 10);
        }
    }

    const cleanShare = config.share ? config.share.replace(/^[\/\\]+|[\/\\]+$/g, '') : '';
    const { tag = 'default', ...smbOptions } = options;
    const isDedicated = Object.keys(smbOptions).length > 0;

    const createClientInstance = () => {
        const client = new SMB2({
            share: `\\\\${address}\\${cleanShare}`,
            domain: config.domain || '',
            username: config.username,
            password: config.password,
            port: port,
            packetConcurrency: 4096, // Hyper-Turbo V8.0: Massive 4096 to prevent internal packet queuing
            autoCloseTimeout: 0,
            ...smbOptions
        });

        // Promisify essential methods to ensure await works correctly
        client.existsP = promisify(client.exists).bind(client);
        client.statP = promisify(client.stat).bind(client);
        client.openP = promisify(client.open).bind(client);
        client.readP = promisify(client.read).bind(client);
        client.closeP = promisify(client.close).bind(client);
        client.readdirP = promisify(client.readdir).bind(client);
        client.unlinkP = promisify(client.unlink).bind(client);
        client.rmdirP = promisify(client.rmdir).bind(client);
        client.mkdirP = promisify(client.mkdir).bind(client);
        client.renameP = promisify(client.rename).bind(client);
        client.createWriteStreamP = promisify(client.createWriteStream).bind(client);
        client.createReadStreamP = promisify(client.createReadStream).bind(client);

        return client;
    };

    if (isDedicated) return createClientInstance();

    const key = `${address}|${cleanShare}|${config.username}|${config.password}|${tag}`;
    if (!smbClients.has(key)) {
        smbClients.set(key, createClientInstance());
    }
    return smbClients.get(key);
};

// Helper: Clear SMB Session (Disconnect cached clients to release locks)
const clearSMBSession = (config) => {
    let address = config.address;
    if (typeof address === 'string' && address.includes(':')) {
        const parts = address.split(':');
        if (parts.length === 2 && !isNaN(parseInt(parts[1], 10))) {
            address = parts[0];
        }
    }
    const cleanShare = config.share ? config.share.replace(/^[\/\\]+|[\/\\]+$/g, '') : '';
    // Prefix matches all tags (default, preview, etc.)
    const prefix = `${address}|${cleanShare}|${config.username}|${config.password}|`;

    for (const [key, client] of smbClients.entries()) {
        if (key.startsWith(prefix)) {
            // Session clearing silenced
            try { client.disconnect(); } catch (e) { }
            smbClients.delete(key);
        }
    }
};

// Helper: Clear SMB by Tag (for isolated streaming lanes)
const clearSMBByTag = (tagPart) => {
    for (const [key, client] of smbClients.entries()) {
        if (key.includes(`|${tagPart}_lane`)) {
            try { client.disconnect(); } catch (e) { }
            smbClients.delete(key);
        }
    }
};

// Helper: Ensure SMB Client is connected (Singleton Connection Promise)
const ensureSMBConnected = async (client) => {
    if (client.connected) return;
    if (client._connectPromise) {
        await client._connectPromise;
        return;
    }

    client._connectPromise = (async () => {
        try {
            // Probe logs silenced
            await client.statP('');
            client.connected = true;
            // Probe logs silenced
        } catch (e) {
            // If server responds with STATUS_ error, it's alive and authenticated.
            const isAlive = e.code === 'EISCONN' || (e.code && (e.code.startsWith('STATUS_') || e.code.startsWith('NT_STATUS_')));
            if (isAlive) {
                // Probe logs silenced
                client.connected = true;
                return;
            }
            console.warn(`[SMB][PROBE] Warn: ${e.code || e.message}`);
        }
    })();

    try {
        await client._connectPromise;
    } finally {
        client._connectPromise = null;
    }
};

const RETRY_ERRORS = [
    'EPIPE',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENOTFOUND',
    'STATUS_NETWORK_NAME_DELETED',
    'STATUS_USER_SESSION_DELETED',
    'STATUS_CONNECTION_DISCONNECTED',
    'STATUS_FILE_CLOSED',
    'STATUS_SHARING_VIOLATION'
];

// Helper: Execute SMB Command with Retry
const executeSMBCommand = async (client, commandFn, timeoutMs = 0) => {
    const run = async () => {
        if (timeoutMs > 0) {
            return Promise.race([
                commandFn(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('SMB Command Timeout')), timeoutMs))
            ]);
        }
        return commandFn();
    };

    try {
        await ensureSMBConnected(client);
        return await run();
    } catch (err) {
        const isRetryable = RETRY_ERRORS.some(code =>
            err.code === code ||
            (err.message && err.message.includes(code))
        );

        if (isRetryable || err.message === 'SMB Command Timeout') {
            console.log(`[SMB Retry] Error (${err.code || err.message}), reconnecting...`);
            // Force disconnect/reset state
            try { client.disconnect(); } catch (e) { }
            // V9.32: 400ms Backoff before retry to let server recover its TCP stack
            await new Promise(r => setTimeout(r, 400));
            // Retry once
            try {
                await ensureSMBConnected(client);
                return await commandFn();
            } catch (retryErr) {
                console.error('[SMB Retry Fail] Hard resetting session cache.', retryErr.message);
                // V9.31: If retry fails, we MUST kill the cache for this client to force a fresh TCP start
                for (const [key, c] of smbClients.entries()) {
                    if (c === client) {
                        try { c.disconnect(); } catch (e) { }
                        smbClients.delete(key);
                        break;
                    }
                }
                throw retryErr;
            }
        }
        throw err;
    }
};

// Helper: Normalize file info for frontend
const normalizeFile = (file, driveId, type = 'webdav') => {
    if (type === 'smb') {
        // SMB2 stats structure handled separately or here if object passed
        return {
            name: file.name,
            path: file.name, // SMB returns name relative to listed folder usually, parent context needed for full path?
            isDirectory: file.isDirectory(),
            size: file.size,
            mtime: file.mtime || file.ctime || file.birthtime || new Date(0),
            type: file.isDirectory() ? 'folder' : mime.lookup(file.name) || 'application/octet-stream'
        };
    }
    return {
        name: file.basename || path.basename(file.filename),
        path: file.filename, // Remote paths are already relative to its root
        isDirectory: file.type === 'directory',
        size: file.size || 0,
        mtime: file.lastmod,
        type: file.type === 'directory' ? 'folder' : mime.lookup(file.filename) || 'application/octet-stream'
    };
};

// Helper: SMB Path Normalizer
const toSMBPath = (p) => {
    return p.replace(/^\/+/, '').replace(/\//g, '\\');
};


const registerSmbStream = (smbPath, stream) => {
    if (!stream || !smbPath) return;
    activeSmbStreams.set(stream, smbPath);
    const cleanup = () => activeSmbStreams.delete(stream);
    stream.once('close', cleanup);
    stream.once('end', cleanup);
    stream.once('error', cleanup);
};

const closeActiveSmbStreamsForPaths = (items) => {
    if (!Array.isArray(items) || items.length === 0) return;
    const targets = items.map(p => toSMBPath(p));
    for (const [stream, smbPath] of activeSmbStreams.entries()) {
        const shouldClose = targets.some(target => {
            if (!target) return false;
            if (smbPath === target) return true;
            return smbPath.startsWith(target + '\\');
        });
        if (shouldClose) {
            try { stream.destroy(); } catch (e) { }
            activeSmbStreams.delete(stream);
        }
    }
};

const isDeletePending = (err) => err && (err.code === 'STATUS_DELETE_PENDING' || err.message?.includes('STATUS_DELETE_PENDING'));

const isNotFound = (err) =>
    err &&
    (err.code === 'STATUS_OBJECT_NAME_NOT_FOUND' ||
        err.code === 'STATUS_NO_SUCH_FILE' ||
        err.message?.includes('STATUS_OBJECT_NAME_NOT_FOUND') ||
        err.message?.includes('STATUS_NoSuchFile'));

const isNotDir = (err) =>
    err &&
    (err.code === 'STATUS_NOT_A_DIRECTORY' ||
        err.code === 'STATUS_FILE_IS_A_DIRECTORY' ||
        err.message?.includes('Not a directory'));

const isDirNotEmpty = (err) =>
    err && (err.code === 'STATUS_DIRECTORY_NOT_EMPTY' || err.message?.includes('STATUS_DIRECTORY_NOT_EMPTY'));

const verifyItemsDeletedSMB = async (config, items) => {
    const client = getSMBClient(config, { forceNew: true, autoCloseTimeout: 0, packetConcurrency: 1, tag: 'verify' });
    try {
        for (const item of items) {
            const smbPath = toSMBPath(item);
            try {
                await executeSMBCommand(client, () => client.stat(smbPath));
                // If stat succeeds, it still exists
                return false;
            } catch (err) {
                if (isNotFound(err) || isDeletePending(err)) {
                    continue;
                }
                // Unknown error, treat as not verified
                return false;
            }
        }
        return true;
    } finally {
        try { client.disconnect(); } catch (e) { }
    }
};

async function deleteDirContentsSMB(client, dirPath) {
    let items = [];
    try {
        items = await executeSMBCommand(client, () => client.readdir(dirPath));
        items = items.filter(name => name !== '.' && name !== '..');
    } catch (err) {
        if (isNotFound(err) || isDeletePending(err)) return;
        throw err;
    }

    for (const item of items) {
        const itemPath = dirPath === '\\' ? item : `${dirPath}\\${item}`;
        await deletePathSMB(client, itemPath);
    }
}

async function deletePathSMB(client, smbPath) {
    try {
        await executeSMBCommand(client, () => client.rmdir(smbPath));
        return;
    } catch (err) {
        if (isDeletePending(err) || isNotFound(err)) return;
        if (isDirNotEmpty(err)) {
            await deleteDirContentsSMB(client, smbPath);
            try {
                await executeSMBCommand(client, () => client.rmdir(smbPath));
                return;
            } catch (err2) {
                if (isDeletePending(err2) || isNotFound(err2)) return;
            }
        }
    }

    try {
        await executeSMBCommand(client, () => client.unlink(smbPath));
    } catch (err) {
        if (isDeletePending(err) || isNotFound(err)) return;
        if (err.code === 'STATUS_FILE_IS_A_DIRECTORY') {
            await deleteDirContentsSMB(client, smbPath);
            await executeSMBCommand(client, () => client.rmdir(smbPath));
            return;
        }
        throw err;
    }
}


// Helper: Safe path resolution for Local
const resolveSafePath = (userPath) => {
    // Remove leading slashes to ensure it's relative
    const safeSuffix = path.normalize(userPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    const absolutePath = path.resolve(STORAGE_DIR, safeSuffix);
    if (!absolutePath.startsWith(STORAGE_DIR)) {
        throw new Error('Access denied: Path traversal detected');
    }
    return absolutePath;
};

// --- Drives API ---
app.get('/api/drives', async (req, res) => {
    let drives = [];
    try {
        drives = await fs.readJson(CONFIG_FILE);
    } catch (e) {
        drives = [{ id: 'local', name: 'Local Storage', type: 'local', path: './storage' }];
    }

    try {
        const drivesWithQuota = await Promise.all(drives.map(async (drive) => {
            // Decrypt for quota check (internal connection)
            const internalDrive = { ...drive };
            if (internalDrive.password) {
                internalDrive.password = decrypt(internalDrive.password);
            }

            // Prepare public drive object (NO PASSWORD)
            const publicDrive = { ...drive };
            delete publicDrive.password; // Remove password from response

            try {
                const withTimeout = (promise, ms) => Promise.race([
                    promise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
                ]);

                if (internalDrive.type === 'webdav') {
                    const client = getWebDAVClient(internalDrive);
                    const quota = await withTimeout(client.getQuota(), 2000);
                    if (quota && quota.used !== undefined && quota.available !== undefined) {
                        const used = parseInt(quota.used, 10) || 0;
                        const available = parseInt(quota.available, 10) || 0;
                        return { ...publicDrive, quota: { used, total: used + available } };
                    }
                } else if (internalDrive.type === 'local') {
                    const stats = await fs.statfs(STORAGE_DIR);
                    const total = stats.blocks * stats.bsize;
                    const available = stats.bfree * stats.bsize;
                    return { ...publicDrive, quota: { used: total - available, total } };
                } else if (internalDrive.type === 'smb') {
                    // SMB Quota not easily available via basic client
                    return { ...publicDrive, quota: null };
                }
            } catch (e) { }
            return { ...publicDrive, quota: null };
        }));

        // Log without sensitive
        res.json(drivesWithQuota);
    } catch (err) {
        // Fallback: strip passwords even on error
        const safeDrives = drives.map(d => {
            const safe = { ...d };
            delete safe.password;
            return safe;
        });
        res.json(safeDrives);
    }
});

const crypto = require('crypto');

app.post('/api/drives', async (req, res) => {
    try {
        const newDrive = req.body;
        // Don't log password!
        const logSafeDrive = { ...newDrive, password: '***' };

        let drives = [];
        try {
            drives = await fs.readJson(CONFIG_FILE);
            if (!Array.isArray(drives)) throw new Error('Not an array');
        } catch (e) {
            drives = [{ id: 'local', name: 'Local Storage', type: 'local', path: './storage' }];
        }

        // Check for duplicates (URL + Username) or (Address + Share + Username)
        const isDuplicate = drives.some(d => {
            if (d.type === 'webdav' && newDrive.type === 'webdav') {
                return d.url === newDrive.url && d.username === newDrive.username;
            }
            if (d.type === 'smb' && newDrive.type === 'smb') {
                return d.address === newDrive.address && d.share === newDrive.share && d.username === newDrive.username;
            }
            return false;
        });

        if (isDuplicate) {
            console.warn('[WARN] Duplicate Drive');
            return res.status(409).json({ error: 'This drive account is already added' });
        }

        // Check for Duplicate Name
        if (drives.some(d => d.name === newDrive.name)) {
            return res.status(409).json({ error: 'Display Name is already taken' });
        }

        // Encrypt Password
        if (newDrive.password) {
            newDrive.password = encrypt(newDrive.password);
        }

        // Assign reliable ID
        newDrive.id = crypto.randomUUID();

        drives.push(newDrive);
        await fs.writeJson(CONFIG_FILE, drives, { spaces: 2 });

        // Return safe object (no password or masked)
        const safeResponse = { ...newDrive };
        delete safeResponse.password;
        res.json(safeResponse);
    } catch (err) {
        console.error('[ERROR] Add Drive Failed:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/drives/test', async (req, res) => {
    try {
        const config = req.body;

        if (config.type === 'smb') {
            const client = getSMBClient(config);
            const files = await client.readdir(''); // Root
            res.json({ success: true, count: files.length });
        } else {
            // WebDAV
            const client = createClient(config.url, {
                username: config.username,
                password: config.password
            });
            await client.getDirectoryContents('/'); // Try to list root
            res.json({ success: true });
        }
    } catch (err) {
        console.error('[Drive Test Failed]', err);
        if (err.code === 'STATUS_BAD_NETWORK_NAME') {
            return res.status(400).json({ error: 'Share Name Not Found', details: `The share '${config.share}' does not exist on this host. Check the name in Finder/Explorer.` });
        }
        res.status(400).json({ error: 'Connection failed', details: err.message });
    }
});

app.delete('/api/drives/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (id === 'local') return res.status(400).json({ error: 'Cannot delete local drive' });

        const drives = await fs.readJson(CONFIG_FILE);
        const newDrives = drives.filter(d => d.id !== id);
        await fs.writeJson(CONFIG_FILE, newDrives, { spaces: 2 });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/drives/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Name required' });

        const drives = await fs.readJson(CONFIG_FILE);
        const driveIndex = drives.findIndex(d => d.id === id);
        if (driveIndex === -1) return res.status(404).json({ error: 'Drive not found' });

        // Check duplicate name (excluding self)
        if (drives.some(d => d.name === name && d.id !== id)) {
            return res.status(409).json({ error: 'Display Name is already taken' });
        }

        drives[driveIndex].name = name;
        // Password remains
        await fs.writeJson(CONFIG_FILE, drives, { spaces: 2 });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/files?path=/&drive=local
app.get('/api/files', async (req, res) => {
    try {
        const { path: reqPath = '/', drive: driveId = 'local' } = req.query;
        const config = await getDriveConfig(driveId);
        if (!config) return res.status(404).json({ error: 'Drive config not found' });

        if (config.type === 'local') {
            const absolutePath = resolveSafePath(reqPath);
            const safePath = path.relative(STORAGE_DIR, absolutePath); // Return relative path

            const allFiles = await fs.readdir(absolutePath);
            // Filter out hidden files
            const files = allFiles.filter(f => !f.startsWith('.'));

            const fileList = await Promise.all(files.map(async file => {
                const fullPath = path.join(absolutePath, file);
                const relPath = path.join('/', safePath, file); // Ensure absolute Web path
                const stats = await fs.stat(fullPath);

                let itemCount = undefined;
                if (stats.isDirectory()) {
                    try {
                        const children = await fs.readdir(fullPath);
                        itemCount = children.filter(c => !c.startsWith('.')).length;
                    } catch (e) { itemCount = 0; }
                }

                return {
                    name: file,
                    path: relPath, // Return consistent path format
                    isDirectory: stats.isDirectory(),
                    size: stats.size,
                    mtime: stats.mtime,
                    itemCount: itemCount,
                    type: stats.isDirectory() ? 'folder' : mime.lookup(fullPath) || 'application/octet-stream'
                };
            }));
            res.json({ path: safePath, files: fileList });
        } else if (config.type === 'smb') {
            const client = getSMBClient(config);
            // Strip leading slashes for SMB
            const smbPath = toSMBPath(reqPath);

            try {
                const listWithClient = async (targetClient) => {
                    // Use stats=true to avoid per-item stat calls (less load, fewer locks).
                    const rawItems = await executeSMBCommand(
                        targetClient,
                        () => targetClient.readdir(smbPath, { stats: true }),
                        10000
                    );
                    // Hide legacy trash folder from older versions
                    return rawItems.filter(item => item.name !== '.__webdavclient_trash__');
                };

                let names;
                try {
                    names = await listWithClient(client);
                } catch (listErr) {
                    // If the cached client is in a bad state, clear and retry once with a fresh connection
                    if (listErr.code === 'ERR_SOCKET_CLOSED_BEFORE_CONNECTION' || listErr.message?.includes('Socket closed before the connection was established')) {
                        clearSMBSession(config);
                        const freshClient = getSMBClient(config, { forceNew: true, autoCloseTimeout: 0, packetConcurrency: 2, tag: 'list' });
                        try {
                            names = await listWithClient(freshClient);
                        } finally {
                            try { freshClient.disconnect(); } catch (e) { }
                        }
                    } else {
                        throw listErr;
                    }
                }

                const results = names.map((item) => {
                    const name = item.name;
                    const webPath = path.posix.join(reqPath, name);
                    const isDir = typeof item.isDirectory === 'function' ? item.isDirectory() : false;
                    return {
                        name,
                        path: webPath,
                        isDirectory: isDir,
                        size: item.size || 0,
                        mtime: item.mtime || item.ctime || item.birthtime || new Date(0),
                        type: isDir ? 'folder' : mime.lookup(name) || 'application/octet-stream'
                    };
                });

                res.json({
                    path: reqPath,
                    files: results
                });
            } catch (smbErr) {
                console.error('SMB List Error:', smbErr);
                res.status(502).json({ error: `SMB Error: ${smbErr.message}` });
            }

        } else {
            // WebDAV Proxy
            const client = getWebDAVClient(config);
            try {
                const items = await client.getDirectoryContents(reqPath);
                res.json({
                    path: reqPath,
                    files: items.map(item => normalizeFile(item, driveId))
                });
            } catch (proxyErr) {
                console.error('WebDAV Proxy Error:', proxyErr.message);
                // Return 502 Bad Gateway to indicate upstream failure
                res.status(502).json({ error: `WebDAV Error: ${proxyErr.message}` });
            }
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/search
app.get('/api/search', async (req, res) => {
    try {
        const { query, drive: driveId = 'local', path: searchPath = '/' } = req.query;
        if (!query) return res.json([]);

        const config = await getDriveConfig(driveId);
        if (!config) return res.status(404).json({ error: 'Drive config not found' });

        if (config.type === 'local') {
            const absoluteRoot = resolveSafePath(searchPath);
            const results = [];

            // Helper for recursive search
            const walk = async (dir) => {
                if (results.length >= 100) return; // Limit results
                try {
                    const files = await fs.readdir(dir, { withFileTypes: true });
                    for (const file of files) {
                        if (file.name.startsWith('.')) continue;
                        if (results.length >= 100) break;

                        const fullPath = path.join(dir, file.name);

                        if (file.name.toLowerCase().includes(query.toLowerCase())) {
                            const relPath = path.relative(STORAGE_DIR, fullPath);
                            results.push({
                                name: file.name,
                                path: '/' + relPath.split(path.sep).join('/'),
                                isDirectory: file.isDirectory(),
                                size: 0, // Skip stat for speed
                                mtime: 0,
                                type: file.isDirectory() ? 'folder' : mime.lookup(file.name) || 'application/octet-stream'
                            });
                        }

                        if (file.isDirectory()) {
                            await walk(fullPath);
                        }
                    }
                } catch (e) {
                    // Ignore access errors
                }
            };

            await walk(absoluteRoot);
            res.json(results);
        } else if (config.type === 'smb') {
            // SMB Search - Shallow only for now
            const client = getSMBClient(config);
            const smbPath = toSMBPath(searchPath);
            const names = await executeSMBCommand(client, () => client.readdir(smbPath));
            const matches = names.filter(n => n.toLowerCase().includes(query.toLowerCase()));
            const results = matches.map(name => ({
                name,
                path: path.posix.join(searchPath, name),
                isDirectory: false, // Don't know without stat
                size: 0,
                mtime: new Date(0),
                type: mime.lookup(name) || 'application/octet-stream'
            }));
            res.json(results);

        } else {
            // WebDAV Search (Naive)
            const client = getWebDAVClient(config);
            const items = await client.getDirectoryContents(searchPath);
            const results = items
                .filter(item => item.basename.toLowerCase().includes(query.toLowerCase()))
                .map(item => normalizeFile(item, driveId));
            res.json(results);
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/raw (Serve file)
app.get('/api/raw', async (req, res) => {
    try {
        const { path: reqPath, drive: driveId = 'local' } = req.query;
        if (!reqPath) return res.status(400).send('Path required');
        const config = await getDriveConfig(driveId);

        if (config.type === 'local') {
            res.sendFile(resolveSafePath(reqPath));
        } else if (config.type === 'smb') {
            const smbPath = toSMBPath(reqPath);

            // V9.29 The Eternal Lane: Strict Persistent Serialization
            await (streamingRequestLock = streamingRequestLock.then(async () => {
                const streamId = 'str_' + Date.now().toString(36).slice(-5) + '_' + Math.floor(Math.random() * 1000);
                console.log(`[${new Date().toLocaleTimeString()}][TURBO][V9.31] [LOCK_ENTER] ${streamId} for ${path.basename(reqPath)}`);

                // 1. Forced Shutdown & Session Purge (V9.32 The Absolute Zero)
                if (lastPreviewStream && !lastPreviewStream.destroyed) {
                    console.log(`[${new Date().toLocaleTimeString()}][TURBO][V9.32] [SINGLE_IGNITION] Purging previous session...`);
                    await lastPreviewStream.shutdown();
                    // V9.32: Physical kill of the TCP session to ensure a clean slate
                    clearSMBByTag('streaming');
                    // Massive 1000ms Gap to allow the router to completely clear handles/socket tables
                    await new Promise(r => setTimeout(r, 1000));
                }

                // 2. Persistent Client Retrieval (Ghost-Protocol v2.1)
                // We further restrict packetConcurrency to 4 for total safety
                const primaryClient = getSMBClient(config, { tag: 'streaming', packetConcurrency: 4 });
                const lanes = [primaryClient];

                try {
                    // 3. Stat Cache: High efficiency metadata
                    let stats = streamingStatCache.get(smbPath);
                    if (!stats || stats.expires < Date.now()) {
                        console.log(`[TURBO][V9.31] [STAT_FETCH] ${streamId}`);
                        stats = await executeSMBCommand(primaryClient, () => primaryClient.statP(smbPath));
                        streamingStatCache.set(smbPath, { ...stats, expires: Date.now() + 30000 });
                    }

                    const fileSize = stats.size;
                    const lastModified = stats.mtime;
                    const range = req.headers.range;
                    let options = {};

                    if (range) {
                        const parts = range.replace(/bytes=/, "").split("-");
                        const start = parseInt(parts[0], 10);
                        const end = parts[1] ? parseInt(parts[1], 10) : undefined;
                        options.start = start;
                        if (end) options.end = end;
                        const finalEnd = end || (fileSize - 1);
                        const chunksize = (finalEnd - start) + 1;

                        res.status(206);
                        res.setHeader('Content-Range', `bytes ${start}-${finalEnd}/${fileSize}`);
                        res.setHeader('Content-Length', chunksize);
                    } else {
                        res.setHeader('Content-Length', fileSize);
                    }

                    res.setHeader('Accept-Ranges', 'bytes');
                    if (lastModified) res.setHeader('Last-Modified', new Date(lastModified).toUTCString());

                    const mimeType = mime.lookup(reqPath) || 'application/octet-stream';
                    res.setHeader('Content-Type', mimeType);

                    // Reduced concurrency for the stream itselt to keep pressure low (1-Lane)
                    const stream = new TurboSMBReadStream(lanes, smbPath, fileSize, { ...options, concurrency: 8 });

                    // V9.30: THE SYNC IGNITION. Wait for handles inside the LOCK.
                    await stream.ignite();
                    lastPreviewStream = stream; // Track globally

                    registerSmbStream(smbPath, stream);

                    let backpressureCount = 0;
                    res.on('drain', () => {
                        backpressureCount++;
                        if (backpressureCount % 20 === 0) console.log(`[PERF][SMB-TURBO] Stream Drain (Backpressure) x${backpressureCount}`);
                    });

                    stream.on('error', (err) => {
                        if (err.code === 'STATUS_FILE_CLOSED' || err.message?.includes('STATUS_FILE_CLOSED')) return;
                        console.error('SMB Turbo Stream Error', err);
                    });

                    const diagStream = createProgressStream('DIAG_RAW_' + Date.now(), fileSize);
                    stream.pipe(diagStream).pipe(res);

                    res.on('close', () => {
                        if (!stream.finished) {
                            stream.destroy();
                            // No timeout here, we let the NEXT request handle the cooldown in the lock
                        }
                    });
                } catch (e) {
                    console.warn(`[${new Date().toLocaleTimeString()}][TURBO][V9.32] [SERIAL_SETUP_FAIL] ${streamId}:`, e.message);
                    // V9.32: Critical session recovery
                    clearSMBByTag('streaming');
                    if (!res.headersSent) res.status(500).send(e.message);
                    else res.end();
                } finally {
                    console.log(`[${new Date().toLocaleTimeString()}][TURBO][V9.32] [LOCK_RELEASE] ${streamId}`);
                }
            }).catch(err => console.error('[TURBO] Global Queue Critical Error', err)));
        } else {
            const client = getWebDAVClient(config);

            const options = {
                method: 'GET',
                headers: {},
                responseType: 'stream',
            };

            // Forward Range Header
            if (req.headers.range) {
                options.headers['Range'] = req.headers.range;
            }

            try {
                const response = await client.customRequest(reqPath, options);

                const getHeader = (key) => {
                    if (response.headers && typeof response.headers.get === 'function') {
                        return response.headers.get(key);
                    }
                    return response.headers ? (response.headers[key] || response.headers[key.toLowerCase()]) : null;
                };

                res.status(response.status);

                const forwardHeaders = [
                    'content-type',
                    'content-length',
                    'content-range',
                    'accept-ranges',
                    'last-modified',
                    'etag',
                    'cache-control'
                ];

                forwardHeaders.forEach(key => {
                    const val = getHeader(key);
                    if (val) {
                        res.setHeader(key, val);
                    }
                });

                if (response.status === 206 && !res.getHeader('accept-ranges')) {
                    res.setHeader('Accept-Ranges', 'bytes');
                }

                let stream = response.body || response.data;
                if (!stream) throw new Error('No response stream available');

                if (!getHeader('content-type')) {
                    const fileName = path.basename(reqPath);
                    const mimeType = mime.lookup(fileName) || 'application/octet-stream';
                    res.setHeader('Content-Type', mimeType);
                }

                if (typeof stream.pipe !== 'function') {
                    try {
                        const { Readable } = require('stream');
                        if (Readable.fromWeb) {
                            stream = Readable.fromWeb(stream);
                        }
                    } catch (e) {
                        console.warn('[Raw] Failed to convert WebStream:', e);
                    }
                }

                if (typeof stream.pipe === 'function') {
                    stream.pipe(res);
                    stream.on('error', (streamErr) => {
                        console.error('Upstream Stream Error:', streamErr);
                    });
                } else {
                    console.error('[Raw] Response is not a stream');
                    res.status(500).send('Upstream response is not a stream');
                }

            } catch (err) {
                if (err.response) {
                    res.status(err.response.status);
                    const errHeaders = ['content-range', 'content-length', 'content-type'];
                    errHeaders.forEach(key => {
                        if (err.response.headers[key]) res.setHeader(key, err.response.headers[key]);
                    });

                    if (err.response.data && typeof err.response.data.pipe === 'function') {
                        err.response.data.pipe(res);
                    } else {
                        res.send(err.message);
                    }
                } else {
                    console.error('[WebDAV Raw Error]', err.message);
                    res.status(502).send('Proxy Error: ' + err.message);
                }
            }
        }
    } catch (err) {
        console.error('[Raw API Error]', err);
        if (!res.headersSent) res.status(500).send(err.message);
    }
});

// GET /api/preview (Image Preview & Conversion)
app.get('/api/preview', async (req, res) => {
    try {
        const { path: reqPath, drive: driveId = 'local' } = req.query;
        if (!reqPath) return res.status(400).send('Path required');
        const config = await getDriveConfig(driveId);

        const fileName = path.basename(reqPath);
        const isHeic = /\.(heic|heif)$/i.test(fileName);

        // Setup Source Stream
        let inputStream;
        if (config.type === 'local') {
            const absPath = resolveSafePath(reqPath);
            if (!fs.existsSync(absPath)) return res.status(404).send('File not found');
            inputStream = fs.createReadStream(absPath);
        } else if (config.type === 'smb') {
            const client = getSMBClient(config, { tag: 'preview' });
            const smbPath = toSMBPath(reqPath);
            try {
                inputStream = await executeSMBCommand(client, () => client.createReadStream(smbPath));
                registerSmbStream(smbPath, inputStream);
            } catch (e) {
                if (e.code === 'STATUS_OBJECT_PATH_NOT_FOUND' || e.code === 'STATUS_OBJECT_NAME_NOT_FOUND') {
                    return res.status(404).send('File not found');
                }
                throw e;
            }
        } else {
            const client = getWebDAVClient(config);
            inputStream = client.createReadStream(reqPath);
        }

        inputStream.on('error', (err) => {
            if (err.code === 'STATUS_FILE_CLOSED' || err.message?.includes('STATUS_FILE_CLOSED')) return;
            console.error('[Preview Stream Error]', err);
            if (!res.headersSent) res.status(500).end();
        });

        if (isHeic && sharp) {
            res.setHeader('Content-Type', 'image/jpeg');
            const transform = sharp().toFormat('jpeg', { quality: 80 });
            inputStream.pipe(transform).pipe(res);
        } else {
            const mimeType = mime.lookup(fileName) || 'application/octet-stream';
            res.setHeader('Content-Type', mimeType);
            inputStream.pipe(res);
        }

    } catch (err) {
        console.error('[Preview API Error]', err);
        if (!res.headersSent) res.status(500).send(err.message);
    }
});


// POST /api/mkdir
app.post('/api/mkdir', async (req, res) => {
    let dedicatedClient = null;
    try {
        const { path: reqPath, drive: driveId = 'local' } = req.body;
        const config = await getDriveConfig(driveId);

        if (config.type === 'local') {
            const absPath = resolveSafePath(reqPath);
            await fs.ensureDir(absPath);
        } else if (config.type === 'smb') {
            // Clear cached sessions to release any potential locks
            clearSMBSession(config);

            // Use dedicated client for Write ops to prevent affecting read ops on shared connection
            dedicatedClient = getSMBClient(config, { forceNew: true });
            const client = dedicatedClient;
            const smbPath = toSMBPath(reqPath);

            // Retry loop to handle race condition where folder is still "deleting"
            let attempts = 0;
            while (true) {
                try {
                    await executeSMBCommand(client, () => client.mkdir(smbPath));
                    break;
                } catch (err) {
                    if ((err.code === 'STATUS_OBJECT_NAME_COLLISION' || err.code === 'STATUS_DELETE_PENDING') && attempts < 15) {
                        console.log(`[Mkdir SMB] Collision/Pending detected for ${smbPath}, retrying... (${attempts + 1}/15)`);
                        await new Promise(r => setTimeout(r, 500));
                        attempts++;
                    } else {
                        throw err;
                    }
                }
            }
        } else {
            const client = getWebDAVClient(config);
            await client.createDirectory(reqPath);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Mkdir Error]', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (dedicatedClient) dedicatedClient.disconnect();
    }
});

// Helper: Recursive SMB Delete (Parallelized with Batching)
const rmDirRecursiveSMB = async (client, dirPath, config = null) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 1. List all children first
    let items = [];
    try {
        items = await executeSMBCommand(client, () => client.readdir(dirPath));
        // Filter out . and .. if they exist (though smb2 usually handles this, it's safer)
        items = items.filter(name => name !== '.' && name !== '..');
    } catch (err) {
        if (err.code === 'STATUS_OBJECT_NAME_NOT_FOUND' || err.code === 'STATUS_DELETE_PENDING') return;
        throw err;
    }

    // Helper: Wait for item to disappear
    const waitForDeletion = async (targetClient, itemPath) => {
        const deadline = Date.now() + 10000; // Wait up to 10s for delete-pending to resolve
        let delay = 200;
        while (Date.now() < deadline) {
            try {
                await executeSMBCommand(targetClient, () => targetClient.stat(itemPath));
                // If stat succeeds, it still exists
                await sleep(delay);
            } catch (e) {
                // If stat fails with Not Found, it's gone!
                if (e.code === 'STATUS_OBJECT_NAME_NOT_FOUND' || e.code === 'STATUS_NO_SUCH_FILE') {
                    return true;
                }
                // If still pending or other error, wait
                await sleep(delay);
            }
            if (delay < 2000) delay += 200;
        }
        // Final sanity check via a fresh SMB session (helps with stale handles)
        if (config) {
            try {
                const freshClient = getSMBClient(config, { autoCloseTimeout: 0, packetConcurrency: 2, forceNew: true, tag: 'delete' });
                try {
                    await executeSMBCommand(freshClient, () => freshClient.stat(itemPath));
                } catch (freshErr) {
                    if (freshErr.code === 'STATUS_OBJECT_NAME_NOT_FOUND' || freshErr.code === 'STATUS_NO_SUCH_FILE') {
                        return true;
                    }
                } finally {
                    try { freshClient.disconnect(); } catch (e) { }
                }
            } catch (e) { }
        }
        console.warn(`[Delete Warn] Item ${itemPath} still exists after waiting`);
        return false;
    };

    // Helper to process a list of items
    const processItems = async (targetClient, itemList) => {
        // Process with limited concurrency (5) to balance speed and stability
        const BATCH_SIZE = 2;
        for (let i = 0; i < itemList.length; i += BATCH_SIZE) {
            const chunk = itemList.slice(i, i + BATCH_SIZE);
            await Promise.all(chunk.map(async (item) => {
                const itemPath = dirPath === '\\' ? item : `${dirPath}\\${item}`;
                let isDir = false;
                try {
                    const stats = await executeSMBCommand(targetClient, () => targetClient.stat(itemPath));
                    isDir = stats.isDirectory();
                    // console.log(`[Delete Debug] Processing child: ${itemPath} (isDir=${isDir})`);
                    if (isDir) {
                        await rmDirRecursiveSMB(targetClient, itemPath, config); // Recursively delete sub-folders
                    } else {
                        await executeSMBCommand(targetClient, () => targetClient.unlink(itemPath)); // Delete file
                    }
                } catch (err) {
                    console.log(`[Delete Debug] Stat/Process failed for ${itemPath}: ${err.code || err.message}`);

                    if (err.code === 'STATUS_OBJECT_NAME_NOT_FOUND' || err.code === 'STATUS_DELETE_PENDING' || err.code === 'STATUS_NO_SUCH_FILE') {
                        // If it's pending, wait for it to actually go away
                        if (err.code === 'STATUS_DELETE_PENDING') {
                            const gone = await waitForDeletion(targetClient, itemPath);
                            if (gone) return;
                            // If still there, fall through to ghost handling or aggressive cleanup
                            console.warn(`[Delete] Item ${itemPath} stuck in PENDING state. Trying aggressive cleanup.`);
                        }

                        // The item appears in readdir but stat fails. It might be a ghost or in a weird state.
                        // Try to blind delete it.
                        try {
                            // Try rmdir first (common for stubborn folders)
                            await executeSMBCommand(targetClient, () => targetClient.rmdir(itemPath));
                            return;
                        } catch (rmErr) {
                            // If it's not a directory, try unlink
                            if (rmErr.code === 'STATUS_NOT_A_DIRECTORY' || rmErr.code === 'STATUS_FILE_IS_A_DIRECTORY' || rmErr.message?.includes('Not a directory')) {
                                try {
                                    await executeSMBCommand(targetClient, () => targetClient.unlink(itemPath));
                                    return;
                                } catch (ulErr) {
                                    // Handle Read-Only/Hidden for ghost files too
                                    if (ulErr.code === 'STATUS_CANNOT_DELETE' || ulErr.code === 'STATUS_ACCESS_DENIED') {
                                        try {
                                            if (typeof targetClient.setFileAttributes === 'function') {
                                                await executeSMBCommand(targetClient, () => targetClient.setFileAttributes(itemPath, {
                                                    hidden: false,
                                                    readOnly: false,
                                                    system: false,
                                                    archive: false
                                                }));
                                                await executeSMBCommand(targetClient, () => targetClient.unlink(itemPath));
                                                return;
                                            }
                                        } catch (attrErr) {
                                            console.warn(`[Delete] Failed to clear attributes for ghost file ${itemPath}:`, attrErr.message);
                                        }
                                    }
                                    console.warn(`[Delete] Failed to delete ghost file ${itemPath}: ${ulErr.message} (${ulErr.code})`);
                                }
                            } else if (rmErr.code === 'STATUS_DELETE_PENDING') {
                                const gone = await waitForDeletion(targetClient, itemPath);
                                if (!gone) {
                                    // It's still here! Maybe it wasn't empty? Try recursing?
                                    console.log(`[Delete] Ghost Item ${itemPath} stuck in PENDING. Trying aggressive cleanup.`);
                                    // Try clearing attributes
                                    try {
                                        if (typeof targetClient.setFileAttributes === 'function') {
                                            await executeSMBCommand(targetClient, () => targetClient.setFileAttributes(itemPath, {
                                                hidden: false,
                                                readOnly: false,
                                                system: false,
                                                archive: false
                                            }));
                                        }
                                    } catch (e) { }

                                    // Try recurse (in case it's a dir)
                                    try {
                                        await rmDirRecursiveSMB(targetClient, itemPath, config);
                                        return;
                                    } catch (recurseErr) {
                                        // If that failed, try unlink again
                                        try {
                                            await executeSMBCommand(targetClient, () => targetClient.unlink(itemPath));
                                            return;
                                        } catch (ulErr) { }
                                    }
                                }
                                return;
                            } else if (rmErr.code === 'STATUS_DIRECTORY_NOT_EMPTY') {
                                // It is a directory and it's not empty! Recurse.
                                await rmDirRecursiveSMB(targetClient, itemPath, config);
                                return;
                            } else if (rmErr.code === 'STATUS_CANNOT_DELETE' || rmErr.code === 'STATUS_ACCESS_DENIED') {
                                // Maybe it was a directory that is read-only?
                                // Try to clear attributes
                                try {
                                    if (typeof targetClient.setFileAttributes === 'function') {
                                        await executeSMBCommand(targetClient, () => targetClient.setFileAttributes(itemPath, {
                                            hidden: false,
                                            readOnly: false,
                                            system: false,
                                            archive: false
                                        }));
                                        await executeSMBCommand(targetClient, () => targetClient.rmdir(itemPath));
                                        return;
                                    }
                                } catch (attrErr) {
                                    console.warn(`[Delete] Failed to clear attributes for ghost dir ${itemPath}:`, attrErr.message);
                                }
                            }
                            // If we are here, we failed to delete the ghost item
                            console.warn(`[Delete] Failed to delete ghost item ${itemPath}: ${rmErr.message} (${rmErr.code})`);
                        }
                        return;
                    }

                    // Try to clear Read-Only attribute if deletion failed
                    if (err.code === 'STATUS_CANNOT_DELETE' || err.code === 'STATUS_ACCESS_DENIED') {
                        try {
                            console.log(`[Delete] Attempting to clear Read-Only/Hidden for ${itemPath}`);
                            // 0x80 = Normal, 0 = Clear all? 
                            // SMB2 usually exposes setFileAttributes or similar?
                            // @marsaud/smb2 might not expose it directly on 'client', let's check if it has a way.
                            // Standard fs doesn't, but SMB protocol does.
                            // If client has setMetadata or similar?
                            // If not available, we can't do much but log.
                            if (typeof targetClient.setFileAttributes === 'function') {
                                await executeSMBCommand(targetClient, () => targetClient.setFileAttributes(itemPath, {
                                    hidden: false,
                                    readOnly: false,
                                    system: false,
                                    archive: false
                                }));
                                // Retry delete once
                                if (isDir) {
                                    await rmDirRecursiveSMB(targetClient, itemPath, config);
                                } else {
                                    await executeSMBCommand(targetClient, () => targetClient.unlink(itemPath));
                                }
                                return;
                            }
                        } catch (attrErr) {
                            console.warn(`[Delete] Failed to clear attributes for ${itemPath}:`, attrErr.message);
                        }
                    }

                    console.error(`[Delete] Failed to delete child ${itemPath} (isDir=${isDir}):`, err.message, err.code);
                }
            }));
        }
        // Small delay to let server state settle
        await new Promise(r => setTimeout(r, 200));
    };

    // 2. Process children (Initial Pass)
    await processItems(client, items);

    // 3. Delete the directory itself (with robust retry for sync lag and leftovers)
    let retryCount = 0;
    // Retry up to 12 times to allow for propagation of child deletions (Delete Pending state)
    while (retryCount < 12) {
        try {
            // console.log(`[Delete Debug] Executing rmdir on: ${dirPath}`);
            await executeSMBCommand(client, () => client.rmdir(dirPath));

            // Verify deletion
            try {
                await executeSMBCommand(client, () => client.stat(dirPath));
                // If stat succeeds, it still exists
                console.warn(`[Delete Warning] rmdir succeeded for ${dirPath} but it still exists! (Ghost directory?)`);
            } catch (e) {
                // If stat fails, it's likely gone (good)
            }
            return;
        } catch (err) {
            if (err.code === 'STATUS_OBJECT_NAME_NOT_FOUND' || err.code === 'STATUS_DELETE_PENDING') {
                return;
            }

            if (err.code === 'STATUS_DIRECTORY_NOT_EMPTY' || err.code === 'STATUS_SHARING_VIOLATION') {
                // console.log(`[Delete] rmdir failed for ${dirPath} (${err.code}). Retrying...`);

                // If directory is not empty, try to see WHAT is left and delete it
                if (err.code === 'STATUS_DIRECTORY_NOT_EMPTY') {
                    try {
                        let remainingItems = await executeSMBCommand(client, () => client.readdir(dirPath));
                        remainingItems = remainingItems.filter(name => name !== '.' && name !== '..');

                        if (remainingItems.length > 0) {
                            console.log(`[Delete] Found ${remainingItems.length} stubborn items in ${dirPath}, cleaning up...`);
                            await processItems(client, remainingItems);
                        } else {
                            // console.warn(`[Delete] Directory ${dirPath} is not empty but readdir found 0 items.`);
                        }
                    } catch (readErr) {
                        // If readdir fails, maybe it's gone or access denied, just continue to wait/retry
                    }
                }

                await sleep(1000 + (retryCount * 750));
                retryCount++;
                continue;
            }

            // Attempt to clear Read-Only/Hidden if deletion failed due to access denied
            if (err.code === 'STATUS_CANNOT_DELETE' || err.code === 'STATUS_ACCESS_DENIED') {
                try {
                    if (typeof client.setFileAttributes === 'function') {
                        await executeSMBCommand(client, () => client.setFileAttributes(dirPath, {
                            hidden: false,
                            readOnly: false,
                            system: false,
                            archive: false
                        }));
                    }
                } catch (attrErr) {
                    console.warn(`[Delete] Failed to clear attributes for ${dirPath}:`, attrErr.message);
                }

                await sleep(1000);
                retryCount++;
                continue;
            }

            throw err;
        }
    }
    throw new Error(`Failed to delete directory ${dirPath} after ${retryCount} retries.`);
};

// POST /api/delete
app.post('/api/delete', async (req, res) => {
    let dedicatedClient = null;
    try {
        const { items, drive: driveId = 'local' } = req.body;
        const config = await getDriveConfig(driveId);

        if (config.type === 'local') {
            await Promise.all(items.map(async itemPath => {
                const absPath = resolveSafePath(itemPath);
                await fs.remove(absPath);
            }));
        } else if (config.type === 'smb') {
            closeActiveSmbStreamsForPaths(items);
            clearSMBSession(config);

            let attempts = 0;
            const MAX_RETRIES = 3;
            let lastError = null;

            while (attempts < MAX_RETRIES) {
                attempts++;
                dedicatedClient = getSMBClient(config, { forceNew: true });
                const client = dedicatedClient;

                try {
                    for (const item of items) {
                        const smbPath = toSMBPath(item);
                        try {
                            await deletePathSMB(client, smbPath);
                        } catch (e) {
                            if (!isNotFound(e) && !isDeletePending(e)) {
                                throw e;
                            }
                        }
                    }

                    // Success!
                    break;
                } catch (err) {
                    lastError = err;
                    console.error(`[Delete] Attempt ${attempts}/${MAX_RETRIES} failed: ${err.message}. Reconnecting...`);

                    if (dedicatedClient) {
                        try { dedicatedClient.disconnect(); } catch (e) { }
                        dedicatedClient = null;
                    }

                    if (attempts < MAX_RETRIES) {
                        await new Promise(r => setTimeout(r, 1500)); // Wait for locks to release
                    }
                }
            }

            if (lastError && attempts === MAX_RETRIES) {
                // If items are already gone, don't surface an error to the UI
                const verified = await verifyItemsDeletedSMB(config, items);
                if (!verified) {
                    throw lastError;
                }
            }

        } else {
            const client = getWebDAVClient(config);
            await Promise.all(items.map(item => client.deleteFile(item.replace(/^\/+/, ''))));
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Delete Error]', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (dedicatedClient) dedicatedClient.disconnect();
    }
});

// POST /api/move
app.post('/api/move', async (req, res) => {
    try {
        const { items, destination, drive: driveId = 'local', overwrite = false } = req.body;
        const config = await getDriveConfig(driveId);

        if (config.type === 'local') {
            await Promise.all(items.map(async itemPath => {
                const absItem = resolveSafePath(itemPath);
                // Destination is a FOLDER in move API
                const absDestDir = resolveSafePath(destination);
                const absNewPath = path.join(absDestDir, path.basename(absItem));

                if (absItem !== absNewPath) {
                    try {
                        await fs.move(absItem, absNewPath, { overwrite: overwrite });
                    } catch (e) {
                        if (e.message.includes('dest already exists')) {
                            const error = new Error('File already exists');
                            error.code = 'EXIST';
                            throw error;
                        }
                        throw e;
                    }
                }
            }));
        } else if (config.type === 'smb') {
            for (const item of items) {
                const smbOld = toSMBPath(item);
                const fileName = path.basename(item);
                const smbDestDir = toSMBPath(destination);
                const smbNew = smbDestDir === '\\' || smbDestDir === '' ? fileName : `${smbDestDir}\\${fileName}`;

                try {
                    await executeSMBCommand(client, () => client.rename(smbOld, smbNew));
                } catch (e) {
                    if (e.code === 'STATUS_OBJECT_NAME_COLLISION') {
                        if (overwrite) {
                            // Delete destination and retry
                            try {
                                const stats = await executeSMBCommand(client, () => client.stat(smbNew));
                                if (stats.isDirectory()) await rmDirRecursiveSMB(client, smbNew);
                                else await executeSMBCommand(client, () => client.unlink(smbNew));
                                await executeSMBCommand(client, () => client.rename(smbOld, smbNew));
                            } catch (retryErr) {
                                throw retryErr;
                            }
                        } else {
                            const error = new Error('File already exists');
                            error.code = 'EXIST';
                            throw error;
                        }
                    } else {
                        throw e;
                    }
                }
            }
        } else {
            const client = getWebDAVClient(config);
            await Promise.all(items.map(item => {
                const cleanDest = destination.replace(/^\/+/, '');
                const destPath = path.posix.join(cleanDest, path.basename(item));
                // Send Overwrite header
                return client.moveFile(item.replace(/^\/+/, ''), destPath, { headers: { 'Overwrite': overwrite ? 'T' : 'F' } });
            }));
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Move Error]', err);
        if (err.code === 'EXIST' || err.message.includes('dest already exists') || (err.response && (err.response.status === 412 || err.response.status === 409))) {
            return res.status(409).json({ error: 'File already exists', code: 'EXIST' });
        }
        res.status(500).json({ error: err.message });
    }
});

const { pipeline } = require('stream/promises');

// Helper: Abstract File System Interface for Transfer
const getFSAdapter = (config) => {
    if (config.type === 'local') {
        return {
            stat: async (p) => {
                const s = await fs.stat(resolveSafePath(p));
                return { isDirectory: () => s.isDirectory(), size: s.size };
            },
            readdir: async (p) => {
                const files = await fs.readdir(resolveSafePath(p));
                return files; // returns names
            },
            mkdir: async (p) => fs.ensureDir(resolveSafePath(p)),
            createReadStream: async (p) => fs.createReadStream(resolveSafePath(p)),
            createWriteStream: async (p) => fs.createWriteStream(resolveSafePath(p)),
            unlink: async (p) => fs.remove(resolveSafePath(p)), // fs-extra remove handles dirs too
            join: (base, name) => path.posix.join(base, name), // Logic uses posix paths internally for recursion
            close: async () => { }
        };
    } else if (config.type === 'smb') {
        // For SMB, we need a primary client for non-streaming operations (stat, readdir, mkdir, unlink)
        // and a set of clients for TurboSMBReadStream.
        const primaryClient = getSMBClient(config, { autoCloseTimeout: 0, packetConcurrency: 512, tag: 'primary' });
        const toSMB = toSMBPath;

        const lanes = [];
        for (let i = 1; i <= 3; i++) { // V9.20: Reversion to 3-Lanes for hardware limit compatibility
            lanes.push(getSMBClient(config, { autoCloseTimeout: 0, packetConcurrency: 64, tag: `lane${i}` }));
        }

        return {
            stat: async (p) => executeSMBCommand(primaryClient, () => primaryClient.stat(toSMB(p))),
            readdir: async (p) => executeSMBCommand(primaryClient, () => primaryClient.readdir(toSMB(p))),
            mkdir: async (p) => executeSMBCommand(primaryClient, () => primaryClient.mkdir(toSMB(p))),
            createReadStream: async (p) => {
                const smbP = toSMB(p);
                const stats = await executeSMBCommand(primaryClient, () => primaryClient.statP(smbP));
                // V9.20 Katana-Drive: 1MB chunks, 3-Lanes, ACC Locked to 1.2s-2.5s RTT
                return new TurboSMBReadStream(lanes, smbP, stats.size, { chunkSize: 1024 * 1024 });
            },
            createWriteStream: async (p) => executeSMBCommand(primaryClient, () => primaryClient.createWriteStreamP(toSMB(p))),
            unlink: async (p) => {
                const smbP = toSMB(p);
                const stats = await executeSMBCommand(primaryClient, () => primaryClient.stat(smbP));
                if (stats.isDirectory()) await rmDirRecursiveSMB(primaryClient, smbP, config);
                else await executeSMBCommand(primaryClient, () => primaryClient.unlink(smbP));
            },
            join: (base, name) => path.posix.join(base, name),
            close: async () => {
                try { await primaryClient.disconnect(); } catch (e) { }
                for (const lane of lanes) {
                    try { lane.disconnect(); } catch (e) { } // Sync call usually
                }
            }
        };
    } else {
        const client = getWebDAVClient(config);
        const toWebDAV = (p) => p.replace(/^\/+/, ''); // Ensure no leading slash for some clients if needed
        return {
            stat: async (p) => {
                const res = await client.stat(toWebDAV(p));
                return { isDirectory: () => res.type === 'directory', size: res.size };
            },
            readdir: async (p) => {
                const items = await client.getDirectoryContents(toWebDAV(p));
                // getDirectoryContents returns objects, we need names
                // Filter out current directory entry if present
                return items
                    .filter(i => i.filename !== toWebDAV(p) && i.filename !== '/' + toWebDAV(p))
                    .map(i => i.basename);
            },
            mkdir: async (p) => client.createDirectory(toWebDAV(p)),
            createReadStream: async (p) => client.createReadStream(toWebDAV(p)),
            createWriteStream: async (p) => {
                // webdav lib: putFileContents accepts stream. 
                // But we need a Writable stream interface.
                // We can use a PassThrough and pipe it to putFileContents?
                // Actually webdav lib `createWriteStream` returns a stream that uploads.
                return client.createWriteStream(toWebDAV(p));
            },
            unlink: async (p) => client.deleteFile(toWebDAV(p)),
            join: (base, name) => path.posix.join(base, name),
            close: async () => { }
        };
    }
};

// Recursive Transfer Function
const transferItemRecursive = async (srcAdapter, dstAdapter, srcPath, dstPath, overwrite = false, taskId = null) => {
    const stats = await srcAdapter.stat(srcPath);

    if (stats.isDirectory()) {
        // Create Dest Dir
        try { await dstAdapter.mkdir(dstPath); } catch (e) { /* ignore exist error */ }

        // List Children
        const children = await srcAdapter.readdir(srcPath);
        for (const childName of children) {
            if (childName === '.' || childName === '..') continue;
            const childSrc = srcAdapter.join(srcPath, childName);
            const childDst = dstAdapter.join(dstPath, childName);
            await transferItemRecursive(srcAdapter, dstAdapter, childSrc, childDst, overwrite, taskId);
        }
    } else {
        // Check existence if not overwriting
        if (!overwrite) {
            try {
                await dstAdapter.stat(dstPath);
                // If we are here, file exists
                const error = new Error('File already exists');
                error.code = 'EXIST';
                throw error;
            } catch (e) {
                if (e.code === 'EXIST') throw e;
                // Otherwise ignore (not found)
            }
        }

        // Helper to perform copy with retry on collision
        const performCopy = async (retry = false) => {
            let readStream, writeStream, progressStream;
            try {
                readStream = await srcAdapter.createReadStream(srcPath);
                progressStream = createProgressStream(taskId, stats.size);
                writeStream = await dstAdapter.createWriteStream(dstPath);

                if (taskId) {
                    activeTasks.set(taskId, {
                        cancel: () => {
                            console.log(`[Task ${taskId}] Cancellation triggered`);
                            if (readStream) readStream.destroy();
                            if (writeStream) writeStream.destroy();
                            if (progressStream) progressStream.destroy();
                        }
                    });
                }

                await pipeline(readStream, progressStream, writeStream);
            } catch (err) {
                if (readStream) readStream.destroy();
                if (progressStream) progressStream.destroy();
                if (writeStream) writeStream.destroy();

                // Handle SMB collision if overwriting is enabled
                if (overwrite && !retry && (err.code === 'STATUS_OBJECT_NAME_COLLISION' || err.message?.includes('STATUS_OBJECT_NAME_COLLISION'))) {
                    console.log(`[Transfer] Collision detected for ${dstPath}. Deleting and retrying...`);
                    try {
                        await dstAdapter.unlink(dstPath);
                        await performCopy(true); // Retry once
                    } catch (retryErr) {
                        throw retryErr; // Fail if delete fails or retry fails
                    }
                } else if (err.message && (err.message.includes('STATUS_FILE_CLOSED') || err.code === 'STATUS_FILE_CLOSED')) {
                    // console.warn(`[Transfer Warn] STATUS_FILE_CLOSED (benign) for ${dstPath}. Ignoring.`);
                } else if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                    // Stream destroyed (likely via cancel)
                    console.log(`[Transfer] Cancelled, cleaning up: ${dstPath}`);
                    try { await dstAdapter.unlink(dstPath); } catch (cleanupErr) { console.warn('[Transfer] Cleanup failed:', cleanupErr.message); }

                    const cancelErr = new Error('Transfer Cancelled');
                    cancelErr.code = 'CANCELLED';
                    throw cancelErr;
                } else {
                    throw err;
                }
            } finally {
                if (taskId) activeTasks.delete(taskId);
            }
        };

        await performCopy();
    }
};

// POST /api/transfer (Cross-drive copy/move)
app.post('/api/transfer', async (req, res) => {
    let srcAdapter, dstAdapter;
    try {
        const { items, sourceDrive, destDrive, destPath, move, overwrite = false, taskId = null } = req.body;
        if (!items || !sourceDrive || !destDrive) return res.status(400).json({ error: 'Missing parameters' });

        const srcConfig = await getDriveConfig(sourceDrive);
        const dstConfig = await getDriveConfig(destDrive);

        srcAdapter = getFSAdapter(srcConfig);
        dstAdapter = getFSAdapter(dstConfig);

        for (const itemPath of items) {
            const fileName = path.basename(itemPath);
            const targetPath = path.posix.join(destPath, fileName);

            try {
                await transferItemRecursive(srcAdapter, dstAdapter, itemPath, targetPath, overwrite, taskId);

                // If Move, delete source after successful transfer
                if (move) {
                    await srcAdapter.unlink(itemPath);
                }
            } catch (e) {
                if (e.code === 'EXIST') {
                    console.log(`[Transfer Info] Target exists, returning 409 for: ${targetPath}`);
                    return res.status(409).json({ error: 'File already exists', code: 'EXIST' });
                }
                if (e.code === 'CANCELLED' || e.message === 'Transfer Cancelled') {
                    console.log(`[Transfer Info] Transfer cancelled: ${itemPath} -> ${targetPath}`);
                } else {
                    console.error(`[Transfer Failed] ${itemPath} -> ${targetPath}:`, e);
                }
                if (e.response && (e.response.status === 412 || e.response.status === 409)) {
                    return res.status(409).json({ error: 'File already exists', code: 'EXIST' });
                }
                throw e; // Stop batch on error
            }
        }
        res.json({ success: true });
    } catch (err) {
        if (!res.headersSent) {
            if (err.code === 'EXIST') return res.status(409).json({ error: 'File already exists', code: 'EXIST' });
            if (err.code === 'CANCELLED' || err.message === 'Transfer Cancelled') {
                return res.json({ success: false, error: 'Cancelled' });
            }
            console.error('[Transfer Error]', err);
            res.status(500).json({ error: err.message });
        }
    } finally {
        if (srcAdapter && srcAdapter.close) await srcAdapter.close();
        if (dstAdapter && dstAdapter.close) await dstAdapter.close();
    }
});

// POST /api/rename
app.post('/api/rename', async (req, res) => {
    try {
        const { oldPath, newName, path: currentPath, drive: driveId = 'local', overwrite = false } = req.body;
        if (!oldPath || !newName) return res.status(400).json({ error: 'Missing parameters' });

        const config = await getDriveConfig(driveId);

        if (config.type === 'local') {
            // Local Rename using resolveSafePath for consistency
            const absOld = resolveSafePath(oldPath);
            const absDir = path.dirname(absOld);
            const absNew = path.join(absDir, newName); // Same dir, new name

            if (!overwrite && await fs.pathExists(absNew)) {
                return res.status(409).json({ error: 'File already exists', code: 'EXIST' });
            }

            console.log(`[Rename] ${absOld} -> ${absNew}`);
            // fs.rename overwrites by default on POSIX, but we checked existence above if !overwrite.
            // If overwrite=true, we just do it.
            await fs.rename(absOld, absNew);
        } else if (config.type === 'smb') {
            let client = getSMBClient(config);
            const smbOld = toSMBPath(oldPath);
            const parts = smbOld.split('\\');
            parts.pop();
            const smbNew = [...parts, newName].join('\\');
            // Retry loop for Rename (Handling SHARING_VIOLATION)
            let renameAttempts = 0;
            const maxRenameAttempts = 3;

            while (renameAttempts < maxRenameAttempts) {
                try {
                    await executeSMBCommand(client, () => client.rename(smbOld, smbNew));
                    break; // Success
                } catch (e) {
                    // Handle Sharing Violation or Access Denied (File in use/Locked)
                    if ((e.code === 'STATUS_SHARING_VIOLATION' || e.code === 'STATUS_ACCESS_DENIED') && renameAttempts < maxRenameAttempts - 1) {
                        console.warn(`[Rename] Locked (${e.code}). Retrying... (${renameAttempts + 1}/${maxRenameAttempts})`);
                        clearSMBSession(config); // Clear locks
                        await new Promise(r => setTimeout(r, 500));
                        client = getSMBClient(config); // Get fresh client
                        renameAttempts++;
                        continue;
                    }

                    if (e.code === 'STATUS_OBJECT_NAME_COLLISION') {
                        if (overwrite) {
                            try {
                                console.log(`[Rename] Collision. Overwriting...`);
                                // Clear session before delete to avoid self-lock
                                clearSMBSession(config);
                                client = getSMBClient(config); // Get fresh client

                                const stats = await executeSMBCommand(client, () => client.stat(smbNew));
                                if (stats.isDirectory()) await rmDirRecursiveSMB(client, smbNew, config);
                                else await executeSMBCommand(client, () => client.unlink(smbNew));

                                // Reset attempt counter to allow retry of rename after successful delete
                                // But prevent infinite loop if delete succeeds but rename fails repeatedly
                                // Actually, just let the next loop iteration handle the rename.
                                // We don't increment renameAttempts here to give it a fair shot?
                                // Let's just continue loop.
                                continue;
                            } catch (retryErr) {
                                // If delete failed with Sharing Violation, we might want to retry the whole outer loop?
                                // For simplicity, throw here if delete fails.
                                throw retryErr;
                            }
                        } else {
                            return res.status(409).json({ error: 'File already exists', code: 'EXIST' });
                        }
                    } else {
                        throw e;
                    }
                }
            }

        } else {
            // WebDAV Rename
            const client = getWebDAVClient(config);
            const cleanOldPath = oldPath.replace(/^\/+/, '');

            const parentDir = path.dirname(cleanOldPath);
            const safeParentDir = parentDir.split(path.sep).join('/');
            const newPath = path.posix.join(safeParentDir, newName);

            try {
                await client.moveFile(cleanOldPath, newPath, { headers: { 'Overwrite': overwrite ? 'T' : 'F' } });
            } catch (e) {
                if (e.response && (e.response.status === 412 || e.response.status === 409)) {
                    return res.status(409).json({ error: 'File already exists', code: 'EXIST' });
                }
                throw e;
            }
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Rename Error]', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/prepare-drag (For Native Drag & Drop)
app.post('/api/prepare-drag', async (req, res) => {
    try {
        const { items, drive: driveId = 'local' } = req.body;

        if (!items || items.length === 0) return res.json({ files: [] });

        const config = await getDriveConfig(driveId);
        const resolvedFiles = [];

        if (config.type === 'local') {
            for (const itemPath of items) {
                const absPath = resolveSafePath(itemPath);
                if (fs.existsSync(absPath)) {
                    resolvedFiles.push(absPath);
                }
            }
        } else {
            const tempDir = path.join(os.tmpdir(), 'webdav-drag-cache');
            await fs.ensureDir(tempDir);

            const downloadPromises = items.map(async (itemPath) => {
                try {
                    const fileName = path.basename(itemPath);
                    const tempFilePath = path.join(tempDir, fileName);

                    if (config.type === 'smb') {
                        const client = getSMBClient(config, { tag: 'preview' });
                        const readStream = await executeSMBCommand(client, () => client.createReadStream(toSMBPath(itemPath)));
                        const writeStream = fs.createWriteStream(tempFilePath);
                        await pipeline(readStream, writeStream);
                    } else {
                        const client = getWebDAVClient(config);
                        const content = await client.getFileContents(itemPath, { format: 'binary' });
                        await fs.writeFile(tempFilePath, content);
                    }
                    return tempFilePath;
                } catch (e) {
                    return null;
                }
            });
            const results = await Promise.all(downloadPromises);
            resolvedFiles.push(...results.filter(p => p !== null));
        }

        res.json({ files: resolvedFiles });
    } catch (err) {
        console.error('[Drag Error]', err);
        res.status(500).json({ error: err.message });
    }
});

// Multer & Upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const { path: reqPath = '/', drive: driveId = 'local' } = req.query;

        try {
            if (driveId === 'local') {
                const absPath = resolveSafePath(reqPath);
                fs.ensureDirSync(absPath);
                cb(null, absPath);
            } else {
                const tempDir = os.tmpdir();
                cb(null, tempDir);
            }
        } catch (e) {
            cb(e);
        }
    },
    filename: (req, file, cb) => {
        // Fix UTF-8 filenames
        const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, name);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 * 1024 } // 10GB limit example
});

app.post('/api/upload', upload.array('files'), async (req, res) => {
    const uploadedFiles = req.files || [];
    const { path: reqPath = '/', drive: driveId = 'local', taskId: queryTaskId = null, overwrite = 'false' } = req.query;
    const shouldOverwrite = overwrite === 'true';
    console.log(`[Upload] Processing ${uploadedFiles.length} files. Drive: ${driveId}. taskId: ${queryTaskId} overwrite: ${shouldOverwrite}`);

    try {
        const config = await getDriveConfig(driveId);

        if (config.type !== 'local') {

            for (const file of uploadedFiles) {
                try {
                    const remotePath = path.posix.join('/', reqPath, file.filename);
                    console.log(`[Upload] Transferring to ${config.type}: ${file.filename}`);

                    if (config.type === 'smb') {
                        // Use autoCloseTimeout: 0 to prevent STATUS_FILE_CLOSED during upload
                        const client = getSMBClient(config, { autoCloseTimeout: 0 });

                        const performUpload = async (retry = false) => {
                            const readStream = fs.createReadStream(file.path);
                            const progressStream = createProgressStream(queryTaskId, file.size);
                            let writeStream = null;

                            // Register cancel handler for this attempt
                            if (queryTaskId) {
                                activeTasks.set(queryTaskId, {
                                    cancel: () => {
                                        console.log(`[Upload ${queryTaskId}] Cancellation triggered`);
                                        if (readStream) readStream.destroy();
                                        if (progressStream) progressStream.destroy();
                                        if (writeStream && typeof writeStream.destroy === 'function') writeStream.destroy();
                                    }
                                });
                            }

                            try {
                                const smbPath = toSMBPath(remotePath);
                                writeStream = await client.createWriteStream(smbPath);

                                // Check if cancelled during await
                                if (readStream.destroyed || progressStream.destroyed) {
                                    if (writeStream) writeStream.destroy();
                                    throw new Error('Upload Cancelled');
                                }

                                // Update cancel handler to include the new writeStream instance
                                if (queryTaskId) {
                                    activeTasks.set(queryTaskId, {
                                        cancel: () => {
                                            console.log(`[Upload ${queryTaskId}] Cancellation triggered (Active Stream)`);
                                            if (readStream) readStream.destroy();
                                            if (progressStream) progressStream.destroy();
                                            if (writeStream) writeStream.destroy();
                                        }
                                    });
                                }

                                await pipeline(readStream, progressStream, writeStream);
                            } catch (err) {
                                if (readStream) readStream.destroy();
                                if (progressStream) progressStream.destroy();
                                if (writeStream) writeStream.destroy();

                                if (err.message === 'Upload Cancelled' || err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                                    throw new Error('Upload Cancelled');
                                }

                                if (shouldOverwrite && !retry && (err.code === 'STATUS_OBJECT_NAME_COLLISION' || err.message?.includes('STATUS_OBJECT_NAME_COLLISION'))) {
                                    console.log(`[Upload] Collision detected for ${remotePath}. Clearing sessions and retrying...`);
                                    try {
                                        clearSMBSession(config);
                                        const smbPath = toSMBPath(remotePath);

                                        // Retry unlink logic for SHARING_VIOLATION
                                        let unlinkAttempts = 0;
                                        while (unlinkAttempts < 3) {
                                            try {
                                                await executeSMBCommand(client, () => client.unlink(smbPath));
                                                break;
                                            } catch (unlinkErr) {
                                                if (unlinkErr.code === 'STATUS_SHARING_VIOLATION' && unlinkAttempts < 2) {
                                                    console.warn(`[Upload] Sharing Violation on Unlink. Retrying in 500ms... (${unlinkAttempts + 1}/3)`);
                                                    await new Promise(r => setTimeout(r, 500));
                                                    unlinkAttempts++;
                                                } else {
                                                    throw unlinkErr;
                                                }
                                            }
                                        }

                                        await performUpload(true); // Retry once
                                    } catch (retryErr) {
                                        throw retryErr;
                                    }
                                } else if (err.message && (err.message.includes('STATUS_FILE_CLOSED') || err.code === 'STATUS_FILE_CLOSED')) {
                                    // console.warn(`[Upload Warn] STATUS_FILE_CLOSED (benign) for ${remotePath}. Ignoring.`);
                                } else {
                                    throw err;
                                }
                            }
                        };

                        try {
                            await performUpload();
                        } finally {
                            await client.disconnect();
                        }

                    } else {
                        const client = getWebDAVClient(config);
                        // WebDAV usually overwrites by default or we can set header. 
                        // Check if we need Overwrite header. Default for putFileContents is usually overwrite.
                        const readStream = fs.createReadStream(file.path);
                        const progressStream = createProgressStream(queryTaskId, file.size);

                        if (queryTaskId) {
                            activeTasks.set(queryTaskId, {
                                cancel: () => {
                                    if (readStream) readStream.destroy();
                                    if (progressStream) progressStream.destroy();
                                }
                            });
                        }

                        try {
                            // webdav-client putFileContents usually overwrites.
                            // To be safe we could add options but let's stick to default which works for most.
                            await client.putFileContents(remotePath, progressStream, { overwrite: shouldOverwrite });
                        } catch (err) {
                            if (readStream.destroyed || progressStream.destroyed) {
                                throw new Error('Upload Cancelled');
                            }
                            throw err;
                        }
                    }
                    console.log(`[Upload] Success: ${remotePath}`);
                } catch (e) {
                    if (e.message === 'Upload Cancelled') {
                        console.log(`[Upload] Cancelled, cleaning up: ${remotePath}`);
                        try {
                            if (config.type === 'smb') {
                                const client = getSMBClient(config);
                                const smbPath = toSMBPath(remotePath);
                                await executeSMBCommand(client, () => client.unlink(smbPath));
                            } else {
                                const client = getWebDAVClient(config);
                                await client.deleteFile(remotePath);
                            }
                        } catch (cleanupErr) { console.warn('[Upload] Cleanup failed:', cleanupErr.message); }
                    } else {
                        console.error(`[Upload] Failed to upload ${file.filename}:`, e);
                        throw e;
                    }
                } finally {
                    if (queryTaskId) activeTasks.delete(queryTaskId);
                    await fs.remove(file.path).catch(e => console.error('Failed to cleanup temp file:', e));
                }
            }
        } else {
            // Multer info silenced
        }
        res.json({ success: true });
    } catch (err) {
        if (err.message === 'Upload Cancelled') {
            return res.json({ success: false, error: 'Cancelled' });
        }
        console.error('[Upload API Error]', err);
        if (uploadedFiles.length > 0 && driveId !== 'local') {
            for (const file of uploadedFiles) {
                await fs.remove(file.path).catch(() => { });
            }
        }
        res.status(500).json({ error: err.message });
    }
});

// --- WebDAV Server (For external mounting of LOCAL drive only) ---
const userManager = new webdavServer.SimpleUserManager();
const user = userManager.addUser('admin', 'admin', true);
const privilegeManager = new webdavServer.SimplePathPrivilegeManager();
privilegeManager.setRights(user, '/', ['all']);
const server = new webdavServer.WebDAVServer({
    httpAuthentication: new webdavServer.HTTPDigestAuthentication(userManager, 'Default Realm'),
    privilegeManager: privilegeManager
});
server.setFileSystem('/', new webdavServer.PhysicalFileSystem(STORAGE_DIR), (s) => { });
app.use(webdavServer.extensions.express('/webdav', server));

// Serve static files from React app (for production/electron)
const CLIENT_BUILD_PATH = path.join(__dirname, '../client/dist');
if (fs.existsSync(CLIENT_BUILD_PATH)) {
    app.use(express.static(CLIENT_BUILD_PATH));

    // Handle SPA routing: return index.html for any unknown non-API routes
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/webdav')) {
            return next();
        }
        res.sendFile(path.join(CLIENT_BUILD_PATH, 'index.html'));
    });
} else {
    console.error(`[Server ERROR] Client Build NOT found at ${CLIENT_BUILD_PATH}`);
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Multi-Drive Server running at http://0.0.0.0:${PORT}`);
    console.log(`[Server] User Data Path: ${APP_DATA_DIR}`);
});
