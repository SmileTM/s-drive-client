import Foundation
import Capacitor
import AMSMB2

class SMBManager: NSObject {
    
    private let TAG = "[SMBManager]"
    
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
              let share = call.getString("share") else {
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
        guard let client = createClient(from: call) else { return }
        let share = call.getString("share") ?? ""
        
        client.connectShare(name: share) { error in
            if let error = error {
                print("\(self.TAG) Connect failed: \(error)")
                call.reject("SMB Connection Failed: \(error.localizedDescription)")
            } else {
                operation(client)
            }
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
        
        print("\(TAG) Download: remote=\(cleanPath), local=\(resolvedDest)")
        
        // Ensure parent directory exists
        let parent = localURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        
        let progressHandler: @Sendable (Int64, Int64) -> Bool = { bytes, total in
            return true
        }
        
        withConnection(call) { client in
            Task {
                do {
                    try await client.downloadItem(atPath: cleanPath, to: localURL, progress: progressHandler)
                    print("\(self.TAG) Download complete: \(resolvedDest)")
                    call.resolve()
                } catch {
                    print("\(self.TAG) Download failed: \(error)")
                    call.reject("SMB Download Failed: \(error.localizedDescription)")
                }
            }
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
        
        print("\(TAG) Upload: local=\(resolvedSource), remote=\(cleanPath)")
        
        guard FileManager.default.fileExists(atPath: resolvedSource) else {
            call.reject("Source file not found: \(resolvedSource)")
            return
        }
        
        let progressHandler: @Sendable (Int64) -> Bool = { bytes in
            return true
        }
        
        withConnection(call) { client in
            Task {
                do {
                    if overwrite {
                        try? await client.removeItem(atPath: cleanPath)
                    }
                    try await client.uploadItem(at: localURL, toPath: cleanPath, progress: progressHandler)
                    print("\(self.TAG) Upload complete: \(cleanPath)")
                    call.resolve()
                } catch {
                    print("\(self.TAG) Upload failed: \(error)")
                    call.reject("SMB Upload Failed: \(error.localizedDescription)")
                }
            }
        }
    }
}
