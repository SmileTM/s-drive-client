package com.android.drive;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WebDavPlugin.class);
        super.onCreate(savedInstanceState);
        checkIntent(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        checkIntent(intent);
    }

    @Override
    public void onStart() {
        super.onStart();
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebSettings settings = getBridge().getWebView().getSettings();
            // Allow mixed content if needed, though ideally secured
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
            settings.setDomStorageEnabled(true);
            settings.setJavaScriptEnabled(true);
        }
    }

    private void checkIntent(Intent intent) {
        if (intent == null) return;

        String action = intent.getAction();
        String type = intent.getType();

        if (Intent.ACTION_SEND.equals(action) && type != null) {
            handleSendImage(intent);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action) && type != null) {
            handleSendMultipleImages(intent);
        } else if (intent.getData() != null) {
            // Existing Deep Link Handler
            String data = intent.getData().toString();
            if (data.contains("webdav://transfers")) {
                if (getBridge() != null) {
                    getBridge().triggerWindowJSEvent("openTransferDeepLink");
                }
            }
        }
    }

    private void handleSendImage(Intent intent) {
        Uri imageUri = (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (imageUri != null) {
            ArrayList<Uri> imageUris = new ArrayList<>();
            imageUris.add(imageUri);
            sendUrisToJS(imageUris);
        }
    }

    private void handleSendMultipleImages(Intent intent) {
        ArrayList<Uri> imageUris = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        if (imageUris != null) {
            sendUrisToJS(imageUris);
        }
    }

    private void sendUrisToJS(ArrayList<Uri> uris) {
        if (getBridge() == null) return;

        JSONArray items = new JSONArray();
        ContentResolver contentResolver = getContentResolver();

        for (Uri uri : uris) {
            // We need to persist permission to read this URI later if we pass it around
            // Or we just read metadata now. Since Capacitor might need to read the file content later,
            // we should try to take persistable URI permission if possible, though for ACTION_SEND
            // the grant is usually temporary.
            // Best approach for Capacitor: Use the content:// URI directly in the JS side
            // and have the plugin read it using the context's ContentResolver.

            try {
                JSONObject item = new JSONObject();
                item.put("uri", uri.toString());
                item.put("name", getFileName(uri));
                item.put("mimeType", contentResolver.getType(uri));
                item.put("size", getFileSize(uri));
                items.put(item);
            } catch (JSONException e) {
                Log.e("MainActivity", "JSON Error", e);
            }
        }

        JSObject ret = new JSObject();
        ret.put("items", items);
        
        // Use notifyListeners if implemented in a plugin, or triggerWindowJSEvent
        // triggerWindowJSEvent is simplest for global listeners
        // We'll dispatch a custom window event that the React app listens for.
        final String safeJson = ret.toString();
        getBridge().eval("window.dispatchEvent(new CustomEvent('appSendIntentReceived', { detail: " + safeJson + " }));", x -> {});
    }

    private String getFileName(Uri uri) {
        String result = null;
        if (uri.getScheme().equals("content")) {
            try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (nameIndex != -1) {
                        result = cursor.getString(nameIndex);
                    }
                }
            }
        }
        if (result == null) {
            result = uri.getPath();
            int cut = result.lastIndexOf('/');
            if (cut != -1) {
                result = result.substring(cut + 1);
            }
        }
        return result;
    }

    private long getFileSize(Uri uri) {
        if (uri.getScheme().equals("content")) {
            try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                    if (sizeIndex != -1) {
                        return cursor.getLong(sizeIndex);
                    }
                }
            }
        }
        return 0;
    }
}
