package com.android.drive;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.Iterator;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.Arrays;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.RandomAccessFile;
import java.io.ByteArrayOutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.Properties;
import java.net.MalformedURLException;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okio.BufferedSink;

import android.os.StatFs;
import android.os.Environment;
import android.util.Base64;
import android.content.Intent;
import android.net.Uri;
import android.database.Cursor;
import android.provider.OpenableColumns;
import android.Manifest;
import android.provider.Settings;
import android.os.Build;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import androidx.core.app.NotificationCompat;
import android.widget.RemoteViews;
import android.os.PowerManager;

import java.util.concurrent.ConcurrentHashMap;
import okhttp3.Call;

// SMB Imports
import jcifs.CIFSContext;
import jcifs.context.SingletonContext;
import jcifs.smb.NtlmPasswordAuthenticator;
import jcifs.smb.SmbFile;
import jcifs.smb.SmbException;
import jcifs.config.PropertyConfiguration;
import jcifs.context.BaseContext;
import jcifs.smb.SmbRandomAccessFile;
import android.net.wifi.WifiManager;

@CapacitorPlugin(
    name = "WebDavNative",
    permissions = {
        @com.getcapacitor.annotation.Permission(
            alias = "post_notifications",
            strings = {Manifest.permission.POST_NOTIFICATIONS}
        )
    }
)
public class WebDavPlugin extends Plugin {

    private final AtomicInteger activeTransfers = new AtomicInteger(0);
    private final ConcurrentHashMap<String, Call> activeCalls = new ConcurrentHashMap<>();
    // Track SMB cancellations manually since they are blocking IO operations
    private final ConcurrentHashMap<String, Boolean> cancelledSmbTasks = new ConcurrentHashMap<>();

    // [PERF] Shared pool for SMB metadata operations (list, delete, mkdir, etc.)
    // Limits concurrency to prevent 0xC000009A (Insufficient Resources)
    private static final ExecutorService smbMetadataExecutor = Executors.newFixedThreadPool(4);

    // [PERF] Cache for the tuned CIFSContext
    private static CIFSContext tunedContext = null;
    private static final Object contextLock = new Object();
    private WifiManager.WifiLock wifiLock = null;

    private void startTransfer() {
        int count = activeTransfers.getAndIncrement();
        if (count == 0) {
            Context context = getContext();
            Intent intent = new Intent(context, FileTransferService.class);
            intent.setAction(FileTransferService.ACTION_START);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        }
    }

    private void endTransfer() {
        int count = activeTransfers.decrementAndGet();
        if (count <= 0) {
            activeTransfers.set(0);
            Context context = getContext();
            Intent intent = new Intent(context, FileTransferService.class);
            intent.setAction(FileTransferService.ACTION_STOP);
            context.startService(intent);
            
            // Force cancel notification ID 9999
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            manager.cancel(9999);
        }
    }

    private OkHttpClient client;

