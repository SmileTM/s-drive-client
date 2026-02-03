package com.webdev.client;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.util.Iterator;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

@CapacitorPlugin(name = "WebDavNative")
public class WebDavPlugin extends Plugin {

    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build();

    @PluginMethod
    public void request(PluginCall call) {
        String url = call.getString("url");
        String method = call.getString("method", "GET");
        JSObject headers = call.getObject("headers");
        String body = call.getString("body");

        if (url == null) {
            call.reject("URL is required");
            return;
        }

        Request.Builder requestBuilder = new Request.Builder()
                .url(url);

        // Set Headers
        if (headers != null) {
            for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                String key = it.next();
                String value = headers.getString(key);
                if (value != null) {
                    requestBuilder.addHeader(key, value);
                }
            }
        }

        // Handle Body & Method
        RequestBody requestBody = null;
        if (body != null) {
            // Defaulting to text/xml for WebDAV, or try to detect from headers
            MediaType mediaType = MediaType.parse("text/xml; charset=utf-8"); 
            if (headers != null && headers.has("Content-Type")) {
                 mediaType = MediaType.parse(headers.getString("Content-Type"));
            }
            requestBody = RequestBody.create(body, mediaType);
        }

        // OkHttp requires a body for some methods (POST, PUT, PROPFIND, PATCH) 
        // and forbids it for others (GET, HEAD).
        // PROPFIND usually has a body but can be empty.
        boolean allowsBody = method.equals("POST") || method.equals("PUT") || method.equals("PATCH") || method.equals("PROPFIND") || method.equals("PROPPATCH") || method.equals("LOCK");
        
        if (allowsBody) {
             if (requestBody == null) {
                 // Empty body for PROPFIND is common
                 requestBody = RequestBody.create("", null); 
             }
             requestBuilder.method(method, requestBody);
        } else {
             requestBuilder.method(method, null);
        }

        // Execute
        try (Response response = client.newCall(requestBuilder.build()).execute()) {
            JSObject ret = new JSObject();
            ret.put("status", response.code());
            ret.put("data", response.body() != null ? response.body().string() : "");
            
            // Copy headers if needed (simplified for now)
            
            call.resolve(ret);
        } catch (IOException e) {
            call.reject(e.getMessage());
        } catch (Exception e) {
             call.reject(e.getMessage());
        }
    }
}
