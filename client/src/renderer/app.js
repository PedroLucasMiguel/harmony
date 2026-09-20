import { harmony } from './bridge.js';
import { publish, watch, hangup, createStatsReader, applySenderSettings } from './webrtc.js';
import { AudioBridge } from './audio-bridge.js';
import { runConnectionTest } from './connection-test.js';
import { ClipBuffer, CLIP_SECONDS } from './clip-buffer.js';

// ---------------------------------------------------------------------------
// Quality presets
//
// Bitrate ceilings, not targets -- the encoder spends less on a static desktop.
// `width: null` means "whatever the source is", which is what you want when
// sharing a single window.
// ---------------------------------------------------------------------------

const QUALITY = {
  low: { label: 'Low — 720p, 30 fps', width: 1280, height: 720, fps: 30, bitrate: 3_000_000 },
  balanced: { label: 'Balanced — 1080p, 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 },
  // Doubling the frame rate does not double the bits needed -- consecutive
  // frames are more alike at 60 fps than at 30 -- so 12 rather than 16, which
  // also leaves room below the native-resolution presets above.
  full60: { label: 'Full HD — 1080p, 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 12_000_000 },
  high: { label: 'High — native, 60 fps', width: null, height: null, fps: 60, bitrate: 15_000_000 },
  ultra: { label: 'Ultra — native, 60 fps', width: null, height: null, fps: 60, bitrate: 25_000_000 },
};

/**
 * What the encoder should give up when it runs short of bandwidth.
 *
 * Measured on a 1080p screen full of motion: at a 4 Mbit ceiling "sharp" gives
 * about 31 fps at full resolution, and raising the ceiling to 10 Mbit takes it
 * to ~58 fps still at 1080p. "smooth" holds ~57 fps on a squeezed link but
 * settles at 720p to do it. Bitrate is a ceiling, not a target -- WebRTC's
 * congestion control still backs off to whatever the connection really has.
 */
const PRIORITY = {
  sharp: {
    label: 'Sharp — keep resolution',
    contentHint: 'detail',
    degradationPreference: 'maintain-resolution',
  },
  smooth: {
    label: 'Smooth — keep framerate',
    contentHint: 'motion',
    degradationPreference: 'balanced',
  },
};

const WATCH_RETRY_MS = 2500;

// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const el = {
  views: document.querySelectorAll('.view'),
  serverUrl: $('server-url'),
  passwordField: $('password-field'),
  password: $('server-password'),
  username: $('username'),
  continue: $('continue'),
  connectError: $('connect-error'),
  liveList: $('live-list'),
  liveItems: $('live-items'),

  pickerUsername: $('picker-username'),
  pickerBack: $('picker-back'),
  pickerRefresh: $('picker-refresh'),
  tabs: document.querySelectorAll('.tab'),
  sourceGrid: $('source-grid'),
  quality: $('quality'),
  priority: $('priority'),
  fallbackField: $('fallback-field'),
  fallback: $('window-audio-fallback'),
  excludeField: $('exclude-field'),
  excludeApp: $('exclude-app'),
  audioInputField: $('audio-input-field'),
  audioInput: $('audio-input'),
  liveQuality: $('live-quality'),
  livePriority: $('live-priority'),
  changeSource: $('change-source'),
  monitorToggle: $('monitor-toggle'),
  audioNote: $('audio-note'),
  startStream: $('start-stream'),

  broadcastTitle: $('broadcast-title'),
  viewerCount: $('viewer-count'),
  stopStream: $('stop-stream'),
  preview: $('preview'),
  broadcastStats: $('broadcast-stats'),
  broadcastLimit: $('broadcast-limit'),
  broadcastAudioNote: $('broadcast-audio-note'),
  broadcastWatch: $('broadcast-watch'),
  togglePreview: $('toggle-preview'),
  previewOff: $('preview-off'),
  previewOffTitle: $('preview-off-title'),
  previewOffText: $('preview-off-text'),

  watchAll: $('watch-all'),
  mosaicGrid: $('mosaic-grid'),
  mosaicCount: $('mosaic-count'),
  mosaicLeave: $('mosaic-leave'),
  mosaicMute: $('mosaic-mute'),
  mosaicVolume: $('mosaic-volume'),
  mosaicVolumeLabel: $('mosaic-volume-label'),
  mosaicAdd: $('mosaic-add'),

  addStream: $('add-stream'),
  addStreamItems: $('add-stream-items'),
  addStreamEmpty: $('add-stream-empty'),
  addStreamClose: $('add-stream-close'),

  clipsEnabled: $('clips-enabled'),
  hwEncoding: $('hw-encoding'),
  hwEncodingNote: $('hw-encoding-note'),
  gpuPreferenceField: $('gpu-preference-field'),
  gpuPreference: $('gpu-preference'),
  gpuHint: $('gpu-hint'),
  gpuHintText: $('gpu-hint-text'),
  broadcastClip: $('broadcast-clip'),
  watchClip: $('watch-clip'),

  testConnection: $('test-connection'),
  diag: $('diag'),
  diagSteps: $('diag-steps'),
  diagVerdict: $('diag-verdict'),
  diagClose: $('diag-close'),

  watchAdd: $('watch-add'),
  watchFullscreen: $('watch-fullscreen'),
  stage: document.querySelector('#view-watch .stage'),

  watchTitle: $('watch-title'),
  watchDot: $('watch-dot'),
  leaveStream: $('leave-stream'),
  remote: $('remote'),
  watchWaiting: $('watch-waiting'),
  watchWaitingText: $('watch-waiting-text'),
  togglePlay: $('toggle-play'),
  toggleMute: $('toggle-mute'),
  volume: $('volume'),
  volumeLabel: $('volume-label'),
  watchStats: $('watch-stats'),
};

/**
 * A blank mosaic.
 *
 * `selection` null means "show whatever is live"; a Set means the user picked
 * specific streams and new ones should not barge in. `closed` holds names the
 * user dismissed by hand, which is what stops the next sync from cheerfully
 * reopening them three seconds later. `maximized` is one tile filling the grid
 * -- still inside the window, unlike fullscreen.
 */
function freshMosaic() {
  return {
    tiles: new Map(),
    selection: null,
    closed: new Set(),
    maximized: null,
    master: { volume: 1, muted: false },
    iceServers: null,
  };
}

/** Everything mutable about the current session. */
const state = {
  settings: null,
  audioAvailable: false,
  audioUnavailableReason: null,

  sources: [],
  cameras: [],
  audioInputs: [],
  processes: [],
  activeKind: 'screen',
  selectedSource: null,
  /** True while the picker is being used to swap the source of a live stream. */
  changingSource: false,

  /** Live broadcast: what we are sending and the senders to swap it on. */
  live: { videoSender: null, videoTrack: null, rawStream: null, source: null, audioMode: null },

  /**
   * Whether the preview is being painted, and what to paint.
   *
   * `hiddenByUser` is a deliberate choice and survives minimise/restore;
   * `windowVisible` is the automatic half. `stream` holds the downscaled copy
   * from previewCopy() -- never the published stream, which is far too
   * expensive to paint.
   */
  preview: { hiddenByUser: false, windowVisible: true, stream: null },

  server: '', // control server base URL, valid outside a session too
  session: null, // server response for the current username

  /** Set once the server says it wants a password. */
  passwordRequired: false,

  /** GPU encode/decode capability, from the main process. */
  gpu: null,

  /** Mosaic mode: one WHEP connection per tile. See freshMosaic(). */
  mosaic: freshMosaic(),

  // Last publish token this client was issued, so a retry on the same name
  // reclaims it instead of being told the name is taken by itself.
  lastClaim: null,
  pc: null,
  resourceUrl: null,
  localStream: null,
  bridge: new AudioBridge(),
  statsReader: null,

  /**
   * Rolling clip buffers, off unless the user opts in.
   * `own` follows the outgoing broadcast; `watch` the single-stream viewer;
   * mosaic tiles keep their own on each entry.
   */
  clips: { enabled: false, own: null, watch: null },

  /** @type {Record<string, number[]>} keyed by activity: session, watch, mosaic */
  timers: {},
};

function showView(id) {
  el.views.forEach((v) => {
    if (v.id === id) v.setAttribute('data-active', '');
    else v.removeAttribute('data-active');
  });
}

/**
 * Timers are grouped so one activity can be stopped without touching another.
 *
 * This matters once a broadcaster can open the mosaic while still live: closing
 * the mosaic must not cancel the heartbeat holding their username, or the stats
 * poller behind their own broadcast.
 */
function addTimer(handle, group = 'session') {
  (state.timers[group] ??= []).push(handle);
  return handle;
}

function clearTimers(group) {
  const groups = group ? [group] : Object.keys(state.timers);
  for (const name of groups) {
    for (const handle of state.timers[name] ?? []) {
      clearInterval(handle);
      clearTimeout(handle);
    }
    state.timers[name] = [];
  }
}

function showError(message) {
  el.connectError.textContent = message;
  el.connectError.hidden = !message;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  state.settings = await harmony.settings.get();
  el.serverUrl.value = state.settings.serverUrl;
  el.username.value = state.settings.username;
  el.password.value = state.settings.password ?? '';
  // Main holds the password for every request it makes; hand back what was
  // saved before anything asks the server for anything.
  await harmony.api.setPassword(el.password.value);
  el.fallback.value = state.settings.windowAudioFallback;
  state.clips.enabled = Boolean(state.settings.clipsEnabled);
  el.clipsEnabled.checked = state.clips.enabled;

  for (const [key, preset] of Object.entries(QUALITY)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = preset.label;
    el.quality.append(option);
  }
  el.quality.value = state.settings.quality in QUALITY ? state.settings.quality : 'balanced';
  el.liveQuality.replaceChildren(...[...el.quality.options].map((o) => o.cloneNode(true)));
  el.liveQuality.value = el.quality.value;

  for (const [key, mode] of Object.entries(PRIORITY)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = mode.label;
    el.priority.append(option);
  }
  el.priority.value = state.settings.priority in PRIORITY ? state.settings.priority : 'sharp';
  el.livePriority.replaceChildren(...[...el.priority.options].map((o) => o.cloneNode(true)));
  el.livePriority.value = el.priority.value;

  const availability = await harmony.audio.availability();
  state.audioAvailable = availability.available;
  state.audioUnavailableReason = availability.reason;

  await refreshGpuStatus();

  if (state.settings.serverUrl) {
    await probeServer();
    refreshLiveList();
  }
}

/**
 * What the GPU is doing, and what the user has asked for.
 *
 * Chromium will not tell us which encoder a given stream ended up on -- the
 * `encoderImplementation` stat is in the spec but absent from this Electron
 * build. So report the capability, which is the honest thing we can know, and
 * say plainly when the user has turned it off themselves.
 */
async function refreshGpuStatus() {
  try {
    state.gpu = await harmony.gpu.status();
  } catch {
    state.gpu = null;
    return;
  }
  const { encodeAccelerated, decodeAccelerated, preference, videoEncode, adapters } = state.gpu;
  el.hwEncoding.checked = preference !== 'off';

  // Only worth offering where there is a second GPU to move to.
  const multiGpu = (adapters?.length ?? 0) > 1;
  const active = adapters?.find((a) => a.active)?.vendor ?? null;
  el.gpuPreferenceField.hidden = !multiGpu;
  if (multiGpu) {
    el.gpuPreference.value = state.gpu.adapterPreference ?? 'auto';
    el.gpuPreferenceField.querySelector('small').textContent =
      `Currently on ${active ?? 'an unknown GPU'}, of ${adapters.map((a) => a.vendor).join(' + ')}. ` +
      'Leave this alone unless you are troubleshooting: the discrete GPU is normally the right ' +
      'choice, because it is where the game being captured already lives.';
  }

  /*
   * Say so unprompted, because nobody would think to look for this, and the
   * fix is outside Harmony entirely.
   *
   * Chromium cannot composite across GPUs on Windows. On a hybrid laptop the
   * display is usually wired to the integrated GPU while Harmony renders on the
   * discrete one, so every frame of Harmony's window is copied between
   * adapters before the desktop compositor can draw it. Measured on a hybrid
   * laptop: the compositor alone cost 25% of a GPU, and dropped to 1.5% once
   * the panel was wired straight to the discrete GPU. See DUAL_GPU_WEIRDNESS.md.
   *
   * There is no switch Harmony can flip for this -- it is a firmware or driver
   * setting (MUX switch, NVIDIA Advanced Optimus, "Display mode" in Armoury
   * Crate / Lenovo Vantage). So this is a warning, not an offer.
   */
  const showHint = multiGpu;
  el.gpuHint.hidden = !showHint;
  if (showHint) {
    el.gpuHintText.textContent =
      `This machine has two GPUs (${adapters.map((a) => a.vendor).join(' + ')}). If your screen is ` +
      'wired to the integrated one, every frame Harmony draws is copied between GPUs before it ' +
      'reaches the display, which costs roughly 10% of the machine while you stream. Look for a ' +
      'MUX switch, NVIDIA Advanced Optimus, or a "display mode" setting in your laptop vendor\'s ' +
      'utility, and point the panel at the discrete GPU. Worth doing once — it is the single ' +
      'largest thing you can change.';
  }

  if (preference === 'off') {
    el.hwEncodingNote.textContent =
      'Off — encoding on the CPU. Turn this back on unless viewers saw a corrupt picture.';
  } else if (encodeAccelerated) {
    el.hwEncodingNote.textContent = `On — your GPU is encoding${
      decodeAccelerated ? ' and decoding' : ''
    }. NVENC, AMF or Quick Sync, whichever your driver provides.`;
  } else {
    el.hwEncodingNote.textContent = `No GPU encoder available (${videoEncode}) — falling back to software H.264, which is slower but works everywhere.`;
  }
}

/**
 * A short label for the stats line, saying what is really encoding.
 *
 * Prefers what the connection reports over what the GPU process advertises.
 * `getGPUFeatureStatus()` describes ordinary media playback and is no guide at
 * all to WebRTC: it said `video_encode: enabled` for months while every call
 * ran on the CPU because of the negotiated H.264 profile. `encoderImplementation`
 * is only populated when a real hardware encoder is running, so it cannot lie
 * in the same direction.
 */
function encoderLabel(stats) {
  if (stats?.implementation) {
    const vendor = /NVIDIA/i.test(stats.implementation)
      ? 'NVENC'
      : /AMD|AMF/i.test(stats.implementation)
        ? 'AMF'
        : /Intel|Quick/i.test(stats.implementation)
          ? 'Quick Sync'
          : 'GPU';
    return `${vendor} encode`;
  }
  if (!state.gpu) return null;
  if (state.gpu.preference === 'off') return 'CPU encode';
  // No implementation named while a stream is running means software, whatever
  // the GPU process claims it is capable of.
  return stats ? 'CPU encode' : null;
}

/**
 * Ask the server whether it wants a password, and show the field if it does.
 *
 * /api/health is the one endpoint outside the password gate, precisely so this
 * question can be asked before the user is prompted. A server that is simply
 * unreachable leaves the field as it is rather than hiding a password the user
 * already typed.
 */
async function probeServer() {
  const server = el.serverUrl.value.trim();
  if (!server) return;
  try {
    const health = await harmony.api.health(server);
    el.passwordField.hidden = !health.passwordRequired;
    state.passwordRequired = Boolean(health.passwordRequired);
  } catch {
    // Unreachable, or an older server with no passwordRequired field. Either
    // way, do not change what the user can see.
  }
}

// ---------------------------------------------------------------------------
// Connect view
// ---------------------------------------------------------------------------

async function refreshLiveList() {
  const server = el.serverUrl.value.trim();
  if (!server) return;
  // Nothing to show until there is a password to show it with, and asking
  // anyway would only produce a 401 on every poll.
  if (state.passwordRequired && !el.password.value) {
    el.liveList.hidden = true;
    return;
  }

  try {
    const { streams } = await harmony.api.streams(server);
    el.liveItems.replaceChildren();

    if (!streams.length) {
      el.liveList.hidden = true;
      return;
    }
    el.passwordField.classList.remove('bad');

    for (const stream of streams) {
      const li = document.createElement('li');

      const dot = document.createElement('span');
      dot.className = 'dot live';

      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = stream.username;

      const count = document.createElement('span');
      count.className = 'pill';
      count.textContent = `${stream.viewers} watching`;

      li.append(dot, who, count);
      li.addEventListener('click', () => {
        el.username.value = stream.username;
        startSession();
      });
      el.liveItems.append(li);
    }
    el.liveList.hidden = false;
  } catch (err) {
    el.liveList.hidden = true;
    // A password problem is the one failure here worth surfacing: without it
    // the list just silently stays empty and looks like "nobody is streaming".
    if (err.code === 'bad_password' || err.code === 'locked_out') {
      el.passwordField.hidden = false;
      el.passwordField.classList.add('bad');
      showError(err.message);
    }
  }
}

async function startSession() {
  const server = el.serverUrl.value.trim();
  const username = el.username.value.trim().toLowerCase();

  if (!server) return showError('Enter the address of your Harmony server.');
  if (!username) return showError('Pick a username.');

  showError('');
  el.continue.disabled = true;
  el.continue.textContent = 'Connecting…';

  try {
    // Before anything else reaches the server, so the very first request of the
    // session already carries it.
    await harmony.api.setPassword(el.password.value);

    const held = state.lastClaim?.username === username ? state.lastClaim.token : undefined;
    const session = await harmony.api.session(server, username, held);
    state.session = { ...session, server };
    if (session.token) state.lastClaim = { username, token: session.token };
    el.passwordField.classList.remove('bad');

    await harmony.settings.set({ serverUrl: server, username, password: el.password.value });
    state.settings = await harmony.settings.get();

    if (session.role === 'broadcaster') {
      await enterPicker();
    } else {
      await enterWatch();
    }
  } catch (err) {
    showError(err.message);
    if (err.code === 'bad_password' || err.code === 'locked_out') {
      el.passwordField.hidden = false;
      el.passwordField.classList.add('bad');
      el.password.focus();
      el.password.select();
    }
  } finally {
    el.continue.disabled = false;
    el.continue.textContent = 'Continue';
  }
}

// ---------------------------------------------------------------------------
// Source picker
// ---------------------------------------------------------------------------

async function enterPicker() {
  el.pickerUsername.textContent = state.session.username;
  state.selectedSource = null;
  state.changingSource = false;
  el.startStream.disabled = true;
  el.startStream.textContent = 'Start streaming';
  el.pickerBack.textContent = 'Cancel';
  showView('view-picker');
  await loadSources();
  updateAudioNote();

  // Hold the username while the user browses windows and picks a quality.
  addTimer(
    setInterval(() => {
      harmony.api
        .heartbeat(state.session.server, state.session.username, state.session.token)
        .catch(() => {});
    }, state.session.heartbeatMs ?? 10_000),
  );
}

async function loadSources() {
  el.sourceGrid.replaceChildren(message('Loading…'));
  try {
    state.sources = await harmony.sources.list();
  } catch (err) {
    el.sourceGrid.replaceChildren(message(err.message));
    return;
  }
  await loadDevices();
  loadProcesses();
  renderSources();
}

/**
 * Cameras, capture cards and audio inputs.
 *
 * Device labels are blank until the user has granted access once, so ask for a
 * throwaway stream first -- otherwise the picker is a list of "Camera 1",
 * "Camera 2" with no way to tell a webcam from a capture card.
 */
async function loadDevices() {
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.some((d) => d.kind === 'videoinput' && !d.label)) {
      const probe = await navigator.mediaDevices
        .getUserMedia({ video: true, audio: true })
        .catch(() => null);
      probe?.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    }

    state.cameras = devices
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({
        id: d.deviceId,
        name: d.label || `Camera ${i + 1}`,
        kind: 'camera',
        thumbnail: null,
        icon: null,
        resolution: null,
      }));

    state.audioInputs = devices
      .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, name: d.label || `Audio input ${i + 1}` }));

    el.audioInput.replaceChildren();
    for (const input of state.audioInputs) {
      const option = document.createElement('option');
      option.value = input.id;
      option.textContent = input.name;
      el.audioInput.append(option);
    }
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'No audio';
    el.audioInput.append(none);
    if (state.settings.audioInputId) el.audioInput.value = state.settings.audioInputId;
  } catch (err) {
    console.warn('[devices]', err.message);
    state.cameras = [];
  }
}

