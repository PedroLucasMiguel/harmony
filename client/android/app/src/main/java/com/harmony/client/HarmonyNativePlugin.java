package com.harmony.client;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.PeerConnection;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * What the page cannot do for itself. Called from src/renderer/web/native.js
 * as Capacitor.nativePromise('HarmonyNative', method, options).
 */
@CapacitorPlugin(name = "HarmonyNative")
public class HarmonyNativePlugin extends Plugin {

    /** The screen share in progress, if any. See ScreenShare. */
    private ScreenShare share;

    /**
     * Share the screen into the channel: the system's "start recording or
     * casting?" prompt, then capture and publish to `url` (the channel's
     * WHIP URL for this member's screen path, from the page).
     */
    @PluginMethod
    public void startScreenShare(PluginCall call) {
        if (share != null) {
            call.reject("Already sharing.");
            return;
        }
        if (!VoiceService.running) {
            call.reject("Join a voice channel first.");
            return;
        }
        if (call.getString("url") == null) {
            call.reject("No screen path for this channel.");
            return;
        }
        MediaProjectionManager projections =
            (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        startActivityForResult(call, projections.createScreenCaptureIntent(), "onProjectionResult");
    }

    @ActivityCallback
    private void onProjectionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent permission = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || permission == null) {
            call.reject("Screen sharing was not allowed.", "cancelled");
            return;
        }
        String url = call.getString("url");
        int fps = call.getInt("fps", 30);
        int kbps = call.getInt("maxBitrateKbps", 4000);
        List<PeerConnection.IceServer> ice = iceServers(call.getArray("iceServers"));

        // The capture can only start once the service has the
        // mediaProjection type -- see VoiceService.onForeground.
        VoiceService.onForeground = () -> {
            share = new ScreenShare(getContext(), reason -> {
                endShare();
                getBridge().triggerWindowJSEvent("harmonyscreenshare", "{\"reason\":\"" + reason + "\"}");
            });
            share.start(permission, url, ice, fps, kbps, new ScreenShare.Result() {
                @Override
                public void ok() {
                    call.resolve();
                }

                @Override
                public void fail(String message) {
                    getActivity().runOnUiThread(() -> endShare());
                    call.reject(message);
                }
            });
        };
        setProjecting(true);
    }

    @PluginMethod
    public void stopScreenShare(PluginCall call) {
        endShare();
        call.resolve();
    }

    private void endShare() {
        if (share == null) return;
        share.stop();
        share = null;
        setProjecting(false);
    }

    /** Add or drop the service's mediaProjection type, if there is a call to keep. */
    private void setProjecting(boolean on) {
        if (!VoiceService.running) {
            VoiceService.onForeground = null;
            return;
        }
        Intent intent = new Intent(getContext(), VoiceService.class)
            .putExtra(VoiceService.EXTRA_PROJECTION, on);
        ContextCompat.startForegroundService(getContext(), intent);
    }

    /** The page's iceServers ({ urls, username, credential }) as org.webrtc's. */
    private static List<PeerConnection.IceServer> iceServers(JSArray list) {
        List<PeerConnection.IceServer> out = new ArrayList<>();
        if (list == null) return out;
        for (int i = 0; i < list.length(); i++) {
            JSONObject entry = list.optJSONObject(i);
            if (entry == null) continue;
            List<String> urls = new ArrayList<>();
            JSONArray many = entry.optJSONArray("urls");
            if (many != null) {
                for (int j = 0; j < many.length(); j++) urls.add(many.optString(j));
            } else if (entry.has("urls")) {
                urls.add(entry.optString("urls"));
            }
            if (urls.isEmpty()) continue;
            PeerConnection.IceServer.Builder builder = PeerConnection.IceServer.builder(urls);
            if (entry.has("username")) builder.setUsername(entry.optString("username"));
            if (entry.has("credential")) builder.setPassword(entry.optString("credential"));
            out.add(builder.createIceServer());
        }
        return out;
    }

    /** Keep a voice call alive: see VoiceService. */
    @PluginMethod
    public void startVoice(PluginCall call) {
        Context context = getContext();
        Intent intent = new Intent(context, VoiceService.class)
            .putExtra(VoiceService.EXTRA_TITLE, call.getString("title", "In a voice channel"))
            .putExtra(VoiceService.EXTRA_TEXT, call.getString("text", "Harmony"));
        try {
            ContextCompat.startForegroundService(context, intent);
            call.resolve();
        } catch (Exception e) {
            // Android refuses a microphone service to an app it considers in
            // the background. The call still works while the app is open.
            call.reject("Could not keep the call running in the background: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopVoice(PluginCall call) {
        Context context = getContext();
        context.stopService(new Intent(context, VoiceService.class));
        call.resolve();
    }

    /** A link in the system browser -- an update's APK, mostly. */
    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("Not a web link.");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /**
     * Save an attachment to Downloads.
     *
     * Through MediaStore on Android 10+, which needs no permission. Older
     * versions get the app's own downloads folder, which needs none either,
     * rather than asking for storage access just for this.
     */
    @PluginMethod
    public void saveFile(PluginCall call) {
        String name = sanitize(call.getString("name", "attachment"));
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String data = call.getString("data", "");
        byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("The file was damaged on the way.");
            return;
        }

        try {
            String where;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContext().getContentResolver()
                    .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new Exception("Downloads is not available.");
                try (OutputStream out = getContext().getContentResolver().openOutputStream(uri)) {
                    if (out == null) throw new Exception("Could not write to Downloads.");
                    out.write(bytes);
                }
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                getContext().getContentResolver().update(uri, values, null, null);
                where = uri.toString();
            } else {
                File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) throw new Exception("Storage is not available.");
                File file = new File(dir, name);
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                }
                where = file.getAbsolutePath();
            }
            JSObject result = new JSObject();
            result.put("name", name);
            result.put("uri", where);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not save the file: " + e.getMessage());
        }
    }

    /**
     * Send the app to the background without closing it: what Back does
     * once there is nothing left on screen to close (see handleBack in
     * app.js). Finishing the activity instead would end a call.
     */
    @PluginMethod
    public void moveToBack(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }

    /** The installed APK's version: what an update is compared against. */
    @PluginMethod
    public void getInfo(PluginCall call) {
        try {
            Context context = getContext();
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            JSObject result = new JSObject();
            result.put("version", info.versionName);
            result.put("build", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode() : info.versionCode);
            call.resolve(result);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    private static String sanitize(String name) {
        String cleaned = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        return cleaned.isEmpty() ? "attachment" : cleaned;
    }
}
