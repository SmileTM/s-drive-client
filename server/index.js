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
let sharp;
try {
    sharp = require('sharp');
} catch (e) {
    console.warn('[WARN] Sharp module not found or failed to load. Image processing disabled.', e.message);
}
const { encrypt, decrypt } = require('./utils/crypto');

const app = express();
const PORT = process.env.PORT || 8000;
const STORAGE_DIR = os.homedir(); // Default to User Home directory
const APP_DATA_DIR = process.env.USER_DATA_PATH || path.join(os.homedir(), '.webdav-client');
const CONFIG_FILE = path.join(APP_DATA_DIR, 'drives.json');

// Ensure storage directory exists
fs.ensureDirSync(STORAGE_DIR);
fs.ensureDirSync(APP_DATA_DIR);
if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeJsonSync(CONFIG_FILE, [{ id: 'local', name: 'Local Storage', type: 'local', path: './storage' }]);
}

app.use(cors());
app.use(express.json());

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
    // config.domain: ""
    
    let address = config.address;
    let port = config.port;

    // Extract port from address if present (e.g. "192.168.1.100:4455")
    if (!port && typeof address === 'string' && address.includes(':')) {
        const parts = address.split(':');
        // Basic check for IPv4:Port format
        if (parts.length === 2 && !isNaN(parseInt(parts[1], 10))) {
            address = parts[0];
            port = parseInt(parts[1], 10);
        }
    }

    const cleanShare = config.share ? config.share.replace(/^[\/\\]+|[\/\\]+$/g, '') : '';

    // Extract tag and separate SMB options
    const { tag = 'default', ...smbOptions } = options;

    // Check if dedicated client requested (e.g. for transfer/upload)
    // Only treat as dedicated if there are actual SMB options passed (like autoCloseTimeout)
    const isDedicated = Object.keys(smbOptions).length > 0;

    const createClient = () => new SMB2({
        share: `\\\\${address}\\${cleanShare}`,
        domain: config.domain || '',
        username: config.username,
        password: config.password,
        port: port, // Optional port
        packetConcurrency: 5,
        autoCloseTimeout: 0, // Keep cached connections alive to prevent race conditions
        ...smbOptions
    });

    if (isDedicated) {
        return createClient();
    }

    const key = `${address}|${cleanShare}|${config.username}|${config.password}|${tag}`;
    if (!smbClients.has(key)) {
        smbClients.set(key, createClient());
    }
    return smbClients.get(key);
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
            // Trigger connection via a lightweight check (root listing)
            // We ignore errors here because the goal is just to connect.
            // If the share is invalid, the actual command later will fail anyway.
            await client.readdir(''); 
        } catch (e) {
            // Ignore readdir errors, just check connected state
        }
    })();

    try {
        await client._connectPromise;
    } finally {
        client._connectPromise = null;
    }
};

const RETRY_ERRORS = ['EPIPE', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'STATUS_NETWORK_NAME_DELETED', 'STATUS_USER_SESSION_DELETED', 'STATUS_CONNECTION_DISCONNECTED', 'STATUS_FILE_CLOSED'];

