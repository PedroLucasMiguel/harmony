package com.harmony.client;

import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjection;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStreamTrack;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpCapabilities;
import org.webrtc.RtpParameters;
import org.webrtc.RtpSender;
import org.webrtc.RtpTransceiver;
import org.webrtc.ScreenCapturerAndroid;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Sharing the phone's screen into a voice channel.
 *
 * Android's WebView cannot capture the screen -- getDisplayMedia does not
 * exist there -- so this is the one part of the call that is not the page's
 * WebRTC. It is a second, native WebRTC stack (org.webrtc, from
 * stream-webrtc-android) that does exactly what the desktop's picker does:
 * capture, encode, and publish to the channel's screen path over WHIP. The
 * page hands it the WHIP URL it would have used itself and then tells the
 * channel, as it always does (voice:publishing, kind 's'); nobody watching
 * can tell which client the picture came from.
 *
 * Video only. Capturing other apps' sound is possible from Android 10 but
 * needs its own audio pipeline into this stack, and is left for later.
 */
final class ScreenShare {

    interface Listener {
        /** The share ended without being asked to: the system's "stop", a failure. */
        void onEnded(String reason);
    }

    private static final String TAG = "HarmonyScreenShare";
    /** The longer side, at most. A phone screen is tall; 1920 keeps it at "1080p". */
    private static final int MAX_LONG_SIDE = 1920;

    private final Context context;
    private final Listener listener;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private EglBase egl;
    private PeerConnectionFactory factory;
    private ScreenCapturerAndroid capturer;
    private SurfaceTextureHelper textures;
    private VideoSource source;
    private VideoTrack track;
    private PeerConnection pc;
    private String resourceUrl;
    private volatile boolean stopping;

