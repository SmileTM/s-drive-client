import Foundation
import Capacitor

class WebDAVManager: NSObject, URLSessionDelegate, URLSessionTaskDelegate, URLSessionDownloadDelegate {
    
    private let TAG = "[WebDAVManager]"
    
    // Track active download tasks
    private var downloadCallbacks = [Int: (call: CAPPluginCall, destURL: URL)]()
    private var uploadCallbacks = [Int: CAPPluginCall]()
    
    override init() {
        super.init()
        print("\(TAG) Initialized")
    }
    
    // MARK: - Path Resolution
    
    private func resolveLocalPath(_ path: String) -> String {
        if path.hasPrefix("/var/") || path.hasPrefix("/private/") || path.hasPrefix("/Users/") {
            return path
        }
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let cleanPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        return docs.appendingPathComponent(cleanPath).path
    }
    
    // MARK: - Public Methods
    
    func request(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"),
              let url = URL(string: urlString),
              let method = call.getString("method") else {
            call.reject("Invalid arguments: url or method missing")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = method
        
        if let headers = call.getObject("headers") as? [String: String] {
            for (key, value) in headers {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }
        
        if let body = call.getString("body") {
            request.httpBody = body.data(using: .utf8)
        }
        
        let dataTask = URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                call.reject(error.localizedDescription)
                return
            }
            
            guard let httpResponse = response as? HTTPURLResponse else {
                call.reject("Invalid response")
                return
            }
            
            var resultData = ""
            if let data = data {
                let responseType = call.getString("responseType") ?? "text"
                if responseType == "base64" {
                    resultData = data.base64EncodedString()
                } else {
                    resultData = String(data: data, encoding: .utf8) ?? ""
                }
            }
            
            call.resolve([
                "status": httpResponse.statusCode,
                "data": resultData,
                "headers": httpResponse.allHeaderFields
            ])
        }
        dataTask.resume()
    }
    
    func download(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"),
              let url = URL(string: urlString) else {
            call.reject("Missing url")
            return
        }
        
        let destPath = call.getString("destPath") ?? ""
        if destPath.isEmpty {
            call.reject("Missing destPath")
            return
        }
        
        let resolvedDest = resolveLocalPath(destPath)
        let destURL = URL(fileURLWithPath: resolvedDest)
        
        print("\(TAG) Download: \(urlString) -> \(resolvedDest)")
        
        // Ensure parent directory exists
        let parent = destURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        
        // Build request with headers
        var request = URLRequest(url: url)
        if let headers = call.getObject("headers") as? [String: String] {
            for (key, value) in headers {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }
        
        // Use a simple data task (download to memory then write)
        // For large files, a download task would be better but this works for V1
        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }
            
            if let error = error {
                call.reject("Download failed: \(error.localizedDescription)")
                return
            }
            
            guard let httpResponse = response as? HTTPURLResponse,
                  (200...299).contains(httpResponse.statusCode) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                call.reject("Download failed with status \(status)")
                return
            }
            
            guard let data = data else {
                call.reject("No data received")
                return
            }
            
            do {
                try data.write(to: destURL)
                print("\(self.TAG) Download complete: \(resolvedDest) (\(data.count) bytes)")
                call.resolve()
            } catch {
                call.reject("Failed to write file: \(error.localizedDescription)")
            }
        }
        task.resume()
    }
    
    func upload(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"),
              let url = URL(string: urlString) else {
            call.reject("Missing url")
            return
        }
        
        let sourcePath = call.getString("sourcePath") ?? ""
        if sourcePath.isEmpty {
            call.reject("Missing sourcePath")
            return
        }
        
        let resolvedSource = resolveLocalPath(sourcePath)
        let sourceURL = URL(fileURLWithPath: resolvedSource)
        
        print("\(TAG) Upload: \(resolvedSource) -> \(urlString)")
        
        guard FileManager.default.fileExists(atPath: resolvedSource) else {
            call.reject("Source file not found: \(resolvedSource)")
            return
        }
        
        guard let fileData = try? Data(contentsOf: sourceURL) else {
            call.reject("Failed to read source file")
            return
        }
        
        let method = call.getString("method") ?? "PUT"
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = fileData
        
        if let headers = call.getObject("headers") as? [String: String] {
            for (key, value) in headers {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }
        
        let task = URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            guard let self = self else { return }
            
            if let error = error {
                call.reject("Upload failed: \(error.localizedDescription)")
                return
            }
            
            guard let httpResponse = response as? HTTPURLResponse,
                  (200...299).contains(httpResponse.statusCode) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                call.reject("Upload failed with status \(status)")
                return
            }
            
            print("\(self.TAG) Upload complete: \(resolvedSource)")
            call.resolve()
        }
        task.resume()
    }
    
    // MARK: - URLSession Delegates (for future background support)
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        print("\(TAG) Download finished: \(location)")
    }
}
