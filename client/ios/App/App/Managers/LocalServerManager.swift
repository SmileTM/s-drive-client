import Foundation
import Capacitor
import GCDWebServer
import UniformTypeIdentifiers

class LocalServerManager: NSObject {
    
    static let shared = LocalServerManager()
    
    private let TAG = "[LocalServer]"
    private var webServer: GCDWebServer?
    private let port: UInt = 8080
    
    override init() {
        super.init()
        // Start server immediately on main thread (GCDWebServer requires main thread init)
        startOnMainThread()
    }
    
    private func startOnMainThread() {
        if Thread.isMainThread {
            self.doStart()
        } else {
            DispatchQueue.main.sync {
                self.doStart()
            }
        }
    }
    
    /// Public way to access server or start it
    func ensureServerRunning() {
        startOnMainThread()
    }
    
    private func doStart() {
        if webServer != nil && webServer!.isRunning {
            return 
        }
        
        print("\(TAG) >>> doStart: Initializing Local Server...")
        webServer = GCDWebServer()
        
        // Serve Documents Directory (equivalent to Android ExternalStorage)
        let documentsPath = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first!
        let documentsUrl = URL(fileURLWithPath: documentsPath)
        print("\(TAG) Documents Path: \(documentsPath)")

        // OPTIONS handler for CORS
        webServer?.addDefaultHandler(forMethod: "OPTIONS", request: GCDWebServerRequest.self, processBlock: { request in
            let response = GCDWebServerDataResponse(statusCode: 200)
            self.addCORSHeaders(to: response)
            return response
        })
        
        // --- THE MEGA ROUTER (Single entry point for GET/HEAD) ---
        // This bypasses GCDWebServer's internal routing bugs by manually checking paths.
        for method in ["GET", "HEAD"] {
            webServer?.addDefaultHandler(forMethod: method, request: GCDWebServerRequest.self, asyncProcessBlock: { request, completion in
                let path = request.path
                print("\(self.TAG) >>> [\(method)] RECV: \(path)")
                
                if path == "/smb" {
                    self.handleSMBRequest(request, method: method, completion: completion)
                } else if path == "/webdav" {
                    self.handleWebDAVRequest(request, method: method, completion: completion)
                } else {
                    // Fallback to serving local files from Documents directory
                    self.handleLocalFileRequest(request, documentsUrl: documentsUrl, method: method, completion: completion)
                }
            })
        }
        
        do {
            try webServer?.start(options: [
                GCDWebServerOption_Port: port,
                GCDWebServerOption_BindToLocalhost: true
            ])
            print("\(TAG) Server started on port \(port)")
        } catch {
            print("\(TAG) !!! Start failed: \(error)")
        }
    }
    
    // MARK: - SMB Handler
    