/** Processes whose audio could be kept out of a screen share. */
async function loadProcesses() {
  try {
    state.processes = await harmony.sources.processes();
  } catch {
    state.processes = [];
  }

  el.excludeApp.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'Nothing — share all system audio';
  el.excludeApp.append(none);

  for (const proc of state.processes) {
    const option = document.createElement('option');
    option.value = String(proc.pid);
    option.textContent = `${proc.name} — ${proc.title.slice(0, 40)}`;
    el.excludeApp.append(option);
  }
}

function message(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

function renderSources() {
  const items =
    state.activeKind === 'camera'
      ? state.cameras
      : state.sources.filter((s) => s.kind === state.activeKind);
  el.sourceGrid.replaceChildren();

  if (!items.length) {
    el.sourceGrid.append(
      message(
        state.activeKind === 'camera'
          ? 'No cameras or capture cards found.'
          : `No ${state.activeKind}s found.`,
      ),
    );
    return;
  }

  for (const source of items) {
    const button = document.createElement('button');
    button.className = 'source';
    button.type = 'button';

    if (source.thumbnail) {
      const img = document.createElement('img');
      img.className = 'thumb';
      img.src = source.thumbnail;
      img.alt = '';
      button.append(img);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    if (source.icon) {
      const icon = document.createElement('img');
      icon.src = source.icon;
      icon.alt = '';
      meta.append(icon);
    }
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = source.resolution ? `${source.name} · ${source.resolution}` : source.name;
    label.title = source.name;
    meta.append(label);
    button.append(meta);

    if (state.selectedSource?.id === source.id) button.setAttribute('data-selected', '');

    button.addEventListener('click', () => {
      state.selectedSource = source;
      el.startStream.disabled = false;
      renderSources();
      updateAudioNote();
    });

    el.sourceGrid.append(button);
  }
}

/**
 * Decide where the audio for this share comes from, and say so in the UI.
 *
 * The rule: whole screen -> all system audio; single window -> only that
 * application's audio. The second half needs the native Windows capture; when
 * that is missing the user chooses between silence and system audio rather than
 * having other apps leak into the stream without being told.
 */
function audioPlan(forSource) {
  const source = forSource ?? state.selectedSource;
  const kind = source?.kind ?? state.activeKind;

  // A camera or capture card has no loopback audio of its own; its sound comes
  // from whichever input the user picked.
  if (kind === 'camera') {
    if (!el.audioInput.value) {
      return { via: 'none', note: 'Sharing without audio.', warn: false };
    }
    const label = state.audioInputs.find((d) => d.id === el.audioInput.value)?.name ?? 'the selected input';
    return { via: 'device', note: `Viewers will hear ${label}.`, warn: false };
  }

  if (state.audioAvailable) {
    if (kind === 'window') {
      return { via: 'native', note: 'Viewers will hear only this application.', warn: false };
    }
    const excluded = state.processes.find((p) => String(p.pid) === el.excludeApp.value);
    return {
      via: 'native',
      note: excluded
        ? `Viewers will hear system audio, except ${excluded.name}.`
        : 'Viewers will hear all system audio.',
      warn: false,
    };
  }

  if (kind === 'screen') {
    return { via: 'chromium', note: 'Viewers will hear all system audio.', warn: false };
  }

  if (el.fallback.value === 'system') {
    return {
      via: 'chromium',
      note: `Per-app audio unavailable — ALL system audio will be shared. ${state.audioUnavailableReason ?? ''}`,
      warn: true,
    };
  }

  return {
    via: 'none',
    note: `Per-app audio unavailable — sharing without sound. ${state.audioUnavailableReason ?? ''}`,
    warn: true,
  };
}

function updateAudioNote() {
  const kind = state.selectedSource?.kind ?? state.activeKind;

  el.fallbackField.hidden = state.audioAvailable || kind !== 'window';
  // Excluding an app needs the native per-process capture.
  el.excludeField.hidden = kind !== 'screen' || !state.audioAvailable;
  el.audioInputField.hidden = kind !== 'camera';

  const plan = audioPlan();
  el.audioNote.textContent = plan.note;
  el.audioNote.toggleAttribute('data-warn', plan.warn);
}

// ---------------------------------------------------------------------------
// Broadcasting
// ---------------------------------------------------------------------------

/**
 * Wait until the control server reports our username as live.
 *
 * Doubles as a catch-all: if ICE came up but no media is flowing, MediaMTX
 * never marks the path ready and the user is told, instead of staring at a
 * "Live" badge nobody can see.
 */
async function confirmLive({ timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { streams } = await harmony.api.streams(state.session.server);
      if (streams.some((s) => s.username === state.session.username)) return;
    } catch {
      // Transient -- keep trying until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  throw new Error(
    'The server never saw this stream go live. Someone else may already be publishing under this name.',
  );
}

/**
 * Open a capture source and return its video track.
 *
 * Screens and windows come from getDisplayMedia; cameras and capture cards are
 * ordinary getUserMedia devices. Any audio that arrives attached to the capture
 * is routed into the mixer rather than published directly, so the track being
 * sent never changes.
 */
async function acquireVideo(source, preset, plan) {
  const { track, rawStream } = await openCapture(source, preset, plan);
  return { track, rawStream, previewTrack: await previewCopy(track) };
}

/** What the preview is downscaled to. See previewCopy(). */
const PREVIEW = { width: 960, height: 540, fps: 10 };

/**
 * A deliberately cheap copy of the capture, for the preview element only.
 *
 * Chromium gives every track taken off a source its own downscale and
 * frame-rate decimation, so a clone can run at 960x540x10 while the track
 * being encoded stays at native resolution and full rate. Measured on this
 * build: 4.2 Mpx/s against 221 Mpx/s for a 1440p60 capture -- a fiftieth of
 * the work, for a picture whose whole job is to tell you that you are sharing
 * the right window.
 *
 * Worth the trouble because of where that work lands. Painting the preview is
 * GPU work on the same adapter the game is using, and it scales with the
 * source resolution rather than with the bitrate -- so a native-resolution
 * preview of a native-resolution game asks that GPU to push roughly twice the
 * pixels it was already pushing, which is why the preview costs several times
 * what the encoder does.
 *
 * Falls back to the unconstrained clone if the constraints are refused, which
 * is no worse than not having tried.
 */
async function previewCopy(track) {
  const clone = track.clone();
  try {
    await clone.applyConstraints({
      width: { max: PREVIEW.width },
      height: { max: PREVIEW.height },
      frameRate: { max: PREVIEW.fps },
    });
  } catch {
    /* Source refuses to rescale. The clone is still a working preview. */
  }
  return clone;
}

async function openCapture(source, preset, plan) {
  if (source.kind === 'camera') {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: source.id },
        width: { ideal: preset.width ?? 1920 },
        height: { ideal: preset.height ?? 1080 },
        frameRate: { ideal: preset.fps },
      },
      audio: false,
    });
    return { track: stream.getVideoTracks()[0], rawStream: stream };
  }

  await harmony.sources.select(source.id, { loopbackAudio: plan.via === 'chromium' });

  const video = { frameRate: { ideal: preset.fps, max: preset.fps } };
  if (preset.width) {
    video.width = { max: preset.width };
    video.height = { max: preset.height };
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video,
    audio: plan.via === 'chromium',
  });
  return { track: stream.getVideoTracks()[0], rawStream: stream };
}

