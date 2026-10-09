package com.harmony.client;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

import java.util.List;

/**
 * The "you are in a voice channel" notification, and what it buys.
 *
 * Without it Android treats a backgrounded app as idle: the microphone goes
 * silent (Android 9+ gives background apps no audio input), Wi-Fi drops into
 * power saving, and the process is first in line to be killed. A foreground
 * service of type microphone is the sanctioned way to say "a call is in
 * progress", and is exactly what every VoIP app does.
 *
 * Started by the page when it joins a voice channel and stopped when it
 * leaves (HarmonyNativePlugin.startVoice / stopVoice). It holds nothing of the
 * call itself -- that stays in the WebView -- only the conditions for it.
 */
public class VoiceService extends Service {

    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    /** true while the screen is being shared: see ScreenShare. */
    static final String EXTRA_PROJECTION = "projection";

    /** Whether the service is up -- i.e. whether there is a call at all. */
    static volatile boolean running;
    /**
     * Run once, on the main thread, right after the next startForeground.
     *
     * Screen capture needs it: Android 14 refuses a MediaProjection unless a
     * foreground service of type mediaProjection is ALREADY running, and
     * startForegroundService only queues the start. This is how the plugin
     * knows the type is in place before it starts capturing.
     */
    static volatile Runnable onForeground;

    private static final String CHANNEL_ID = "voice";
    private static final int NOTIFICATION_ID = 1;

    private String title = "In a voice channel";
    private String text = "Harmony";
    private boolean projecting;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private AudioManager audio;
    private AudioDeviceCallback deviceCallback;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Each start may change only some of it: joining another channel
        // changes the title, starting or stopping a screen share changes
        // the type. Whatever is not in this intent stays as it was.
        if (intent != null) {
            if (intent.hasExtra(EXTRA_TITLE)) title = intent.getStringExtra(EXTRA_TITLE);
            if (intent.hasExtra(EXTRA_TEXT)) text = intent.getStringExtra(EXTRA_TEXT);
            if (intent.hasExtra(EXTRA_PROJECTION)) projecting = intent.getBooleanExtra(EXTRA_PROJECTION, false);
        }
        Notification notification = buildNotification(
            projecting ? title + " \u00b7 sharing your screen" : title, text);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
            if (projecting) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
            startForeground(NOTIFICATION_ID, notification, types);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
            if (projecting) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
            startForeground(NOTIFICATION_ID, notification, types);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        running = true;
        Runnable then = onForeground;
        onForeground = null;
        if (then != null) then.run();

        acquireLocks();
        routeAudio();
        // Moving channels starts it again with a new title; nothing else
        // to do. Not sticky: if Android kills the process, the call is gone
        // with it and there is nothing for a restarted service to keep up.
        return START_NOT_STICKY;
    }

    /** Swiping Harmony away ends the call, so it ends this too. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        releaseLocks();
        restoreAudio();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification buildNotification(String title, String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && manager.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Voice calls", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while you are in a voice channel.");
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        Intent open = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_harmony)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(tap)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    /**
     * A partial wake lock keeps the CPU running with the screen off; the
     * Wi-Fi lock keeps the radio out of power save, whose batching of
     * packets is audible as stutter in a call.
     */
    private void acquireLocks() {
        if (wakeLock == null) {
            PowerManager power = getSystemService(PowerManager.class);
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "harmony:voice");
            wakeLock.setReferenceCounted(false);
        }
        // Bounded, as Android asks; a call longer than this keeps going on
        // whatever the system allows.
        wakeLock.acquire(12 * 60 * 60 * 1000L);

        if (wifiLock == null) {
            WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wifi.createWifiLock(mode, "harmony:voice");
            wifiLock.setReferenceCounted(false);
        }
        wifiLock.acquire();
    }

    private void releaseLocks() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
    }

    /*
     * Where the call is heard.
     *
     * Once a page captures the microphone, Chromium puts Android's audio into
     * call mode, whose default output is the EARPIECE -- the phone has to be
     * held to the ear like a phone call. A voice channel is used like a
     * speakerphone, so: a headset if one is connected, otherwise the
     * loudspeaker, re-decided whenever a headset comes or goes.
     */
    private void routeAudio() {
        audio = getSystemService(AudioManager.class);
        if (audio == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (deviceCallback == null) {
                deviceCallback = new AudioDeviceCallback() {
                    @Override
                    public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
                        pickCommunicationDevice();
                    }

                    @Override
                    public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
                        pickCommunicationDevice();
                    }
                };
                audio.registerAudioDeviceCallback(deviceCallback, null);
            }
            pickCommunicationDevice();
        } else {
            audio.setSpeakerphoneOn(!headsetConnected());
        }
    }

    private void pickCommunicationDevice() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || audio == null) return;
        List<AudioDeviceInfo> devices = audio.getAvailableCommunicationDevices();
        AudioDeviceInfo headset = null;
        AudioDeviceInfo speaker = null;
        for (AudioDeviceInfo device : devices) {
            if (isHeadset(device.getType())) headset = device;
            else if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) speaker = device;
        }
        AudioDeviceInfo target = headset != null ? headset : speaker;
        if (target != null) audio.setCommunicationDevice(target);
    }

    private boolean headsetConnected() {
        for (AudioDeviceInfo device : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            if (isHeadset(device.getType())) return true;
        }
        return false;
    }

    private static boolean isHeadset(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
                return true;
            default:
                return false;
        }
    }

    private void restoreAudio() {
        if (audio == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (deviceCallback != null) audio.unregisterAudioDeviceCallback(deviceCallback);
            deviceCallback = null;
            audio.clearCommunicationDevice();
        } else {
            audio.setSpeakerphoneOn(false);
        }
    }
}
