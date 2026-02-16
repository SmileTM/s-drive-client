import Foundation
import Capacitor
import GCDWebServer

class LocalServerManager: NSObject {
    
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
            doStart()
        } else {
            DispatchQueue.main.sync {
                self.doStart()
            }
        }
    }
    
    private func doStart() {
        if webServer != nil && webServer!.isRunning {
            return
        }
        
        webServer = GCDWebServer()
        
        // Serve Documents Directory (equivalent to Android ExternalStorage)
        let documentsPath = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first!
        let documentsUrl = URL(fileURLWithPath: documentsPath)
        
        print("\(TAG) Documents Path: \(documentsPath)")

        // Add Default Handlers for OPTIONS (CORS Preflight)
        webServer?.addDefaultHandler(forMethod: "OPTIONS", request: GCDWebServerRequest.self, processBlock: { request in
            let response = GCDWebServerDataResponse(statusCode: 200)
            response.setValue("*", forAdditionalHeader: "Access-Control-Allow-Origin")
            response.setValue("GET, HEAD, OPTIONS", forAdditionalHeader: "Access-Control-Allow-Methods")
            response.setValue("*", forAdditionalHeader: "Access-Control-Allow-Headers")
            return response
        })
        
        // Custom Handler for GET/HEAD with CORS + Range Support
        webServer?.addHandler(forMethod: "GET", pathRegex: ".*", request: GCDWebServerRequest.self, processBlock: { request in
            let path = request.path
            let fileUrl = documentsUrl.appendingPathComponent(path)
            
            // Check if file exists and is not directory
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: fileUrl.path, isDirectory: &isDir) && !isDir.boolValue {
                
                // Create File Response with Byte Range Support
                if let response = GCDWebServerFileResponse(file: fileUrl.path, byteRange: request.byteRange) {
                    response.setValue("*", forAdditionalHeader: "Access-Control-Allow-Origin")
                    response.setValue("bytes", forAdditionalHeader: "Accept-Ranges")
                    response.cacheControlMaxAge = 3600
                    return response
                }
            }
            
            // Not Found
            let notFound = GCDWebServerDataResponse(statusCode: 404)
            notFound.setValue("*", forAdditionalHeader: "Access-Control-Allow-Origin")
            return notFound
        })

        // Also handle HEAD requests
        webServer?.addHandler(forMethod: "HEAD", pathRegex: ".*", request: GCDWebServerRequest.self, processBlock: { request in
             let path = request.path
             let fileUrl = documentsUrl.appendingPathComponent(path)
             
             if let response = GCDWebServerFileResponse(file: fileUrl.path, byteRange: request.byteRange) {
                 response.setValue("*", forAdditionalHeader: "Access-Control-Allow-Origin")
                 response.setValue("bytes", forAdditionalHeader: "Accept-Ranges")
                 return response
             }
             let notFound = GCDWebServerDataResponse(statusCode: 404)
             notFound.setValue("*", forAdditionalHeader: "Access-Control-Allow-Origin")
             return notFound
        })
        
        do {
            try webServer?.start(options: [
                GCDWebServerOption_Port: port,
                GCDWebServerOption_BindToLocalhost: true
            ])
            print("\(TAG) Started on port \(port), serving: \(documentsPath)")
        } catch {
            print("\(TAG) Failed to start: \(error)")
        }
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
            // Try to restart
            startOnMainThread()
            if let server = webServer, server.isRunning, let url = server.serverURL {
                call.resolve(["url": url.absoluteString])
            } else {
                call.reject("Server not running")
            }
        }
    }
}
