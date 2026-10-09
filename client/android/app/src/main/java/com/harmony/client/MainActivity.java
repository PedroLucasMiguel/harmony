package com.harmony.client;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

/**
 * The whole app is the web client (client/www, copied in by `cap sync`) in
 * Capacitor's WebView. This adds the one plugin Harmony needs and keeps the
 * page's renderer from being treated as disposable when it is not on screen.
 */
public class MainActivity extends BridgeActivity {

    private static final int NOTIFICATION_REQUEST = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Before super.onCreate: that is where Capacitor reads the list.
        registerPlugin(HarmonyNativePlugin.class);
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // A voice call runs in this renderer. By default Android lowers a
            // WebView renderer's priority once the app is not visible, which
            // is the first thing it kills under memory pressure -- the call
            // would drop the moment somebody opened their camera.
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }

        // Back goes to the page, which decides: close a dialog, a drawer,
        // return to the channel list -- and only then move to the background
        // (HarmonyNativePlugin.moveToBack). Capacitor's default would
        // navigate the WebView's history or close the app, ending a call.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                getBridge().triggerWindowJSEvent("harmonyback");
            }
        });

        // The call notification (VoiceService) is invisible without this on
        // Android 13+. Asked once, up front; refusing it only hides the
        // notification, the call still stays up.
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATION_REQUEST);
        }
    }
}
