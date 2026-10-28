// `harmony` for the builds that have no main process: the browser and Android.
//
// The desktop app's renderer talks to Electron's main process through the
// object src/renderer/bridge.js builds from the preload. This builds the same
// object -- same names, same arguments, same answers -- out of what a page
// can do on its own, so app.js runs unchanged on top of either. Where the
// desktop has something a page cannot (picking a window to share, global
// hotkeys, the GPU), `capabilities` says so and the UI hides it; the methods
// still exist, and answer "not here", so nothing calls an undefined.
//
// DEFAULTS and VERSION come from build-info.js, which scripts/build-web.js
// generates from src/main/settings.js and package.json -- one source for the
// default settings, not two.

import { DEFAULTS, VERSION } from './build-info.js';
import { api, fetchBytes, normalizeBase } from './api.js';
import { RealtimeClient } from './realtime.js';
import { isNative, native } from './native.js';

const NATIVE = isNative();
const SETTINGS_KEY = 'harmony.settings';
const RELEASES = 'https://api.github.com/repos/PedroLucasMiguel/harmony/releases/latest';
const RELEASES_PAGE = 'https://github.com/PedroLucasMiguel/harmony/releases/latest';

const unsupported = (what) => {
  const error = new Error(`${what} is not available in this version of Harmony.`);
  error.code = 'unsupported';
  return error;
};

// --- settings ----------------------------------------------------------------

// Defaults that differ on a phone: the desktop's 115% is for reading a laptop
// from across a desk, and a phone has its own text-size setting.
const PLATFORM_DEFAULTS = { uiScale: 100 };

let settingsCache = null;

function readSettings() {
  if (settingsCache) return settingsCache;
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') ?? {};
  } catch {
    stored = {};
  }
  settingsCache = { ...DEFAULTS, ...PLATFORM_DEFAULTS, ...stored };
  return settingsCache;
}

function writeSettings(patch) {
  settingsCache = { ...readSettings(), ...(patch ?? {}) };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsCache));
  } catch (err) {
    console.warn('[settings] could not persist:', err.message);
  }
  return settingsCache;
}

// --- size ----------------------------------------------------------------------

/*
 * The Size setting, without Electron's window zoom.
 *
 * The viewport tag's scale does the same job: at 120% the page is laid out
 * 1/1.2 as wide in CSS pixels and drawn 1.2 times bigger, so everything --
 * type, icons, spacing -- grows together, and every measurement the page
 * takes (getBoundingClientRect, style.left on a popover) stays in one unit.
 * CSS `zoom` on the root would scale the drawing but not the measurements,
 * and every popover positioned by script would land in the wrong place.
 *
 * Capped lower than the desktop's 180: a phone is already narrow, and at
 * 180% there is about 200 px of page left to lay out in.
 */
const SCALE_MIN = 70;
const SCALE_MAX = 150;

let scaleInUse = 100;

function applyViewportScale(percent) {
  const wanted = Number(percent);
  const used = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number.isFinite(wanted) ? wanted : 100));
  scaleInUse = used;
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta) {
    const s = used / 100;
    // The width has to be given, as the screen's divided by the scale.
    // Measured on a phone: with a scale and no width, Android lays the page
    // out 980 px wide (its desktop default) and shows a corner of it.
    const width = Math.round(screen.width / s);
    meta.setAttribute('content',
      `width=${width}, initial-scale=${s}, minimum-scale=${s}, maximum-scale=${s}, `
      + 'user-scalable=no, viewport-fit=cover');
  }
  return used;
}

// Turning the phone swaps the screen's width for its height, and the width
// above was worked out from the old one.
screen.orientation?.addEventListener?.('change', () => applyViewportScale(scaleInUse));

// --- media -------------------------------------------------------------------

/*
 * Uploads load straight from the server by media key: GET /api/media/<hash>?k=
 * -- see server/src/media-keys.js. An <img> sends no headers, so the key is
 * what stands in for the door password and the session token. The browser's
 * own HTTP cache does what the desktop's media cache does; the server marks
 * every upload immutable.
 */