/**
 * Point the mixer at whatever this source's audio should be. The published
 * audio track is untouched -- only what feeds it changes.
 */
async function routeAudio(source, plan) {
  state.bridge.detachPcm();
  state.bridge.detachDevice();

  if (plan.via === 'device') {
    try {
      const label = await state.bridge.attachDevice(el.audioInput.value || undefined);
      return { mode: 'device', note: `Viewers will hear ${label}.` };
    } catch (err) {
      return { mode: 'none', note: `Could not open that audio input: ${err.message}` };
    }
  }

  if (plan.via === 'chromium') {
    state.bridge.attachStream(state.live.rawStream);
    return { mode: 'chromium-loopback', note: plan.note };
  }

  if (plan.via === 'native') {
    const result = await harmony.audio.start({
      kind: source.kind,
      sourceId: source.id,
      sourceName: source.name,
      fallback: el.fallback.value,
      excludePid: source.kind === 'screen' ? Number(el.excludeApp.value) || null : null,
    });
    if (result.mode !== 'none' && result.mode !== 'chromium-loopback') state.bridge.attachPcm();
    return { mode: result.mode, note: result.note ?? plan.note };
  }

  await harmony.audio.stop().catch(() => {});
  return { mode: 'none', note: plan.note };
}

async function startBroadcast() {
  const source = state.selectedSource;
  if (!source) return;

  const preset = QUALITY[el.quality.value];
  const priority = PRIORITY[el.priority.value] ?? PRIORITY.sharp;
  const plan = audioPlan();

  el.startStream.disabled = true;
  el.startStream.textContent = 'Going live…';

  await harmony.settings.set({
    quality: el.quality.value,
    priority: el.priority.value,
    windowAudioFallback: el.fallback.value,
  });

  try {
    // Video first: picking a capture source is what grants the user activation
    // an AudioContext needs to leave the suspended state.
    const { track: videoTrack, rawStream, previewTrack } = await acquireVideo(source, preset, plan);
    state.live.rawStream = rawStream;
    state.live.source = source;
    state.preview.stream = new MediaStream([previewTrack]);

    // One audio track for the whole broadcast, created before anything is
    // published so that switching sources later needs no renegotiation.
    const audioTrack = await state.bridge.start();

    const audio = await routeAudio(source, plan);
    state.live.audioMode = audio.mode;
    const audioNote = audio.note;

    const stream = new MediaStream([videoTrack, audioTrack]);
    state.localStream = stream;
    state.live.videoTrack = videoTrack;

    // Stopping the share from the OS overlay ends the track, not the session.
    videoTrack.addEventListener('ended', () => stopBroadcast());

    const { pc, resourceUrl } = await publish({
      url: state.session.whipUrl,
      stream,
      iceServers: state.session.iceServers,
      codec: 'H264',
      maxBitrate: preset.bitrate,
      maxFramerate: preset.fps,
      contentHint: priority.contentHint,
      degradationPreference: priority.degradationPreference,
      insertableStreams: state.clips.enabled,
    });

    state.live.videoSender = pc.getSenders().find((s) => s.track?.kind === 'video') ?? null;

    // Our own frames are already encoded on the way out, so buffering them
    // is pure copying.
    state.clips.own = attachClips(pc, state.session.username, 'sender');
    el.broadcastClip.hidden = !state.clips.own;

    state.pc = pc;
    state.resourceUrl = resourceUrl;
    state.statsReader = createStatsReader(pc, 'outbound');

    // A successful WHIP handshake is not proof of being on air. MediaMTX
    // answers the offer before it decides whether this publisher may have the
    // path, so if the name is already taken at the media-server level the
    // connection comes up and the stream then goes nowhere. Confirm the server
    // actually sees us live rather than trusting the 201.
    await confirmLive();

    // Re-read rather than trusting what boot() saw: the GPU process reports
    // roughly 300ms after the window loads, and boot() runs before that. Main
    // caches the answer, so this is free once it has settled.
    refreshGpuStatus();

    applyPreviewVisibility();
    el.broadcastTitle.textContent = `Live as ${state.session.username}`;
    el.broadcastAudioNote.textContent = audioNote;
    el.broadcastStats.textContent = 'Connecting…';
    el.liveQuality.value = el.quality.value;
    el.livePriority.value = el.priority.value;
    updateMonitorButton();
    showView('view-broadcast');

    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        stopBroadcast(`Connection ${pc.connectionState}.`);
      }
    });

    addTimer(setInterval(updateBroadcastStats, 1000));
  } catch (err) {
    await teardown();
    showError(
      err.name === 'NotAllowedError' ? 'Screen capture was blocked.' : err.message,
    );
    showView('view-connect');
  } finally {
    el.startStream.disabled = false;
    el.startStream.textContent = 'Start streaming';
  }
}

