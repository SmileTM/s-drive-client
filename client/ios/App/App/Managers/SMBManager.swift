import Foundation
import Capacitor
import AMSMB2

class SMBManager: NSObject {
    
    private let TAG = "[SMBManager]"
    private let stateQueue = DispatchQueue(label: "SMBManager.StateQueue")
    private var activeTasks: [String: Task<Void, Never>] = [:]
    private var cancelledIds: Set<String> = []
    
    static let shared = SMBManager()
    
    // Public access to cached file size
    func getCachedFileSize(address: String, share: String, path: String) -> Int64 {
        let cacheKey = "\(address)/\(share)\(path)"
        cacheLock.lock()
        defer { cacheLock.unlock() }
        return fileSizeCache[cacheKey] ?? 0
    }
    
    // Connection Cache: Keeps one active manager per address/share/user
    private struct ConnectionKey: Hashable {
        let address: String
        let share: String
        let user: String
    }
    private var connectionCache: [ConnectionKey: AMSMB2.SMB2Manager] = [:]
    private var transferConnectionCache: [ConnectionKey: AMSMB2.SMB2Manager] = [:]
    
    // Transfer concurrency limiter (2 concurrent max across all SMB)
    private let transferSemaphore = DispatchSemaphore(value: 2)
    private let limitQueue = DispatchQueue(label: "SMBManager.LimitQueue", attributes: .concurrent)
    
    // File Attribute Cache: Stores file sizes to avoid redundant network round-trips during Seeking
    private var fileSizeCache: [String: Int64] = [:]
    private let cacheLock = NSLock()
    
    // MARK: - Path Resolution
    
    /// Resolve a local path from JS.
    /// On Android, relative paths map to ExternalStorageDirectory.
    /// On iOS, we map to the app's Documents directory (equivalent).
    private func resolveLocalPath(_ path: String) -> String {
        // If already a full iOS path, use as-is
        if path.hasPrefix("/var/") || path.hasPrefix("/private/") || path.hasPrefix("/Users/") {
            return path
        }
        
        // Otherwise, treat as relative to Documents directory (iOS equivalent of ExternalStorage)
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let cleanPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        return docs.appendingPathComponent(cleanPath).path
    }
    
    // MARK: - Connection Helper
    
    /// Create a fresh SMB2 client from call parameters
    private func createClient(from call: CAPPluginCall) -> AMSMB2.SMB2Manager? {
        guard let address = call.getString("address"),
              call.getString("share") != nil else {
            call.reject("Missing address or share")
            return nil
        }
        
        let username = call.getString("username") ?? "guest"
        let password = call.getString("password") ?? ""
        
        let urlString = "smb://\(address)"
        guard let url = URL(string: urlString) else {
            call.reject("Invalid URL: \(urlString)")
            return nil
        }
        
        let credential = URLCredential(user: username, password: password, persistence: .forSession)
        return AMSMB2.SMB2Manager(url: url, credential: credential)
    }
    
    /// Connect to share, perform operation, then clean up
    private func withConnection(_ call: CAPPluginCall, operation: @escaping (AMSMB2.SMB2Manager) -> Void) {
        withConnectionHelper(call, isTransfer: false, operation: operation)
    }

    private func withTransferConnection(_ call: CAPPluginCall, operation: @escaping (AMSMB2.SMB2Manager) -> Void) {
        withConnectionHelper(call, isTransfer: true, operation: operation)
    }

    private func withConnectionHelper(_ call: CAPPluginCall, isTransfer: Bool, operation: @escaping (AMSMB2.SMB2Manager) -> Void) {
        guard let address = call.getString("address"),
              let share = call.getString("share") else {
            call.reject("Missing address or share")
            return
        }
        
        let username = call.getString("username") ?? "guest"
        let key = ConnectionKey(address: address, share: share, user: username)
        
        cacheLock.lock()
        let cached = isTransfer ? transferConnectionCache[key] : connectionCache[key]
        cacheLock.unlock()
        
        if let client = cached {
            operation(client)
            return
        }
        
        guard let client = createClient(from: call) else { return }
        
        client.connectShare(name: share) { error in
            if let error = error {
                print("\(self.TAG) Connect failed: \(error)")
                call.reject("SMB Connection Failed: \(error.localizedDescription)")
            } else {
                print("\(self.TAG) Connect success: \(share) [Transfer: \(isTransfer)]")
                self.cacheLock.lock()
                if isTransfer {
                    self.transferConnectionCache[key] = client
                } else {
                    self.connectionCache[key] = client
                }
                self.cacheLock.unlock()
                operation(client)
            }
        }
    }
    