    private void initClient() {
        try {
            // Create a trust manager that does not validate certificate chains
            final javax.net.ssl.TrustManager[] trustAllCerts = new javax.net.ssl.TrustManager[] {
                new javax.net.ssl.X509TrustManager() {
                    @Override
                    public void checkClientTrusted(java.security.cert.X509Certificate[] chain, String authType) throws java.security.cert.CertificateException {
                    }

                    @Override
                    public void checkServerTrusted(java.security.cert.X509Certificate[] chain, String authType) throws java.security.cert.CertificateException {
                    }

                    @Override
                    public java.security.cert.X509Certificate[] getAcceptedIssuers() {
                        return new java.security.cert.X509Certificate[]{};
                    }
                }
            };

            // Install the all-trusting trust manager
            final javax.net.ssl.SSLContext sslContext = javax.net.ssl.SSLContext.getInstance("SSL");
            sslContext.init(null, trustAllCerts, new java.security.SecureRandom());
            
            // Create an ssl socket factory with our all-trusting manager
            final javax.net.ssl.SSLSocketFactory sslSocketFactory = sslContext.getSocketFactory();

            client = new OkHttpClient.Builder()
                .sslSocketFactory(sslSocketFactory, (javax.net.ssl.X509TrustManager)trustAllCerts[0])
                .hostnameVerifier((hostname, session) -> true)
                .protocols(Arrays.asList(Protocol.HTTP_1_1))
                .connectTimeout(60, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(0, TimeUnit.SECONDS) // No write timeout for large uploads
                .retryOnConnectionFailure(true)
                .build();

        } catch (Exception e) {
            // Fallback to default if SSL init fails (should generally not happen)
            android.util.Log.e("WebDavNative", "Failed to init unsafe SSL client", e);
            client = new OkHttpClient.Builder()
                .protocols(Arrays.asList(Protocol.HTTP_1_1))
                .connectTimeout(60, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(0, TimeUnit.SECONDS)
                .build();
        }
    }

    private LocalFileServer localServer;

    @Override
    public void load() {
        super.load();
        initClient();
        try {
            // [PERF] Global WiFi Lock for High Performance
            if (wifiLock == null) {
                WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    // WIFI_MODE_FULL_LOW_LATENCY = 4 (API 29+)
                    int lockType = WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                    if (Build.VERSION.SDK_INT >= 29) {
                        lockType = 4; // Use literal 4 to avoid compile error on older SDKs if not defined
                    }
                    wifiLock = wm.createWifiLock(lockType, "WebDavGlobalHighPerfLock");
                    wifiLock.acquire();
                    android.util.Log.i("WebDavNative", "Global WiFi Lock Acquired (Type: " + lockType + ")");
                }
            }
            
            localServer = new LocalFileServer();
            localServer.start();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (localServer != null) {
            localServer.stopServer();
        }
        if (wifiLock != null && wifiLock.isHeld()) {
            wifiLock.release();
            wifiLock = null;
            android.util.Log.i("WebDavNative", "Global WiFi Lock Released");
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void startBackgroundWork(PluginCall call) {
        startTransfer();
        call.resolve();
    }

    @PluginMethod
    public void stopBackgroundWork(PluginCall call) {
        // Force reset and stop
        activeTransfers.set(0);
        Context context = getContext();
        Intent intent = new Intent(context, FileTransferService.class);
        intent.setAction(FileTransferService.ACTION_STOP);
        context.startService(intent);
        
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        manager.cancel(9999);
        
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        if (id != null) {
            // Immediate UI feedback, only if tasks are actually running
            if (activeTransfers.get() > 0) {
                boolean isZh = java.util.Locale.getDefault().getLanguage().equals("zh");
                String title = isZh ? "正在取消..." : "Cancelling...";
                doUpdateNotification(9999, title, "", 0, 0, "");
            }
            // Cancel WebDAV
            Call c = activeCalls.get(id);
            if (c != null) {
                android.util.Log.d("WebDavNative", "Cancelling active call: " + id);
                c.cancel();
                activeCalls.remove(id);
            }
            
            // Cancel SMB
            cancelledSmbTasks.put(id, true);
        }
        call.resolve();
    }

    @PluginMethod
    public void requestBatteryOptimizationBypass(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            String packageName = getContext().getPackageName();
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
                Intent intent = new Intent();
                intent.setAction(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(Uri.parse("package:" + packageName));
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                call.resolve();
                return;
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void getServerUrl(PluginCall call) {
        if (localServer != null && localServer.getPort() > 0) {
            JSObject ret = new JSObject();
            ret.put("url", "http://127.0.0.1:" + localServer.getPort());
            call.resolve(ret);
        } else {
            call.reject("Server not running");
        }
    }

    // --- Helper: Read line from BufferedInputStream without consuming extra bytes ---
    private String readLine(BufferedInputStream in) throws IOException {
        ByteArrayOutputStream lineBuf = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') lineBuf.write(b);
        }
        if (lineBuf.size() == 0 && b == -1) return null;
        return lineBuf.toString("UTF-8");
    }

    private String formatSpeed(long bytesPerSec) {
        if (bytesPerSec < 1024 * 1024) {
            return String.format(java.util.Locale.US, "%.1f KB/s", bytesPerSec / 1024.0);
        }
        return String.format(java.util.Locale.US, "%.1f MB/s", bytesPerSec / (1024.0 * 1024.0));
    }

    // --- SMB Helpers ---
    private int getCpuCores() {
        return Runtime.getRuntime().availableProcessors();
    }

    private long getTotalMemory() {
        android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
        android.app.ActivityManager activityManager = (android.app.ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        activityManager.getMemoryInfo(mi);
        return mi.totalMem;
    }

    private CIFSContext getCifsContext(String username, String password, String domain) {
        synchronized (contextLock) {
            if (tunedContext == null) {
                int cores = getCpuCores();
                long totalMem = getTotalMemory();
                boolean isHighEnd = cores >= 6 && totalMem >= 7L * 1024 * 1024 * 1024; // 6 cores & 7GB+ RAM
                
                android.util.Log.i("WebDavNative", "PERF: Hardware Profile - Cores: " + cores + ", RAM: " + (totalMem / (1024*1024)) + "MB, HighEnd: " + isHighEnd);

                // [PERF] Extreme performance tuning (V8 Auto-Scaling)
                java.util.Properties prop = new java.util.Properties();
                prop.put("jcifs.smb.client.minVersion", "SMB202");
                prop.put("jcifs.smb.client.maxVersion", "SMB311");
                prop.put("jcifs.smb.client.readSize", "8388608"); // 8MB read size for Hyper-Turbo
                prop.put("jcifs.smb.client.writeSize", "8388608"); 
                
                // Dynamic Buffer & Window Sizes
                String bufSize = isHighEnd ? "67108864" : "33554432"; // 64MB if high-end, else 32MB
                prop.put("jcifs.smb.client.rcv_buf_size", bufSize);
                prop.put("jcifs.smb.client.snd_buf_size", bufSize);
                prop.put("jcifs.smb.client.maximumBufferSize", bufSize);
                prop.put("jcifs.smb.client.transactionSize", bufSize);
                prop.put("jcifs.smb.client.socketReceiveBufferSize", bufSize);
                prop.put("jcifs.smb.client.socketSendBufferSize", bufSize);

                prop.put("jcifs.smb.client.useLargeReadWrite", "true");
                prop.put("jcifs.smb.client.maxMpxCount", isHighEnd ? "2048" : "1024");
                prop.put("jcifs.smb.client.maximumCredits", isHighEnd ? "16384" : "8192"); 
                
                prop.put("jcifs.smb.client.signingPreferred", "false");
                prop.put("jcifs.smb.client.signingEnforced", "false");
                prop.put("jcifs.smb.client.ipcSigningEnforced", "false");
                prop.put("jcifs.smb.client.tcpNoDelay", "true");
                prop.put("jcifs.smb.client.disableSpnegoIntegrity", "true");
                prop.put("jcifs.smb.client.disableSpnegoSgn", "true");
                prop.put("jcifs.smb.client.encryptionPreferred", "false");
                prop.put("jcifs.smb.client.useSessKeepalive", "true");
                prop.put("jcifs.smb.client.dfs.disabled", "true");
                prop.put("jcifs.smb.client.useBatching", "true");
                prop.put("jcifs.resolveOrder", "DNS");
                
                try {
                    PropertyConfiguration config = new PropertyConfiguration(prop);
                    android.util.Log.i("WebDavNative", "PERF: JCIFS V8 (Auto-Scaling) properties applied");
                    tunedContext = new BaseContext(config);
                } catch (Exception e) {
                    android.util.Log.e("WebDavNative", "Failed to load tuned JCIFS properties, using default", e);
                    tunedContext = SingletonContext.getInstance();
                }
            }
        }

        if (username != null && !username.isEmpty()) {
            NtlmPasswordAuthenticator auth = new NtlmPasswordAuthenticator(domain, username, password);
            return tunedContext.withCredentials(auth);
        }
        return tunedContext.withGuestCrendentials();
    }
    private String buildSmbUrl(String host, String share, String path) {
        StringBuilder sb = new StringBuilder("smb://");
        sb.append(host);
        if (!host.endsWith("/")) sb.append("/");
        if (share != null && !share.isEmpty()) {
            sb.append(share);
            if (!share.endsWith("/")) sb.append("/");
        }
        if (path != null && !path.isEmpty()) {
            String p = path.startsWith("/") ? path.substring(1) : path;
            sb.append(p);
        }
        // NOTE: SmbFile requires directory URLs to end with / for some operations, but regular files usually don't.
        // It's safer to let the logic handle trailing slashes or add them if we know it's a dir.
        return sb.toString();
    }

    @PluginMethod
    public void smbConnect(PluginCall call) {
        String address = call.getString("address");
        String share = call.getString("share");
        String username = call.getString("username");
        String password = call.getString("password");
        String domain = call.getString("domain");

        if (address == null || share == null) {
            call.reject("Address and Share are required");
            return;
        }

        try {
            CIFSContext ctx = getCifsContext(username, password, domain);
            String url = buildSmbUrl(address, share, "");
            SmbFile f = new SmbFile(url, ctx);
            
            // Try to connect/list
            if (f.exists()) {
                call.resolve();
            } else {
                call.reject("Share not found or access denied");
            }
        } catch (Exception e) {
            call.reject("SMB Connection Failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void smbListDirectory(PluginCall call) {
        String address = call.getString("address");
        String share = call.getString("share");
        String path = call.getString("path");
        String username = call.getString("username");
        String password = call.getString("password");
        String domain = call.getString("domain");

        if (address == null || share == null) {
            call.reject("Address and Share are required");
            return;
        }

        smbMetadataExecutor.execute(() -> {
            try {
                CIFSContext ctx = getCifsContext(username, password, domain);
                String url = buildSmbUrl(address, share, path);
                if (!url.endsWith("/")) url += "/"; // List requires dir
                
                SmbFile dir = new SmbFile(url, ctx);
                SmbFile[] files = dir.listFiles();
                
                com.getcapacitor.JSArray results = new com.getcapacitor.JSArray();
                if (files != null) {
                    for (SmbFile f : files) {
                        JSObject item = new JSObject();
                        String name = f.getName();
                        // Remove trailing slash from name for consistency
                        if (name.endsWith("/")) name = name.substring(0, name.length() - 1);
                        
                        item.put("name", name);
                        item.put("isDirectory", f.isDirectory());
                        item.put("size", f.length());
                        item.put("mtime", f.lastModified());
                        
                        // Construct path relative to share root? 
                        // Frontend expects full path from root e.g. /Folder/File
                        // Our `path` input is relative to share.
                        // But f.getName() returns just the name usually? 
                        // Actually SmbFile.getName() returns the last component + slash if dir.
                        
                        // We construct the 'path' field for the frontend
                        String parentPath = path.startsWith("/") ? path : "/" + path;
                        if (!parentPath.endsWith("/")) parentPath += "/";
                        item.put("path", parentPath + name);
                        
                        results.put(item);
                    }
                }
                
                JSObject ret = new JSObject();
                ret.put("items", results);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("SMB List Failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void smbDelete(PluginCall call) {
        String address = call.getString("address");
        String share = call.getString("share");
        String path = call.getString("path");
        String username = call.getString("username");
        String password = call.getString("password");
        String domain = call.getString("domain");

        if (address == null || share == null || path == null) {
            call.reject("Missing parameters");
            return;
        }

        smbMetadataExecutor.execute(() -> {
            try {
                CIFSContext ctx = getCifsContext(username, password, domain);
                String url = buildSmbUrl(address, share, path);
                SmbFile f = new SmbFile(url, ctx);
                
                // If not found, try appending '/' to treat as directory
                if (!f.exists()) {
                    if (!url.endsWith("/")) {
                        String dirUrl = url + "/";
                        SmbFile dirF = new SmbFile(dirUrl, ctx);
                        if (dirF.exists()) {
                            f = dirF;
                        } else {
                            call.reject("SMB Delete Failed: The system cannot find the file specified.");
                            return;
                        }
                    } else {
                         call.reject("SMB Delete Failed: The system cannot find the file specified.");
                         return;
                    }
                }

                if (f.isDirectory()) {
                    android.util.Log.d("WebDavNative", "Deleting directory recursive: " + f.getPath());
                    deleteRecursive(f);
                } else {
                    f.delete();
                }
                call.resolve();
            } catch (Exception e) {
                android.util.Log.e("WebDavNative", "SMB Delete Error", e);
                call.reject("SMB Delete Failed: " + e.getMessage());
            }
        });
    }

    private void deleteRecursive(SmbFile file) throws Exception {
        // Validation: If it's a directory, ensure URL ends with '/' for correct context resolution
        SmbFile cleanFile = file;
        if (file.isDirectory() && !file.getPath().endsWith("/")) {
            cleanFile = new SmbFile(file.getPath() + "/", file.getContext());
        }
        
        String url = cleanFile.getPath();

        if (cleanFile.isDirectory()) {
            try {
                // Now safe to use listFiles() because cleanFile has trailing slash
                SmbFile[] children = cleanFile.listFiles();
                if (children != null) {
                    for (SmbFile child : children) {
                        deleteRecursive(child);
                    }
                }
            } catch (Exception e) {
                android.util.Log.w("WebDavNative", "Failed to list directory: " + url, e);
            }
        }

        try {
            // Delete the directory/file itself
            // Note: use the original file object if the slash version has issues deleting? 
            // Usually slash version is fine for delete().
            cleanFile.delete(); 
            // android.util.Log.d("WebDavNative", "Deleted: " + url);
        } catch (Exception e) {
            String msg = e.getMessage();
            if (msg != null && (msg.contains("cannot find") || msg.contains("No such file"))) {
                android.util.Log.w("WebDavNative", "File not found during delete (ignoring): " + url);
            } else {
                throw e;
            }
        }
    }

    @PluginMethod
    public void smbMkdir(PluginCall call) {
        String address = call.getString("address");
        String share = call.getString("share");
        String path = call.getString("path");
        String username = call.getString("username");
        String password = call.getString("password");
        String domain = call.getString("domain");

        if (address == null || share == null || path == null) {
            call.reject("Missing parameters");
            return;
        }

        smbMetadataExecutor.execute(() -> {
            try {
                CIFSContext ctx = getCifsContext(username, password, domain);
                String url = buildSmbUrl(address, share, path);
                // Ensure trailing slash for directory URL in jcifs
                if (!url.endsWith("/")) url += "/";
                
                SmbFile f = new SmbFile(url, ctx);
                if (!f.exists()) {
                    f.mkdirs();
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("SMB Mkdir Failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void smbRename(PluginCall call) {
        String address = call.getString("address");
        String share = call.getString("share");
        String oldPath = call.getString("oldPath");
        String newPath = call.getString("newPath");
        String username = call.getString("username");
        String password = call.getString("password");
        String domain = call.getString("domain");

        if (address == null || share == null || oldPath == null || newPath == null) {
            call.reject("Missing parameters");
            return;
        }

        smbMetadataExecutor.execute(() -> {
            try {
                CIFSContext ctx = getCifsContext(username, password, domain);
                String oldUrl = buildSmbUrl(address, share, oldPath);
                String newUrl = buildSmbUrl(address, share, newPath);
                Boolean overwrite = call.getBoolean("overwrite", false);
                
                SmbFile f = new SmbFile(oldUrl, ctx);
                
                // For directories, ensure URLs end with /
                boolean isSourceDir = f.isDirectory();
                if (isSourceDir) {
                    if (!oldUrl.endsWith("/")) oldUrl += "/";
                    if (!newUrl.endsWith("/")) newUrl += "/";
                    f = new SmbFile(oldUrl, ctx);
                }
                
                SmbFile dest = new SmbFile(newUrl, ctx);
                
                if (dest.exists()) {
                    if (!overwrite) {
                        call.reject("File exists");
                        return;
                    }
                    // For directories, need recursive delete
                    try {
                        if (dest.isDirectory()) {
                            deleteRecursive(dest);
                        } else {
                            dest.delete();
                        }
                    } catch (Exception delErr) {
                        android.util.Log.w("WebDavNative", "Failed to delete for overwrite: " + delErr.getMessage());
                    }
                }
                
                f.renameTo(dest);
                call.resolve();
            } catch (Exception e) {
                call.reject("SMB Rename Failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void smbCopy(PluginCall call) {
        String address = call.getString("address");
        String share = call.getString("share");
        String path = call.getString("path");
        String newPath = call.getString("newPath");
        String username = call.getString("username");
        String password = call.getString("password");
        String domain = call.getString("domain");

        if (address == null || share == null || path == null || newPath == null) {
            call.reject("Missing parameters");
            return;
        }

        new Thread(() -> {
            try {
                CIFSContext ctx = getCifsContext(username, password, domain);
                String url = buildSmbUrl(address, share, path);
                String newUrl = buildSmbUrl(address, share, newPath);
                Boolean overwrite = call.getBoolean("overwrite", false);

                SmbFile f = new SmbFile(url, ctx);
                
                // For directories, ensure URLs end with / to avoid "paths overlap" error
                if (f.isDirectory()) {
                    if (!url.endsWith("/")) url += "/";
                    if (!newUrl.endsWith("/")) newUrl += "/";
                    f = new SmbFile(url, ctx);
                }
                
                android.util.Log.d("WebDavNative", "SMB Copy: " + url + " -> " + newUrl + " (overwrite=" + overwrite + ")");

                SmbFile dest = new SmbFile(newUrl, ctx);

                if (dest.exists()) {
                     if (!overwrite) {
                         call.reject("File exists");
                         return;
                     }
                     try {
                         if (dest.isDirectory()) {
                             deleteRecursive(dest);
                         } else {
                             dest.delete();
                         }
                     } catch (Exception ignore) {
                         android.util.Log.w("WebDavNative", "Failed to delete existing destination: " + ignore.getMessage());
                     }
                }
                
                f.copyTo(dest);
                call.resolve();
            } catch (Exception e) {
                android.util.Log.e("WebDavNative", "SMB Copy Error", e);
                call.reject("SMB Copy Failed: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void smbDownload(PluginCall call) {
        startTransfer();
        final String callbackId = call.getString("id");
        if (callbackId != null) cancelledSmbTasks.put(callbackId, false);

        String address = call.getString("address");
        String share = call.getString("share");
        String remotePath = call.getString("path");
        String destPath = call.getString("destPath");
        String username = call.getString("username");
        String password = call.getString("password");
        String domain = call.getString("domain");

        if (address == null || share == null || remotePath == null || destPath == null) {
            call.reject("Missing parameters");
            endTransfer(); // Ensure endTransfer is called on early exit
            return;
        }

        new Thread(() -> {
            try {
                // [FIX] Immediate notification to eliminate delay
                boolean isZhInit = java.util.Locale.getDefault().getLanguage().equals("zh");
                String titleInit = isZhInit ? "正在连接 SMB..." : "Connecting SMB...";
                String fileNameInit = remotePath.contains("/") ? remotePath.substring(remotePath.lastIndexOf('/') + 1) : remotePath;
                doUpdateNotification(9999, titleInit, fileNameInit, 0, 0, "");

                CIFSContext ctx = getCifsContext(username, password, domain);
                String url = buildSmbUrl(address, share, remotePath);
                SmbFile smbFile = new SmbFile(url, ctx);

                if (!smbFile.exists()) {
                    call.reject("File not found");
                    return;
                }

                File localFile;
                File root = Environment.getExternalStorageDirectory();
                if (destPath.startsWith(root.getAbsolutePath())) {
                    localFile = new File(destPath);
                } else if (destPath.startsWith("/")) {
                    // Check for known absolute paths
                    if (destPath.startsWith("/data/") || destPath.startsWith("/storage/") || destPath.startsWith("/sdcard/")) {
                        localFile = new File(destPath);
                    } else {
                        localFile = new File(root, destPath.substring(1));
                    }
                } else {
                    localFile = new File(root, destPath);
                }
                
                android.util.Log.d("WebDavNative", "Resolved SMB download target: " + localFile.getAbsolutePath());
                
                // Create parent dirs
                File parent = localFile.getParentFile();
                if (parent != null && !parent.exists()) {
                    parent.mkdirs();
                }

                final long fileSize = smbFile.length();
                if (fileSize <= 0) {
                    localFile.createNewFile(); // Create an empty file
                    call.resolve();
                    return;
                }

                final java.util.concurrent.atomic.AtomicLong downloaded = new java.util.concurrent.atomic.AtomicLong(0);
                final java.util.concurrent.atomic.AtomicBoolean hasError = new java.util.concurrent.atomic.AtomicBoolean(false);
                final java.lang.StringBuilder errorMsg = new java.lang.StringBuilder();
                final String finalFileName = smbFile.getName();

                // [PERF] Survivor-Turbo V9.4 (Stabilized)
                android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
                ((android.app.ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE)).getMemoryInfo(mi);
                
                int cores = getCpuCores();
                long availMemMB = mi.availMem / (1024 * 1024);
                boolean isHighEnd = cores >= 6 && mi.totalMem >= 7L * 1024 * 1024 * 1024;
                
                // [PERF] Smooth-Hyper V9.6 (Balanced Concurrency)
                int threadCount = 1;
                if (mi.lowMemory) {
                    threadCount = 4;
                } else if (fileSize > 100 * 1024 * 1024) {
                    threadCount = isHighEnd ? 20 : 12; // 20 threads: Optimal for Wi-Fi & CPU switching
                } else if (fileSize > 50 * 1024 * 1024) {
                    threadCount = 8;
                } else {
                    threadCount = 4;
                }
                
                final int bufferSize = 4194304; // 4MB: Sweet spot for stability + throughput
                final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(threadCount);
                android.util.Log.i("WebDavNative", "Starting V9.6 SMOOTH-HYPER: " + threadCount + " threads, Buffer 4MB");

                for (int i = 0; i < threadCount; i++) {
                    final int threadIndex = i;
                    final int totalThreads = threadCount;
                    new Thread(() -> {
                        long start = threadIndex * (fileSize / totalThreads);
                        long end = (threadIndex == totalThreads - 1) ? fileSize - 1 : (threadIndex + 1) * (fileSize / totalThreads) - 1;
                        if (start > end) { latch.countDown(); return; }

                        try (jcifs.smb.SmbFile sf = new jcifs.smb.SmbFile(url, ctx);
                             jcifs.smb.SmbRandomAccessFile sraf = new jcifs.smb.SmbRandomAccessFile(sf, "r");
                             java.io.RandomAccessFile raf = new java.io.RandomAccessFile(localFile, "rw")) {
                            
                            sraf.seek(start);
                            raf.seek(start);
                            
                            byte[] buffer = new byte[bufferSize]; 
                            long pos = start;

                            while (pos <= end && !hasError.get()) {
                                if (callbackId != null && Boolean.TRUE.equals(cancelledSmbTasks.get(callbackId))) {
                                    throw new java.io.IOException("Cancelled");
                                }
                                
                                int toRead = (int) Math.min(bufferSize, end - pos + 1);
                                if (toRead <= 0) break;

                                int read = sraf.read(buffer, 0, toRead);
                                if (read == -1) break;
                                
                                raf.write(buffer, 0, read);
                                downloaded.addAndGet(read);
                                pos += read;
                            }
                        } catch (Exception e) {
                            hasError.set(true);
                            errorMsg.append(e.getMessage());
                            android.util.Log.e("WebDavNative", "T" + threadIndex + " error: " + e.getMessage());
                        } finally {
                            latch.countDown();
                        }
                    }).start();
                    
                    try { Thread.sleep(40); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                }

                // Smooth Performance Monitor (V9.6 EMA)
                long lastUpdate = System.currentTimeMillis();
                long lastBytes = 0;
                long smoothedSpeed = 0;

                while (latch.getCount() > 0 && !hasError.get()) {
                    long now = System.currentTimeMillis();
                    long dt = now - lastUpdate;
                    if (dt >= 1000) {
                        long current = downloaded.get();
                        long instantSpeed = (current - lastBytes) * 1000 / dt;
                        
                        // [V9.6] EMA Smoothing: 30% instant + 70% history
                        // This filters out the "sawtooth" effect of multi-threaded IO spikes
                        if (smoothedSpeed == 0) smoothedSpeed = instantSpeed;
                        else smoothedSpeed = (long) (smoothedSpeed * 0.7 + instantSpeed * 0.3);

                        JSObject ret = new JSObject();
                        ret.put("downloaded", current);
                        ret.put("total", fileSize);
                        ret.put("speed", smoothedSpeed);
                        ret.put("id", callbackId != null ? callbackId : "smb_smooth_hyper");
                        notifyListeners("downloadProgress", ret);

                        doUpdateNotification(9999, isZhInit ? "正在下载" : "Downloading", finalFileName, (int)(current/1024), (int)(fileSize/1024), formatSpeed(smoothedSpeed));
                        
                        lastUpdate = now;
                        lastBytes = current;
                    }
                    try { Thread.sleep(500); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                }
                latch.await();

                if (hasError.get()) {
                    if (errorMsg.toString().contains("Cancelled")) throw new java.io.IOException("Cancelled");
                    throw new Exception(errorMsg.toString());
                }

                doUpdateNotification(9999, isZhInit ? "下载完成" : "Download Complete", finalFileName, (int)(fileSize/1024), (int)(fileSize/1024), "");
                call.resolve();

            } catch (Exception e) {
                if (e.getMessage() != null && e.getMessage().equals("Cancelled")) {
                    android.util.Log.d("WebDavNative", "SMB Download Cancelled");
                    call.reject("Cancelled");
                } else {
                    android.util.Log.e("WebDavNative", "SMB Download Error: " + e.getMessage(), e);
                    call.reject("SMB Download Error: " + e.getMessage());
                }
            } finally {
                if (callbackId != null) cancelledSmbTasks.remove(callbackId);
                endTransfer();
            }
        }).start();
    }

    @PluginMethod
    public void smbUpload(PluginCall call) {
        startTransfer();
        final String callbackId = call.getString("id");
        if (callbackId != null) cancelledSmbTasks.put(callbackId, false);

        String address = call.getString("address");
        String share = call.getString("share");
        String remotePath = call.getString("path");
        String sourcePath = call.getString("sourcePath");
        String username = call.getString("username");
        String password = call.getString("password");
        String domain = call.getString("domain");

        if (address == null || share == null || remotePath == null || sourcePath == null) {
            call.reject("Missing parameters");
            endTransfer(); // Ensure endTransfer is called on early exit
            return;
        }

        new Thread(() -> {
            try {
                // [FIX] Immediate notification to eliminate delay
                boolean isZhInit = java.util.Locale.getDefault().getLanguage().equals("zh");
                String titleInit = isZhInit ? "正在连接 SMB..." : "Connecting SMB...";
                String fileNameInit = sourcePath.contains("/") ? sourcePath.substring(sourcePath.lastIndexOf('/') + 1) : sourcePath;
                doUpdateNotification(9999, titleInit, fileNameInit, 0, 0, "");

                final boolean isContentUri = sourcePath.startsWith("content://");
                final File localFile;
                final long fileSize;
                final String sourceName;

                if (isContentUri) {
                    localFile = null;
                    Uri uri = Uri.parse(sourcePath);
                    long querySize = -1;
                    String queryName = "Shared File";
                    try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
                        if (cursor != null && cursor.moveToFirst()) {
                             int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                             if (sizeIndex != -1) querySize = cursor.getLong(sizeIndex);
                             int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                             if (nameIndex != -1) queryName = cursor.getString(nameIndex);
                        }
                    }
                    if (querySize == -1) {
                        call.reject("Could not determine size of content URI");
                        return;
                    }
                    fileSize = querySize;
                    sourceName = queryName;
                } else {
                    File temp = new File(sourcePath);
                    if (!temp.exists()) {
                        File root = Environment.getExternalStorageDirectory();
                        if (sourcePath.startsWith("/")) {
                             // Absolute path check
                             if (sourcePath.startsWith(root.getAbsolutePath())) {
                                  // it's absolute
                             } else {
                                  // might be relative to root
                                  File check = new File(root, sourcePath.substring(1));
                                  if (check.exists()) temp = check;
                             }
                        }
                        // Re-resolve somewhat to ensure we find it if it's relative
                        if (!temp.exists()) {
                             temp = new File(root, sourcePath.startsWith("/") ? sourcePath.substring(1) : sourcePath);
                        }
                        if (!temp.exists()) {
                             temp = new File(getContext().getExternalCacheDir(), sourcePath.startsWith("/") ? sourcePath.substring(1) : sourcePath);
                        }
                    }
                    
                    if (!temp.exists()) {
                        call.reject("Source file not found: " + sourcePath);
                        return;
                    }
                    localFile = temp;
                    fileSize = localFile.length();
                    sourceName = localFile.getName();
                }

                // Overwrite check (logic remains same for remote dest)
                Boolean overwrite = call.getBoolean("overwrite", false);
                CIFSContext ctx = getCifsContext(username, password, domain);
                String url = buildSmbUrl(address, share, remotePath);
                SmbFile smbFile = new SmbFile(url, ctx);

                if (smbFile.exists() && !overwrite) {
                    call.reject("File exists");
                    return;
                }

                try {
                    String parentUrl = url.substring(0, url.lastIndexOf('/'));
                    if (parentUrl.length() > ("smb://" + address + "/" + share).length()) {
                         SmbFile parent = new SmbFile(parentUrl + "/", ctx);
                         if (!parent.exists()) parent.mkdirs();
                    }
                } catch(Exception e) { /* ignore */ }

                long uploaded = 0;
                long lastUpdate = 0;
                long lastBytes = 0;
                
                InputStream in = null;
                try {
                     if (isContentUri) {
                         in = getContext().getContentResolver().openInputStream(Uri.parse(sourcePath));
                     } else {
                         in = new java.io.FileInputStream(localFile);
                     }
                     
                     if (in == null) throw new IOException("Failed to open input stream");
                     
                     try (java.io.BufferedOutputStream out = new java.io.BufferedOutputStream(smbFile.getOutputStream(), 2097152)) {
                        byte[] buffer = new byte[8388608]; // [PERF] 8MB buffer
                        int read;
                        
                        // Initial notification update
                        String threadTitle = isZhInit ? "正在上传" : "Uploading";
                        doUpdateNotification(9999, threadTitle, sourceName, 0, (int)(fileSize/1024), "");

                        while ((read = in.read(buffer)) != -1) {
                            if (callbackId != null && Boolean.TRUE.equals(cancelledSmbTasks.get(callbackId))) {
                                throw new IOException("Cancelled");
                            }
                            out.write(buffer, 0, read);
                            uploaded += read;
    
                            long now = System.currentTimeMillis();
                            if (now - lastUpdate > 1000) {
                                if (callbackId != null && Boolean.TRUE.equals(cancelledSmbTasks.get(callbackId))) throw new IOException("Cancelled");
    
                                JSObject ret = new JSObject();
                                ret.put("uploaded", uploaded);
                                ret.put("total", fileSize);
                                
                                long diffBytes = uploaded - lastBytes;
                                long diffTime = now - lastUpdate;
                                long speed = diffTime > 0 ? (diffBytes * 1000 / diffTime) : 0;
                                
                                ret.put("speed", speed);
                                if (callbackId != null) ret.put("id", callbackId);
                                notifyListeners("uploadProgress", ret);
    
                                String speedStr = formatSpeed(speed);
                                
                                boolean isZh = java.util.Locale.getDefault().getLanguage().equals("zh");
                                String title = isZh ? "正在上传" : "Uploading";
                                
                                doUpdateNotification(9999, title, sourceName, (int)(uploaded/1024), (int)(fileSize/1024), speedStr);
                                
                                lastUpdate = now;
                                lastBytes = uploaded;
                            }
                        }
                        out.flush();
                        
                        // Force 100% notification on completion
                        boolean isZhFinal = java.util.Locale.getDefault().getLanguage().equals("zh");
                        String titleFinal = isZhFinal ? "上传完成" : "Upload Complete";
                        doUpdateNotification(9999, titleFinal, sourceName, (int)(fileSize/1024), (int)(fileSize/1024), "");
                     }
                } finally {
                     if (in != null) try { in.close(); } catch (IOException e) {}
                }
                call.resolve();

            } catch (Exception e) {
                if (e.getMessage() != null && e.getMessage().equals("Cancelled")) {
                    android.util.Log.d("WebDavNative", "SMB Upload Cancelled");
                    call.reject("Cancelled");
                } else {
                    android.util.Log.e("WebDavNative", "SMB Upload Error", e);
                    call.reject("SMB Upload Error: " + e.getMessage());
                }
            } finally {
                if (callbackId != null) cancelledSmbTasks.remove(callbackId);
                endTransfer();
            }
        }).start();
    }

    // ... (Keep existing LocalFileServer class and other methods)

    private class LocalFileServer extends Thread {
        private ServerSocket serverSocket;
        private int port;
        private boolean isRunning = true;
        private final ExecutorService executor = Executors.newFixedThreadPool(16);
        private final AtomicInteger activeStreams = new AtomicInteger(0);

        public LocalFileServer() throws IOException {
            serverSocket = new ServerSocket(0);
            port = serverSocket.getLocalPort();
        }

        public int getPort() {
            return port;
        }

        public void stopServer() {
            isRunning = false;
            try { serverSocket.close(); } catch (Exception e) {}
            executor.shutdownNow();
        }

        @Override
        public void run() {
            while (isRunning) {
                try {
                    Socket socket = serverSocket.accept();
                    executor.submit(() -> handleClient(socket));
                } catch (IOException e) {
                    if (isRunning) e.printStackTrace();
                }
            }
        }

        private void handleClient(Socket socket) {
            try (InputStream rawIn = socket.getInputStream();
                 OutputStream out = socket.getOutputStream()) {
                
                BufferedInputStream in = new BufferedInputStream(rawIn);
                
                String requestLine = readLine(in);
                if (requestLine == null) return;

                String[] parts = requestLine.split(" ");
                if (parts.length < 2) return;
                
                String method = parts[0].toUpperCase();
                String path = java.net.URLDecoder.decode(parts[1], "UTF-8");
                
                long contentLength = -1;
                long rangeStart = 0;
                long rangeEnd = -1;

                String line;
                while ((line = readLine(in)) != null && !line.isEmpty()) {
                    String lower = line.toLowerCase();
                    if (lower.startsWith("content-length:")) {
                        contentLength = Long.parseLong(line.substring(15).trim());
                    } else if (lower.startsWith("range:")) {
                        Pattern p = Pattern.compile("bytes=(\\d+)-(\\d*)");
                        Matcher m = p.matcher(lower);
                        if (m.find()) {
                            rangeStart = Long.parseLong(m.group(1));
                            if (!m.group(2).isEmpty()) {
                                rangeEnd = Long.parseLong(m.group(2));
                            }
                        }
                    }
                }

                // Route: /smb/stream?address=...
                if (path.startsWith("/smb")) {
                    if ("OPTIONS".equals(method)) {
                        out.write("HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Allow-Headers: Range, Content-Type\r\nAccess-Control-Max-Age: 86400\r\n\r\n".getBytes());
                    } else {
                        handleSmbStream(parts[1], rangeStart, rangeEnd, out);
                    }
                    return;
                }

                File root;
                if (path.startsWith("/cache/")) {
                    root = getContext().getExternalCacheDir();
                    path = path.substring(7);
                } else {
                    root = Environment.getExternalStorageDirectory();
                }
                
                File file = new File(root, path);
                
                if (!file.getCanonicalPath().startsWith(root.getCanonicalPath())) {
                    out.write("HTTP/1.1 403 Forbidden\r\n\r\n".getBytes());
                    return;
                }

                if ("PUT".equals(method)) {
                    File parent = file.getParentFile();
                    if (!parent.exists()) parent.mkdirs();
                    
                    boolean success = false;
                    try (FileOutputStream fos = new FileOutputStream(file)) {
                         byte[] buffer = new byte[65536];
                         long bytesLeft = contentLength;
                         int read;
                         while (bytesLeft > 0 || contentLength == -1) {
                             int maxRead = (contentLength == -1) ? buffer.length : (int) Math.min(buffer.length, bytesLeft);
                             read = in.read(buffer, 0, maxRead);
                             if (read == -1) break;
                             fos.write(buffer, 0, read);
                             if (contentLength != -1) bytesLeft -= read;
                         }
                         success = true;
                    } catch (Exception e) {
                        e.printStackTrace();
                    } finally {
                        if (!success && file.exists()) {
                            android.util.Log.d("WebDavNative", "Deleting partial PUT file: " + file.getAbsolutePath());
                            file.delete();
                        }
                    }
                    if (success) {
                        out.write("HTTP/1.1 201 Created\r\nAccess-Control-Allow-Origin: *\r\n\r\n".getBytes());
                    } else {
                        out.write("HTTP/1.1 500 Internal Server Error\r\n\r\n".getBytes());
                    }
                } else if ("OPTIONS".equals(method)) {
                    out.write("HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, PUT, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n\r\n".getBytes());
                } else {
                    if (!file.exists() || !file.isFile()) {
                        out.write("HTTP/1.1 404 Not Found\r\n\r\n".getBytes());
                        return;
                    }

                    long fileLength = file.length();
                    if (rangeEnd == -1) rangeEnd = fileLength - 1;
                    long finalLength = rangeEnd - rangeStart + 1;

                    StringBuilder headers = new StringBuilder();
                    headers.append("HTTP/1.1 206 Partial Content\r\n");
                    headers.append("Content-Type: application/octet-stream\r\n"); 
                    headers.append("Accept-Ranges: bytes\r\n");
                    headers.append("Content-Length: ").append(finalLength).append("\r\n");
                    headers.append("Content-Range: bytes ").append(rangeStart).append("-").append(rangeEnd).append("/").append(fileLength).append("\r\n");
                    headers.append("Access-Control-Allow-Origin: *\r\n");
                    headers.append("\r\n");
                    out.write(headers.toString().getBytes());

                    try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
                        raf.seek(rangeStart);
                        byte[] buffer = new byte[65536];
                        long bytesToRead = finalLength;
                        while (bytesToRead > 0) {
                            int read = raf.read(buffer, 0, (int) Math.min(buffer.length, bytesToRead));
                            if (read == -1) break;
                            out.write(buffer, 0, read);
                            bytesToRead -= read;
                        }
                    }
                }

            } catch (Exception e) {
                e.printStackTrace();
            } finally {
                try { socket.close(); } catch (IOException e) {}
            }
        }

        public void handleSmbStream(String uri, long rangeStart, long rangeEnd, OutputStream out) {
            SmbRandomAccessFile raf = null;
            final int streamId = activeStreams.incrementAndGet();
            
            try {
                android.util.Log.d("WebDavNative", "handleSmbStream: " + uri);
                
                int qIndex = uri.indexOf('?');
                if (qIndex == -1) {
                    out.write("HTTP/1.1 400 Bad Request\r\n\r\n".getBytes());
                    return;
                }
                
                String query = uri.substring(qIndex + 1);
                String[] pairs = query.split("&");
                String address = null, share = null, path = null, user = "", pass = "", domain = "";
                
                for (String pair : pairs) {
                    int idx = pair.indexOf('=');
                    if (idx > 0) {
                        String key = java.net.URLDecoder.decode(pair.substring(0, idx), "UTF-8");
                        String val = java.net.URLDecoder.decode(pair.substring(idx + 1), "UTF-8");
                        if (key.equals("address")) address = val;
                        else if (key.equals("share")) share = val;
                        else if (key.equals("path")) path = val;
                        else if (key.equals("username")) user = val;
                        else if (key.equals("password")) pass = val;
                        else if (key.equals("domain")) domain = val;
                    }
                }

                if (address == null || share == null || path == null) {
                    out.write("HTTP/1.1 400 Bad Request (Missing Params)\r\n\r\n".getBytes());
                    return;
                }

                // [PERF] Seek-first strategy:
                // For small range requests (common when dragging progress bar), prefer
                // single-lane low-latency streaming over high-throughput multi-lane mode.
                final int CHUNK_SIZE = 2 * 1024 * 1024;
                final BytePool bytePool = BytePool.getInstance(CHUNK_SIZE);
                
                CIFSContext ctx = getCifsContext(user, pass, domain);
                String url = buildSmbUrl(address, share, path);
                final SmbFile smbFile = new SmbFile(url, ctx);
                
                raf = new SmbRandomAccessFile(smbFile, "r");
                long fileLength = raf.length();

                if (rangeEnd == -1) rangeEnd = fileLength - 1;
                long contentLength = rangeEnd - rangeStart + 1;
                
                // Headers
                StringBuilder headers = new StringBuilder();
                headers.append("HTTP/1.1 206 Partial Content\r\n");
                headers.append("Content-Type: video/mp4\r\n"); 
                headers.append("Accept-Ranges: bytes\r\n");
                headers.append("Content-Length: ").append(contentLength).append("\r\n");
                headers.append("Content-Range: bytes ").append(rangeStart).append("-").append(rangeEnd).append("/").append(fileLength).append("\r\n");
                headers.append("Access-Control-Allow-Origin: *\r\n");
                headers.append("\r\n");
                out.write(headers.toString().getBytes());

                final boolean hasExplicitRange = (rangeStart > 0) || (rangeEnd < fileLength - 1);
                if (hasExplicitRange && contentLength <= 8L * 1024L * 1024L) {
                    // Low-latency path for frequent seek operations.
                    BufferedOutputStream bout = new BufferedOutputStream(out, 64 * 1024);
                    byte[] buffer = new byte[256 * 1024];
                    long remaining = contentLength;
                    raf.seek(rangeStart);
                    while (remaining > 0) {
                        int toRead = (int) Math.min(buffer.length, remaining);
                        int read = raf.read(buffer, 0, toRead);
                        if (read <= 0) break;
                        bout.write(buffer, 0, read);
                        remaining -= read;
                    }
                    bout.flush();
                    return;
                }
                
                final int THREAD_COUNT = 3;
                final ConcurrentHashMap<Long, SMBChunk> bufferMap = new ConcurrentHashMap<>();
                final java.util.concurrent.Semaphore bufferPermits = new java.util.concurrent.Semaphore(16); // 32MB Buffer
                final java.util.concurrent.atomic.AtomicLong nextReadOffset = new java.util.concurrent.atomic.AtomicLong(rangeStart);
                final java.util.concurrent.atomic.AtomicBoolean streamRunning = new java.util.concurrent.atomic.AtomicBoolean(true);
                final java.util.concurrent.atomic.AtomicReference<Throwable> workerError = new java.util.concurrent.atomic.AtomicReference<>(null);
                final Object notifyLock = new Object();
                final java.util.List<Thread> workers = new java.util.ArrayList<>();
                final long finalRangeEnd = rangeEnd;
                final long finalContentLength = contentLength;
                final long finalRangeStart = rangeStart;

                // --- Start Workers ---
                for (int i = 0; i < THREAD_COUNT; i++) {
                    final int workerId = i;
                    Thread worker = new Thread(() -> {
                        SmbRandomAccessFile myRaf = null;
                        try {
                             myRaf = new SmbRandomAccessFile(smbFile, "r");
                            while (streamRunning.get()) {
                                bufferPermits.acquire(); 
                                long myOffset = nextReadOffset.getAndAdd(CHUNK_SIZE);
                                if (myOffset > finalRangeEnd || !streamRunning.get()) {
                                    bufferPermits.release();
                                    break; 
                                }

                                byte[] buf = bytePool.acquire();
                                int toRead = (int) Math.min(CHUNK_SIZE, finalContentLength - (myOffset - finalRangeStart));
                                if (toRead <= 0) {
                                     bytePool.release(buf);
                                     bufferPermits.release();
                                     break;
                                }

                                myRaf.seek(myOffset);
                                long t0 = System.currentTimeMillis();
                                int read = myRaf.read(buf, 0, toRead);
                                long cost = System.currentTimeMillis() - t0;

                                if (cost > 500) {
                                    android.util.Log.w("WebDavNative", "[TRACE] [Lane#" + workerId + "] [IO_SLOW] Cost: " + cost + "ms, Offset: " + myOffset);
                                }

                                if (read <= 0) {
                                    bytePool.release(buf);
                                    bufferPermits.release();
                                    break;
                                }
                                bufferMap.put(myOffset, new SMBChunk(buf, read));
                                synchronized(notifyLock) { notifyLock.notify(); }
                            }
                        } catch (Exception e) {
                            if (streamRunning.get()) workerError.set(e);
                        } finally {
                            if (myRaf != null) try { myRaf.close(); } catch (Exception e) {}
                        }
                    }, "SMB-Lane-" + i);
                    workers.add(worker);
                    worker.start();
                }

                // --- Consumer ---
                BufferedOutputStream bout = new BufferedOutputStream(out, 64 * 1024);
                long currentOffset = rangeStart;
                long totalBytesWritten = 0;
                long startTime = System.currentTimeMillis();
                long lastLogTime = startTime;
                long lastBytesWritten = 0;

                try {
                    while (currentOffset <= rangeEnd && streamRunning.get()) {
                        if (workerError.get() != null) throw new IOException(workerError.get());

                        SMBChunk chunk = null;
                        synchronized(notifyLock) {
                            while (streamRunning.get() && (chunk = bufferMap.remove(currentOffset)) == null) {
                                if (workerError.get() != null) throw new IOException(workerError.get());
                                long tWaitStart = System.currentTimeMillis();
                                notifyLock.wait(500); 
                                long waitCost = System.currentTimeMillis() - tWaitStart;
                                if (waitCost > 100 && streamRunning.get()) {
                                    android.util.Log.w("WebDavNative", "[TRACE] [Consumer] [GAP] Waited " + waitCost + "ms for Offset: " + currentOffset);
                                }
                            }
                        }

                        if (chunk == null) continue;
                        bout.write(chunk.data, 0, chunk.actualLength);
                        currentOffset += chunk.actualLength;
                        totalBytesWritten += chunk.actualLength;
                        bytePool.release(chunk.data);
                        bufferPermits.release();

                        // [DIAGNOSTICS] Log Speed & WiFi Stats every 1s
                        long now = System.currentTimeMillis();
                        if (now - lastLogTime >= 1000) {
                            long diff = totalBytesWritten - lastBytesWritten;
                            double speed = (diff / 1024.0 / 1024.0) * (1000.0 / (now - lastLogTime));
                            
                            // Get WiFi Stats
                            int rssi = -127;
                            int linkSpeed = -1;
                            boolean ignoringBattery = false;
                            try {
                                WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                                if (wm != null) {
                                    android.net.wifi.WifiInfo info = wm.getConnectionInfo();
                                    if (info != null) {
                                        rssi = info.getRssi();
                                        linkSpeed = info.getLinkSpeed();
                                    }
                                }
                                PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
                                if (pm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                                    ignoringBattery = pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
                                }
                            } catch (Exception e) {}

                            android.util.Log.i("WebDavNative", String.format(java.util.Locale.US, 
                                "[SPEED] %.2f MB/s | [WIFI] RSSI: %d dBm, LinkSpeed: %d Mbps | [POWER] NoLimit: %b | [BUFFER] %d/16", 
                                speed, rssi, linkSpeed, ignoringBattery, 16 - bufferPermits.availablePermits()));
                            
                            lastLogTime = now;
                            lastBytesWritten = totalBytesWritten;
                        }
                    }
                    bout.flush();
                } finally {
                    streamRunning.set(false);
                    for (Thread t : workers) t.interrupt();
                    for (SMBChunk c : bufferMap.values()) bytePool.release(c.data);
                }
            } catch (Exception e) {
                if (isClientDisconnect(e)) {
                    android.util.Log.d("WebDavNative", "handleSmbStream client disconnected: " + e.getMessage());
                } else {
                    android.util.Log.e("WebDavNative", "handleSmbStream error", e);
                }
            } finally {
                activeStreams.decrementAndGet();
                if (raf != null) try { raf.close(); } catch (Exception e) {}
            }
        }

        private boolean isClientDisconnect(Throwable err) {
            Throwable cur = err;
            while (cur != null) {
                String cls = cur.getClass().getName();
                String msg = cur.getMessage();
                if (cls.contains("ConnectionResetException")) return true;
                if (cur instanceof java.net.SocketException || cur instanceof java.io.EOFException) {
                    if (msg == null) return true;
                    String lower = msg.toLowerCase(java.util.Locale.ROOT);
                    if (lower.contains("connection reset")
                        || lower.contains("broken pipe")
                        || lower.contains("socket closed")
                        || lower.contains("connection aborted")) {
                        return true;
                    }
                }
                cur = cur.getCause();
            }
            return false;
        }
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33) {
            if (getContext().checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissionForAlias("post_notifications", call, "notificationPermissionCallback");
            } else {
                call.resolve();
            }
        } else {
            call.resolve();
        }
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33) {
            if (getContext().checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                call.resolve();
            } else {
                call.reject("Permission denied");
            }
        } else {
            call.resolve();
        }
    }

    @PluginMethod
    public void requestManageStoragePermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (!Environment.isExternalStorageManager()) {
                try {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                    Uri uri = Uri.fromParts("package", getActivity().getPackageName(), null);
                    intent.setData(uri);
                    getActivity().startActivity(intent);
                    call.resolve();
                } catch (Exception e) {
                    call.reject("Failed to open settings: " + e.getMessage());
                }
            } else {
                call.resolve();
            }
        } else {
            call.resolve();
        }
    }

    @PluginMethod
    public void getStorageInfo(PluginCall call) {
        try {
            File path = Environment.getExternalStorageDirectory();
            StatFs stat = new StatFs(path.getPath());
            long total = stat.getBlockCountLong() * stat.getBlockSizeLong();
            long free = stat.getAvailableBlocksLong() * stat.getBlockSizeLong();
            long used = total - free;

            JSObject ret = new JSObject();
            ret.put("total", total);
            ret.put("used", used);
            ret.put("free", free);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void search(PluginCall call) {
        String query = call.getString("query");
        if (query == null || query.isEmpty()) {
            JSObject ret = new JSObject();
            ret.put("items", new com.getcapacitor.JSArray());
            call.resolve(ret);
            return;
        }

        final int LIMIT = 100;
        final long TIME_LIMIT = 5000;
        final long startTime = System.currentTimeMillis();

        File root = Environment.getExternalStorageDirectory();
        String rootPath = root.getAbsolutePath();
        com.getcapacitor.JSArray results = new com.getcapacitor.JSArray();

        java.util.Stack<File> stack = new java.util.Stack<>();
        stack.push(root);

        int count = 0;

        while (!stack.isEmpty()) {
            if (count >= LIMIT || System.currentTimeMillis() - startTime > TIME_LIMIT) break;
            
            File dir = stack.pop();
            File[] files = dir.listFiles();
            if (files == null) continue;

            for (File f : files) {
                if (f.getName().startsWith(".")) continue;
                if (count >= LIMIT || System.currentTimeMillis() - startTime > TIME_LIMIT) break;

                if (f.getName().toLowerCase().contains(query.toLowerCase())) {
                    JSObject item = new JSObject();
                    item.put("name", f.getName());
                    String fullPath = f.getAbsolutePath();
                    String relPath = fullPath.startsWith(rootPath) ? fullPath.substring(rootPath.length()) : fullPath;
                    if (!relPath.startsWith("/")) relPath = "/" + relPath;
                    
                    item.put("path", relPath);
                    item.put("isDirectory", f.isDirectory());
                    item.put("size", f.length());
                    item.put("mtime", f.lastModified());
                    results.put(item);
                    count++;
                }

                if (f.isDirectory()) stack.push(f);
            }
        }

        JSObject ret = new JSObject();
        ret.put("items", results);
        call.resolve(ret);
    }

    @PluginMethod
    public void listDirectory(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("Path is required");
            return;
        }

        File root = Environment.getExternalStorageDirectory();
        File dir = new File(root, path);

        if (!dir.exists() || !dir.isDirectory()) {
            call.reject("Directory does not exist");
            return;
        }

        File[] files = dir.listFiles();
        com.getcapacitor.JSArray results = new com.getcapacitor.JSArray();

        if (files != null) {
            for (File f : files) {
                JSObject item = new JSObject();
                item.put("name", f.getName());
                item.put("isDirectory", f.isDirectory());
                item.put("size", f.length());
                item.put("mtime", f.lastModified());
                results.put(item);
            }
        }

        JSObject ret = new JSObject();
        ret.put("items", results);
        call.resolve(ret);
    }

    @PluginMethod
    public void createDirectory(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("Path is required");
            return;
        }

        File root = Environment.getExternalStorageDirectory();
        
        File dir;
        if (path.startsWith(root.getAbsolutePath())) {
             dir = new File(path);
        } else if (path.startsWith("/")) {
             if (path.startsWith("/data/") || path.startsWith("/storage/") || path.startsWith("/sdcard/")) {
                 dir = new File(path);
             } else {
                 dir = new File(root, path.substring(1));
             }
        } else {
             dir = new File(root, path);
        }

        if (dir.exists()) {
            call.resolve();
            return;
        }

        boolean success = dir.mkdirs();
        if (success) call.resolve();
        else call.reject("Failed to create directory: " + dir.getAbsolutePath());
    }

    @PluginMethod
    public void updateNotification(PluginCall call) {
        int id = call.getInt("id", 1);
        String title = call.getString("title", "File Operation");
        String description = call.getString("description", "Processing...");
        int progress = call.getInt("progress", 0);
        int max = call.getInt("max", 100);
        String speed = call.getString("speed", "");
        
        doUpdateNotification(id, title, description, progress, max, speed);
        call.resolve();
    }
    
    private void doUpdateNotification(int id, String title, String description, int progress, int max, String speed) {
        if (activeTransfers.get() <= 0) {
            // No transfers running, don't update/re-post notification
            return;
        }
        Context context = getContext();
        
        // Log for debugging
        android.util.Log.d("WebDavNative", "Updating notification ID: " + id + " Title: " + title + " Speed: " + speed);

        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel("file_ops_v2", "File Operations", NotificationManager.IMPORTANCE_LOW);
            channel.setSound(null, null); 
            channel.enableVibration(false);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        int iconResId = com.android.drive.R.drawable.ic_stat_transfer_0;
        if (max > 0) {
            int percent = (int) ((progress * 100.0f) / max);
            if (percent >= 100) iconResId = com.android.drive.R.drawable.ic_stat_transfer_100;
            else if (percent >= 80) iconResId = com.android.drive.R.drawable.ic_stat_transfer_80;
            else if (percent >= 60) iconResId = com.android.drive.R.drawable.ic_stat_transfer_60;
            else if (percent >= 40) iconResId = com.android.drive.R.drawable.ic_stat_transfer_40;
            else if (percent >= 20) iconResId = com.android.drive.R.drawable.ic_stat_transfer_20;
        }

        Intent launchIntent = new Intent(context, MainActivity.class);
        launchIntent.setAction(Intent.ACTION_VIEW);
        launchIntent.setData(Uri.parse("webdav://transfers"));
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        PendingIntent pendingIntent = null;
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        pendingIntent = PendingIntent.getActivity(context, 0, launchIntent, flags);

        // Custom Layout Logic
        RemoteViews customView = new RemoteViews(context.getPackageName(), com.android.drive.R.layout.notification_transfer);
        
        // 1. Filename (Title)
        String displayTitle = (description != null && !description.isEmpty()) ? description : title;
        customView.setTextViewText(com.android.drive.R.id.notification_title, displayTitle);
        
        // 2. Status & Speed (Bottom Right)
        String displayStatus = title;
        if (speed != null && !speed.isEmpty()) {
            displayStatus = title + " • " + speed;
        }
        customView.setTextViewText(com.android.drive.R.id.notification_status, displayStatus);
        
        // 3. Progress
        if (max > 0) {
            customView.setProgressBar(com.android.drive.R.id.notification_progress, max, progress, false);
        } else {
            customView.setProgressBar(com.android.drive.R.id.notification_progress, 0, 0, true);
        }
        
        // 4. Icon
        customView.setImageViewResource(com.android.drive.R.id.notification_icon, iconResId);

        // Build Notification using Custom Layout (both Collapsed and Expanded)
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, "file_ops_v2")
                .setSmallIcon(iconResId)
                .setCustomContentView(customView)
                .setCustomBigContentView(customView) // Ensure visibility when expanded
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setOnlyAlertOnce(true);
        
        // Add standard progress as fallback/extra info for some system catchers
        if (max > 0) {
            builder.setProgress(max, progress, false);
        } else {
            builder.setProgress(0, 0, true);
        }
        
        if (pendingIntent != null) {
            builder.setContentIntent(pendingIntent);
        }

        manager.notify(id, builder.build());
    }

    @PluginMethod
    public void cancelNotification(PluginCall call) {
        int id = call.getInt("id", 1);
        Context context = getContext();
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        manager.cancel(id);
        call.resolve();
    }

    @PluginMethod
    public void upload(PluginCall call) {
        startTransfer();
        String tempIdForFinally = null;
        try {
            String url = call.getString("url");
            String method = call.getString("method", "PUT");
            JSObject headers = call.getObject("headers");
            String sourcePath = call.getString("sourcePath");
            String tempId = call.getString("id");
            
            final boolean isContentUriInit = sourcePath != null && sourcePath.startsWith("content://");

            // [FIX] Immediate notification to eliminate delay
            boolean isZhInit = java.util.Locale.getDefault().getLanguage().equals("zh");
            String titleInit = isZhInit ? "正在准备上传" : "Preparing Upload";
            String fileNameInit = isContentUriInit ? "Shared File" : (sourcePath != null ? new java.io.File(sourcePath).getName() : "...");
            doUpdateNotification(9999, titleInit, fileNameInit, 0, 0, "");

            android.util.Log.d("WebDavNative", "Initial ID from call: " + tempId);
            if (headers != null) {
                 android.util.Log.d("WebDavNative", "Headers present. Keys: " + headers.keys());
                 try {
                     String headerId = headers.getString("X-Capacitor-Id");
                     android.util.Log.d("WebDavNative", "ID from header: " + headerId);
                     if (tempId == null) tempId = headerId;
                 } catch (Exception e) {
                     android.util.Log.e("WebDavNative", "Error reading header ID", e);
                 }
            } else {
                 android.util.Log.d("WebDavNative", "Headers are NULL");
            }

            if (tempId == null && headers != null) {
                tempId = headers.getString("X-Capacitor-Id");
            }
            tempIdForFinally = tempId;
            final String callbackId = tempId;

            if (url == null || sourcePath == null) {
                call.reject("URL and sourcePath are required");
                endTransfer();
                return;
            }

            android.util.Log.d("WebDavNative", "Upload sourcePath: " + sourcePath);
            android.util.Log.d("WebDavNative", "Upload Input Keys: " + call.getData().keys());

            final boolean isContentUri = sourcePath.startsWith("content://");
            final File fileFinal;
            final long sourceSize;

            if (isContentUri) {
                fileFinal = null;
                Uri uri = Uri.parse(sourcePath);
                long querySize = -1;
                try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                         int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                         if (sizeIndex != -1) {
                             querySize = cursor.getLong(sizeIndex);
                         }
                    }
                }
                if (querySize == -1) {
                    // Fallback or guess?
                    call.reject("Could not determine size of content URI");
                    return;
                }
                sourceSize = querySize;
                android.util.Log.d("WebDavNative", "Resolved content URI size: " + sourceSize);

            } else {
                File file = new File(sourcePath);
                if (!file.exists()) {
                    // Not a valid absolute path, try relative to External Storage
                    File root = Environment.getExternalStorageDirectory();
                    String relative = sourcePath.startsWith("/") ? sourcePath.substring(1) : sourcePath;
                    file = new File(root, relative);
                    
                    if (!file.exists()) {
                        // Try Cache Dir
                        File cache = getContext().getExternalCacheDir();
                        file = new File(cache, relative);
                    }
                }
                android.util.Log.d("WebDavNative", "Resolved upload file: " + file.getAbsolutePath() + " (Exists: " + file.exists() + ")");

                if (!file.exists()) {
                    call.reject("File not found: " + file.getAbsolutePath());
                    return;
                }
                fileFinal = file;
                sourceSize = file.length();
            }

            Request.Builder requestBuilder = new Request.Builder().url(url);

            if (headers != null) {
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String key = it.next();
                    String value = headers.getString(key);
                    if (value != null) requestBuilder.addHeader(key, value);
                }
            }

            // Handle Basic Auth if username/password are provided but no Auth header
            String username = call.getString("username");
            String password = call.getString("password");
            if (username != null && password != null && (headers == null || !headers.has("Authorization"))) {
                 String credentials = username + ":" + password;
                 String basic = "Basic " + android.util.Base64.encodeToString(credentials.getBytes(), android.util.Base64.NO_WRAP);
                 requestBuilder.addHeader("Authorization", basic);
                 android.util.Log.d("WebDavNative", "Added Basic Auth header for upload");
            }

            final MediaType mediaTypeFinal;
            if (headers != null && headers.has("Content-Type")) {
                mediaTypeFinal = MediaType.parse(headers.getString("Content-Type"));
            } else {
                mediaTypeFinal = MediaType.parse("application/octet-stream");
            }

            RequestBody requestBody = new RequestBody() {
                @Override
                public MediaType contentType() { return mediaTypeFinal; }
                @Override
                public long contentLength() { return sourceSize; }
                @Override
                public void writeTo(BufferedSink sink) throws IOException {
                    byte[] buffer = new byte[262144]; // 256KB buffer
                    long uploaded = 0;
                    InputStream in = null;
                    
                    try {
                        if (isContentUri) {
                            in = getContext().getContentResolver().openInputStream(Uri.parse(sourcePath));
                        } else {
                            in = new java.io.FileInputStream(fileFinal);
                        }
                        
                        if (in == null) throw new IOException("Failed to open input stream");

                        int read;
                        long lastUpdate = 0;
                        long lastBytes = 0;
                        
                        // Initial notification update
                        String threadTitle = isZhInit ? "正在上传" : "Uploading";
                        String threadFileName = isContentUri ? "Shared File" : fileFinal.getName();
                        doUpdateNotification(9999, threadTitle, threadFileName, 0, (int)(sourceSize/1024), "");

                        while ((read = in.read(buffer)) != -1) {
                            // Check for cancellation
                            if (callbackId != null && !activeCalls.containsKey(callbackId)) {
                                throw new IOException("Cancelled");
                            }

                            sink.write(buffer, 0, read);
                            uploaded += read;
                            
                            long now = System.currentTimeMillis();
                            if (now - lastUpdate > 1000) {
                                 // Re-check cancellation before updating UI to prevent overwriting "Cancelling..." state
                                 if (callbackId != null && !activeCalls.containsKey(callbackId)) {
                                     throw new IOException("Cancelled");
                                 }

                                 JSObject ret = new JSObject();
                                 ret.put("uploaded", uploaded);
                                 ret.put("uploaded", uploaded);
                                 ret.put("total", sourceSize);
                                 
                                 // Calculate Speed
                                 long diffBytes = uploaded - lastBytes;
                                 long diffTime = now - lastUpdate;
                                 long speed = diffTime > 0 ? (diffBytes * 1000 / diffTime) : 0;
                                 
                                 ret.put("speed", speed);
                                 if (callbackId != null) ret.put("id", callbackId);
                                 
                                 notifyListeners("uploadProgress", ret);
                                 
                                 String speedStr = formatSpeed(speed);
                                 
                                 boolean isZh = java.util.Locale.getDefault().getLanguage().equals("zh");
                                 String title = isZh ? "正在上传" : "Uploading";
                                 
                                 String fileName = isContentUri ? "Shared File" : fileFinal.getName();
                                 doUpdateNotification(9999, title, fileName, (int)(uploaded/1024), (int)(sourceSize/1024), speedStr);
                                 
                                 lastUpdate = now;
                                 lastBytes = uploaded;
                            }
                        }
                        
                        // Force 100% notification on completion
                        boolean isZhFinal = java.util.Locale.getDefault().getLanguage().equals("zh");
                        String titleFinal = isZhFinal ? "上传完成" : "Upload Complete";
                        String fileName = isContentUri ? "Shared File" : fileFinal.getName();
                        doUpdateNotification(9999, titleFinal, fileName, (int)(sourceSize/1024), (int)(sourceSize/1024), "");
                    } finally {
                        if (in != null) try { in.close(); } catch (IOException e) {}
                    }
                }
            };

            requestBuilder.method(method, requestBody);


            Call callObj = client.newCall(requestBuilder.build());
            if (callbackId != null) activeCalls.put(callbackId, callObj);

            try (Response response = callObj.execute()) {
                 if (response.isSuccessful()) {
                     call.resolve();
                 } else {
                     call.reject("Upload failed: " + response.code() + " " + response.message());
                 }
            } catch (IOException e) {
                String errorMsg = e.getClass().getSimpleName() + ": " + e.getMessage();
                android.util.Log.e("WebDavNative", "Upload Network Error: " + errorMsg, e);
                call.reject(errorMsg);
            }
        } finally {
            if (tempIdForFinally != null) activeCalls.remove(tempIdForFinally);
            endTransfer();
        }
    }

    @PluginMethod
    public void download(PluginCall call) {
        startTransfer();
        String idForFinally = null;
        File file = null;
        try {
            String url = call.getString("url");
            String destPath = call.getString("destPath");
            JSObject headers = call.getObject("headers");
            final String callbackId = call.getString("id");
            idForFinally = callbackId;

            if (url == null || destPath == null) {
                call.reject("URL and destPath are required");
                endTransfer();
                return;
            }

            android.util.Log.d("WebDavNative", "Download destPath: " + destPath);

            // [FIX] Immediate notification to eliminate delay
            boolean isZhInit = java.util.Locale.getDefault().getLanguage().equals("zh");
            String titleInit = isZhInit ? "正在准备下载" : "Preparing Download";
            String fileNameInit = new java.io.File(destPath).getName();
            doUpdateNotification(9999, titleInit, fileNameInit, 0, 0, "");

            File root = Environment.getExternalStorageDirectory();
            
            if (destPath.startsWith(root.getAbsolutePath())) {
                file = new File(destPath);
            } else {
                String relativePath = destPath.startsWith("/") ? destPath.substring(1) : destPath;
                file = new File(root, relativePath);
            }

            android.util.Log.d("WebDavNative", "Resolved download file: " + file.getAbsolutePath());

            // Ensure parent directory exists
            File parent = file.getParentFile();
            if (parent != null && !parent.exists()) {
                boolean created = parent.mkdirs();
                android.util.Log.d("WebDavNative", "Created parent dir: " + parent.getAbsolutePath() + " = " + created);
            }

            Request.Builder requestBuilder = new Request.Builder().url(url).get();

            // Handle Basic Auth if username/password are provided but no Auth header
            String username = call.getString("username");
            String password = call.getString("password");
            // Check if headers already has Auth, if so, skip. But headers map iteration happens later.
            // We can add it now. If headers adds it later, OkHttp supports multiple headers or overwrites?
            // User headers should probably take precedence, but let's check.
            // Actually, we can just add it here. The loop below adds from 'headers' object.
            
            if (username != null && password != null) {
                 boolean hasAuthInHeaders = (headers != null && headers.has("Authorization"));
                 if (!hasAuthInHeaders) {
                     String credentials = username + ":" + password;
                     String basic = "Basic " + android.util.Base64.encodeToString(credentials.getBytes(), android.util.Base64.NO_WRAP);
                     requestBuilder.addHeader("Authorization", basic);
                     android.util.Log.d("WebDavNative", "Added Basic Auth header for download");
                 }
            }

            if (headers != null) {
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String key = it.next();
                    String value = headers.getString(key);
                    if (value != null) requestBuilder.addHeader(key, value);
                }
            }

            Call callObj = client.newCall(requestBuilder.build());
            if (callbackId != null) activeCalls.put(callbackId, callObj);

            try (Response response = callObj.execute()) {
                if (!response.isSuccessful()) {
                    call.reject("Download failed: " + response.code() + " " + response.message());
                    return;
                }

                if (response.body() == null) {
                    call.reject("Empty response body");
                    return;
                }

                long contentLength = response.body().contentLength();
                long downloaded = 0;
                
                try (InputStream in = response.body().byteStream();
                     FileOutputStream out = new FileOutputStream(file)) {
                    
                    byte[] buffer = new byte[262144]; // 256KB buffer
                    int read;
                    long lastUpdate = 0;
                    long lastBytes = 0;

                    // Initial notification update
                    String threadTitle = isZhInit ? "正在下载" : "Downloading";
                    doUpdateNotification(9999, threadTitle, file.getName(), 0, (int)(contentLength/1024), "");

                    while ((read = in.read(buffer)) != -1) {
                        // Check for cancellation
                        if (callbackId != null && !activeCalls.containsKey(callbackId)) {
                            throw new IOException("Cancelled");
                        }

                        out.write(buffer, 0, read);
                        downloaded += read;
                        
                        long now = System.currentTimeMillis();
                        if (now - lastUpdate > 1000) {
                            // Re-check cancellation before updating UI
                            if (callbackId != null && !activeCalls.containsKey(callbackId)) {
                                throw new IOException("Cancelled");
                            }

                            JSObject ret = new JSObject();
                            ret.put("downloaded", downloaded);
                            ret.put("total", contentLength);
                            
                            long diffBytes = downloaded - lastBytes;
                            long diffTime = now - lastUpdate;
                            long speed = diffTime > 0 ? (diffBytes * 1000 / diffTime) : 0;
                            
                            ret.put("speed", speed);
                            if (callbackId != null) ret.put("id", callbackId);
                            
                            notifyListeners("downloadProgress", ret);
                            
                            // Calculate Speed
                            String speedStr = formatSpeed(speed);
                            
                            boolean isZh = java.util.Locale.getDefault().getLanguage().equals("zh");
                            String title = isZh ? "正在下载" : "Downloading";
                            
                            if (contentLength > 0) {
                                 doUpdateNotification(9999, title, file.getName(), (int)(downloaded/1024), (int)(contentLength/1024), speedStr);
                            } else {
                                 doUpdateNotification(9999, title, file.getName(), 0, 0, speedStr);
                            }
                            
                            lastUpdate = now;
                            lastBytes = downloaded;
                        }
                    }
                    out.flush();
                    
                    // Force 100% notification on completion
                    boolean isZhFinal = java.util.Locale.getDefault().getLanguage().equals("zh");
                    String titleFinal = isZhFinal ? "下载完成" : "Download Complete";
                    doUpdateNotification(9999, titleFinal, file.getName(), (int)(contentLength/1024), (int)(contentLength/1024), "");
                }
                
                call.resolve();

            } catch (Exception e) {
                // IMPORTANT: Delete partial file on failure/cancellation
                if (file != null && file.exists()) {
                    android.util.Log.d("WebDavNative", "Deleting partial download file: " + file.getAbsolutePath());
                    file.delete();
                }
                String errorMsg = e.getClass().getSimpleName() + ": " + e.getMessage();
                android.util.Log.e("WebDavNative", "Download Error: " + errorMsg, e);
                call.reject(errorMsg);
            }
        } finally {
            if (idForFinally != null) activeCalls.remove(idForFinally);
            endTransfer();
        }
    }

    @PluginMethod
    public void request(PluginCall call) {
        String url = call.getString("url");
        String method = call.getString("method", "GET");
        JSObject headers = call.getObject("headers");
        String body = call.getString("body");
        boolean bodyIsBase64 = call.getBoolean("bodyIsBase64", false);
        String responseType = call.getString("responseType", "text");
        String reqId = call.getString("id");

        if (url == null) {
            call.reject("URL is required");
            return;
        }

        Request.Builder requestBuilder = new Request.Builder().url(url);

        if (headers != null) {
            for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                String key = it.next();
                String value = headers.getString(key);
                if (value != null) requestBuilder.addHeader(key, value);
            }
            if (reqId == null) {
                reqId = headers.getString("X-Capacitor-Id");
            }
        }
        final String callbackId = reqId;

        RequestBody requestBody = null;
        if (body != null) {
            MediaType mediaType = MediaType.parse("text/xml; charset=utf-8"); 
            if (headers != null && headers.has("Content-Type")) {
                 mediaType = MediaType.parse(headers.getString("Content-Type"));
            }
            if (bodyIsBase64) {
                try {
                    byte[] decoded = Base64.decode(body, Base64.DEFAULT);
                    requestBody = RequestBody.create(decoded, mediaType);
                } catch (IllegalArgumentException e) {
                    call.reject("Invalid Base64 body");
                    return;
                }
            } else {
                requestBody = RequestBody.create(body, mediaType);
            }
        }
        
        boolean allowsBody = method.equals("POST") || method.equals("PUT") || method.equals("PATCH") || method.equals("PROPFIND") || method.equals("PROPPATCH") || method.equals("LOCK");
        if (allowsBody) {
             if (requestBody == null) requestBody = RequestBody.create("", null);
             requestBuilder.method(method, requestBody);
        } else {
             requestBuilder.method(method, null);
        }

        Call callObj = client.newCall(requestBuilder.build());
        if (callbackId != null) activeCalls.put(callbackId, callObj);

        try (Response response = callObj.execute()) {
            JSObject ret = new JSObject();
            ret.put("status", response.code());
            if (response.body() != null) {
                if ("base64".equals(responseType)) {
                    byte[] bytes = response.body().bytes();
                    String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                    ret.put("data", base64);
                } else {
                    ret.put("data", response.body().string());
                }
            } else {
                ret.put("data", "");
            }
            call.resolve(ret);
        } catch (IOException e) {
            call.reject(e.getMessage());
        } catch (Exception e) {
             call.reject(e.getMessage());
        } finally {
            if (callbackId != null) activeCalls.remove(callbackId);
        }
    }

    private static class SMBChunk {
        final byte[] data;
        final int actualLength;
        SMBChunk(byte[] data, int actualLength) {
            this.data = data;
            this.actualLength = actualLength;
        }
    }

    private static class BytePool {
        private final java.util.concurrent.LinkedBlockingQueue<byte[]> pool;
        private final int bufferSize;
        private static BytePool instance;

        private BytePool(int bufferSize) {
            this.bufferSize = bufferSize;
            this.pool = new java.util.concurrent.LinkedBlockingQueue<>(64);
            for (int i = 0; i < 16; i++) pool.add(new byte[bufferSize]);
        }

        public static synchronized BytePool getInstance(int size) {
            if (instance == null || instance.bufferSize != size) {
                instance = new BytePool(size);
            }
            return instance;
        }

        public byte[] acquire() {
            byte[] buf = pool.poll();
            return (buf != null) ? buf : new byte[bufferSize];
        }

        public void release(byte[] buf) {
            if (buf != null && buf.length == bufferSize) {
                pool.offer(buf);
            }
        }
    }
}