// Helper: Execute SMB Command with Retry
const executeSMBCommand = async (client, commandFn) => {
    try {
        await ensureSMBConnected(client);
        return await commandFn();
    } catch (err) {
        const isRetryable = RETRY_ERRORS.some(code => 
            err.code === code || 
            (err.message && err.message.includes(code))
        );
        
        if (isRetryable) {
            console.log(`[SMB Retry] Connection error (${err.code || err.message}), reconnecting...`);
            // Force disconnect/reset state
            client.disconnect(); 
            // Retry once
            await ensureSMBConnected(client);
            return await commandFn();
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
            mtime: file.changeTime, // SMB2 uses changeTime/lastWriteTime
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
            } catch (e) {}
            return { ...publicDrive, quota: null };
        }));
        
        // Log without sensitive data
        console.log('[DEBUG] Drives Quota:', JSON.stringify(drivesWithQuota.map(d => ({id: d.id, quota: d.quota})), null, 2));
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
        console.log('[DEBUG] POST /api/drives payload:', logSafeDrive);
        
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
        console.log('[DEBUG] Write success. New count:', drives.length);
        
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
        // Password remains untouched (encrypted)
        
        console.log('[DEBUG] Renaming drive:', id, 'to', name, '. Total drives:', drives.length);
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
        console.log(`[DEBUG] GET /api/files path="${reqPath}" drive="${driveId}"`);

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
                // @marsaud/smb2 readdir returns just names by default.
                // Wrap readdir in executeSMBCommand
                const names = await executeSMBCommand(client, () => client.readdir(smbPath));
                
                // Process files in chunks to avoid STATUS_INSUFFICIENT_RESOURCES
                const results = [];
                const CHUNK_SIZE = 5;
                
                for (let i = 0; i < names.length; i += CHUNK_SIZE) {
                    const chunk = names.slice(i, i + CHUNK_SIZE);
                    const chunkResults = await Promise.all(chunk.map(async name => {
                        try {
                            const itemPath = smbPath === '\\' || smbPath === '' ? name : `${smbPath}\\${name}`;
                            // Wrap stat in executeSMBCommand (concurrently might be heavy, but retry handles dropping)
                            const stats = await executeSMBCommand(client, () => client.stat(itemPath));
                            
                            // Construct full relative path for frontend
                            const webPath = path.posix.join(reqPath, name);
                            
                            return {
                                name: name,
                                path: webPath,
                                isDirectory: stats.isDirectory(),
                                size: stats.size,
                                mtime: stats.changeTime,
                                type: stats.isDirectory() ? 'folder' : mime.lookup(name) || 'application/octet-stream'
                            };
                        } catch(e) {
                            return null; 
                        }
                    }));
                    results.push(...chunkResults);
                }
                
                res.json({
                    path: reqPath,
                    files: results.filter(f => f !== null)
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

        console.log(`[DEBUG] GET /api/search query="${query}" drive="${driveId}"`);

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
            const client = getSMBClient(config, { tag: 'preview' });
            const smbPath = toSMBPath(reqPath);
            
            try {
                const range = req.headers.range;
                let options = {};
                
                if (range) {
                    const parts = range.replace(/bytes=/, "").split("-");
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : undefined;
                    options.start = start;
                    if (end) options.end = end;
                    res.status(206);
                    
                    // We need file size for Content-Range header
                    const stats = await executeSMBCommand(client, () => client.stat(smbPath));
                    const fileSize = stats.size;
                    const finalEnd = end || (fileSize - 1);
                    const chunksize = (finalEnd - start) + 1;

                    res.setHeader('Content-Range', `bytes ${start}-${finalEnd}/${fileSize}`);
                    res.setHeader('Content-Length', chunksize);
                    res.setHeader('Accept-Ranges', 'bytes');
                } else {
                    const stats = await executeSMBCommand(client, () => client.stat(smbPath));
                    res.setHeader('Content-Length', stats.size);
                    res.setHeader('Accept-Ranges', 'bytes');
                }

                const fileName = path.basename(reqPath);
                const mimeType = mime.lookup(fileName) || 'application/octet-stream';
                res.setHeader('Content-Type', mimeType);

                const stream = await executeSMBCommand(client, () => client.createReadStream(smbPath, options));
                
                stream.on('error', (err) => {
                    if (err.code === 'STATUS_FILE_CLOSED' || err.message?.includes('STATUS_FILE_CLOSED')) return;
                    console.error('SMB Stream Error', err);
                });

                stream.pipe(res);
            } catch (e) {
                if (e.code === 'STATUS_OBJECT_PATH_NOT_FOUND' || e.code === 'STATUS_OBJECT_NAME_NOT_FOUND') {
                    return res.status(404).send('File not found');
                }
                throw e;
            }

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
             } catch(e) {
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
    try {
        const { path: reqPath, drive: driveId = 'local' } = req.body;
        console.log(`[DEBUG] POST /api/mkdir path="${reqPath}" drive="${driveId}"`);
        const config = await getDriveConfig(driveId);

        if (config.type === 'local') {
            const absPath = resolveSafePath(reqPath);
            await fs.ensureDir(absPath);
        } else if (config.type === 'smb') {
            const client = getSMBClient(config);
            const smbPath = toSMBPath(reqPath);
            await executeSMBCommand(client, () => client.mkdir(smbPath));
        } else {
            const client = getWebDAVClient(config);
            await client.createDirectory(reqPath);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Mkdir Error]', err);
        res.status(500).json({ error: err.message });
    }
});

// Helper: Recursive SMB Delete
const rmDirRecursiveSMB = async (client, dirPath) => {
    const items = await executeSMBCommand(client, () => client.readdir(dirPath));
    for (const item of items) {
        const itemPath = dirPath === '\\' ? item : `${dirPath}\\${item}`;
        const stats = await executeSMBCommand(client, () => client.stat(itemPath));
        if (stats.isDirectory()) {
            await rmDirRecursiveSMB(client, itemPath);
        } else {
            await executeSMBCommand(client, () => client.unlink(itemPath));
        }
    }
    await executeSMBCommand(client, () => client.rmdir(dirPath));
};