    // MARK: - Performance Tracking (EMA)
    
    private var lastBytes: [String: Int64] = [:]
    private var lastUpdate: [String: Date] = [:]
    private var smoothedSpeed: [String: Double] = [:]
    
    private func registerTask(_ task: Task<Void, Never>, for id: String) {
        stateQueue.sync {
            activeTasks[id] = task
            cancelledIds.remove(id)
        }
    }
    
    private func removeTask(for id: String) {
        stateQueue.sync {
            activeTasks.removeValue(forKey: id)
        }
    }
    
    private func isCancelled(id: String) -> Bool {
        stateQueue.sync {
            cancelledIds.contains(id)
        }
    }
    
    func cancelTransfer(id: String) -> Bool {
        var task: Task<Void, Never>?
        stateQueue.sync {
            cancelledIds.insert(id)
            task = activeTasks[id]
            activeTasks.removeValue(forKey: id)
        }
        task?.cancel()
        return task != nil
    }
    
    /// Notify progress back to JS with EMA smoothing
    private func notifyProgress(for call: CAPPluginCall, downloaded: Int64, total: Int64) {
        let callbackId = call.getString("id") ?? "smb_download"
        let now = Date()
        
        let lastTime = lastUpdate[callbackId] ?? now.addingTimeInterval(-1)
        let lastB = lastBytes[callbackId] ?? 0
        let dt = now.timeIntervalSince(lastTime)
        
        // Update at most once per 500ms to JS, but sample as much as possible
        if dt >= 0.8 {
            let diffBytes = downloaded - lastB
            let instantSpeed = Double(diffBytes) / dt
            
            // EMA: 30% instant + 70% history
            var currentSmoothed = smoothedSpeed[callbackId] ?? instantSpeed
            currentSmoothed = (currentSmoothed * 0.7) + (instantSpeed * 0.3)
            
            smoothedSpeed[callbackId] = currentSmoothed
            lastBytes[callbackId] = downloaded
            lastUpdate[callbackId] = now
            
            let data: [String: Any] = [
                "downloaded": downloaded,
                "total": total,
                "speed": Int64(currentSmoothed),
                "id": callbackId
            ]
            // Note: Plugin should be the one notifying.
            // We can notify via NotificationCenter or passing a delegate.
            // For simplicity in this bridge, we'll use a globally accessible way or
            // expect the caller to handle notifications if we change signature.
            // But CAPPlugin has its own notification system.
            NotificationCenter.default.post(name: NSNotification.Name("WebDavProgress"), object: nil, userInfo: data)
        }
    }
    
    // MARK: - Public Methods
    
    /// Connect (test connection only)
    func connect(_ call: CAPPluginCall) {
        withConnection(call) { _ in
            print("\(self.TAG) Connected successfully")
            call.resolve(["success": true])
        }
    }
    
    /// List Directory
    func listDirectory(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? "/"
        let cleanPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        
        withConnection(call) { client in
            client.contentsOfDirectory(atPath: cleanPath) { result in
                switch result {
                case .success(let files):
                    let items = files.map { file -> [String: Any] in
                        let name = file[.nameKey] as? String ?? ""
                        let size = file[.fileSizeKey] as? Int64 ?? 0
                        let isDir = file[.isDirectoryKey] as? Bool ?? false
                        let date = file[.contentModificationDateKey] as? Date ?? Date()
                        
                        return [
                            "name": name,
                            "path": (path == "/" ? "" : path) + "/" + name,
                            "size": size,
                            "isDirectory": isDir,
                            "mtime": date.timeIntervalSince1970 * 1000
                        ]
                    }
                    call.resolve(["items": items])
                case .failure(let error):
                    call.reject("SMB List Failed: \(error.localizedDescription)")
                }
            }
        }
    }
    
    /// Create Directory
    func mkdir(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""
        let cleanPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        
        withConnection(call) { client in
            Task {
                do {
                    try await client.createDirectory(atPath: cleanPath)
                    call.resolve()
                } catch {
                    call.reject("SMB Mkdir Failed: \(error.localizedDescription)")
                }
            }
        }
    }
    