    private func handleSMBRequest(_ request: GCDWebServerRequest, method: String, completion: @escaping (GCDWebServerResponse) -> Void) {
        let params = self.queryItems(from: request)
        guard let address = params["address"],
              let share = params["share"],
              let path = params["path"] else {
            print("\(self.TAG) !!! SMB: Missing params")
            let resp = GCDWebServerDataResponse(statusCode: 400)
            self.addCORSHeaders(to: resp)
            completion(resp)
            return
        }
        
        let username = params["username"] ?? "guest"
        let password = params["password"] ?? ""
        let requestedRange = request.headers["Range"]
        let (rangeStart, rangeEnd) = self.parseRangeHeader(requestedRange)
        
        // --- STEP 1: Ensure we have the file size (Critical for AVPlayer) ---
        var totalSize: Int64 = fileSizeSync(address: address, share: share, path: path)
        if totalSize <= 0 {
            print("\(self.TAG) SMB: Cache miss, fetching size for \(path)...")
            let sizeWaiter = DispatchSemaphore(value: 0)
            SMBManager.shared.fetchFileSize(address: address, share: share, path: path, user: username, pass: password) { size in
                totalSize = size
                sizeWaiter.signal()
            }
            _ = sizeWaiter.wait(timeout: DispatchTime.now() + 5.0)
        }
        
        // --- STEP 2: Configure Stream and Cancellation ID ---
        let mime = self.guessContentType(forPath: path, fallback: "application/octet-stream")
        let defaultChunkSize: Int64 = 4 * 1024 * 1024
        let cancelID = "smb_stream_\(UUID().uuidString.prefix(8))"
        let actualEnd = (rangeEnd >= rangeStart) ? rangeEnd : (totalSize > 0 ? (totalSize - 1) : (rangeStart + defaultChunkSize - 1))
        let requestLength = actualEnd - rangeStart + 1
        
        print("\(self.TAG) SMB Stream Init [\(cancelID)]: \(path), Size: \(totalSize), Range: \(rangeStart)-\(actualEnd)")

        var isFinished = false
        var streamError: Error?
        var internalBuffer = Data()
        let lock = NSLock()
        let streamSemaphore = DispatchSemaphore(value: 0)
        
        SMBManager.shared.streamIncremental(
            address: address, share: share, path: path,
            user: username, pass: password,
            offset: rangeStart, length: requestLength,
            cancelID: cancelID,
            onData: { chunk in
                lock.lock()
                internalBuffer.append(chunk)
                lock.unlock()
                streamSemaphore.signal()
            },
            completion: { _, error in
                lock.lock()
                isFinished = true
                streamError = error
                lock.unlock()
                streamSemaphore.signal()
            }
        )
        
        // --- STEP 3: Setup the Response (StreamBlock) ---
        // We use a canceller object that triggers when the response is deallocated (connection closed)
        let canceller = StreamCanceller(id: cancelID)
        
        let response = GCDWebServerStreamedResponse(contentType: mime, streamBlock: { [canceller] (errorPoint: AutoreleasingUnsafeMutablePointer<NSError?>?) -> Data? in
            while true {
                lock.lock()
                if !internalBuffer.isEmpty {
                    let dataToSend = internalBuffer
                    internalBuffer = Data()
                    lock.unlock()
                    return dataToSend
                }
                
                if isFinished {
                    let err = streamError
                    lock.unlock()
                    
                    if let err = err {
                        print("\(self.TAG) !!! SMB Stream [\(cancelID)] finished with ERROR: \(err)")
                        errorPoint?.pointee = err as NSError
                    } else {
                        print("\(self.TAG) SMB Stream [\(cancelID)] finished clean: \(path)")
                    }
                    // Explicitly cleanup here too for immediate effect on normal finish
                    SMBManager.shared.cancelStreamSync(id: canceller.id)
                    return Data() 
                }
                lock.unlock()
                
                // Optimized wait: Use 100ms timeout for high responsiveness
                _ = streamSemaphore.wait(timeout: DispatchTime.now() + 0.1)
            }
        })
        
        // --- STEP 4: Set Headers (RFC 7233 Compliance) ---
        let isRangeRequest = requestedRange != nil
        response.statusCode = isRangeRequest ? 206 : 200
        response.setValue("bytes", forAdditionalHeader: "Accept-Ranges")
        
        if isRangeRequest {
            let totalStr = totalSize > 0 ? "\(totalSize)" : "*"
            response.setValue("bytes \(rangeStart)-\(actualEnd)/\(totalStr)", forAdditionalHeader: "Content-Range")
            print("\(self.TAG) SMB Response [206] [\(cancelID)]: \(rangeStart)-\(actualEnd)/\(totalStr)")
        } else {
            print("\(self.TAG) SMB Response [200] [\(cancelID)]: TotalSize: \(totalSize)")
        }
        
        self.addCORSHeaders(to: response)
        completion(response)
    }
    
    // Helper to get cached file size (non-blocking if cached)
    private func fileSizeSync(address: String, share: String, path: String) -> Int64 {
        return SMBManager.shared.getCachedFileSize(address: address, share: share, path: path)
    }
    
    // MARK: - WebDAV Handler
    
