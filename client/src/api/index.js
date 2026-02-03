import axios from 'axios';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { createClient } from 'webdav';
import { Buffer } from 'buffer';

// Polyfill Buffer for webdav library in browser environment if needed
if (typeof window !== 'undefined') {
    window.Buffer = window.Buffer || Buffer;
}

// --- Helper: Get WebDAV Client ---
const getWebDAVClient = (driveConfig) => {
    return createClient(driveConfig.url, {
        username: driveConfig.username,
        password: driveConfig.password
    });
};

// --- Helper: Normalize Native File Object ---
const normalizeNativeFile = (fileInfo, parentPath) => {
  // Capacitor Filesystem returns different structure
  return {
    name: fileInfo.name,
    path: parentPath === '/' ? `/${fileInfo.name}` : `${parentPath}/${fileInfo.name}`,
    isDirectory: fileInfo.type === 'directory',
    size: fileInfo.size || 0,
    mtime: fileInfo.mtime || Date.now(),
    type: fileInfo.type === 'directory' ? 'folder' : 'application/octet-stream' // Simplified
  };
};

// --- Strategy 1: Server API (Node.js/Electron) ---
const ServerAPI = {
  getFiles: async (path, driveId) => {
    const res = await axios.get(`/api/files?path=${encodeURIComponent(path)}&drive=${driveId}`);
    return res.data.files;
  },
  createFolder: async (path, driveId) => {
    await axios.post('/api/mkdir', { path, drive: driveId });
  },
  deleteItems: async (items, driveId) => {
    await axios.post('/api/delete', { items, drive: driveId });
  },
  renameItem: async (oldPath, newName, currentPath, driveId) => {
    await axios.post('/api/rename', { oldPath, newName, path: currentPath, drive: driveId });
  },
  moveItems: async (items, destination, driveId) => {
    await axios.post('/api/move', { items, destination, drive: driveId });
  },
  uploadFiles: async (path, files, driveId) => {
    const formData = new FormData();
    files.forEach(f => formData.append('files', f));
    await axios.post(`/api/upload?path=${encodeURIComponent(path)}&drive=${driveId}`, formData, { 
      headers: { 'Content-Type': 'multipart/form-data' } 
    });
  },
  getDrives: async () => {
    const res = await axios.get(`/api/drives?t=${Date.now()}`);
    return res.data;
  },
  addDrive: async (drive) => {
    const res = await axios.post('/api/drives', drive);
    return res.data;
  },
  updateDrive: async (id, data) => {
    await axios.patch(`/api/drives/${id}`, data);
  },
  testConnection: async (config) => {
    await axios.post('/api/drives/test', config);
  },
  removeDrive: async (id) => {
    await axios.delete(`/api/drives/${id}`);
  },
  getFileUrl: (path, driveId) => `/api/raw?path=${encodeURIComponent(path)}&drive=${driveId}`,
  readFileText: async (path, driveId) => {
      const res = await axios.get(`/api/raw?path=${encodeURIComponent(path)}&drive=${driveId}`, { responseType: 'text' });
      return res.data;
  }
};