/**
 * Paint the preview, or stop painting it.
 *
 * Detaching `srcObject` is what actually saves the work: the video element
 * stops being composited, while the MediaStreamTrack behind it carries on being
 * captured and encoded, because the RTCRtpSender holds that track independently
 * of any element displaying it. Hiding with CSS would not do this -- the frames
 * would still arrive and still be painted.
 *
 * Why it matters here more than in an ordinary app: Harmony disables Chromium's
 * occlusion and background throttling so the encoder keeps running while the
 * broadcaster looks at what they are sharing. That same setting means a preview
 * sitting on a second monitor, or behind a fullscreen game, is composited
 * forever at full rate -- on the very GPU the game is using.
 *
 * Two things stop it: the user asking, and the window being minimised. Losing
 * focus deliberately does not, even though it is free performance -- a preview
 * that blanks itself every time you click elsewhere reads as a bug, and with
 * the preview downscaled (previewCopy) and the display no longer crossing
 * adapters, what it saves is no longer worth what it costs in confusion.
 */
function applyPreviewVisibility() {
  const reason = previewPauseReason();

  if (!reason) {
    if (state.preview.stream && el.preview.srcObject !== state.preview.stream) {
      el.preview.srcObject = state.preview.stream;
    }
  } else if (el.preview.srcObject) {
    el.preview.srcObject = null;
  }

  el.previewOff.hidden = !reason;
  if (reason === 'minimised') {
    el.previewOffTitle.textContent = 'Preview paused';
    el.previewOffText.textContent =
      'You are still live. Harmony is not drawing the preview while the window is minimised, ' +
      'because nothing would see it — that work would be pure waste.';
  } else {
    el.previewOffTitle.textContent = 'Preview hidden';
    el.previewOffText.textContent =
      'You are still live. Drawing the preview costs GPU work on top of the game you are sharing, ' +
      'so hiding it is free performance.';
  }

  el.togglePreview.textContent = state.preview.hiddenByUser ? 'Show preview' : 'Hide preview';
  el.togglePreview.classList.toggle('active', state.preview.hiddenByUser);
}

/** @returns {'user'|'minimised'|null} null meaning "paint it". */
function previewPauseReason() {
  if (state.preview.hiddenByUser) return 'user';
  if (!state.preview.windowVisible) return 'minimised';
  return null;
}

/** Plain-language version of WebRTC's qualityLimitationReason. */
const LIMIT_TEXT = {
  bandwidth: 'limited by your upload speed',
  cpu: 'limited by this computer',
  other: 'limited',
};