    private func handleWebDAVRequest(_ request: GCDWebServerRequest, method: String, completion: @escaping (GCDWebServerResponse) -> Void) {
        let params = self.queryItems(from: request)
        guard let baseUrl = params["baseUrl"],
              let remotePath = params["path"] else {
            completion(GCDWebServerDataResponse(statusCode: 400))
            return
        }
        
        let username = params["username"] ?? ""
        let password = params["password"] ?? ""
        guard var comps = URLComponents(string: baseUrl) else {
            completion(GCDWebServerDataResponse(statusCode: 400))
            return
        }
        
        let cleanPath = remotePath.hasPrefix("/") ? remotePath : "/\(remotePath)"
        let basePath = comps.path.hasSuffix("/") ? String(comps.path.dropLast()) : comps.path
        comps.path = basePath + cleanPath
        guard let remoteURL = comps.url else {
            completion(GCDWebServerDataResponse(statusCode: 400))
            return
        }
        
        var req = URLRequest(url: remoteURL)
        req.httpMethod = method
        req.timeoutInterval = 60 // Extended for playback
        
        if !username.isEmpty {
            let auth = "\(username):\(password)"
            if let authData = auth.data(using: .utf8) {
                req.setValue("Basic \(authData.base64EncodedString())", forHTTPHeaderField: "Authorization")
            }
        }
        
        let requestedRange = request.headers["Range"]
        if let requestedRange = requestedRange, !requestedRange.isEmpty {
            req.setValue(requestedRange, forHTTPHeaderField: "Range")
        }
        
        // Use streaming approach for WebDAV too to avoid OOM and enable seek
        let mime = self.guessContentType(forPath: remotePath, fallback: "application/octet-stream")
        
        if method == "HEAD" {
            URLSession.shared.dataTask(with: req) { _, response, _ in
                guard let http = response as? HTTPURLResponse else {
                    completion(GCDWebServerResponse(statusCode: 502))
                    return
                }
                let resp = GCDWebServerResponse(statusCode: http.statusCode)
                for (key, value) in http.allHeaderFields {
                    if let k = key as? String, let v = value as? String {
                        if ["Content-Length", "Content-Range", "Accept-Ranges", "Content-Type"].contains(k) {
                            resp.setValue(v, forAdditionalHeader: k)
                        }
                    }
                }
                self.addCORSHeaders(to: resp)
                completion(resp)
            }.resume()
            return
        }

        // GET Response: Stream directly from URLSession
        var internalBuffer = Data()
        var isFinished = false
        var responseError: Error?
        var httpResponse: HTTPURLResponse?
        let lock = NSLock()
        let semaphore = DispatchSemaphore(value: 0)
        
        let session = URLSession(configuration: .default, delegate: WebDAVStreamDelegate(onResponse: { resp in
            httpResponse = resp
            semaphore.signal()
        }, onData: { chunk in
            lock.lock()
            internalBuffer.append(chunk)
            lock.unlock()
            semaphore.signal()
        }, onComplete: { error in
            lock.lock()
            isFinished = true
            responseError = error
            lock.unlock()
            semaphore.signal()
        }), delegateQueue: nil)
        
        session.dataTask(with: req).resume()
        
        // Wait for headers to arrive so we can create the response object with proper status/mime
        let _ = semaphore.wait(timeout: .now() + 10.0)
        
        let finalMime = httpResponse?.value(forHTTPHeaderField: "Content-Type") ?? mime
        let response = GCDWebServerStreamedResponse(contentType: finalMime, streamBlock: { (errorPoint: AutoreleasingUnsafeMutablePointer<NSError?>?) -> Data? in
            while true {
                lock.lock()
                if !internalBuffer.isEmpty {
                    let chunk = internalBuffer
                    internalBuffer = Data()
                    lock.unlock()
                    return chunk
                }
                if isFinished {
                    lock.unlock()
                    return Data()
                }
                lock.unlock()
                _ = semaphore.wait(timeout: DispatchTime.now() + 0.1)
            }
        })
        
        if let http = httpResponse {
            response.statusCode = http.statusCode
            for (key, value) in http.allHeaderFields {
                if let k = key as? String, let v = value as? String {
                    if ["Content-Length", "Content-Range", "Accept-Ranges"].contains(k) {
                        response.setValue(v, forAdditionalHeader: k)
                    }
                }
            }
        }
        
        self.addCORSHeaders(to: response)
        completion(response)
    }
    
    // MARK: - File Handler
    
