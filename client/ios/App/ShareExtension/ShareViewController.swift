import UIKit
import Social
import MobileCoreServices
import UniformTypeIdentifiers

class ShareViewController: SLComposeServiceViewController {
    
    private let appGroup = "group.com.android.drive.share"
    private var sharedFiles: [URL] = []
    
    override func isContentValid() -> Bool {
        // Do validation of contentText and/or NSExtensionContext attachments here
        return true
    }

    override func didSelectPost() {
        // This is called after the user taps Post. 
        // We'll extract the files and handle them.
        self.handleAttachments()
    }

    override func configurationItems() -> [Any]! {
        // To add configuration options via table cells at the bottom of the sheet, return an array of SLComposeSheetConfigurationItem here.
        return []
    }
    
    private func handleAttachments() {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else {
            self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
            return
        }
        
        let dispatchGroup = DispatchGroup()
        
        for item in items {
            guard let attachments = item.attachments else { continue }
            for attachment in attachments {
                // Support generic file types
                if attachment.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
                    dispatchGroup.enter()
                    attachment.loadItem(forTypeIdentifier: UTType.data.identifier, options: nil) { [weak self] (data, error) in
                        defer { dispatchGroup.leave() }
                        if let url = data as? URL {
                            self?.sharedFiles.append(url)
                        }
                    }
                }
            }
        }
        
        dispatchGroup.notify(queue: .main) {
            self.startUpload()
        }
    }
    
    private func startUpload() {
        // Here we will implement the background URLSession upload logic
        // For now, we'll just show a success message and close.
        print("ShareExtension: Starting upload of \(sharedFiles.count) files")
        
        // Finalize
        self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }
}