async function updateBroadcastStats() {
  if (!state.statsReader) return;
  const s = await state.statsReader();
  const bits = [
    s.width ? `${s.width}×${s.height}` : null,
    s.fps ? `${s.fps} fps` : null,
    s.kbps ? `${(s.kbps / 1000).toFixed(1)} Mbps` : null,
    s.codec,
    s.rtt != null ? `${s.rtt} ms` : null,
    s.availableKbps ? `link ${(s.availableKbps / 1000).toFixed(1)} Mbps` : null,
    s.encodeMs != null ? `encode ${s.encodeMs.toFixed(1)} ms` : null,
    encoderLabel(s),
  ].filter(Boolean);
  el.broadcastStats.textContent = bits.join('  ·  ') || 'Connecting…';

  // Say why the picture is worse than requested, rather than leaving the
  // broadcaster to guess whether it is them, their connection, or the server.
  const limit = s.limitedBy && s.limitedBy !== 'none' ? LIMIT_TEXT[s.limitedBy] ?? s.limitedBy : null;
  el.broadcastLimit.textContent = limit ? `⚠ ${limit}` : '';
  el.broadcastLimit.hidden = !limit;

  try {
    const { streams } = await harmony.api.streams(state.session.server);
    const mine = streams.find((x) => x.username === state.session.username);
    el.viewerCount.textContent = `${mine?.viewers ?? 0} watching`;
  } catch {
    /* transient */
  }
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

/**
 * Start buffering a connection, if the user has clips switched on.
 *
 * Taps the encoded frames rather than the decoded ones, so nothing is
 * re-encoded; see clip-buffer.js. Returns null when there is nothing to tap,
 * which for a receiver means media has not started flowing yet.
 *
 * @param {'sender'|'receiver'} side
 */
function attachClips(pc, label, side) {
  if (!state.clips.enabled || !pc) return null;

  const buffer = new ClipBuffer(label);
  const parts = side === 'sender' ? pc.getSenders() : pc.getReceivers();
  let hasVideo = false;

  for (const part of parts) {
    if (part.track?.kind === 'video') hasVideo = buffer.attach(part, 'video') || hasVideo;
    else if (part.track?.kind === 'audio') buffer.attach(part, 'audio');
  }
  return hasVideo ? buffer : null;
}

async function saveClip(buffer, label, button) {
  if (!buffer) return;
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Saving…';
  }
  try {
    const { data, seconds } = buffer.build();
    const { path } = await harmony.clips.save(data, label);
    toast(`Clip saved — ${seconds.toFixed(0)}s, ${(data.byteLength / 1e6).toFixed(1)} MB`, path);
  } catch (err) {
    toast(`Could not save the clip: ${err.message}`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

/** Small transient message; clicking it reveals the file. */
function toast(message, filePath) {
  let node = document.getElementById('toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'toast';
    node.className = 'toast';
    document.body.append(node);
  }
  node.textContent = message + (filePath ? '  (click to show)' : '');
  node.onclick = filePath ? () => harmony.clips.reveal(filePath).catch(() => {}) : null;
  node.classList.toggle('clickable', Boolean(filePath));
  node.hidden = false;
  clearTimeout(node.dataset.timer);
  node.dataset.timer = setTimeout(() => {
    node.hidden = true;
  }, 6000);
}

/** Commit a source chosen from the picker while the broadcast is running. */
async function applySourceChange() {
  const source = state.selectedSource;
  if (!source) return;

  el.startStream.disabled = true;
  el.startStream.textContent = 'Switching…';
  try {
    await changeLiveSource(source);
    state.changingSource = false;
    showView('view-broadcast');
  } catch (err) {
    el.audioNote.textContent =
      err.name === 'NotAllowedError' ? 'That source was not allowed.' : err.message;
    el.audioNote.toggleAttribute('data-warn', true);
  } finally {
    el.startStream.disabled = false;
    el.startStream.textContent = state.changingSource ? 'Use this source' : 'Start streaming';
  }
}

/** Apply the quality and priority selectors to a stream that is already live. */
async function applyLiveQuality() {
  const preset = QUALITY[el.liveQuality.value];
  const priority = PRIORITY[el.livePriority.value] ?? PRIORITY.sharp;
  const { videoSender, videoTrack } = state.live;
  if (!videoSender || !videoTrack) return;

  videoTrack.contentHint = priority.contentHint;

  // Resolution and frame rate live on the capture; bitrate and the degradation
  // policy live on the sender. Both have to move together.
  try {
    await videoTrack.applyConstraints({
      frameRate: { ideal: preset.fps, max: preset.fps },
      ...(preset.width ? { width: { max: preset.width }, height: { max: preset.height } } : {}),
    });
  } catch {
    // Some capture sources refuse constraint changes; the sender limits below
    // still apply, so this is not worth failing over.
  }

  await applySenderSettings(videoSender, {
    maxBitrate: preset.bitrate,
    maxFramerate: preset.fps,
    degradationPreference: priority.degradationPreference,
  });

  await harmony.settings.set({ quality: el.liveQuality.value, priority: el.livePriority.value });
}

/**
 * Swap what is being streamed without interrupting the broadcast.
 *
 * replaceTrack() changes the sender's source in place, so there is no
 * renegotiation and viewers keep the same connection -- the picture simply
 * becomes something else.
 */
async function changeLiveSource(source) {
  const preset = QUALITY[el.liveQuality.value];
  const priority = PRIORITY[el.livePriority.value] ?? PRIORITY.sharp;
  const plan = audioPlan(source);

  const previousTrack = state.live.videoTrack;
  const previousStream = state.live.rawStream;
  const previousPreview = state.preview.stream;

  const { track, rawStream, previewTrack } = await acquireVideo(source, preset, plan);
  state.preview.stream = new MediaStream([previewTrack]);
  state.live.rawStream = rawStream;
  state.live.source = source;
  state.selectedSource = source;

  track.contentHint = priority.contentHint;
  await state.live.videoSender.replaceTrack(track);
  state.live.videoTrack = track;
  track.addEventListener('ended', () => stopBroadcast());

  // Only now retire the old capture, so there is no gap in between.
  previousTrack?.stop();
  previousStream?.getTracks().forEach((t) => t.stop());
  previousPreview?.getTracks().forEach((t) => t.stop());

  const audio = await routeAudio(source, plan);
  state.live.audioMode = audio.mode;
  el.broadcastAudioNote.textContent = audio.note ?? '';

  state.localStream = new MediaStream([track, ...state.localStream.getAudioTracks()]);
  // Respects a hidden preview: switching source must not silently turn the
  // painting back on.
  applyPreviewVisibility();

  await applyLiveQuality();
  updateMonitorButton();
}

/**
 * Monitoring is only offered for input devices.
 *
 * With a screen or window share the machine is already playing that sound out
 * loud, and feeding it back into the speakers would land straight back in a
 * system-audio capture. A capture card is the opposite case: nothing plays its
 * audio unless we do.
 */
function canMonitor() {
  return state.live.audioMode === 'device';
}

function updateMonitorButton() {
  const allowed = canMonitor();
  el.monitorToggle.disabled = !allowed;
  if (!allowed) {
    state.bridge.setMonitor(false);
    el.monitorToggle.classList.remove('active');
    el.monitorToggle.title =
      state.live.audioMode === 'none'
        ? 'Nothing to monitor: this source has no audio'
        : 'You already hear this audio through your speakers';
    return;
  }
  const on = state.bridge.monitoring;
  el.monitorToggle.classList.toggle('active', on);
  el.monitorToggle.title = on ? 'Stop hearing my own audio' : 'Hear my own audio';
}

async function stopBroadcast(reason) {
  await teardown();
  if (reason) showError(reason);
  showView('view-connect');
  refreshLiveList();
}

// ---------------------------------------------------------------------------
// Watching
// ---------------------------------------------------------------------------

async function enterWatch() {
  el.watchTitle.textContent = `Watching ${state.session.username}`;
  el.watchWaiting.hidden = false;
  el.watchWaitingText.textContent = state.session.pending
    ? `Waiting for ${state.session.username} to start sharing…`
    : 'Connecting…';
  el.watchDot.classList.remove('live');
  el.watchStats.textContent = '';
  showView('view-watch');

  connectWatch();
}

async function connectWatch() {
  try {
    const { pc, stream, resourceUrl } = await watch({
      url: state.session.whepUrl,
      iceServers: state.session.iceServers,
      insertableStreams: state.clips.enabled,
    });

    // Attach at once rather than waiting for 'connected': with insertable
    // streams on, incoming frames are held until something reads them.
    state.clips.watch = attachClips(pc, state.session.username, 'receiver');
    el.watchClip.hidden = !state.clips.watch;

    state.pc = pc;
    state.resourceUrl = resourceUrl;
    state.statsReader = createStatsReader(pc, 'inbound');

    el.remote.srcObject = stream;
    el.remote.volume = Number(el.volume.value) / 100;

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') {
        el.watchWaiting.hidden = true;
        el.watchDot.classList.add('live');
      } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        // The broadcaster stopped or the network dropped. Go back to polling
        // instead of erroring out -- they may well come straight back.
        el.watchWaiting.hidden = false;
        el.watchWaitingText.textContent = `Stream ended. Waiting for ${state.session.username}…`;
        el.watchDot.classList.remove('live');
        retryWatch();
      }
    });

    addTimer(setInterval(updateWatchStats, 1000), 'watch');
  } catch (err) {
    if (err.code === 'not_live' || err.code === 'media_error') {
      el.watchWaitingText.textContent = `Waiting for ${state.session.username} to start sharing…`;
      retryWatch();
    } else {
      await teardown();
      showError(err.message);
      showView('view-connect');
    }
  }
}

function retryWatch() {
  clearTimers('watch');
  state.pc?.close();
  state.pc = null;
  state.statsReader = null;
  addTimer(setTimeout(connectWatch, WATCH_RETRY_MS), 'watch');
}

async function updateWatchStats() {
  if (!state.statsReader) return;
  const s = await state.statsReader();
  const bits = [
    s.width ? `${s.width}×${s.height}` : null,
    s.fps ? `${s.fps} fps` : null,
    s.kbps ? `${(s.kbps / 1000).toFixed(1)} Mbps` : null,
    s.codec,
    s.rtt != null ? `${s.rtt} ms` : null,
  ].filter(Boolean);
  el.watchStats.textContent = bits.join('  ·  ');
}

// ---------------------------------------------------------------------------
// Mosaic: every live stream at once
// ---------------------------------------------------------------------------

/**
 * Narrower than this and a tile is not worth showing.
 *
 * Generous on purpose: these tiles carry screen shares, and a 1080p desktop
 * squeezed into 260px is unreadable. One column of usable tiles that you scroll
 * beats two columns of thumbnails.
 */
const MIN_TILE_WIDTH = 320;

/** Below this a tile has no room for a volume slider beside its buttons. */
const COMPACT_TILE_WIDTH = 260;

const GRID_GAP = 12;

/**
 * Lay the tiles out to fit the box in both directions.
 *
 * Choosing columns from the width alone is not enough: four tiles in two
 * columns of a wide window produce two rows taller than the window, and the
 * bottom row's controls end up below the fold where nobody can reach them.
 *
 * So try every column count and keep the one that makes each 16:9 tile largest
 * while still fitting the available height. Tiles are then given an explicit
 * width, and the grid is centred, so they stay exactly 16:9 rather than being
 * stretched into letterboxes.
 */
