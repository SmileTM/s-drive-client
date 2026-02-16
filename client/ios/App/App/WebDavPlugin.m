#import <Capacitor/Capacitor.h>

CAP_PLUGIN(WebDavPlugin, "WebDavNative",
           // WebDAV
           CAP_PLUGIN_METHOD(echo, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(request, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(download, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(upload, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(cancel, CAPPluginReturnPromise);

           // Background
           CAP_PLUGIN_METHOD(startBackgroundWork, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(stopBackgroundWork, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(requestNotificationPermission,
                             CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(cancelNotification, CAPPluginReturnPromise);

           // Local Server
           CAP_PLUGIN_METHOD(getServerUrl, CAPPluginReturnPromise);

           // Android Parity Methods
           CAP_PLUGIN_METHOD(getStorageInfo, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(listDirectory, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(createDirectory, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(search, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(requestManageStoragePermission,
                             CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(updateNotification, CAPPluginReturnPromise);

           // SMB
           CAP_PLUGIN_METHOD(smbConnect, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(smbListDirectory, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(smbMkdir, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(smbDelete, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(smbRename, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(smbCopy, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(smbDownload, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(smbUpload, CAPPluginReturnPromise);)