    private func handleLocalFileRequest(_ request: GCDWebServerRequest, documentsUrl: URL, method: String, completion: @escaping (GCDWebServerResponse) -> Void) {
        let fileUrl = documentsUrl.appendingPathComponent(request.path)
        var isDir: ObjCBool = false
        
        if FileManager.default.fileExists(atPath: fileUrl.path, isDirectory: &isDir) && !isDir.boolValue {
            if let response = (method == "HEAD") 
                ? GCDWebServerResponse(statusCode: 200) 
                : GCDWebServerFileResponse(file: fileUrl.path, byteRange: request.byteRange) {
                
                response.setValue("bytes", forAdditionalHeader: "Accept-Ranges")
                self.addCORSHeaders(to: response)
                completion(response)
                return
            }
        }
        
        print("\(self.TAG) !!! 404 - Not found: \(request.path)")
        let resp = GCDWebServerDataResponse(statusCode: 404)
        self.addCORSHeaders(to: resp)
        completion(resp)
    }
    
    private func addCORSHeaders(to response: GCDWebServerResponse) {
        response.setValue("*", forAdditionalHeader: "Access-Control-Allow-Origin")
        response.setValue("GET, HEAD, OPTIONS", forAdditionalHeader: "Access-Control-Allow-Methods")
        response.setValue("*", forAdditionalHeader: "Access-Control-Allow-Headers")
    }
    
    private func queryItems(from request: GCDWebServerRequest) -> [String: String] {
        var result: [String: String] = [:]
        
        if let query = request.query {
            for (rawKey, rawValue) in query {
                let key = "\(rawKey)"
                if let value = rawValue as? String {
                    result[key] = value
                } else if let value = rawValue as? NSNumber {
                    result[key] = value.stringValue
                } else {
                    result[key] = "\(rawValue)"
                }
            }
        }
        
        return result
    }
    
    private func parseRangeHeader(_ rangeHeader: String?) -> (start: Int64, end: Int64) {
        guard let rangeHeader = rangeHeader, rangeHeader.hasPrefix("bytes=") else {
            return (0, -1)
        }
        let payload = String(rangeHeader.dropFirst("bytes=".count))
        let parts = payload.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard let first = parts.first, let start = Int64(first) else {
            return (0, -1)
        }
        if parts.count == 2, let end = Int64(parts[1]) {
            return (start, max(start, end))
        }
        return (start, -1)
    }
    
    private func guessContentType(forPath path: String, fallback: String) -> String {
        let ext = URL(fileURLWithPath: path).pathExtension
        if !ext.isEmpty, let type = UTType(filenameExtension: ext), let mime = type.preferredMIMEType {
            return mime
        }
        return fallback
    }
    
    func stop() {
        if let server = webServer, server.isRunning {
            server.stop()
            print("\(TAG) Stopped")
        }
    }
    
    func getServerUrl(_ call: CAPPluginCall) {
        if let server = webServer, server.isRunning, let url = server.serverURL {
            call.resolve(["url": url.absoluteString])
        } else {
            // Try to restart if not running
            startOnMainThread()
            if let server = webServer, server.isRunning, let url = server.serverURL {
                call.resolve(["url": url.absoluteString])
            } else {
                call.reject("Server not running")
            }
        }
    }
}

// MARK: - WebDAV Stream Helper
class WebDAVStreamDelegate: NSObject, URLSessionDataDelegate {
    let onResponse: (HTTPURLResponse) -> Void
    let onData: (Data) -> Void
    let onComplete: (Error?) -> Void
    
    init(onResponse: @escaping (HTTPURLResponse) -> Void, onData: @escaping (Data) -> Void, onComplete: @escaping (Error?) -> Void) {
        self.onResponse = onResponse
        self.onData = onData
        self.onComplete = onComplete
    }
    
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let http = response as? HTTPURLResponse {
            onResponse(http)
        }
        completionHandler(.allow)
    }
    
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        onData(data)
    }
    
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        onComplete(error)
    }
}

/// Helper to handle response lifecycle for cancellation
private class StreamCanceller {
    let id: String
    init(id: String) { self.id = id }
    deinit {
        print("[LocalServer] StreamCanceller: Response deallocated for \(id). Stopping SMB fetch.")
        SMBManager.shared.cancelStreamSync(id: id)
    }
}