// --- Strategy 2: Native API (Capacitor) ---
const NativeAPI = {
  getFiles: async (reqPath, driveId) => {
    if (driveId !== 'local') {
       // WebDAV Logic
       const drives = await NativeAPI.getDrives();
       const config = drives.find(d => d.id === driveId);
       if (!config) throw new Error("Drive not found");
       
       const client = getWebDAVClient(config);
       const items = await client.getDirectoryContents(reqPath);
       
       // Normalize WebDAV items to App format
       return items.map(item => ({
           name: item.basename,
           path: item.filename, 
           isDirectory: item.type === 'directory',
           size: item.size,
           mtime: item.lastmod,
           type: item.type === 'directory' ? 'folder' : (item.mime || 'application/octet-stream')
       }));
    }
    
    // Convert Web Path to Native Path
    // Native Root is usually 'Documents' or 'ExternalStorage'
    // Here we map '/' to Directory.Documents
    
    try {
      const res = await Filesystem.readdir({
        path: reqPath,
        directory: Directory.Documents
      });
      
      return res.files.map(f => normalizeNativeFile(f, reqPath));
    } catch (e) {
      console.error("Native Read Error:", e);
      return [];
    }
  },

  createFolder: async (path, driveId) => {
    if (driveId !== 'local') {
       const drives = await NativeAPI.getDrives();
       const config = drives.find(d => d.id === driveId);
       const client = getWebDAVClient(config);
       await client.createDirectory(path);
       return;
    }
    await Filesystem.mkdir({
      path: path,
      directory: Directory.Documents,
      recursive: true // Like ensureDir
    });
  },

  deleteItems: async (items, driveId) => {
    if (driveId !== 'local') {
       const drives = await NativeAPI.getDrives();
       const config = drives.find(d => d.id === driveId);
       const client = getWebDAVClient(config);
       await Promise.all(items.map(item => client.deleteFile(item)));
       return;
    }
    await Promise.all(items.map(itemPath => 
      Filesystem.deleteFile({
        path: itemPath,
        directory: Directory.Documents
      })
    ));
  },
  
  renameItem: async (oldPath, newName, currentPath, driveId) => {
      if (driveId !== 'local') {
        const drives = await NativeAPI.getDrives();
        const config = drives.find(d => d.id === driveId);
        const client = getWebDAVClient(config);
        
        // Construct new path
        const pathParts = oldPath.split('/');
        pathParts.pop();
        const newPath = [...pathParts, newName].join('/'); // Simple join for now
        
        await client.moveFile(oldPath, newPath);
        return;
      }
      // Capacitor 5+ supports rename directly via rename() or move()
      // We construct the new path manually
      const pathParts = oldPath.split('/');
      pathParts.pop(); // remove old name
      const baseDir = pathParts.join('/');
      const newPath = `${baseDir}/${newName}`;

      await Filesystem.rename({
          from: oldPath,
          to: newPath,
          directory: Directory.Documents
      });
  },

  moveItems: async (items, destination, driveId) => {
      if (driveId !== 'local') {
        const drives = await NativeAPI.getDrives();
        const config = drives.find(d => d.id === driveId);
        const client = getWebDAVClient(config);
        
        await Promise.all(items.map(item => {
             const destPath = `${destination}/${item.split('/').pop()}`.replace('//', '/');
             return client.moveFile(item, destPath);
        }));
        return;
      }
      // Not easily implemented without full path logic, skip for now or use copy+delete
      throw new Error("Move not fully implemented in Native mode prototype");
  },

  uploadFiles: async (path, files, driveId) => {
    // Handling File Objects in Native is tricky. 
    // Usually involves reading file into base64 and writing.
    if (driveId !== 'local') {
        const drives = await NativeAPI.getDrives();
        const config = drives.find(d => d.id === driveId);
        const client = getWebDAVClient(config);

        await Promise.all(files.map(async file => {
            const arrayBuffer = await file.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const remotePath = `${path}/${file.name}`.replace('//', '/');
            await client.putFileContents(remotePath, buffer);
        }));
        return;
    }

    for (const file of files) {
       // Quick and dirty: Read as DataURL (if small) or need a plugin to handle blobs
       // This is a complex part often requiring a specific 'FilePicker' plugin instead of standard HTML input
       console.warn("Direct upload in Native mode requires FilePicker plugin integration.");
    }
  },

  getDrives: async () => {
    // Persist drives in Capacitor Preferences instead of JSON file
    const { value } = await Preferences.get({ key: 'drives' });
    let drives = value ? JSON.parse(value) : [];
    
    // Always ensure Local is there
    if (!drives.find(d => d.id === 'local')) {
      drives.unshift({ id: 'local', name: 'On My Phone', type: 'local', path: '/' });
    }
    return drives;
  },

  addDrive: async (drive) => {
    const drives = await NativeAPI.getDrives();
    drives.push({ ...drive, id: crypto.randomUUID() });
    await Preferences.set({ key: 'drives', value: JSON.stringify(drives) });
    return drive;
  },

  updateDrive: async (id, data) => {
    let drives = await NativeAPI.getDrives();
    const index = drives.findIndex(d => d.id === id);
    if (index !== -1) {
      drives[index] = { ...drives[index], ...data };
      await Preferences.set({ key: 'drives', value: JSON.stringify(drives) });
    }
  },

  testConnection: async (config) => {
      const client = getWebDAVClient(config);
      await client.getDirectoryContents('/'); 
  },

  removeDrive: async (id) => {
    let drives = await NativeAPI.getDrives();
    drives = drives.filter(d => d.id !== id);
    await Preferences.set({ key: 'drives', value: JSON.stringify(drives) });
  },

  getFileUrl: async (path, driveId) => {
      // Returns a Promise resolving to a src string (Data URI)
      if (driveId !== 'local') {
          try {
            const drives = await NativeAPI.getDrives();
            const config = drives.find(d => d.id === driveId);
            const client = getWebDAVClient(config);
            // Get file link (download link) usually requires auth.
            // Better to download content and convert to blob URL
            const buffer = await client.getFileContents(path, { format: 'binary' });
            const blob = new Blob([buffer]);
            return URL.createObjectURL(blob);
          } catch (e) { return ''; }
      }
      try {
          const file = await Filesystem.readFile({
              path: path,
              directory: Directory.Documents
          });
          // Guess mime type roughly or assume generic
          // Filesystem returns 'data' which is base64
          return `data:application/octet-stream;base64,${file.data}`;
      } catch (e) { return ''; }
  },

  readFileText: async (path, driveId) => {
      if (driveId !== 'local') {
          const drives = await NativeAPI.getDrives();
          const config = drives.find(d => d.id === driveId);
          const client = getWebDAVClient(config);
          const text = await client.getFileContents(path, { format: 'text' });
          return text;
      }
      const file = await Filesystem.readFile({
          path: path,
          directory: Directory.Documents,
          encoding: Encoding.UTF8
      });
      return file.data;
  }
};

// --- Export Unified API ---
const isNative = Capacitor.isNativePlatform();
const api = isNative ? NativeAPI : ServerAPI;

export default api;