function layoutMosaic() {
  const { maximized, tiles } = state.mosaic;

  // One tile filling the grid is just the one-column case with everything else
  // hidden, so the same fitting code covers it.
  for (const [username, entry] of tiles) {
    entry.el.hidden = Boolean(maximized) && username !== maximized;
  }

  const count = maximized && tiles.has(maximized) ? 1 : tiles.size;
  if (!count) return;

  // clientWidth includes the grid's own padding, but the tiles are laid out in
  // the content box inside it. Measuring the wrong box made every layout up to
  // 2 x 12px too wide, which is exactly enough to raise a horizontal scrollbar
  // on a grid that was otherwise a perfect fit.
  const style = getComputedStyle(el.mosaicGrid);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);

  const width = (el.mosaicGrid.clientWidth || window.innerWidth) - padX;
  const height = (el.mosaicGrid.clientHeight || window.innerHeight) - padY;
  if (width < 2 || height < 2) return; // not laid out yet

  let best = null;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cellW = (width - GRID_GAP * (cols - 1)) / cols;
    const cellH = (height - GRID_GAP * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;

    // Largest 16:9 box that fits the cell.
    const tileW = Math.min(cellW, (cellH * 16) / 9);
    if (tileW < MIN_TILE_WIDTH) continue;
    if (!best || tileW > best.tileW) best = { cols, tileW };
  }

  // Nothing fits the height at a usable size: fall back to filling the width
  // and letting the grid scroll, which is better than unreadable thumbnails.
  if (!best) {
    const cols = Math.max(1, Math.floor((width + GRID_GAP) / (MIN_TILE_WIDTH + GRID_GAP)));
    best = { cols, tileW: (width - GRID_GAP * (cols - 1)) / cols };
  }

  el.mosaicGrid.style.setProperty('--cols', best.cols);
  el.mosaicGrid.style.setProperty('--tile-w', `${Math.floor(best.tileW)}px`);

  for (const entry of state.mosaic.tiles.values()) {
    entry.el.classList.toggle('compact', best.tileW < COMPACT_TILE_WIDTH);
  }
}

/**
 * @param {string[]|null} usernames  specific streams to show, or null for all
 */
/** True when we are publishing right now, so the mosaic must not disturb it. */
const isBroadcasting = () => Boolean(state.live.videoSender && state.pc);

async function enterMosaic(usernames = null) {
  const server = el.serverUrl.value.trim() || state.server;
  if (!server) return showError('Enter the address of your Harmony server.');

  state.server = server;
  state.mosaic = freshMosaic();
  state.mosaic.selection = usernames ? new Set(usernames) : null;
  el.mosaicLeave.textContent = isBroadcasting() ? 'Back to my stream' : 'Leave';
  el.mosaicGrid.replaceChildren();
  el.mosaicVolume.value = '100';
  el.mosaicVolumeLabel.textContent = '100%';
  el.mosaicMute.innerHTML = '&#128266;';
  showView('view-mosaic');

  await syncMosaic();
  // Streams come and go while you watch; the grid follows.
  addTimer(setInterval(syncMosaic, 3000), 'mosaic');
  addTimer(setInterval(updateMosaicMeta, 1000), 'mosaic');
}

async function syncMosaic() {
  let streams;
  let iceServers;
  try {
    ({ streams, iceServers } = await harmony.api.streams(state.server));
  } catch {
    return; // transient; the next tick retries
  }
  if (iceServers) state.mosaic.iceServers = iceServers;

  const { selection, closed } = state.mosaic;
  const wanted = streams.filter((s) => {
    // Closing a tile has to stick. Without this the next sync -- three seconds
    // later -- sees the stream still live and opens it straight back up.
    if (closed.has(s.username)) return false;
    if (selection) return selection.has(s.username);
    // Watching everything while broadcasting should not include a second copy
    // of your own stream -- the preview already shows it, and pulling it back
    // down from the server would just spend bandwidth twice.
    return !(isBroadcasting() && s.username === state.session?.username);
  });
  const wantedNames = new Set(wanted.map((s) => s.username));

  for (const username of [...state.mosaic.tiles.keys()]) {
    if (!wantedNames.has(username)) removeTile(username);
  }
  for (const stream of wanted) {
    if (!state.mosaic.tiles.has(stream.username)) openTile(stream);
  }

  const count = state.mosaic.tiles.size;
  el.mosaicCount.textContent = `${count} ${count === 1 ? 'stream' : 'streams'}`;
  layoutMosaic();

  const empty = el.mosaicGrid.querySelector('.empty');
  if (!count && !empty) {
    el.mosaicGrid.replaceChildren(
      message(
        closed.size
          ? 'No streams open. Use + Add stream to bring one back.'
          : selection
            ? 'None of the chosen streams are live.'
            : 'Nobody is streaming right now.',
      ),
    );
  } else if (count && empty) {
    empty.remove();
  }
}

/** Add a stream to the mosaic, switching into it from wherever we are. */
async function addStreamToMosaic(username) {
  closeAddStream();

  if (state.mosaic.tiles.size || document.getElementById('view-mosaic').hasAttribute('data-active')) {
    // Already in the mosaic: widen the selection and let the next sync open it.
    // Asking for it explicitly also overrides an earlier dismissal.
    state.mosaic.closed.delete(username);
    if (state.mosaic.selection) state.mosaic.selection.add(username);
    await syncMosaic();
    return;
  }

  // Coming from the single-stream view: keep what we were watching and add to it.
  const current = state.session?.username;
  await teardown();
  await enterMosaic(current ? [current, username] : [username]);
}

/**
 * Note this never calls /api/session: watching is public and claiming a name
 * here could steal it from a broadcaster who stopped a moment ago.
 */
function openTile({ username, whepUrl }) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.user = username;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  // Start muted so autoplay is never blocked, then applyTileAudio unmutes once
  // the stream is attached.
  video.muted = true;

  const status = document.createElement('div');
  status.className = 'tile-status';
  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  const statusText = document.createElement('span');
  statusText.textContent = `Connecting to ${username}…`;
  status.append(spinner, statusText);

  const bar = document.createElement('div');
  bar.className = 'tile-bar';
  const dot = document.createElement('span');
  dot.className = 'dot live';
  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = username;
  const meta = document.createElement('span');
  meta.className = 'tile-meta';

  const controls = document.createElement('div');
  controls.className = 'tile-controls';

  const muteBtn = document.createElement('button');
  muteBtn.className = 'tile-btn';
  muteBtn.type = 'button';
  muteBtn.dataset.role = 'mute';
  muteBtn.innerHTML = '&#128266;';
  muteBtn.title = `Mute ${username}`;

  const volume = document.createElement('input');
  volume.type = 'range';
  volume.className = 'tile-volume';
  volume.min = '0';
  volume.max = '100';
  volume.value = '100';
  volume.title = `Volume for ${username}`;

  // Maximize fills the mosaic with this one stream but stays inside the window,
  // so the rest of the app -- and everything else on the desktop -- is still
  // visible. Fullscreen, next to it, covers the screen.
  const maxBtn = document.createElement('button');
  maxBtn.className = 'tile-btn';
  maxBtn.type = 'button';
  maxBtn.dataset.role = 'maximize';
  maxBtn.innerHTML = '&#10530;';
  maxBtn.title = `Maximize ${username}`;

  const fsBtn = document.createElement('button');
  fsBtn.className = 'tile-btn';
  fsBtn.type = 'button';
  fsBtn.dataset.role = 'fullscreen';
  fsBtn.innerHTML = '&#9974;';
  fsBtn.title = 'Fullscreen';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tile-btn';
  closeBtn.type = 'button';
  closeBtn.dataset.role = 'close';
  closeBtn.innerHTML = '&#10005;';
  closeBtn.title = `Close ${username}`;

  const clipBtn = document.createElement('button');
  clipBtn.className = 'tile-btn';
  clipBtn.type = 'button';
  clipBtn.dataset.role = 'clip';
  clipBtn.innerHTML = '&#9986;';
  clipBtn.title = `Save the last ${CLIP_SECONDS} seconds`;
  clipBtn.hidden = true;

  controls.append(muteBtn, volume, clipBtn, maxBtn, fsBtn, closeBtn);
  bar.append(dot, name, meta, controls);

  tile.append(video, status, bar);
  el.mosaicGrid.append(tile);

  const entry = {
    el: tile,
    video,
    status,
    statusText,
    meta,
    muteBtn,
    fsBtn,
    maxBtn,
    closeBtn,
    clipBtn,
    clips: null,
    pc: null,
    resourceUrl: null,
    stats: null,
    // Per-tile audio. Every stream can be heard at once; these are how you
    // balance them rather than being forced to pick just one.
    volume: 1,
    muted: false,
  };
  state.mosaic.tiles.set(username, entry);

  // Controls sit inside the tile, so stop their clicks reaching it.
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    entry.muted = !entry.muted;
    muteBtn.innerHTML = entry.muted ? '&#128263;' : '&#128266;';
    muteBtn.title = `${entry.muted ? 'Unmute' : 'Mute'} ${username}`;
    applyTileAudio();
  });

  volume.addEventListener('click', (e) => e.stopPropagation());
  volume.addEventListener('input', (e) => {
    e.stopPropagation();
    entry.volume = Number(volume.value) / 100;
    if (entry.volume > 0 && entry.muted) {
      entry.muted = false;
      muteBtn.innerHTML = '&#128266;';
    }
    applyTileAudio();
  });

  clipBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    saveClip(entry.clips, username, clipBtn);
  });

  maxBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMaximized(username);
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTile(username);
  });

  fsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFullscreen(tile);
  });
  tile.addEventListener('dblclick', () => toggleFullscreen(tile));

  watch({ url: whepUrl, iceServers: state.mosaic.iceServers, insertableStreams: state.clips.enabled })
    .then(({ pc, stream, resourceUrl }) => {
      // The tile may have been removed while we were connecting.
      if (state.mosaic.tiles.get(username) !== entry) {
        hangup(pc, resourceUrl);
        return;
      }
      entry.pc = pc;
      entry.resourceUrl = resourceUrl;
      entry.stats = createStatsReader(pc, 'inbound');
      entry.clips = attachClips(pc, username, 'receiver');
      if (entry.clipBtn) entry.clipBtn.hidden = !entry.clips;
      video.srcObject = stream;
      status.hidden = true;
      // applyTileAudio owns both muted and volume; setting them here as well
      // once cost every tile its sound, by throwing before it could run.
      applyTileAudio();
    })
    .catch((err) => {
      if (state.mosaic.tiles.get(username) !== entry) return;
      spinner.remove();
      entry.statusText.textContent = err.code === 'not_live' ? 'Stream ended' : err.message;
    });
}