    /// Delete File/Directory
    func delete(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""
        let cleanPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        
        withConnection(call) { client in
            Task {
                do {
                    try await client.removeItem(atPath: cleanPath)
                    call.resolve()
                } catch {
                    call.reject("SMB Delete Failed: \(error.localizedDescription)")
                }
            }
        }
    }
    
    /// Rename / Move
    func rename(_ call: CAPPluginCall) {
        guard let oldPath = call.getString("oldPath") ?? call.getString("path"),
              let newPath = call.getString("newPath") else {
            call.reject("Missing oldPath/newPath")
            return
        }
        
        let cleanOld = oldPath.hasPrefix("/") ? String(oldPath.dropFirst()) : oldPath
        let cleanNew = newPath.hasPrefix("/") ? String(newPath.dropFirst()) : newPath
        
        withConnection(call) { client in
            Task {
                do {
                    try await client.moveItem(atPath: cleanOld, toPath: cleanNew)
                    call.resolve()
                } catch {
                    call.reject("SMB Rename Failed: \(error.localizedDescription)")
                }
            }
        }
    }
    
    /// Copy
    func copy(_ call: CAPPluginCall) {
        guard let path = call.getString("path"),
              let newPath = call.getString("newPath") else {
            call.reject("Missing path/newPath")
            return
        }
        
        let cleanOld = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let cleanNew = newPath.hasPrefix("/") ? String(newPath.dropFirst()) : newPath
        
        withConnection(call) { client in
            Task {
                do {
                    try await client.copyItem(atPath: cleanOld, toPath: cleanNew, recursive: true, progress: nil)
                    call.resolve()
                } catch {
                    call.reject("SMB Copy Failed: \(error.localizedDescription)")
                }
            }
        }
    }
    
    /// Download (Stream to local file)
    func download(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Missing path")
            return
        }
        
        let destPath = call.getString("destPath") ?? call.getString("localPath") ?? ""
        if destPath.isEmpty {
            call.reject("Missing destPath")
            return
        }
        
        let resolvedDest = resolveLocalPath(destPath)
        let localURL = URL(fileURLWithPath: resolvedDest)
        let cleanPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let callbackId = call.getString("id") ?? "smb_download"
        
        print("\(TAG) Download: remote=\(cleanPath), local=\(resolvedDest)")
        
        // Reset performance tracking for this ID
        lastBytes[callbackId] = 0
        lastUpdate[callbackId] = Date()
        smoothedSpeed[callbackId] = 0
        
        // Ensure parent directory exists
        let parent = localURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        
        let progressHandler: @Sendable (Int64, Int64) -> Bool = { [weak self] bytes, total in
            if self?.isCancelled(id: callbackId) == true {
                return false
            }
            self?.notifyProgress(for: call, downloaded: bytes, total: total)
            return true
        }
        
