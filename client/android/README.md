# Harmony for Android

The web client in `client/src/renderer`, wrapped by [Capacitor](https://capacitorjs.com).
Nothing in this folder is the app's UI. It holds the shell around it:

- `HarmonyNativePlugin.java` covers what a page can't do. It keeps a call
  running in the background, opens links in the system browser, saves files
  to Downloads and sends the app to the background on Back.
- `VoiceService.java` is the foreground service behind the "in a voice
  channel" notification. It keeps the microphone, Wi-Fi and CPU awake with
  the screen off, and sends call audio to the loudspeaker or a headset.
- `MainActivity.java` registers the plugin, keeps the WebView's renderer at
  high priority, and hands Back to the page.

## What it can do

It handles voice, watching streams, camera, chat, reactions, emoji and the
soundpad. It can't share the phone's screen, use per-app audio, set global
hotkeys or save clips; those controls are hidden. See `capabilities` in
`src/renderer/web/bridge.js`.

## Building

On a machine with Android Studio, JDK 21 and the Android SDK:

```bash
cd client
npm install
npm run android:sync                         # web client -> android/app/src/main/assets
cd android && ./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

You don't have to build it yourself. Every push to `main` builds a debug APK
in CI: open the run in Actions and download `harmony-android-debug`.

To debug the running app, open `chrome://inspect` in desktop Chrome with the
phone connected over adb. The WebView shows up there with a full DevTools
console.

## Releases and the signing key

The `v*` tag that builds the desktop release also builds a signed APK
(`.github/workflows/release.yml`) and attaches it to the GitHub Release.

Android only installs an update over an existing app if both are signed with
the same key, so every release must use the same keystore. Make it once:

```bash
keytool -genkeypair -v -keystore harmony.jks -alias harmony \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 harmony.jks > harmony.jks.b64     # macOS: base64 -i harmony.jks
```

Add these repository secrets (Settings → Secrets and variables → Actions):

| secret | value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the contents of `harmony.jks.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `harmony` (the `-alias` above) |
| `ANDROID_KEY_PASSWORD` | the key password, if different from the keystore's |

Keep `harmony.jks` and its passwords somewhere safe, outside the repository.
If the key is lost, nobody can update the installed app: everyone would have
to uninstall and reinstall.

If the secrets aren't set, the release still goes out, without an APK and
with a warning on the run.

## Updates

The app checks GitHub Releases (`checkUpdates` in `web/bridge.js`). When
there's a newer version, it offers the APK, and Android's installer takes it
from there. [Obtainium](https://github.com/ImranR98/Obtainium) can also track
the repository and install updates on its own.

## Plain-HTTP servers

A LAN server is often `http://192.168.x.x`. The app allows that
(`usesCleartextTraffic`, and `allowMixedContent` in `capacitor.config.json`)
because the page itself is served from `https://localhost`. That keeps it a
secure context, which the microphone requires.