/**
 * Dismiss one stream from the mosaic.
 *
 * The connection is torn down, not just hidden -- a tile you cannot see should
 * not still be costing you a decoder and the bandwidth of a 1080p stream. The
 * name is remembered so the periodic sync does not reopen it; + Add stream is
 * the way back.
 */
function closeTile(username) {
  const { mosaic } = state;
  mosaic.closed.add(username);
  mosaic.selection?.delete(username);
  if (mosaic.maximized === username) mosaic.maximized = null;
  removeTile(username);

  const count = mosaic.tiles.size;
  el.mosaicCount.textContent = `${count} ${count === 1 ? 'stream' : 'streams'}`;
  layoutMosaic();

  if (!count) {
    el.mosaicGrid.replaceChildren(
      message('No streams open. Use + Add stream to bring one back.'),
    );
  }
}

/** Fill the grid with one stream, without leaving the window. */
function toggleMaximized(username) {
  const { mosaic } = state;
  mosaic.maximized = mosaic.maximized === username ? null : username;

  for (const [name, entry] of mosaic.tiles) {
    const on = mosaic.maximized === name;
    entry.maxBtn.innerHTML = on ? '&#10529;' : '&#10530;';
    entry.maxBtn.title = on ? 'Back to the grid' : `Maximize ${name}`;
  }
  layoutMosaic();
}

function removeTile(username) {
  const entry = state.mosaic.tiles.get(username);
  if (!entry) return;
  state.mosaic.tiles.delete(username);
  // A maximized stream that ends must not leave the grid stuck showing nothing.
  if (state.mosaic.maximized === username) state.mosaic.maximized = null;
  entry.clips?.detach();
  // If this tile was filling the screen, do not leave the user stranded there.
  if (document.fullscreenElement === entry.el) document.exitFullscreen().catch(() => {});
  entry.video.srcObject = null;
  if (entry.pc) hangup(entry.pc, entry.resourceUrl);
  entry.el.remove();
}

/**
 * Every tile can be heard at once; the master control scales them all.
 * Effective volume is the tile's own level times the master level.
 */
function applyTileAudio() {
  const { master } = state.mosaic;
  for (const entry of state.mosaic.tiles.values()) {
    entry.video.muted = entry.muted || master.muted;
    entry.video.volume = Math.max(0, Math.min(1, entry.volume * master.volume));
  }
}

async function updateMosaicMeta() {
  for (const entry of state.mosaic.tiles.values()) {
    if (!entry.stats) continue;
    const s = await entry.stats();
    entry.meta.textContent = s.width ? `${s.height}p · ${s.fps} fps` : '';
  }
}

async function leaveMosaic() {
  // Only the mosaic's own timers: a broadcast may still be running behind it.
  clearTimers('mosaic');
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  for (const username of [...state.mosaic.tiles.keys()]) removeTile(username);
  state.mosaic = freshMosaic();

  if (isBroadcasting()) {
    showView('view-broadcast');
    return;
  }
  showView('view-connect');
  refreshLiveList();
}

// ---------------------------------------------------------------------------
// Fullscreen
//
// The real Fullscreen API rather than a CSS overlay, so a stream covers the
// taskbar like any other video. Chromium already exits on Escape; the explicit
// key handler is for the case where focus sits somewhere that swallows it.
// ---------------------------------------------------------------------------

function toggleFullscreen(element) {
  if (document.fullscreenElement === element) {
    document.exitFullscreen().catch(() => {});
  } else {
    element.requestFullscreen().catch((err) => console.warn('[fullscreen]', err.message));
  }
}

// Escape backs out of exactly one thing at a time, outermost first.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (document.fullscreenElement) {
    event.preventDefault();
    document.exitFullscreen().catch(() => {});
  } else if (!el.addStream.hidden) {
    closeAddStream();
  } else if (state.mosaic.maximized) {
    event.preventDefault();
    toggleMaximized(state.mosaic.maximized);
  }
});

document.addEventListener('fullscreenchange', () => {
  const active = document.fullscreenElement;
  for (const entry of state.mosaic.tiles.values()) {
    const on = entry.el === active;
    entry.fsBtn.innerHTML = on ? '&#10005;' : '&#9974;';
    entry.fsBtn.title = on ? 'Exit fullscreen (Esc)' : 'Fullscreen';
  }
  const watching = el.stage === active;
  el.watchFullscreen.innerHTML = watching ? '&#10005;' : '&#9974;';
  el.watchFullscreen.title = watching ? 'Exit fullscreen (Esc)' : 'Fullscreen';
});

// ---------------------------------------------------------------------------
// Add-stream picker
// ---------------------------------------------------------------------------

async function openAddStream() {
  el.addStreamItems.replaceChildren();
  el.addStreamEmpty.hidden = true;
  el.addStream.hidden = false;

  const already = new Set([
    ...state.mosaic.tiles.keys(),
    ...(state.session ? [state.session.username] : []),
  ]);

  let streams = [];
  try {
    ({ streams } = await harmony.api.streams(state.server || el.serverUrl.value.trim()));
  } catch {
    /* fall through to the empty message */
  }

  const options = streams.filter((s) => !already.has(s.username));
  if (!options.length) {
    el.addStreamEmpty.hidden = false;
    return;
  }

  for (const stream of options) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot live';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = stream.username;
    const count = document.createElement('span');
    count.className = 'pill';
    count.textContent = `${stream.viewers} watching`;
    li.append(dot, who, count);
    li.addEventListener('click', () => addStreamToMosaic(stream.username));
    el.addStreamItems.append(li);
  }
}

function closeAddStream() {
  el.addStream.hidden = true;
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

async function teardown() {
  clearTimers();

  if (state.pc) await hangup(state.pc, state.resourceUrl);
  state.pc = null;
  state.resourceUrl = null;
  state.statsReader = null;

  await state.bridge.stop();
  await harmony.audio.stop().catch(() => {});
  await harmony.sources.clear().catch(() => {});

  state.localStream?.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  state.clips.own?.detach();
  state.clips.watch?.detach();
  state.clips.own = null;
  state.clips.watch = null;
  el.broadcastClip.hidden = true;
  el.watchClip.hidden = true;

  state.live.rawStream?.getTracks().forEach((t) => t.stop());
  state.preview.stream?.getTracks().forEach((t) => t.stop());
  state.preview.stream = null;
  state.live = { videoSender: null, videoTrack: null, rawStream: null, source: null, audioMode: null };
  state.changingSource = false;
  el.preview.srcObject = null;
  el.remote.srcObject = null;

  // Give the username back at once rather than waiting for the claim to lapse.
  if (state.session?.token) {
    await harmony.api
      .release(state.session.server, state.session.username, state.session.token)
      .catch(() => {});
    state.lastClaim = null;
  }
  state.session = null;
  state.selectedSource = null;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

el.continue.addEventListener('click', startSession);
el.username.addEventListener('keydown', (e) => e.key === 'Enter' && startSession());
el.serverUrl.addEventListener('keydown', (e) => e.key === 'Enter' && startSession());
el.password.addEventListener('keydown', (e) => e.key === 'Enter' && startSession());
el.serverUrl.addEventListener('change', async () => {
  // A different server may have a different answer about passwords.
  await probeServer();
  refreshLiveList();
});
// Typing a new password is a reason to retry the list that just failed.
el.password.addEventListener('change', async () => {
  await harmony.api.setPassword(el.password.value);
  refreshLiveList();
});

el.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    el.tabs.forEach((t) => t.removeAttribute('data-active'));
    tab.setAttribute('data-active', '');
    state.activeKind = tab.dataset.kind;
    renderSources();
    updateAudioNote();
  });
});

el.pickerRefresh.addEventListener('click', loadSources);
el.fallback.addEventListener('change', updateAudioNote);
el.excludeApp.addEventListener('change', updateAudioNote);
el.audioInput.addEventListener('change', () => {
  harmony.settings.set({ audioInputId: el.audioInput.value }).catch(() => {});
  updateAudioNote();
});

el.startStream.addEventListener('click', () => {
  // The picker doubles as "change source" once a broadcast is running.
  if (state.changingSource) return applySourceChange();
  return startBroadcast();
});