let mediaBase = '';
let mediaKey = '';

const mediaUrl = (hash) => {
  if (!mediaBase) return '';
  return mediaKey
    ? `${mediaBase}/api/media/${hash}?k=${encodeURIComponent(mediaKey)}`
    : `${mediaBase}/api/uploads/${hash}`;
};

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/*
 * Above this, Android hands a file to the system's downloader rather than
 * reading it into the page: the page would hold all of it, then base64 it
 * across to Java -- a few times the file's size in memory.
 */
const NATIVE_SAVE_LIMIT = 32 * 1024 * 1024;

async function saveMedia(hash, suggestedName, size = 0) {
  if (!mediaBase) throw new Error('not connected to a server');
  const name = String(suggestedName ?? '').trim().replace(/[\\/]/g, '_')
    || `${hash.slice(0, 12)}`;
  const download = `${mediaUrl(hash)}${mediaKey ? '&' : '?'}download=${encodeURIComponent(name)}`;

  if (!NATIVE) {
    // A browser downloads it itself, straight from the server -- the server
    // marks it as an attachment -- with its own progress and no copy of it
    // in this page at all.
    const a = document.createElement('a');
    a.href = download;
    a.download = name;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    return { saved: true, name };
  }
  if (size > NATIVE_SAVE_LIMIT) {
    await openExternal(download);
    return { saved: true, name, handedOff: true };
  }

  const res = await fetch(mediaUrl(hash));
  if (!res.ok) throw new Error(`The server returned ${res.status} for that file.`);
  const blob = await res.blob();
  const saved = await native.saveFile(name, blob.type || 'application/octet-stream', await blobToBase64(blob));
  return saved ? { saved: true, name: saved.name } : { saved: false };
}

// --- server logos ------------------------------------------------------------

/*
 * Kept in the Cache API by hash, so the server list can show a logo at start
 * up before any server has been asked -- what the desktop's logo cache does.
 * The Cache API only exists in a secure context; without it logos are kept
 * for the session only.
 */
const LOGO_CACHE = 'harmony-logos';
const logoUrls = new Map();

const logoKey = (hash) => `https://harmony.invalid/logo/${hash}`;

async function warmLogos() {
  if (!globalThis.caches) return;
  try {
    const cache = await caches.open(LOGO_CACHE);
    for (const request of await cache.keys()) {
      const hash = request.url.split('/').pop();
      const res = await cache.match(request);
      if (res) logoUrls.set(hash, URL.createObjectURL(await res.blob()));
    }
  } catch {
    /* an empty list is fine */
  }
}

async function ensureLogo(server, serverPassword, hash) {
  if (!/^[0-9a-f]{64}$/.test(String(hash))) return null;
  if (logoUrls.has(hash)) return logoUrls.get(hash);
  const blob = await fetchBytes(server, '/api/server/logo', { serverPassword: serverPassword ?? '' });
  try {
    const cache = globalThis.caches ? await caches.open(LOGO_CACHE) : null;
    await cache?.put(logoKey(hash), new Response(blob, { headers: { 'Content-Type': blob.type } }));
  } catch {
    /* kept for this session only */
  }
  const url = URL.createObjectURL(blob);
  logoUrls.set(hash, url);
  return url;
}

// --- realtime ----------------------------------------------------------------

const realtime = new RealtimeClient();

// A phone loses its socket to the screen turning off and to changing
// networks; coming back from either is when to reconnect, not 15 s later.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) realtime.nudge();
});
window.addEventListener('online', () => realtime.nudge());

// --- updates (Android only) ---------------------------------------------------

/*
 * The same status the desktop updater reports (src/main/updater.js), so the
 * same UI draws it. An APK cannot replace itself, so this is the macOS shape:
 * "manual", and the action opens the download in the system browser, where
 * Android's own installer takes it from there.
 */
const updateListeners = new Set();
let lastUpdateCheck = 0;
let updateStatus = { state: NATIVE ? 'idle' : 'unsupported', current: VERSION };

