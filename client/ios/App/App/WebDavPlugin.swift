import Foundation
import Capacitor

/**
 * WebDavPlugin
 * Acts as a bridge between Capacitor JS and Native Swift Managers.
 * Delegates actual logic to WebDAVManager, SMBManager, and LocalServerManager.
 *
 * Capacitor 8: Uses CAPBridgedPlugin protocol for plugin registration.
 */
@objc(WebDavPlugin)
public class WebDavPlugin: CAPPlugin, CAPBridgedPlugin {
    
    // MARK: - CAPBridgedPlugin Protocol
    public let identifier = "WebDavPlugin"
    public let jsName = "WebDavNative"
    public let pluginMethods: [CAPPluginMethod] = [
        // WebDAV
        CAPPluginMethod(name: "echo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "upload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        
        // Background
        CAPPluginMethod(name: "startBackgroundWork", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopBackgroundWork", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestNotificationPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelNotification", returnType: CAPPluginReturnPromise),
        
        // Local Server
        CAPPluginMethod(name: "getServerUrl", returnType: CAPPluginReturnPromise),
        
        // Android Parity
        CAPPluginMethod(name: "getStorageInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listDirectory", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createDirectory", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "search", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestManageStoragePermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateNotification", returnType: CAPPluginReturnPromise),
        
        // SMB
        CAPPluginMethod(name: "smbConnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "smbListDirectory", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "smbMkdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "smbDelete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "smbRename", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "smbCopy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "smbDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "smbUpload", returnType: CAPPluginReturnPromise),
    ]
    
    // MARK: - Managers
    private let webdav = WebDAVManager()
    private let smb = SMBManager()
    private let server = LocalServerManager()
    
    override public func load() {
        print("[WebDavPlugin] Plugin loaded (Capacitor 8 CAPBridgedPlugin)")
    }
    
    // MARK: - WebDAV Methods
    
    @objc func echo(_ call: CAPPluginCall) {
        call.resolve(["value": call.getString("value") ?? ""])
    }
    
    @objc func request(_ call: CAPPluginCall) {
        webdav.request(call)
    }
    
    @objc func download(_ call: CAPPluginCall) {
        webdav.download(call)
    }
    
    @objc func upload(_ call: CAPPluginCall) {
        webdav.upload(call)
    }
    
    @objc func cancel(_ call: CAPPluginCall) {
        call.resolve()
    }
    
    // MARK: - Background / Notification (Stubs)
    
    @objc func startBackgroundWork(_ call: CAPPluginCall) {
        call.resolve()
    }
    
    @objc func stopBackgroundWork(_ call: CAPPluginCall) {
        call.resolve()
    }
    
    @objc func requestNotificationPermission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            call.resolve(["granted": granted])
        }
    }
    
    @objc func cancelNotification(_ call: CAPPluginCall) {
        call.resolve()
    }
    
    // MARK: - Local Server
    
    @objc func getServerUrl(_ call: CAPPluginCall) {
        server.getServerUrl(call)
    }
    
    // MARK: - Android Parity
    
    @objc func getStorageInfo(_ call: CAPPluginCall) {
        let fileURL = URL(fileURLWithPath: NSHomeDirectory())
        do {
            let values = try fileURL.resourceValues(forKeys: [.volumeTotalCapacityKey, .volumeAvailableCapacityKey])
            if let total = values.volumeTotalCapacity, let available = values.volumeAvailableCapacity {
                call.resolve([
                    "total": total,
                    "used": total - available,
                    "free": available
                ])
            } else {
                call.resolve(["total": 0, "used": 0, "free": 0])
            }
        } catch {
            call.reject("Failed to get storage info: \(error.localizedDescription)")
        }
    }
    
    @objc func listDirectory(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Path missing")
            return
        }
        do {
            let items = try FileManager.default.contentsOfDirectory(atPath: path)
            let result = items.map { name -> [String: Any] in
                var isDir: ObjCBool = false
                let fullPath = (path as NSString).appendingPathComponent(name)
                FileManager.default.fileExists(atPath: fullPath, isDirectory: &isDir)
                return ["name": name, "type": isDir.boolValue ? "directory" : "file"]
            }
            call.resolve(["files": result])
        } catch {
            call.reject(error.localizedDescription)
        }
    }
    
    @objc func createDirectory(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("Path missing")
            return
        }
        do {
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: nil)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }
    
    @objc func search(_ call: CAPPluginCall) {
        call.resolve(["files": []])
    }
    
    @objc func requestManageStoragePermission(_ call: CAPPluginCall) {
        call.resolve(["granted": true])
    }
    
    @objc func updateNotification(_ call: CAPPluginCall) {
        call.resolve()
    }
    
    // MARK: - SMB Methods
    
    @objc func smbConnect(_ call: CAPPluginCall) { smb.connect(call) }
    @objc func smbListDirectory(_ call: CAPPluginCall) { smb.listDirectory(call) }
    @objc func smbMkdir(_ call: CAPPluginCall) { smb.mkdir(call) }
    @objc func smbDelete(_ call: CAPPluginCall) { smb.delete(call) }
    @objc func smbRename(_ call: CAPPluginCall) { smb.rename(call) }
    @objc func smbCopy(_ call: CAPPluginCall) { smb.copy(call) }
    @objc func smbDownload(_ call: CAPPluginCall) { smb.download(call) }
    @objc func smbUpload(_ call: CAPPluginCall) { smb.upload(call) }
}