// POST /api/delete
app.post('/api/delete', async (req, res) => {
    try {
        const { items, drive: driveId = 'local' } = req.body;
        console.log(`[DEBUG] POST /api/delete count=${items?.length} drive="${driveId}"`);
        const config = await getDriveConfig(driveId);

        if (config.type === 'local') {
            await Promise.all(items.map(async itemPath => {
                const absPath = resolveSafePath(itemPath);
                await fs.remove(absPath);
            }));
        } else if (config.type === 'smb') {
            const client = getSMBClient(config);
            for (const item of items) {
                const smbPath = toSMBPath(item);
                try {
                    const stats = await executeSMBCommand(client, () => client.stat(smbPath));
                    if (stats.isDirectory()) {
                         await rmDirRecursiveSMB(client, smbPath); 
                    } else {
                         await executeSMBCommand(client, () => client.unlink(smbPath));
                    }
                } catch(e) {
                    // Ignore if not found, else throw
                    if (!e.message.includes('STATUS_OBJECT_NAME_NOT_FOUND') && !e.message.includes('STATUS_NoSuchFile')) {
                         throw e;
                    }
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
            const client = getSMBClient(config);
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
            close: async () => {}
        };
    } else if (config.type === 'smb') {
        // Disable autoClose for transfer to avoid connection drops
        // Limit packetConcurrency to avoid STATUS_INSUFFICIENT_RESOURCES
        // autoCloseTimeout: 0 prevents the client from closing the connection while a stream is still active
        const client = getSMBClient(config, { autoCloseTimeout: 0, packetConcurrency: 5 });
        const toSMB = toSMBPath;
        return {
            stat: async (p) => executeSMBCommand(client, () => client.stat(toSMB(p))),
            readdir: async (p) => executeSMBCommand(client, () => client.readdir(toSMB(p))),
            mkdir: async (p) => executeSMBCommand(client, () => client.mkdir(toSMB(p))),
            createReadStream: async (p) => executeSMBCommand(client, () => client.createReadStream(toSMB(p))),
            createWriteStream: async (p) => executeSMBCommand(client, () => client.createWriteStream(toSMB(p))),
            unlink: async (p) => {
                const smbP = toSMB(p);
                const stats = await executeSMBCommand(client, () => client.stat(smbP));
                if (stats.isDirectory()) await rmDirRecursiveSMB(client, smbP);
                else await executeSMBCommand(client, () => client.unlink(smbP));
            },
            join: (base, name) => path.posix.join(base, name),
            close: async () => client.disconnect()
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
            close: async () => {}
        };
    }
};

// Recursive Transfer Function
const transferItemRecursive = async (srcAdapter, dstAdapter, srcPath, dstPath, overwrite = false) => {
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
            await transferItemRecursive(srcAdapter, dstAdapter, childSrc, childDst, overwrite);
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
            let readStream, writeStream;
            try {
                readStream = await srcAdapter.createReadStream(srcPath);
                writeStream = await dstAdapter.createWriteStream(dstPath);
                await pipeline(readStream, writeStream);
            } catch (err) {
                if (readStream) readStream.destroy();
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
                } else {
                    // Ignore STATUS_FILE_CLOSED as it likely means the server closed the handle before we could destroy the stream
                    if (err.message && (err.message.includes('STATUS_FILE_CLOSED') || err.code === 'STATUS_FILE_CLOSED')) {
                        console.warn(`[Transfer Warn] Swallowed cleanup error for ${srcPath}:`, err.message);
                    } else {
                        throw err;
                    }
                }
            }
        };

        await performCopy();
    }
};