    ScreenShare(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    interface Result {
        void ok();
        void fail(String message);
    }

    /**
     * Capture and publish. `permission` is the result of the system's
     * "start recording or casting?" prompt, already accepted.
     */
    void start(Intent permission, String whipUrl, List<PeerConnection.IceServer> iceServers,
               int fps, int maxBitrateKbps, Result result) {
        worker.execute(() -> {
            try {
                startOnWorker(permission, whipUrl, iceServers, fps, maxBitrateKbps);
                result.ok();
            } catch (Exception e) {
                Log.w(TAG, "could not start", e);
                stopOnWorker(false);
                result.fail(e.getMessage() != null ? e.getMessage() : e.toString());
            }
        });
    }

    /** Stop, hang up, release everything. Safe to call twice. */
    void stop() {
        worker.execute(() -> stopOnWorker(true));
    }

    private void startOnWorker(Intent permission, String whipUrl, List<PeerConnection.IceServer> iceServers,
                               int fps, int maxBitrateKbps) throws Exception {
        stopping = false;
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions());
        egl = EglBase.create();
        factory = PeerConnectionFactory.builder()
            // No microphone here: the page's own stack is publishing that. An
            // audio device module that never records keeps this one from
            // touching the mic at all.
            .setAudioDeviceModule(JavaAudioDeviceModule.builder(context)
                .setUseHardwareAcousticEchoCanceler(false)
                .setUseHardwareNoiseSuppressor(false)
                .createAudioDeviceModule())
            .setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(), true, true))
            .setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext()))
            .createPeerConnectionFactory();

        // --- capture -----------------------------------------------------
        int[] size = captureSize();
        capturer = new ScreenCapturerAndroid(permission, new MediaProjection.Callback() {
            @Override
            public void onStop() {
                // The system's own "stop sharing" (the status-bar chip, the
                // notification) -- or another app taking the projection.
                if (!stopping) main.post(() -> listener.onEnded("stopped"));
            }
        });
        textures = SurfaceTextureHelper.create("HarmonyCapture", egl.getEglBaseContext());
        source = factory.createVideoSource(true);
        capturer.initialize(textures, context, source.getCapturerObserver());
        capturer.startCapture(size[0], size[1], fps);
        track = factory.createVideoTrack("screen", source);

        // --- the connection ----------------------------------------------
        PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(iceServers);
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        config.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE;
        final Object gathered = new Object();
        final boolean[] done = { false };
        pc = factory.createPeerConnection(config, new PeerObserver() {
            @Override
            public void onIceGatheringChange(PeerConnection.IceGatheringState state) {
                if (state == PeerConnection.IceGatheringState.COMPLETE) {
                    synchronized (gathered) {
                        done[0] = true;
                        gathered.notifyAll();
                    }
                }
            }

            @Override
            public void onConnectionChange(PeerConnection.PeerConnectionState state) {
                if (state == PeerConnection.PeerConnectionState.FAILED && !stopping) {
                    main.post(() -> listener.onEnded("failed"));
                }
            }
        });
        if (pc == null) throw new Exception("Could not create the connection.");

        RtpTransceiver transceiver = pc.addTransceiver(track,
            new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY,
                Collections.singletonList("screen")));
        preferH264(transceiver);
        limitBitrate(transceiver.getSender(), fps, maxBitrateKbps);

        // --- WHIP ----------------------------------------------------------
        SessionDescription offer = await(cb -> pc.createOffer(cb, new MediaConstraints()));
        awaitSet(cb -> pc.setLocalDescription(cb, offer));
        // Every candidate in the offer, rather than trickling: MediaMTX's WHIP
        // PATCH is the only trickle path and there is no need for it. With no
        // STUN configured this is host candidates only, and quick.
        synchronized (gathered) {
            long deadline = System.currentTimeMillis() + 3000;
            while (!done[0] && System.currentTimeMillis() < deadline) {
                gathered.wait(Math.max(1, deadline - System.currentTimeMillis()));
            }
        }
        String answer = post(whipUrl, pc.getLocalDescription().description);
        awaitSet(cb -> pc.setRemoteDescription(cb,
            new SessionDescription(SessionDescription.Type.ANSWER, answer)));
    }

    private void stopOnWorker(boolean announce) {
        stopping = true;
        if (resourceUrl != null) {
            String url = resourceUrl;
            resourceUrl = null;
            try {
                HttpURLConnection http = (HttpURLConnection) new URL(url).openConnection();
                http.setRequestMethod("DELETE");
                http.setConnectTimeout(3000);
                http.setReadTimeout(3000);
                http.getResponseCode();
                http.disconnect();
            } catch (Exception ignored) {
                // MediaMTX drops the session on its own once ICE times out.
            }
        }
        if (capturer != null) {
            try {
                capturer.stopCapture();
            } catch (Exception ignored) {
                // Never started, or already stopped by the system.
            }
            capturer.dispose();
            capturer = null;
        }
        if (pc != null) {
            pc.dispose();
            pc = null;
        }
        if (track != null) {
            track.dispose();
            track = null;
        }
        if (source != null) {
            source.dispose();
            source = null;
        }
        if (textures != null) {
            textures.dispose();
            textures = null;
        }
        if (factory != null) {
            factory.dispose();
            factory = null;
        }
        if (egl != null) {
            egl.release();
            egl = null;
        }
    }

    /** The screen's own shape, scaled so its longer side is at most 1920, even-sized. */
    private int[] captureSize() {
        DisplayMetrics metrics = new DisplayMetrics();
        WindowManager windows = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        windows.getDefaultDisplay().getRealMetrics(metrics);
        int w = metrics.widthPixels;
        int h = metrics.heightPixels;
        double scale = Math.min(1.0, (double) MAX_LONG_SIDE / Math.max(w, h));
        return new int[] { even(w * scale), even(h * scale) };
    }

    private static int even(double v) {
        int n = (int) Math.round(v);
        return n - (n % 2);
    }

    /**
     * H.264 first: the phone encodes it in hardware, and it is what every
     * Harmony viewer decodes best. VP8 stays in the list as the fallback for
     * a device whose hardware encoder is missing or refuses.
     */
    private void preferH264(RtpTransceiver transceiver) {
        RtpCapabilities caps = factory.getRtpSenderCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO);
        List<RtpCapabilities.CodecCapability> h264 = new ArrayList<>();
        List<RtpCapabilities.CodecCapability> rest = new ArrayList<>();
        for (RtpCapabilities.CodecCapability codec : caps.codecs) {
            if ("H264".equalsIgnoreCase(codec.name)) h264.add(codec);
            else rest.add(codec);
        }
        h264.addAll(rest);
        try {
            transceiver.setCodecPreferences(h264);
        } catch (Exception e) {
            Log.w(TAG, "codec preferences refused; using the default order", e);
        }
    }

    /**
     * A cap and a frame rate, and keep the resolution when bandwidth runs
     * short: text on a shared screen has to stay readable, and a lower frame
     * rate is the cheaper thing to give up.
     */
    private void limitBitrate(RtpSender sender, int fps, int maxBitrateKbps) {
        RtpParameters params = sender.getParameters();
        params.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION;
        for (RtpParameters.Encoding encoding : params.encodings) {
            encoding.maxBitrateBps = maxBitrateKbps * 1000;
            encoding.maxFramerate = fps;
        }
        sender.setParameters(params);
    }

    /** POST the offer; keep the Location for hanging up; return the answer. */
    private String post(String url, String sdp) throws Exception {
        HttpURLConnection http = (HttpURLConnection) new URL(url).openConnection();
        http.setRequestMethod("POST");
        http.setConnectTimeout(10000);
        http.setReadTimeout(20000);
        http.setDoOutput(true);
        http.setRequestProperty("Content-Type", "application/sdp");
        try (OutputStream out = http.getOutputStream()) {
            out.write(sdp.getBytes(StandardCharsets.UTF_8));
        }
        int status = http.getResponseCode();
        if (status == 401 || status == 403) {
            throw new Exception("The media server refused this share. Rejoin the channel and try again.");
        }
        if (status < 200 || status >= 300) {
            throw new Exception("The media server answered " + status + ".");
        }
        String location = http.getHeaderField("Location");
        if (location != null) resourceUrl = new URL(new URL(url), location).toString();
        try (InputStream in = http.getInputStream()) {
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int n;
            while ((n = in.read(chunk)) > 0) body.write(chunk, 0, n);
            return body.toString("UTF-8");
        } finally {
            http.disconnect();
        }
    }

    // --- making the callback API sequential ------------------------------

    private interface CreateCall {
        void run(SdpObserver observer);
    }

    private SessionDescription await(CreateCall call) throws Exception {
        final Object lock = new Object();
        final SessionDescription[] out = { null };
        final String[] error = { null };
        call.run(new SdpObserver() {
            @Override
            public void onCreateSuccess(SessionDescription sdp) {
                synchronized (lock) {
                    out[0] = sdp;
                    lock.notifyAll();
                }
            }

            @Override
            public void onCreateFailure(String message) {
                synchronized (lock) {
                    error[0] = message;
                    lock.notifyAll();
                }
            }

            @Override
            public void onSetSuccess() { }

            @Override
            public void onSetFailure(String message) { }
        });
        synchronized (lock) {
            long deadline = System.currentTimeMillis() + 10000;
            while (out[0] == null && error[0] == null && System.currentTimeMillis() < deadline) {
                lock.wait(Math.max(1, deadline - System.currentTimeMillis()));
            }
        }
        if (error[0] != null) throw new Exception(error[0]);
        if (out[0] == null) throw new Exception("Timed out preparing the connection.");
        return out[0];
    }

    private void awaitSet(CreateCall call) throws Exception {
        final Object lock = new Object();
        final boolean[] ok = { false };
        final String[] error = { null };
        call.run(new SdpObserver() {
            @Override
            public void onCreateSuccess(SessionDescription sdp) { }

            @Override
            public void onCreateFailure(String message) { }

            @Override
            public void onSetSuccess() {
                synchronized (lock) {
                    ok[0] = true;
                    lock.notifyAll();
                }
            }

            @Override
            public void onSetFailure(String message) {
                synchronized (lock) {
                    error[0] = message;
                    lock.notifyAll();
                }
            }
        });
        synchronized (lock) {
            long deadline = System.currentTimeMillis() + 10000;
            while (!ok[0] && error[0] == null && System.currentTimeMillis() < deadline) {
                lock.wait(Math.max(1, deadline - System.currentTimeMillis()));
            }
        }
        if (error[0] != null) throw new Exception(error[0]);
        if (!ok[0]) throw new Exception("Timed out setting up the connection.");
    }

    /** PeerConnection.Observer with every method a no-op, to override the two that matter. */
    private abstract static class PeerObserver implements PeerConnection.Observer {
        @Override public void onSignalingChange(PeerConnection.SignalingState state) { }
        @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) { }
        @Override public void onIceConnectionReceivingChange(boolean receiving) { }
        @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) { }
        @Override public void onIceCandidate(IceCandidate candidate) { }
        @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) { }
        @Override public void onAddStream(org.webrtc.MediaStream stream) { }
        @Override public void onRemoveStream(org.webrtc.MediaStream stream) { }
        @Override public void onDataChannel(org.webrtc.DataChannel channel) { }
        @Override public void onRenegotiationNeeded() { }
    }
}