        withTransferConnection(call) { client in
            if self.isCancelled(id: callbackId) {
                call.reject("Cancelled")
                return
            }
            let task = Task { [weak self] in
                guard let self = self else { return }
                
                await withCheckedContinuation { continuation in
                    self.limitQueue.async {
                        self.transferSemaphore.wait()
                        continuation.resume(returning: ())
                    }
                }
                defer { self.transferSemaphore.signal() }
                
                do {
                    try await client.downloadItem(atPath: cleanPath, to: localURL, progress: progressHandler)
                    if self.isCancelled(id: callbackId) || Task.isCancelled {
                        call.reject("Cancelled")
                        return
                    }
                    print("\(self.TAG) Download complete: \(resolvedDest)")
                    
                    // Final 100% notification
                    let finalData: [String: Any] = [
                        "downloaded": -1, // Use -1 as signal for 100% if total unknown, or real value
                        "id": callbackId
                    ]
                    NotificationCenter.default.post(name: NSNotification.Name("WebDavProgress"), object: nil, userInfo: finalData)
                    
                    self.lastBytes.removeValue(forKey: callbackId)
                    self.lastUpdate.removeValue(forKey: callbackId)
                    self.smoothedSpeed.removeValue(forKey: callbackId)
                    self.removeTask(for: callbackId)
                    
                    call.resolve()
                } catch {
                    self.removeTask(for: callbackId)
                    if self.isCancelled(id: callbackId) || Task.isCancelled {
                        call.reject("Cancelled")
                        return
                    }
                    print("\(self.TAG) Download failed: \(error)")
                    call.reject("SMB Download Failed: \(error.localizedDescription)")
                }
            }
            self.registerTask(task, for: callbackId)
        }
    }
    
    /// Upload (Stream from local file)
    func upload(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Missing path")
            return
        }
        
        let sourcePath = call.getString("sourcePath") ?? ""
        if sourcePath.isEmpty {
            call.reject("Missing sourcePath")
            return
        }
        
        let resolvedSource = resolveLocalPath(sourcePath)
        let localURL = URL(fileURLWithPath: resolvedSource)
        let cleanPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let overwrite = call.getBool("overwrite") ?? false
        
        let callbackId = call.getString("id") ?? "smb_upload"
        
        print("\(TAG) Upload: local=\(resolvedSource), remote=\(cleanPath)")
        
        guard FileManager.default.fileExists(atPath: resolvedSource) else {
            call.reject("Source file not found: \(resolvedSource)")
            return
        }
        
        // Reset performance tracking for upload
        lastBytes[callbackId] = 0
        lastUpdate[callbackId] = Date()
        smoothedSpeed[callbackId] = 0
        
        let progressHandler: @Sendable (Int64) -> Bool = { [weak self] bytes in
            if self?.isCancelled(id: callbackId) == true {
                return false
            }
            // For upload, AMSMB2 usually gives total bytes sent so far
            // We'll treat total as unknown or pass file size if available
            let fileSize = (try? FileManager.default.attributesOfItem(atPath: resolvedSource)[.size] as? Int64) ?? 0
            self?.notifyProgress(for: call, downloaded: bytes, total: fileSize)
            return true
        }
        
        withTransferConnection(call) { client in
            if self.isCancelled(id: callbackId) {
                call.reject("Cancelled")
                return
            }
            let task = Task { [weak self] in
                guard let self = self else { return }
                
                await withCheckedContinuation { continuation in
                    self.limitQueue.async {
                        self.transferSemaphore.wait()
                        continuation.resume(returning: ())
                    }
                }
                defer { self.transferSemaphore.signal() }
                
                do {
                    if overwrite {
                        try? await client.removeItem(atPath: cleanPath)
                    }
                    try await client.uploadItem(at: localURL, toPath: cleanPath, progress: progressHandler)
                    if self.isCancelled(id: callbackId) || Task.isCancelled {
                        call.reject("Cancelled")
                        return
                    }
                    print("\(self.TAG) Upload complete: \(cleanPath)")
                    
                    // Final cleanup and 100% signal
                    let finalData: [String: Any] = [
                        "downloaded": -1,
                        "id": callbackId
                    ]
                    NotificationCenter.default.post(name: NSNotification.Name("WebDavProgress"), object: nil, userInfo: finalData)
                    
                    self.lastBytes.removeValue(forKey: callbackId)
                    self.lastUpdate.removeValue(forKey: callbackId)
                    self.smoothedSpeed.removeValue(forKey: callbackId)
                    self.removeTask(for: callbackId)
                    
                    call.resolve()
                } catch {
                    self.removeTask(for: callbackId)
                    if self.isCancelled(id: callbackId) || Task.isCancelled {
                        call.reject("Cancelled")
                        return
                    }
                    print("\(self.TAG) Upload failed: \(error)")
                    call.reject("SMB Upload Failed: \(error.localizedDescription)")
                }
            }
            self.registerTask(task, for: callbackId)
        }
    }
    
    // MARK: - Streaming Helper
    
    /// Stream partial content for LocalServerManager
    /// Uses cached connection, attribute cache, and direct readData API for high performance.
    func streamPart(address: String, share: String, path: String, user: String, pass: String, offset: Int64, length: Int64, completion: @escaping (Data?, Int64, Error?) -> Void) {
        let key = ConnectionKey(address: address, share: share, user: user)
        let cacheKey = "\(address)/\(share)\(path)"
        
        // 1. Check if we have the size in cache to avoid attributesOfItem
        var cachedSize: Int64?
        cacheLock.lock()
        cachedSize = fileSizeCache[cacheKey]
        cacheLock.unlock()
        
        let getManager = { () -> AMSMB2.SMB2Manager? in
            self.cacheLock.lock()
            defer { self.cacheLock.unlock() }
            return self.connectionCache[key]
        }
        
        let performRead: (AMSMB2.SMB2Manager, Int64) -> Void = { client, fileSize in
            let start = UInt64(max(0, offset))
            let end = start + UInt64(length)
            let range: Range<UInt64> = start..<end
            
            client.contents(atPath: path, range: range, progress: { _, _ in true }) { result in
                switch result {
                case .success(let data):
                    completion(data, fileSize, nil)
                case .failure(let error):
                    print("\(self.TAG) !!! streamPart contents ERROR: \(error)")
                    completion(nil, fileSize, error)
                }
            }
        }
        
        let handleManager = { (client: AMSMB2.SMB2Manager) in
            if let fileSize = cachedSize {
                performRead(client, fileSize)
            } else {
                // Must fetch size first, then cache it
                print("\(self.TAG) streamPart: fetching size for \(path)")
                client.attributesOfItem(atPath: path) { result in
                    switch result {
                    case .success(let attrs):
                        let fileSize = attrs[.fileSizeKey] as? Int64 ?? 0
                        self.cacheLock.lock()
                        self.fileSizeCache[cacheKey] = fileSize
                        self.cacheLock.unlock()
                        performRead(client, fileSize)
                    case .failure(let error):
                        completion(nil, 0, error)
                    }
                }
            }
        }
        
        if let cached = getManager() {
            handleManager(cached)
        } else {
            // New connection needed
            let urlString = "smb://\(address)"
            guard let url = URL(string: urlString) else {
                completion(nil, 0, NSError(domain: "SMB", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid URL"]))
                return
            }
            let credential = URLCredential(user: user, password: pass, persistence: .forSession)
            guard let client = AMSMB2.SMB2Manager(url: url, credential: credential) else {
                completion(nil, 0, NSError(domain: "SMB", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to create SMB client"]))
                return
            }
            
            client.connectShare(name: share) { error in
                if let error = error {
                    completion(nil, 0, error)
                    return
                }
                
                self.cacheLock.lock()
                self.connectionCache[key] = client
                self.cacheLock.unlock()
                
                handleManager(client)
            }
        }
    }
    
    /// Stream content incrementally for LocalServerManager (Pipeline Streaming)
    /// This allows pushing data to the player as soon as chunks arrive from SMB.
    /// Stream content incrementally for LocalServerManager (Pipeline Streaming)
    /// - Parameter cancelID: A unique ID to allow manual cancellation if client disconnects
    func streamIncremental(address: String, share: String, path: String, user: String, pass: String, offset: Int64, length: Int64, cancelID: String? = nil, onData: @escaping (Data) -> Void, completion: @escaping (Int64, Error?) -> Void) {
        let key = ConnectionKey(address: address, share: share, user: user)
        let cacheKey = "\(address)/\(share)\(path)"
        
        // 1. Check size cache
        var cachedSize: Int64?
        cacheLock.lock()
        cachedSize = fileSizeCache[cacheKey]
        cacheLock.unlock()
        
        // 2. Cancellation tracking setup
        if let cid = cancelID {
            stateQueue.sync {
                cancelledIds.remove(cid)
            }
        }
        
        let getManager = { () -> AMSMB2.SMB2Manager? in
            self.cacheLock.lock()
            defer { self.cacheLock.unlock() }
            return self.connectionCache[key]
        }
        
        let performStream: (AMSMB2.SMB2Manager, Int64) -> Void = { client, fileSize in
            let requestOffset = max(0, offset)
            let actualLength = (length <= 0) ? (fileSize - requestOffset) : length
            
            print("\(self.TAG) >>> streamIncremental: offset=\(requestOffset), length=\(actualLength), total=\(fileSize), cid=\(cancelID ?? "none")")
            
            // Optimization: If the request is tiny (like 0-1 for sniffing), use contents(atPath:range:...)
            // Reduced to 4KB (standard sniff size) to ensure we don't intercept real media requests.
            if actualLength > 0 && actualLength <= 1024 * 4 {
                let start = UInt64(requestOffset)
                let end = start + UInt64(actualLength)
                let range: Range<UInt64> = start..<end
                
                print("\(self.TAG) streamIncremental: Using Sniff-read optimization (<=4KB)")
                client.contents(atPath: path, range: range, progress: { _, _ in true }) { result in
                    switch result {
                    case .success(let data):
                        onData(data)
                        completion(fileSize, nil)
                    case .failure(let error):
                        completion(fileSize, error)
                    }
                }
                return
            }
            
            var bytesReceived: Int64 = 0
            client.contents(atPath: path, offset: requestOffset, fetchedData: { chunkOffset, totalSize, data in
                // Check if this stream has been cancelled by LocalServerManager
                if let cid = cancelID, self.isCancelled(id: cid) {
                    print("\(self.TAG) streamIncremental: Cancel signal received for \(cid). Stopping SMB fetch.")
                    return false // Tells AMSMB2 to stop
                }

                onData(data)
                bytesReceived += Int64(data.count)
                
                // If we've received enough data for this specific request range, stop.
                if bytesReceived >= actualLength {
                    return false // Stop SMB fetch
                }
                return true // Continue
            }) { error in
                if let error = error, (error as NSError).code == 57 {
                    print("\(self.TAG) !!! Socket disconnected. Clearing cache.")
                    self.cacheLock.lock()
                    self.connectionCache.removeValue(forKey: key)
                    self.cacheLock.unlock()
                }
                completion(fileSize, error)
            }
        }
        
        let handleManager = { (client: AMSMB2.SMB2Manager) in
            if let fileSize = cachedSize {
                performStream(client, fileSize)
            } else {
                client.attributesOfItem(atPath: path) { result in
                    switch result {
                    case .success(let attrs):
                        let fileSize = attrs[.fileSizeKey] as? Int64 ?? 0
                        self.cacheLock.lock()
                        self.fileSizeCache[cacheKey] = fileSize
                        self.cacheLock.unlock()
                        performStream(client, fileSize)
                    case .failure(let error):
                        completion(0, error)
                    }
                }
            }
        }
        
        if let cached = getManager() {
            handleManager(cached)
        } else {
            let urlString = "smb://\(address)"
            guard let url = URL(string: urlString) else {
                completion(0, NSError(domain: "SMB", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid URL"]))
                return
            }
            let credential = URLCredential(user: user, password: pass, persistence: .forSession)
            guard let client = AMSMB2.SMB2Manager(url: url, credential: credential) else {
                completion(0, NSError(domain: "SMB", code: 500, userInfo: [NSLocalizedDescriptionKey: "Failed to create SMB client"]))
                return
            }
            
            client.connectShare(name: share) { error in
                if let error = error {
                    completion(0, error)
                    return
                }
                self.cacheLock.lock()
                self.connectionCache[key] = client
                self.cacheLock.unlock()
                handleManager(client)
            }
        }
    }
    
    /// Mark a stream as cancelled to stop background fetching
    func cancelStreamSync(id: String) {
        stateQueue.sync {
            cancelledIds.insert(id)
        }
    }
    
    /// Fetch file size synchronously-ish for LocalServerManager
    /// Fetch file size synchronously-ish for LocalServerManager
    func fetchFileSize(address: String, share: String, path: String, user: String, pass: String, completion: @escaping (Int64) -> Void) {
        let key = ConnectionKey(address: address, share: share, user: user)
        let cacheKey = "\(address)/\(share)\(path)"
        let cleanPath = path.hasPrefix("/") ? String(path.dropFirst()) : path

        // Fast path: cached value
        cacheLock.lock()
        if let size = fileSizeCache[cacheKey] {
            cacheLock.unlock()
            completion(size)
            return
        }
        let cachedClient = connectionCache[key]
        cacheLock.unlock()

        let retrieveSize = { (client: AMSMB2.SMB2Manager) in
            client.attributesOfItem(atPath: cleanPath) { result in
                switch result {
                case .success(let attrs):
                    let size = attrs[.fileSizeKey] as? Int64 ?? 0
                    self.cacheLock.lock()
                    self.fileSizeCache[cacheKey] = size
                    self.cacheLock.unlock()
                    completion(size)
                case .failure:
                    completion(0)
                }
            }
        }

        if let client = cachedClient {
            retrieveSize(client)
        } else {
            let urlString = "smb://\(address)"
            guard let url = URL(string: urlString),
                  let client = AMSMB2.SMB2Manager(url: url, credential: URLCredential(user: user, password: pass, persistence: .forSession)) else {
                completion(0)
                return
            }
            client.connectShare(name: share) { error in
                if error != nil {
                    completion(0)
                    return
                }
                self.cacheLock.lock()
                self.connectionCache[key] = client
                self.cacheLock.unlock()
                retrieveSize(client)
            }
        }
    }
}