el.liveQuality.addEventListener('change', applyLiveQuality);
el.livePriority.addEventListener('change', applyLiveQuality);

el.changeSource.addEventListener('click', async () => {
  state.changingSource = true;
  state.selectedSource = null;
  el.startStream.disabled = true;
  el.startStream.textContent = 'Use this source';
  el.pickerBack.textContent = 'Back to stream';
  el.pickerUsername.textContent = state.session.username;
  showView('view-picker');
  await loadSources();
  updateAudioNote();
});

/** Chromium reads the adapter switch once, at startup, so this needs a restart. */
async function setGpuPreference(value) {
  await harmony.settings.set({ gpuPreference: value });
  state.settings = await harmony.settings.get();
  el.gpuPreference.value = value;
  // The dual-GPU warning stays up: it is about how the display is wired, which
  // this setting cannot change.
  toast(
    isBroadcasting()
      ? 'Saved. It applies next time Harmony starts — restarting now would end your stream.'
      : 'Saved. Restart Harmony to apply it — click here to restart now.',
  );
  const node = document.getElementById('toast');
  if (node && !isBroadcasting()) {
    node.classList.add('clickable');
    node.onclick = () => harmony.relaunch().catch(() => {});
  }
}

el.gpuPreference.addEventListener('change', () => setGpuPreference(el.gpuPreference.value));

el.togglePreview.addEventListener('click', () => {
  state.preview.hiddenByUser = !state.preview.hiddenByUser;
  applyPreviewVisibility();
  if (state.preview.hiddenByUser) {
    toast('Preview hidden. You are still live — this only stops Harmony drawing it.');
  }
});

// The hidden panel sits over the stage, so it is the obvious thing to click to
// get the picture back.
el.previewOff.addEventListener('click', () => {
  if (state.preview.hiddenByUser) {
    state.preview.hiddenByUser = false;
    applyPreviewVisibility();
  }
});

// Minimising is the automatic half: the window is gone, so painting it is pure
// waste. Automatic, and it does not overwrite a deliberate choice.
harmony.onWindowVisibility((visible) => {
  state.preview.windowVisible = visible;
  applyPreviewVisibility();

  // Mosaic tiles too. Each one is a decoder feeding a composited element, and a
  // minimised window shows none of it. Pausing leaves the connection up, so
  // restoring resumes at live rather than reconnecting. The single-stream view
  // is left alone on purpose -- it has a pause button the user owns.
  for (const entry of state.mosaic.tiles.values()) {
    if (visible) entry.video.play().catch(() => {});
    else entry.video.pause();
  }
});

el.monitorToggle.addEventListener('click', () => {
  if (!canMonitor()) return;
  state.bridge.setMonitor(!state.bridge.monitoring);
  updateMonitorButton();
});

el.pickerBack.addEventListener('click', async () => {
  // While live, the picker is a detour rather than a way out.
  if (state.changingSource) {
    state.changingSource = false;
    showView('view-broadcast');
    return;
  }
  await teardown();
  showView('view-connect');
  refreshLiveList();
});

el.stopStream.addEventListener('click', () => stopBroadcast());

// Wrapped: addEventListener would otherwise pass the click Event as `usernames`.
// Watching others without interrupting your own broadcast.
el.broadcastWatch.addEventListener('click', () => enterMosaic());

el.clipsEnabled.addEventListener('change', () => {
  state.clips.enabled = el.clipsEnabled.checked;
  harmony.settings.set({ clipsEnabled: state.clips.enabled }).catch(() => {});
  if (!state.clips.enabled) {
    // Stop buffering immediately and give the memory back; the taps themselves
    // survive until the connection ends, but they stop retaining anything.
    state.clips.own?.clear();
    state.clips.watch?.clear();
    for (const entry of state.mosaic.tiles.values()) entry.clips?.clear();
  }
  toast(
    state.clips.enabled
      ? `Clips on — the last ${CLIP_SECONDS}s of each stream will be kept in memory.`
      : 'Clips off.',
  );
});

/**
 * The encoder choice is a Chromium command-line switch, and those are read once
 * at startup -- so unlike every other setting here, this one cannot apply to
 * the running process. Say so, and offer the restart rather than leaving the
 * checkbox looking like it did something.
 */
el.hwEncoding.addEventListener('change', async () => {
  const preference = el.hwEncoding.checked ? 'auto' : 'off';
  await harmony.settings.set({ hardwareEncoding: preference });
  state.settings = await harmony.settings.get();

  el.hwEncodingNote.textContent =
    preference === 'off'
      ? 'Will encode on the CPU after a restart.'
      : 'Will use the GPU again after a restart.';

  if (isBroadcasting()) {
    toast('Saved. It applies next time Harmony starts — restarting now would end your stream.');
    return;
  }
  toast('Saved. Restart Harmony to apply it — click here to restart now.');
  const node = document.getElementById('toast');
  if (node) {
    node.classList.add('clickable');
    node.onclick = () => harmony.relaunch().catch(() => {});
  }
});

el.broadcastClip.addEventListener('click', () =>
  saveClip(state.clips.own, state.session?.username ?? 'me', el.broadcastClip),
);
el.watchClip.addEventListener('click', () =>
  saveClip(state.clips.watch, state.session?.username ?? 'stream', el.watchClip),
);

el.testConnection.addEventListener('click', async () => {
  const server = el.serverUrl.value.trim();
  if (!server) return showError('Enter the address of your Harmony server first.');

  el.diagSteps.replaceChildren();
  el.diagVerdict.textContent = 'Testing…';
  el.diag.hidden = false;
  el.testConnection.disabled = true;

  const addStep = ({ name, ok, detail }) => {
    const li = document.createElement('li');
    const mark = document.createElement('span');
    mark.className = `diag-mark ${ok ? 'good' : 'bad'}`;
    mark.textContent = ok ? '✓' : '✕';
    const text = document.createElement('span');
    text.textContent = detail ? `${name} — ${detail}` : name;
    li.append(mark, text);
    el.diagSteps.append(li);
  };

  try {
    const { ok, verdict } = await runConnectionTest(server, addStep);
    el.diagVerdict.textContent = verdict;
    el.diagVerdict.classList.toggle('bad', !ok);
  } catch (err) {
    el.diagVerdict.textContent = err.message;
    el.diagVerdict.classList.add('bad');
  } finally {
    el.testConnection.disabled = false;
  }
});

el.diagClose.addEventListener('click', () => {
  el.diag.hidden = true;
});
el.diag.addEventListener('click', (e) => {
  if (e.target === el.diag) el.diag.hidden = true;
});

el.watchAll.addEventListener('click', () => enterMosaic());
el.mosaicLeave.addEventListener('click', leaveMosaic);

el.mosaicMute.addEventListener('click', () => {
  const { master } = state.mosaic;
  master.muted = !master.muted;
  el.mosaicMute.innerHTML = master.muted ? '&#128263;' : '&#128266;';
  el.mosaicMute.title = master.muted ? 'Unmute everything' : 'Mute everything';
  applyTileAudio();
});

el.mosaicVolume.addEventListener('input', () => {
  const value = Number(el.mosaicVolume.value);
  state.mosaic.master.volume = value / 100;
  el.mosaicVolumeLabel.textContent = `${value}%`;
  if (value > 0 && state.mosaic.master.muted) {
    state.mosaic.master.muted = false;
    el.mosaicMute.innerHTML = '&#128266;';
  }
  applyTileAudio();
});

el.mosaicAdd.addEventListener('click', openAddStream);
el.watchAdd.addEventListener('click', openAddStream);
el.addStreamClose.addEventListener('click', closeAddStream);
el.addStream.addEventListener('click', (e) => {
  if (e.target === el.addStream) closeAddStream(); // click the backdrop to dismiss
});

el.watchFullscreen.addEventListener('click', () => toggleFullscreen(el.stage));
el.remote.addEventListener('dblclick', () => toggleFullscreen(el.stage));

el.leaveStream.addEventListener('click', async () => {
  await teardown();
  showView('view-connect');
  refreshLiveList();
});

el.togglePlay.addEventListener('click', () => {
  if (el.remote.paused) {
    el.remote.play();
    el.togglePlay.innerHTML = '&#10074;&#10074;';
    el.togglePlay.title = 'Pause';
  } else {
    el.remote.pause();
    el.togglePlay.innerHTML = '&#9654;';
    el.togglePlay.title = 'Resume';
  }
});

el.toggleMute.addEventListener('click', () => {
  el.remote.muted = !el.remote.muted;
  el.toggleMute.innerHTML = el.remote.muted ? '&#128263;' : '&#128266;';
  el.toggleMute.title = el.remote.muted ? 'Unmute' : 'Mute';
});

el.volume.addEventListener('input', () => {
  const value = Number(el.volume.value);
  el.remote.volume = value / 100;
  el.volumeLabel.textContent = `${value}%`;
  if (value > 0 && el.remote.muted) {
    el.remote.muted = false;
    el.toggleMute.innerHTML = '&#128266;';
  }
});

// Re-flow the mosaic as the window changes size.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layoutMosaic, 120);
});

// Release the username even if the user closes the window mid-stream.
window.addEventListener('beforeunload', () => {
  if (state.session?.token) {
    harmony.api.release(state.session.server, state.session.username, state.session.token);
  }
});

boot();