function setUpdate(patch) {
  updateStatus = { current: currentVersion, ...patch };
  for (const fn of updateListeners) fn(updateStatus);
}

function newer(candidate, current) {
  const parts = (v) => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

async function checkUpdates() {
  if (!NATIVE) {
    setUpdate({ state: 'unsupported', error: 'This version of Harmony is updated by reloading the page.' });
    return updateStatus;
  }
  // A check that hung is not a reason to stop checking: see the desktop's
  // CHECK_STALE_MS in src/main/updater.js.
  if (updateStatus.state === 'checking' && Date.now() - lastUpdateCheck < 60_000) return updateStatus;
  lastUpdateCheck = Date.now();
  if (updateStatus.state !== 'available') setUpdate({ state: 'checking' });
  try {
    const res = await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    const release = await res.json();
    const version = String(release.tag_name ?? '').replace(/^v/, '');
    const apk = (release.assets ?? []).find((a) => /\.apk$/i.test(a.name));
    if (version && apk && newer(version, currentVersion)) {
      setUpdate({ state: 'available', version, manual: true, url: apk.browser_download_url });
    } else {
      setUpdate({ state: 'latest' });
    }
  } catch (err) {
    setUpdate({ state: 'error', error: err.message });
  }
  return updateStatus;
}

async function openUpdate() {
  await openExternal(updateStatus.url || RELEASES_PAGE);
  return updateStatus;
}

async function openExternal(url) {
  if (NATIVE) await native.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

// --- start-up ----------------------------------------------------------------

let currentVersion = VERSION;
if (NATIVE) {
  // The APK's own version is the one that matters for updates: it is what
  // Android installed, whatever this copy of the page was built as.
  currentVersion = (await native.info().catch(() => null))?.version ?? VERSION;
  updateStatus = { ...updateStatus, current: currentVersion };
  // The same cadence as the desktop (src/main/updater.js): half-hourly,
  // and on coming back to the app if the last check is ten minutes old.
  setTimeout(() => checkUpdates(), 15_000);
  setInterval(() => checkUpdates(), 30 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastUpdateCheck > 10 * 60 * 1000) checkUpdates();
  });
}
await warmLogos();

// --- the object ----------------------------------------------------------------