// POST /api/transfer (Cross-drive copy/move)
app.post('/api/transfer', async (req, res) => {
    let srcAdapter, dstAdapter;
    try {
        const { items, sourceDrive, destDrive, destPath, move, overwrite = false } = req.body;
        console.log(`[DEBUG] POST /api/transfer count=${items?.length} from=${sourceDrive} to=${destDrive} overwrite=${overwrite}`);
        if (!items || !sourceDrive || !destDrive) return res.status(400).json({ error: 'Missing parameters' });

        const srcConfig = await getDriveConfig(sourceDrive);
        const dstConfig = await getDriveConfig(destDrive);

        srcAdapter = getFSAdapter(srcConfig);
        dstAdapter = getFSAdapter(dstConfig);

        for (const itemPath of items) {
            const fileName = path.basename(itemPath);
            const targetPath = path.posix.join(destPath, fileName);
            
            try {
                await transferItemRecursive(srcAdapter, dstAdapter, itemPath, targetPath, overwrite);
                
                // If Move, delete source after successful transfer
                if (move) {
                    await srcAdapter.unlink(itemPath);
                }
            } catch (e) {
                if (e.code === 'EXIST') {
                     console.log(`[Transfer Info] Target exists, returning 409 for: ${targetPath}`);
                     return res.status(409).json({ error: 'File already exists', code: 'EXIST' });
                }
                console.error(`[Transfer Failed] ${itemPath} -> ${targetPath}:`, e);
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
        console.log(`[DEBUG] POST /api/rename old="${oldPath}" new="${newName}" drive="${driveId}" overwrite=${overwrite}`);
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
            const client = getSMBClient(config);
            const smbOld = toSMBPath(oldPath);
            const parts = smbOld.split('\\');
            parts.pop();
            const smbNew = [...parts, newName].join('\\');
            try {
                await executeSMBCommand(client, () => client.rename(smbOld, smbNew));
            } catch (e) {
                if (e.code === 'STATUS_OBJECT_NAME_COLLISION') {
                    if (overwrite) {
                        try {
                            const stats = await executeSMBCommand(client, () => client.stat(smbNew));
                            if (stats.isDirectory()) await rmDirRecursiveSMB(client, smbNew);
                            else await executeSMBCommand(client, () => client.unlink(smbNew));
                            await executeSMBCommand(client, () => client.rename(smbOld, smbNew));
                        } catch (retryErr) { throw retryErr; }
                    } else {
                        return res.status(409).json({ error: 'File already exists', code: 'EXIST' });
                    }
                } else {
                    throw e;
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
    const { path: reqPath = '/', drive: driveId = 'local' } = req.query;
    console.log(`[Upload] Processing ${uploadedFiles.length} files. Drive: ${driveId}`);

    try {
        const config = await getDriveConfig(driveId);

        if (config.type !== 'local') {
            
            for (const file of uploadedFiles) {
                try {
                    const remotePath = path.posix.join('/', reqPath, file.filename);
                    console.log(`[Upload] Transferring to ${config.type}: ${file.filename}`);
                    
                    const readStream = fs.createReadStream(file.path);

                    if (config.type === 'smb') {
                        // Use autoCloseTimeout: 0 to prevent STATUS_FILE_CLOSED during upload
                        const client = getSMBClient(config, { autoCloseTimeout: 0 });
                        try {
                            const smbPath = toSMBPath(remotePath);
                            const writeStream = await client.createWriteStream(smbPath);
                            await pipeline(readStream, writeStream);
                        } catch (err) {
                            if (err.message && (err.message.includes('STATUS_FILE_CLOSED') || err.code === 'STATUS_FILE_CLOSED')) {
                                console.warn(`[Upload Warn] Swallowed cleanup error for ${remotePath}:`, err.message);
                            } else {
                                throw err;
                            }
                        } finally {
                            await client.disconnect();
                        }
                    } else {
                         const client = getWebDAVClient(config);
                         await client.putFileContents(remotePath, readStream);
                    }
                    console.log(`[Upload] Success: ${remotePath}`);
                } catch (e) {
                    console.error(`[Upload] Failed to upload ${file.filename}:`, e);
                    throw e; 
                } finally {
                    await fs.remove(file.path).catch(e => console.error('Failed to cleanup temp file:', e));
                }
            }
        } else {
             console.log('[Upload] Local files saved directly via Multer.');
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Upload API Error]', err);
        if (uploadedFiles.length > 0 && driveId !== 'local') {
            for (const file of uploadedFiles) {
                await fs.remove(file.path).catch(() => {});
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
server.setFileSystem('/', new webdavServer.PhysicalFileSystem(STORAGE_DIR), (s) => {});
app.use(webdavServer.extensions.express('/webdav', server));

// Serve static files from React app (for production/electron)
const CLIENT_BUILD_PATH = path.join(__dirname, '../client/dist');
console.log(`[Server] Checking Client Build Path: ${CLIENT_BUILD_PATH}`);

if (fs.existsSync(CLIENT_BUILD_PATH)) {
    console.log('[Server] Client Build found. Serving static files.');
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