export const harmony = {
  platform: NATIVE ? 'android' : 'web',

  /*
   * What this build can do. The desktop answers true to all of it; here the
   * UI hides whatever is false (see applyCapabilities in app.js).
   */
  capabilities: {
    // Android shares through its own capture (ScreenShare.java); a browser
    // tab here could use getDisplayMedia, but not through the desktop's
    // picker, which is what the share button opens.
    screenShare: NATIVE,
    nativeScreenShare: NATIVE,
    appAudio: false,
    hotkeys: false,
    // A window of its own for the picture in picture is the desktop's.
    popout: false,
    clips: false,
    gpu: false,
    // A viewport scale only means something where the page IS the window:
    // the Android app. A desktop browser ignores the viewport tag.
    scale: NATIVE,
    updates: NATIVE,
    reveal: false,
    // Android has its notification for the call instead; a page has neither.
    tray: false,
  },

  settings: {
    get: async () => readSettings(),
    set: async (patch) => writeSettings(patch),
  },

  gpu: {
    status: async () => { throw unsupported('GPU settings'); },
  },

  relaunch: async () => {
    window.location.reload();
    return true;
  },
  setScale: async (percent) => applyViewportScale(percent),
  scaleDefault: PLATFORM_DEFAULTS.uiScale,

  logos: {
    ensure: (server, serverPassword, hash) => ensureLogo(server, serverPassword, hash),
  },
  logoUrl: (hash) => logoUrls.get(hash) ?? '',
  version: async () => currentVersion,

  /*
   * A remembered account password. A page has no keychain to seal it with;
   * it lives in this app's own storage, which on Android no other app can
   * read. Marked plain, the same as the desktop's no-keyring fallback.
   */
  secrets: {
    protect: async (text) => (text ? `plain:${text}` : ''),
    reveal: async (sealed) => (String(sealed ?? '').startsWith('plain:') ? String(sealed).slice(6) : ''),
  },

  updates: {
    get: async () => updateStatus,
    check: () => checkUpdates(),
    download: () => openUpdate(),
    install: async () => false,
    open: () => openUpdate(),
    onStatus(handler) {
      updateListeners.add(handler);
      return () => updateListeners.delete(handler);
    },
  },

  hotkeys: {
    set: async (bindings) =>
      (bindings ?? []).map((b) => ({ id: b.id, ok: false, error: 'unsupported' })),
    onFired: () => () => {},
  },

  strings: {
    set: async () => true,
  },

  voiceTray: {
    setPictures: async () => false,
    setState: async () => false,
    onCommand: () => () => {},
  },

  onWindowVisibility(handler) {
    const listener = () => handler(!document.hidden);
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },

  // No global key hook in a browser or on a phone: push to talk there is the
  // key while the page has focus, which the page handles itself.
  ptt: {
    set: async () => ({ ok: false, error: 'unavailable' }),
    openSettings: async () => false,
    resetAccess: async () => false,
    onState: () => () => {},
  },

  permissions: {
    screen: async () => 'granted',
    openScreenSettings: async () => false,
    resetScreen: async () => false,
  },

  sources: {
    list: async () => [],
    processes: async () => [],
    select: async () => false,
    clear: async () => true,
  },

  audio: {
    availability: async () => ({
      available: false,
      exclusion: false,
      reason: 'Sharing an application\'s sound needs the desktop app.',
    }),
    start: async () => { throw unsupported('Application audio'); },
    stop: async () => true,
    onPcm: () => () => {},
  },

  clips: {
    save: async () => { throw unsupported('Saving clips'); },
    reveal: async () => true,
  },

  api,

  media: {
    async setServer(server) {
      mediaBase = server ? normalizeBase(server) : '';
      mediaKey = '';
      if (!mediaBase) return true;
      try {
        mediaKey = (await api.mediaKey(server))?.key ?? '';
      } catch {
        // An older server has no media keys: pictures will not load, but
        // nothing else depends on them.
        mediaKey = '';
      }
      return true;
    },
    keep: async () => true,
    stats: async () => null,
    upload: (server, bytes, contentType) => api.uploadFile(server, bytes, contentType),
    uploadOpen: (server, size, contentType) => api.uploadOpen(server, size, contentType),
    uploadChunk: (server, id, offset, blob) => api.uploadChunk(server, id, offset, blob),
    uploadFinish: (server, id) => api.uploadFinish(server, id),
    uploadCancel: (server, id) => api.uploadCancel(server, id),
    save: (hash, suggestedName, size) => saveMedia(hash, suggestedName, size),
    // The browser and Android show their own download progress.
    onProgress: () => () => {},
    reveal: async () => true,
  },

  mediaUrl,

  realtime: {
    connect: (server, token) => realtime.connect(server, token),
    request: (type, payload) => realtime.request(type, payload),
    disconnect: async () => {
      realtime.disconnect();
      return true;
    },
    onEvent: (handler) => realtime.on('event', handler),
  },

  /**
   * Android only: publishing the screen natively. `onEnded` fires when it
   * stops without being asked -- the system's own "stop", or a failure.
   */
  screenShare: {
    start: (options) => native.startScreenShare(options),
    stop: () => native.stopScreenShare().catch(() => null),
    onEnded(handler) {
      const listener = (event) => handler(event.reason ?? 'stopped');
      window.addEventListener('harmonyscreenshare', listener);
      return () => window.removeEventListener('harmonyscreenshare', listener);
    },
  },

  /** Android only: the voice call's foreground service. No-ops elsewhere. */
  voiceService: {
    start: (title, text) => native.startVoice(title, text).catch(() => null),
    stop: () => native.stopVoice().catch(() => null),
  },

  openExternal,

  /** Android's back button with nothing left to close. Absent elsewhere. */
  ...(NATIVE ? { moveToBack: () => native.moveToBack().catch(() => null) } : {}),
};
