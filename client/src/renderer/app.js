import { harmony } from './bridge.js';
import { EMOJI_SECTIONS, emojiByShortcode } from './emoji.js';
import { publish, watch, hangup, createStatsReader, applySenderSettings } from './webrtc.js';
import { AudioBridge } from './audio-bridge.js';
import { runConnectionTest } from './connection-test.js';
import { ClipBuffer, CLIP_SECONDS } from './clip-buffer.js';
import { VoiceSession } from './voice.js';
import {
  createSink, MAX_GAIN, asPercent, playSample, setOutputDevice, monitorStream, playCue,
  setCueVolume,
} from './gain.js';

// ---------------------------------------------------------------------------
// Stream presets
//
// Resolution and frame rate are chosen separately, and the bitrate follows
// from the pair. They used to come bundled as five named presets, which
// meant 720p at 60 fps -- the obvious choice for a game on a modest upload --
// simply did not exist.
//
// `width: null` means "whatever the source is", which is what you want when
// sharing a single window.
// ---------------------------------------------------------------------------

const RESOLUTIONS = {
  480: { label: '480p', width: 854, height: 480 },
  720: { label: '720p', width: 1280, height: 720 },
  1080: { label: '1080p', width: 1920, height: 1080 },
  native: { label: 'Native', width: null, height: null },
};

const FRAMERATES = [30, 60, 120];

/*
 * Bitrate ceilings in Mbit/s, one per frame rate above. Ceilings, not
 * targets -- the encoder spends less on a static desktop, and congestion
 * control backs off to whatever the link really has.
 *
 * Doubling the frame rate does not double the bits needed -- consecutive
 * frames are more alike at 60 fps than at 30 -- so each step is about half
 * again rather than twice. The 1080p and native rows at 30 and 60 are the old
 * Balanced, Full HD and High presets, which were measured; 120 extends the
 * same curve.
 */
const BITRATE_MBPS = {
  480: [1.5, 2.5, 4],
  720: [3, 5, 8],
  1080: [8, 12, 18],
  native: [15, 20, 28],
};

/** What the old bundled presets meant, for a settings file that still has one. */
const LEGACY_QUALITY = {
  low: ['720', 30],
  balanced: ['1080', 30],
  full60: ['1080', 60],
  high: ['native', 60],
  ultra: ['native', 60],
};

/** The encoder settings for a resolution and frame rate. */
function streamPreset(resolution, fps) {
  const res = RESOLUTIONS[resolution] ? resolution : '1080';
  const index = Math.max(0, FRAMERATES.indexOf(Number(fps)));
  return {
    width: RESOLUTIONS[res].width,
    height: RESOLUTIONS[res].height,
    fps: FRAMERATES[index],
    bitrate: BITRATE_MBPS[res][index] * 1_000_000,
  };
}

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

/**
 * Account state for the connect screen.
 *
 * `supported` stays false against a pre-accounts server, which is what keeps
 * the old single-box flow working untouched.
 */
const AUTH_DEFAULTS = {
  supported: false,
  hasAccounts: false,
  needsOwner: false,
  mode: 'login',
  token: '',
  user: null,
};

// ---------------------------------------------------------------------------

/**
 * Fold what someone typed into the form that is actually stored.
 *
 * Mirrors normalizeName() on the server: "Pedro Lucas" is a perfectly
 * reasonable thing to type and becomes `pedrolucas`. Doing it here as well
 * means the box shows what will be used instead of quietly rewriting it on
 * submit -- the server would reach the same answer either way, but only one of
 * those is honest about it.
 */
const normalizeName = (raw) => String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');

const $ = (id) => document.getElementById(id);

const el = {
  views: document.querySelectorAll('.view'),
  serverUrl: $('server-url'),
  passwordField: $('password-field'),
  password: $('server-password'),
  username: $('username'),
  usernameHint: $('username-hint'),
  accountFields: $('account-fields'),
  accountPassword: $('account-password'),
  accountPasswordLabel: $('account-password-label'),
  accountConfirmField: $('account-confirm-field'),
  accountConfirm: $('account-confirm'),
  ownerKeyField: $('owner-key-field'),
  ownerKey: $('owner-key'),
  rememberAccount: $('remember-account'),
  authModeText: $('auth-mode-text'),
  authModeToggle: $('auth-mode-toggle'),
  continue: $('continue'),
  connectError: $('connect-error'),
  liveList: $('live-list'),
  liveItems: $('live-items'),

  channelsWho: $('channels-who'),
  channelsAvatar: $('channels-avatar'),
  avatarButton: $('avatar-button'),
  avatarFile: $('avatar-file'),
  channelsRole: $('channels-role'),
  serverName: $('server-name'),
  serverSettings: $('server-settings'),
  serverDialog: $('server-dialog'),
  serverForm: $('server-form'),
  serverNameInput: $('server-name-input'),
  serverPasswordInput: $('server-password-input'),
  serverPasswordOff: $('server-password-off'),
  serverPasswordNote: $('server-password-note'),
  serverErrorLine: $('server-error'),
  serverNote: $('server-note'),
  serverCancel: $('server-cancel'),
  rowMenu: $('row-menu'),
  rowMenuName: $('row-menu-name'),
  rowMenuBody: $('row-menu-body'),
  memberMenu: $('member-menu'),
  memberMenuAvatar: $('member-menu-avatar'),
  memberMenuName: $('member-menu-name'),
  memberMenuBody: $('member-menu-body'),
  channelsMembers: $('channels-members'),
  memberList: $('member-list'),
  memberItems: $('member-items'),
  memberCount: $('member-count'),
  channelsSignout: $('channels-signout'),
  channelAdd: $('channel-add'),
  channelItems: $('channel-items'),
  channelsLayout: document.querySelector('.channels-layout'),
  channelStage: $('channel-stage'),
  channelsError: $('channels-error'),
  voiceIdle: $('voice-idle'),
  voiceActive: $('voice-active'),
  voiceName: $('voice-name'),
  voiceCount: $('voice-count'),
  voiceRoster: $('voice-roster'),
  chatActive: $('chat-active'),
  chatName: $('chat-name'),
  chatSearch: $('chat-search'),
  chatSearchClear: $('chat-search-clear'),
  chatPinned: $('chat-pinned'),
  chatLog: $('chat-log'),
  chatForm: $('chat-form'),
  chatInput: $('chat-input'),
  chatFile: $('chat-file'),
  chatAttach: $('chat-attach'),
  chatNote: $('chat-note'),
  chatSend: $('chat-send'),
  uiScale: $('ui-scale'),
  scaleValue: $('scale-value'),
  scaleDown: $('scale-down'),
  scaleUp: $('scale-up'),
  scaleReset: $('scale-reset'),
  lightbox: $('lightbox'),
  lightboxImg: $('lightbox-img'),
  lightboxName: $('lightbox-name'),
  lightboxSave: $('lightbox-save'),
  lightboxClose: $('lightbox-close'),
  chatPending: $('chat-pending'),
  chatPendingThumb: $('chat-pending-thumb'),
  chatPendingName: $('chat-pending-name'),
  chatPendingClear: $('chat-pending-clear'),
  soundpad: $('soundpad'),
  chatEmoji: $('chat-emoji'),
  mentionPop: $('mention-pop'),
  mentionItems: $('mention-items'),
  mentionSound: $('mention-sound'),
  emojiPop: $('emoji-pop'),
  emojiSearch: $('emoji-search'),
  emojiGrid: $('emoji-grid'),
  emojiEmpty: $('emoji-empty'),
  emojiPreview: $('emoji-preview'),
  emojiAdd: $('emoji-add'),
  emojiFile: $('emoji-file'),
  soundpadAdd: $('soundpad-add'),
  soundpadFile: $('soundpad-file'),
  soundpadGrid: $('soundpad-grid'),
  soundpadSearch: $('soundpad-search'),
  soundpadEmpty: $('soundpad-empty'),
  soundpadVolume: $('soundpad-volume'),
  soundpadVolumeLabel: $('soundpad-volume-label'),
  soundpadMute: $('soundpad-mute'),
  ask: $('ask'),
  askForm: $('ask-form'),
  askTitle: $('ask-title'),
  askText: $('ask-text'),
  askFields: $('ask-fields'),
  askError: $('ask-error'),
  askCancel: $('ask-cancel'),
  askOk: $('ask-ok'),
  channelVideo: $('channel-video'),
  voiceInput: $('voice-input'),
  voiceOutput: $('voice-output'),
  voiceDeviceNote: $('voice-device-note'),
  micGain: $('mic-gain'),
  micGainLabel: $('mic-gain-label'),
  micGate: $('mic-gate'),
  micGateLabel: $('mic-gate-label'),
  micMeter: $('mic-meter'),
  micMeterFill: $('mic-meter-fill'),
  micMeterMark: $('mic-meter-mark'),
  voiceSounds: $('voice-sounds'),
  soundVolume: $('sound-volume'),
  soundVolumeLabel: $('sound-volume-label'),
  hotkeyList: $('hotkey-list'),
  hotkeyRecorder: $('hotkey-recorder'),
  hotkeyRecorderTitle: $('hotkey-recorder-title'),
  hotkeyCapture: $('hotkey-capture'),
  hotkeyRecorderError: $('hotkey-recorder-error'),
  hotkeyRecorderClear: $('hotkey-recorder-clear'),
  hotkeyRecorderCancel: $('hotkey-recorder-cancel'),
  themeGrid: $('theme-grid'),
  themeCustom: $('theme-custom'),
  voiceCamera: $('voice-camera'),
  voiceCam: $('voice-cam'),
  voiceScreen: $('voice-screen'),
  voiceMute: $('voice-mute'),
  voiceDeafen: $('voice-deafen'),
  voiceSoundboard: $('voice-soundboard'),
  voiceConfig: $('voice-config'),
  devicesDialog: $('devices'),
  voiceLeave: $('voice-leave'),
  voicePanel: $('voice-panel'),
  voiceSignal: $('voice-signal'),
  voiceState: $('voice-state'),
  voiceWhere: $('voice-where'),
  selfStatus: $('self-status'),
  selfName: $('self-name'),
  peerMenu: $('peer-menu'),
  peerMenuAvatar: $('peer-menu-avatar'),
  peerMenuName: $('peer-menu-name'),
  peerMenuBody: $('peer-menu-body'),

  picker: $('picker'),
  pickerUsername: $('picker-username'),
  pickerBack: $('picker-back'),
  pickerRefresh: $('picker-refresh'),
  tabs: document.querySelectorAll('.tab'),
  sourceGrid: $('source-grid'),
  resolution: $('resolution'),
  framerate: $('framerate'),
  fallbackField: $('fallback-field'),
  fallback: $('window-audio-fallback'),
  excludeField: $('exclude-field'),
  excludeApp: $('exclude-app'),
  audioInputField: $('audio-input-field'),
  audioInput: $('audio-input'),
  liveResolution: $('live-resolution'),
  liveFramerate: $('live-framerate'),
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
  // Fullscreen goes on the whole view, not just the stage, so the real
  // controls come with it -- otherwise fullscreen would need a second copy of
  // every button, and the two would drift apart.
  watchView: $('view-watch'),

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
    /*
     * Closed streams that are still live, as empty squares.
     *
     * Closing a tile tears the connection down -- that is the point, it is
     * how you stop paying for a decoder and a 1080p downstream -- but the
     * square stays where it was so you can click it to come back. Before,
     * the tile simply vanished and the only way back was + Add stream,
     * which meant closing something to glance away cost you your place in
     * the grid.
     */
    ghosts: new Map(),
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
  /** Who is signed in, and what this server supports. See AUTH_DEFAULTS. */
  auth: { ...AUTH_DEFAULTS },

  /**
   * Channels, and the voice channel we are in (if any).
   *
   * `list` and `occupancy` are mirrors of server pushes -- never edited
   * locally, so there is nothing to reconcile when a push arrives.
   */
  channels: {
    list: [],
    /**
     * Folders for the sidebar.
     *
     * A group OWNS nothing: deleting one leaves its channels where they
     * were, ungrouped, which is the ON DELETE SET NULL in schema v7. It is
     * a heading with a fold, not a container.
     */
    groups: [],
    /**
     * Which groups are rolled up, by id. Local and unsaved to the server:
     * a folder you closed is a fact about your sidebar, not about
     * everybody's.
     */
    collapsed: new Set(),
    occupancy: {},
    /** The roster of the channel WE are in. */
    roster: [],
    /**
     * Every channel's roster, keyed by channel id.
     *
     * The server already broadcasts voice:roster for every channel to every
     * client, not just to that channel's members -- it has to, or a sidebar
     * could never show occupancy. Keeping the whole roster rather than only
     * its length is what lets the sidebar name the people in a channel you
     * are not in, which is the entire point of a sidebar.
     */
    rosters: {},
    /**
     * Who has a socket open, by user id.
     *
     * Derived on the server from open sockets and pushed -- never stored
     * there and never inferred here. A client that guessed at this from
     * voice rosters would call somebody offline the moment they left a
     * channel, which is the opposite of true.
     */
    online: new Set(),
    joining: false,
  },

  /**
   * Everyone with an account, by id.
   *
   * Kept because the voice roster and chat messages carry a user id and a
   * nickname but not a picture -- the picture can change mid-session, and
   * denormalising it into every roster push would mean a stale avatar on every
   * screen until the next one. One map, updated by `user:updated`.
   */
  users: new Map(),

  /**
   * Where a screen share goes: null for the flat `<nickname>` namespace, or a
   * channel's own `vc-<cid>-<mid>-s` path.
   */
  share: { target: null },
  chat: { channelId: null, messages: [], pinned: [], searching: false, pendingFile: null },
  soundpad: { clips: [] },
  /**
   * The server's own emoji.
   *
   * byName as well as the list, because every message body is scanned for
   * :name: on every render -- a linear search through the list would be
   * that scan times the number of emoji, for every message on screen.
   */
  emojis: { list: [], byName: new Map() },
  /**
   * Channels holding something addressed to you, by id.
   *
   * Client-side and not persisted: it answers "since I have been looking",
   * which is the only question a mark on a sidebar row can honestly
   * answer without a read-receipt table on the server.
   */
  /*
   * Mentions waiting for you, per channel: channelId -> how many.
   *
   * Entirely local -- counted from the pushes this client receives, never
   * sent anywhere, and gone when the app closes. Each person's client counts
   * only what names them (or @everyone), so whoever was mentioned sees the
   * number and nobody else does.
   */
  mentioned: new Map(),
  /** The webcam publish, which is a SECOND stream under `<nickname>-cam`. */
  camera: { stream: null, publication: null, session: null },
  voice: new VoiceSession(),
  audioAvailable: false,
  audioUnavailableReason: null,

  sources: [],
  cameras: [],
  audioInputs: [],
  processes: [],
  /**
   * What the person picked in "Exclude audio" since the picker opened, or
   * null for "not touched" -- in which case Harmony itself is excluded.
   */
  excludeChoice: null,
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
   * `windowVisible` is the automatic half. `stream` holds the clone from
   * previewCopy() -- never the published track itself.
   *
   * Hidden until asked for, on every new broadcast: nobody but you sees it,
   * and you are already looking at the thing it is a picture of.
   */
  preview: { hiddenByUser: true, windowVisible: true, stream: null },

  server: '', // control server base URL, valid outside a session too
  session: null, // server response for the current username

  /** Set once the server says it wants a password. */
  passwordRequired: false,

  /** GPU encode/decode capability, from the main process. */
  gpu: null,

  /**
   * Single-stream watching. Kept here rather than read off the element because
   * the element is permanently muted -- gain.js owns what you actually hear.
   */
  watch: { volume: 1, muted: false, sink: null },

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
  // The picker is a window over a view, and every way out of it -- going
  // live, backing out, failing -- ends by naming the view to land on. Closing
  // it here means none of them can leave it open over the result.
  if (el.picker.open) el.picker.close();
}

/** Open the source picker over whatever is on screen. */
function openPicker() {
  if (!el.picker.open) el.picker.showModal();
}

/**
 * A row of buttons that behaves as one choice.
 *
 * Buttons rather than a <select> because there are three or four options and
 * all of them fit: a select hides the alternatives behind a click to save
 * space nobody needed.
 */
function fillSegmented(container, entries, value) {
  container.replaceChildren(
    ...entries.map(([key, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.role = 'radio';
      button.dataset.value = String(key);
      button.textContent = label;
      button.setAttribute('aria-checked', String(String(key) === String(value)));
      return button;
    }),
  );
}

function segmentedValue(container) {
  return container.querySelector('[aria-checked="true"]')?.dataset.value ?? null;
}

function pickSegmented(container, value) {
  for (const button of container.querySelectorAll('button')) {
    button.setAttribute('aria-checked', String(button.dataset.value === String(value)));
  }
}

/** The preset the picker is set to. */
function pickerPreset() {
  return streamPreset(segmentedValue(el.resolution), segmentedValue(el.framerate));
}

/** The preset the live bar is set to. */
function livePreset() {
  return streamPreset(el.liveResolution.value, el.liveFramerate.value);
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
  // First, before anything is drawn. Applying it later means the window
  // opens in the default palette and flashes into the chosen one.
  applyTheme(state.settings.theme);
  el.serverUrl.value = state.settings.serverUrl;
  el.username.value = state.settings.username;
  el.password.value = state.settings.password ?? '';
  // Main holds the password for every request it makes; hand back what was
  // saved before anything asks the server for anything.
  await harmony.api.setPassword(el.password.value);

  setCueVolume((state.settings.soundVolume ?? 100) / 100);
  // Mute and deafen are bound from the start; clips join once the soundpad
  // of a server has loaded, since their ids mean nothing before that.
  syncHotkeys();

  el.rememberAccount.checked = state.settings.rememberAccount !== false;
  if (state.settings.sessionToken) {
    // Restore before probeServer, so /api/health is already authenticated and
    // a still-valid token skips the login form entirely.
    state.auth.token = state.settings.sessionToken;
    await harmony.api.setSessionToken(state.auth.token);
  }
  el.fallback.value = state.settings.windowAudioFallback;
  state.clips.enabled = Boolean(state.settings.clipsEnabled);
  el.clipsEnabled.checked = state.clips.enabled;

  // A settings file from before resolution and frame rate were separate
  // still says what it wanted, as one of the old bundled presets.
  const legacy = LEGACY_QUALITY[state.settings.quality] ?? LEGACY_QUALITY.balanced;
  const resolution = state.settings.resolution in RESOLUTIONS ? state.settings.resolution : legacy[0];
  const framerate = FRAMERATES.includes(Number(state.settings.framerate))
    ? Number(state.settings.framerate)
    : legacy[1];
  const resolutionEntries = Object.entries(RESOLUTIONS).map(([key, r]) => [key, r.label]);
  const framerateEntries = FRAMERATES.map((fps) => [fps, `${fps} fps`]);

  fillSegmented(el.resolution, resolutionEntries, resolution);
  fillSegmented(el.framerate, framerateEntries, framerate);
  for (const [select, entries, value] of [
    [el.liveResolution, resolutionEntries, resolution],
    [el.liveFramerate, framerateEntries, framerate],
  ]) {
    select.replaceChildren(...entries.map(([key, label]) => new Option(label, String(key))));
    select.value = String(value);
  }

  // Not in the picker any more -- it is a question about a stream that is
  // already running, and the live bar is where it can be answered.
  for (const [key, mode] of Object.entries(PRIORITY)) {
    el.livePriority.append(new Option(mode.label, key));
  }
  el.livePriority.value = state.settings.priority in PRIORITY ? state.settings.priority : 'sharp';

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
    /*
     * The field STAYS. Only the hint changes.
     *
     * It used to appear and disappear as the server was probed, which meant
     * the form you were filling in was not the form you had been looking at
     * a second earlier -- and a box that is not there yet is one people
     * assume is not wanted.
     */
    el.passwordField.querySelector('span').textContent = health.passwordRequired
      ? 'Server password'
      : 'Server password (not needed)';
    state.passwordRequired = Boolean(health.passwordRequired);

    // `hasAccounts` is absent on a pre-accounts server, which is exactly how we
    // tell the two apart -- undefined means "this server has no account system",
    // so the whole block stays hidden and the single-box flow is unchanged.
    // It is also absent while unauthenticated, since /api/health withholds its
    // details until the shared password is right.
    state.auth.supported = health.hasAccounts !== undefined;
    state.auth.hasAccounts = Boolean(health.hasAccounts);
    state.auth.needsOwner = Boolean(health.needsOwner);

    // An empty server has nobody to log in as, so offer registration first.
    if (state.auth.supported && !state.auth.hasAccounts) state.auth.mode = 'register';
    await restoreSession();
    applyAuthMode();
  } catch {
    // Unreachable, or an older server with no passwordRequired field. Either
    // way, do not change what the user can see.
  }
}

/**
 * Show the account fields in the mode we are actually in.
 *
 * Registering and logging in are deliberately NOT inferred from whether the
 * nickname exists: the server answers "wrong nickname or password" to both, on
 * purpose, so that this screen cannot be used to enumerate who has an account.
 * That means the user has to say which they meant, and auto-creating an account
 * on a mistyped password would be the worst possible guess.
 */
/**
 * Turn a saved session token back into a signed-in user.
 *
 * "Stay signed in" has always SAVED the token -- boot() restores it and hands
 * it to main for every request. What it never did was tell the client who
 * that token belongs to, and the connect screen gates on `state.auth.user`,
 * which only authenticate() ever set. So a saved session still demanded the
 * password, and the setting looked like it was not saving anything.
 *
 * One call to /api/accounts/me closes that. A token the server no longer
 * accepts is dropped here rather than left to fail later with something
 * confusing.
 */
async function restoreSession() {
  if (!state.auth.token || !state.auth.supported || state.auth.user) return;
  try {
    const { user } = await harmony.api.me(el.serverUrl.value.trim());
    state.auth.user = user;
    el.username.value = user.nickname;
  } catch (err) {
    // 401 means expired or revoked -- an ordinary thing, not an error worth
    // showing. Anything else (server down) leaves the token alone so a
    // reachable server can still honour it later.
    if (err.status === 401 || err.code === 'login_required') await adoptSession('');
  }
}

function applyAuthMode() {
  const on = state.auth.supported;
  const signedIn = Boolean(state.auth.user);
  /*
   * The account column is ALWAYS on screen, and so is the sign-up link.
   *
   * Both used to be hidden until a server had been probed and had reported
   * that it has accounts. Two problems with that: the form rearranged
   * itself under the cursor a second after the window opened, and the way
   * to create an account was invisible to anybody who had not already got
   * one -- which is everybody who needs it.
   *
   * There is nothing to lose by showing them. A server with no accounts
   * ignores the password (see `wantsSignIn` in startSession, which is
   * gated on auth.supported), so the worst case is a box somebody fills in
   * for nothing rather than a box they cannot find.
   */
  el.accountFields.hidden = false;
  document.body.dataset.authMode = on ? state.auth.mode : 'none';

  if (signedIn) {
    // Nothing to type: the password box would only invite somebody to
    // re-enter a password they do not need.
    el.accountPassword.value = '';
    el.accountPassword.placeholder = 'Already signed in';
    el.accountPasswordLabel.textContent = 'Password';
    el.accountConfirmField.hidden = true;
    el.ownerKeyField.hidden = true;
    el.usernameHint.textContent = `Signed in as ${displayOf(
      state.auth.user.id, state.auth.user.nickname,
    )}.`;
    el.authModeText.textContent = 'Not you?';
    el.authModeToggle.textContent = 'Sign out';
    el.continue.textContent = 'Connect';
    return;
  }

  const registering = state.auth.mode === 'register';
  el.accountPasswordLabel.textContent = registering ? 'Choose a password' : 'Password';
  el.accountPassword.placeholder = registering ? 'At least 6 characters' : '';
  el.accountConfirmField.hidden = !registering;
  el.ownerKeyField.hidden = !(registering && state.auth.needsOwner);

  el.usernameHint.textContent = (() => {
    if (!on) {
      return 'Free name \u2192 you start streaming. '
        + 'Name already live \u2192 you join and watch.';
    }
    return registering
      ? 'This becomes your permanent name. 2-20 characters, and it is what your stream is called.'
      : 'The nickname you registered with.';
  })();

  el.authModeText.textContent = registering ? 'Already registered?' : 'No account yet?';
  el.authModeToggle.textContent = registering ? 'Sign in' : 'Create one';
  el.continue.textContent = registering ? 'Create account' : 'Connect';
}

/** Hand the token to main, and persist it only if they asked us to. */
async function adoptSession(token) {
  state.auth.token = token ?? '';
  await harmony.api.setSessionToken(state.auth.token);
  await harmony.settings.set({
    sessionToken: el.rememberAccount.checked ? state.auth.token : '',
    rememberAccount: el.rememberAccount.checked,
  });
}

/**
 * Log in or register, depending on the mode. Returns the account, or throws
 * with a message already fit to show.
 */
async function authenticate(server, nickname) {
  const registering = state.auth.mode === 'register';
  const password = el.accountPassword.value;
  const ownerKey = el.ownerKey.value.trim();

  if (registering && password !== el.accountConfirm.value) {
    throw new Error('The two passwords do not match.');
  }

  const result = registering
    ? await harmony.api.register(server, nickname, password, ownerKey)
    : await harmony.api.login(server, nickname, password, ownerKey);

  await adoptSession(result.token);
  state.auth.user = result.user;

  // Say so rather than silently making them a member -- someone pasting a key
  // that does not work needs to know before they wonder why they cannot
  // create channels.
  if (result.ownerKeyRejected) {
    showError('That owner key was not accepted, so this account is an ordinary member.');
  } else if (result.ownerClaimed) {
    showError('');
  }
  return result.user;
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
      el.passwordField.classList.add('bad');
      showError(err.message);
    }
  }
}

async function startSession() {
  const server = el.serverUrl.value.trim();
  const username = normalizeName(el.username.value);

  if (!server) return showError('Enter the address of your Harmony server.');
  if (!username) return showError('Pick a username.');

  showError('');
  el.continue.disabled = true;
  el.continue.textContent = 'Connecting…';

  try {
    // Before anything else reaches the server, so the very first request of the
    // session already carries it.
    await harmony.api.setPassword(el.password.value);

    // A server we have not reached yet has not told us whether it has accounts.
    if (!state.auth.supported) await probeServer();

    /**
     * Mirror the server's own rule exactly.
     *
     * A server with an account system but no accounts yet still answers
     * anonymous claims -- that is what keeps a fresh install usable the moment
     * it starts, before anyone has registered. So signing in is REQUIRED only
     * once an account exists, and OPTIONAL (but honoured) before that, which is
     * how the first person registers at all.
     *
     * Getting this wrong in either direction is visible: too strict and a brand
     * new server cannot be used without registering first; too lax and the
     * impersonation hole /api/session was fixed for stays open on the client
     * side.
     */
    const mustSignIn = state.auth.supported && state.auth.hasAccounts;
    const wantsSignIn = state.auth.supported && el.accountPassword.value.length > 0;

    // `state.auth.user` is set either by a sign-in just now or by a saved
    // session restored in probeServer. Checking the password box instead of
    // this is what made "stay signed in" useless.
    if (mustSignIn && !state.auth.user && !el.accountPassword.value) {
      el.accountPassword.focus();
      throw new Error('This server has accounts. Enter your password, or create an account.');
    }

    if ((mustSignIn || wantsSignIn) && !state.auth.user) {
      await authenticate(server, username);
    }

    const held = state.lastClaim?.username === username ? state.lastClaim.token : undefined;
    const session = await harmony.api.session(server, username, held);
    state.session = { ...session, server };
    if (session.token) state.lastClaim = { username, token: session.token };
    el.passwordField.classList.remove('bad');

    await harmony.settings.set({ serverUrl: server, username, password: el.password.value });
    state.settings = await harmony.settings.get();

    // A signed-in user gets the lobby; everyone else keeps the original
    // straight-to-your-stream flow, which is what an account-less server and
    // every 1.0.0 client still do.
    if (state.auth.user) {
      state.server = server;
      await enterChannels();
    } else if (session.role === 'broadcaster') {
      await enterPicker();
    } else {
      await enterWatch();
    }
  } catch (err) {
    showError(err.message);
    if (err.code === 'bad_password' || err.code === 'locked_out') {
      el.passwordField.classList.add('bad');
      el.password.focus();
      el.password.select();
    }
    if (err.code === 'bad_credentials' || err.code === 'weak_password') {
      el.accountPassword.focus();
      el.accountPassword.select();
    }
    if (err.code === 'nickname_taken') {
      // They meant to sign in. Put them there rather than making them find the
      // link themselves.
      state.auth.mode = 'login';
      applyAuthMode();
      el.accountPassword.focus();
    }
    // A failed login must not leave a half-adopted session behind.
    if (state.auth.supported && !state.auth.user) await adoptSession('');
  } finally {
    el.continue.disabled = false;
    el.continue.textContent =
      state.auth.supported && state.auth.mode === 'register' ? 'Create account' : 'Connect';
  }
}

// ---------------------------------------------------------------------------
// Channels and voice
// ---------------------------------------------------------------------------

function showChannelsError(message) {
  el.channelsError.textContent = message;
  el.channelsError.hidden = !message;
}

const isAdmin = () => state.auth.user?.role === 'owner' || state.auth.user?.role === 'admin';
const isOwner = () => state.auth.user?.role === 'owner';

/* Asking the person something ------------------------------------------
 *
 * Electron does not implement window.prompt(). Not discouraged -- absent,
 * and it throws. So every prompt() in this file was code that could never
 * run, and the features behind them (naming a channel, naming a soundpad
 * clip, entering a channel password, renaming) were all unreachable the
 * moment anybody pressed the button.
 *
 * They survived every test because the UI suite STUBBED window.prompt
 * before clicking. Replacing a platform function in a test is how you end
 * up proving your code works against a platform you do not have. Nothing is
 * stubbed now; the test drives this dialog.
 *
 * One dialog, reused: a title, some fields, OK and Cancel. It resolves with
 * the values, or null if they backed out.
 */

/** @type {null | ((value: object | null) => void)} */
let askResolve = null;

function closeAsk(value) {
  const resolve = askResolve;
  askResolve = null;
  try { el.ask.close(); } catch { /* already closed */ }
  el.askFields.replaceChildren();
  el.askError.hidden = true;
  resolve?.(value);
}

/**
 * @param {{title: string, text?: string, okLabel?: string,
 *          fields?: Array<{name: string, label: string, type?: string,
 *                          value?: string, placeholder?: string,
 *                          options?: Array<{value: string, label: string}>,
 *                          required?: boolean}>}} spec
 * @returns {Promise<Record<string, string> | null>}
 */
function ask(spec) {
  // A second question while one is open would orphan the first promise.
  if (askResolve) closeAsk(null);

  el.askTitle.textContent = spec.title;
  el.askText.textContent = spec.text ?? '';
  el.askText.hidden = !spec.text;
  el.askOk.textContent = spec.okLabel ?? 'OK';

  el.askFields.replaceChildren(...(spec.fields ?? []).map((field) => {
    const label = document.createElement('label');
    label.className = 'field';

    const caption = document.createElement('span');
    caption.textContent = field.label;
    label.append(caption);

    let input;
    if (field.options) {
      input = document.createElement('select');
      input.append(...field.options.map((o) => new Option(o.label, o.value)));
    } else if (field.multiline) {
      // A message can have newlines in it, and an <input> cannot hold one
      // -- it would silently drop every line break the moment somebody
      // edited a two-line message.
      input = document.createElement('textarea');
      input.rows = field.rows ?? 4;
      input.placeholder = field.placeholder ?? '';
      if (field.maxlength) input.maxLength = field.maxlength;
    } else {
      input = document.createElement('input');
      input.type = field.type ?? 'text';
      input.placeholder = field.placeholder ?? '';
      input.autocomplete = 'off';
      // The server refuses past 32 code points. Being stopped at the
      // keyboard beats typing a name and being told no.
      if (field.maxlength) input.maxLength = field.maxlength;
    }
    input.name = field.name;
    input.value = field.value ?? '';
    if (field.required) input.required = true;
    label.append(input);
    return label;
  }));

  el.ask.showModal();
  // Focus the first field: answering without reaching for the mouse is most
  // of why a prompt was reached for in the first place.
  el.askFields.querySelector('input, select, textarea')?.focus();

  return new Promise((resolve) => {
    askResolve = resolve;
  });
}

/** Yes or no, in the same dialog, so nothing depends on window.confirm. */
/**
 * Yes or no, with the button saying which yes.
 *
 * okLabel defaults to 'OK' and every caller passes its own. It used to
 * default to 'Delete', which was right for the four delete confirmations
 * that existed at the time and silently wrong for everything added since:
 * "Make somebody an admin?" offered [Cancel] [Delete]. A default that is
 * correct for today's callers and dangerous for tomorrow's is worse than
 * no default at all.
 */
async function askConfirm(title, { text, okLabel = 'OK' } = {}) {
  return (await ask({ title, text, okLabel, fields: [] })) !== null;
}

/** Profile pictures ------------------------------------------------------ */

/** Square side we store an avatar at, and the ceiling the server enforces. */
const AVATAR_PX = 256;
const AVATAR_MAX_BYTES = 256 * 1024;

const knownUser = (id) => state.users.get(id) ?? null;

/**
 * What to call somebody.
 *
 * ONE function, used everywhere a person's name is drawn, because the
 * alternative is a display name that appears in the roster and not in the
 * chat -- and somebody wondering which of the two people is them.
 *
 * The accounts list rather than the roster: a roster entry describes a
 * membership of a channel, and it is built on the server from the nickname
 * because that is the identity the slot is keyed to. The display name is a
 * property of the person, so it is looked up by user id and the roster's
 * own nickname is only the fallback for somebody not in the list yet.
 */
const displayOf = (userId, fallback = '') =>
  knownUser(userId)?.displayName || fallback || knownUser(userId)?.nickname || 'someone';

/** The same, for the shape avatarEl wants. */
const faceOf = (userId, fallback = '') =>
  knownUser(userId) ?? { nickname: fallback };

/**
 * One avatar: the picture if there is one, initials if there is not.
 *
 * `harmony://app/media/<hash>` is same-origin, so the CSP's `img-src 'self'`
 * covers it with no change, and the main process downloads and verifies the
 * file the first time the element asks for it.
 */
function avatarEl(user, extraClass = '') {
  const span = document.createElement('span');
  span.className = `avatar ${extraClass}`.trim();
  if (user?.avatarHash) {
    const img = document.createElement('img');
    img.src = harmony.mediaUrl(user.avatarHash);
    img.alt = '';
    span.append(img);
  } else {
    // Initials from whatever they are CALLED, so the letters match the name
    // written beside them. [...spread] rather than slice(0, 2), because
    // slice would cut an emoji in half and render half a surrogate pair.
    const name = String(user?.displayName || user?.nickname || '?');
    span.textContent = [...name].slice(0, 2).join('').toUpperCase();
  }
  return span;
}

/**
 * Repaint our own picture in the bar.
 *
 * Moves the children out of a throwaway avatarEl rather than building the
 * markup a second way, so the bar can never drift from the rows.
 */
function renderOwnAvatar() {
  el.channelsAvatar.replaceChildren(...avatarEl(state.auth.user).childNodes);
}

/**
 * Everything the media cache must not evict, recomputed from scratch.
 *
 * media.keep REPLACES the set rather than adding to it, so each caller
 * working out its own half is a bug waiting to happen: whoever ran last wins
 * and the other half starts being evicted. Avatars made that concrete --
 * they are drawn on every screen constantly, so losing one means downloading
 * it again immediately. Hence one function, called from all three places that
 * change any part of it.
 */
function refreshKeepSet() {
  return harmony.media.keep([
    ...[...state.users.values()].map((u) => u.avatarHash).filter(Boolean),
    ...state.soundpad.clips.map((c) => c.hash),
    ...state.emojis.list.map((e) => e.hash),
    ...state.chat.pinned.map((m) => m.attachmentHash).filter(Boolean),
  ]).catch(() => { /* the cache is a cache */ });
}

/** Pull the roster so every id in a message or a roster row has a picture. */
async function refreshUsers() {
  try {
    const { users } = await harmony.api.roster(state.server);
    state.users = new Map(users.map((u) => [u.id, u]));
    await refreshKeepSet();
  } catch {
    // Not fatal: without it everyone simply shows initials.
  }
}

/**
 * Downscale a picked image and upload it.
 *
 * Resized here rather than on the server, which is what keeps the server free
 * of an image library. A 256-pixel square JPEG is a few kilobytes, so the
 * server's cap is a backstop against somebody posting a raw photo through the
 * API rather than something this path ever hits.
 */
async function setOwnAvatar(file) {
  try {
    showChannelsError('');
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_PX;
    canvas.height = AVATAR_PX;
    const ctx = canvas.getContext('2d');
    // Cover rather than fit: a letterboxed avatar in a circle looks broken.
    const scale = Math.max(AVATAR_PX / bitmap.width, AVATAR_PX / bitmap.height);
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.drawImage(bitmap, (AVATAR_PX - w) / 2, (AVATAR_PX - h) / 2, w, h);
    bitmap.close();

    const encode = (quality) =>
      new Promise((done) => canvas.toBlob(done, 'image/jpeg', quality));
    let blob = await encode(0.85);
    if (blob && blob.size > AVATAR_MAX_BYTES) blob = await encode(0.6);
    if (!blob) throw new Error('Could not read that image.');
    if (blob.size > AVATAR_MAX_BYTES) throw new Error('That picture is too detailed to shrink.');

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const upload = await harmony.media.upload(state.server, bytes, 'image/jpeg');
    const { user } = await harmony.api.setAvatar(state.server, upload.hash);
    state.auth.user = user;
    state.users.set(user.id, user);
    renderOwnAvatar();
    refreshKeepSet();
  } catch (err) {
    showChannelsError(err.message);
  }
}

/**
 * Open the realtime socket and show the lobby.
 *
 * Only ever reached by a signed-in user: an anonymous client on a server with
 * no accounts keeps the original single-box flow, which is what lets a 1.0.0
 * deployment and its tests carry on unchanged.
 */
async function enterChannels() {
  el.channelsWho.textContent = state.auth.user.displayName || state.auth.user.nickname;
  el.channelsRole.textContent = state.auth.user.role === 'member' ? '' : state.auth.user.role;
  el.channelAdd.hidden = !isAdmin();
  // The media route serves `harmony://app/media/<hash>` -- a hash and nothing
  // else, which is what lets it be used straight in an <img src>. Main needs
  // to be told separately where to download from.
  await harmony.media.setServer(state.server);
  showChannelsError('');
  // Restored here rather than at boot: the column only exists in the
  // lobby, and applyMemberList draws it.
  applyMemberList(state.settings?.showMembers !== false);
  renderOwnAvatar();
  await refreshUsers();
  // Nothing has happened yet, so nothing else would have called it: the
  // voice panel, the stage and the member column all start from here.
  applyStage();
  // What the server calls itself, and whether the owner's button appears.
  loadServerInfo();
  loadSoundpad();
  loadEmojis();
  // Before anybody clicks, not on the click. See scheduleEmojiGrid.
  scheduleEmojiGrid();
  showView('view-channels');

  try {
    const hello = await harmony.realtime.connect(state.server, state.auth.token);
    state.channels.list = hello.channels ?? [];
    state.channels.occupancy = hello.occupancy ?? {};
    // A client that just connected has missed every roster broadcast, so the
    // whole picture arrives once with the hello.
    state.channels.rosters = hello.rosters ?? {};
  } catch (err) {
    showChannelsError(`Live updates unavailable: ${err.message}`);
    // Fall back to the REST list so the lobby is still usable read-only.
    try {
      const {
        channels, groups, occupancy, rosters, online,
      } = await harmony.api.channels(state.server);
      state.channels.list = channels;
      state.channels.groups = groups ?? [];
      state.channels.online = new Set(online ?? []);
      state.channels.occupancy = occupancy ?? {};
      state.channels.rosters = rosters ?? {};
    } catch { /* nothing more to try */ }
  }
  renderChannels();
}

/**
 * Move one channel one place and send the whole resulting order.
 *
 * The server takes a complete permutation rather than "move X to N", so two
 * admins reordering at once cannot interleave into an order neither of them
 * chose. That makes this the client's job: work out the list we want, send it.
 */
async function editChannel(channel) {
  const answer = await ask({
    title: `Edit #${channel.name}`,
    text: 'Leave the password empty to remove it.',
    okLabel: 'Save',
    fields: [
      { name: 'name', label: 'Name', value: channel.name, required: true },
      { name: 'password', label: 'Password', type: 'password', placeholder: 'No password' },
    ],
  });
  if (!answer) return;
  try {
    await harmony.api.updateChannel(state.server, channel.id, {
      name: answer.name,
      password: answer.password,
    });
  } catch (err) {
    showChannelsError(err.message);
  }
}

/** A small admin button that must not also trigger the row's own click. */
function closeRowMenu() {
  el.rowMenu.hidden = true;
}

/**
 * A little menu of things to do to a row in the sidebar.
 *
 * One function for channels and for group headings, because the two
 * offered the same two things and differed only in their wording. It takes
 * the items rather than the subject: what can be done to a group is not a
 * variation on what can be done to a channel, and a function that took one
 * and branched would be two functions sharing a name.
 *
 * @param {string} label  what the menu is about, shown at the top
 * @param {Array<{label: string, title: string, run: Function, danger?: boolean}>} items
 * @param {MouseEvent} event
 */
/**
 * @param {string} label
 * @param {{label: string, title?: string, danger?: boolean, run: () => void}[]} items
 * @param {MouseEvent|{clientX: number, clientY: number}} event  where to open it
 * @param {{above?: Element}} [options]  open ABOVE this element instead, left
 *   edges aligned -- for a menu that belongs to a button rather than to a
 *   point the pointer happened to be at.
 */
function openRowMenu(label, items, event, { above = null } = {}) {
  closePeerMenu();
  closeMemberMenu();

  el.rowMenuName.textContent = label;
  el.rowMenuBody.replaceChildren(...items.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ghost menu-item${item.danger ? ' danger' : ''}`;
    button.textContent = item.label;
    button.title = item.title;
    button.addEventListener('click', () => {
      closeRowMenu();
      item.run();
    });
    return button;
  }));

  // Shown off-screen first: a hidden element has no size, and the clamp
  // below needs one. The same trick as the other two menus.
  el.rowMenu.style.left = '-9999px';
  el.rowMenu.style.top = '0px';
  el.rowMenu.hidden = false;
  const box = el.rowMenu.getBoundingClientRect();
  const anchor = above?.getBoundingClientRect();
  const x = anchor ? anchor.left : event.clientX;
  const y = anchor ? anchor.top - box.height - 6 : event.clientY;
  el.rowMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
  el.rowMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
}

/*
 * The sidebar.
 *
 * Ungrouped channels first, then each group with its own under it. That
 * order is also the order the whole arrangement is SUBMITTED in, which is
 * what makes positions and groups agree: Channels.arrange writes
 * position = index in the submitted list, so as long as a group's channels
 * are contiguous here they stay contiguous there.
 *
 * Nothing is applied locally after a drag. The server broadcasts the new
 * list and the sidebar is redrawn from it, so what you see is always what
 * was actually written -- and a rejected drag snaps back rather than
 * leaving the sidebar showing an arrangement the server never accepted.
 */

/** Channels in the order they are drawn: ungrouped, then group by group. */
/**
 * Every channel, in the order the sidebar draws them.
 *
 * `groups` is a parameter rather than always state, because moving a group
 * moves its channels with it: the caller works out the new group order and
 * asks what the channel order would be under it, without anything in state
 * changing until the server has agreed.
 */
function orderedChannels(groups = state.channels.groups) {
  const byGroup = new Map([[null, []]]);
  for (const group of groups) byGroup.set(group.id, []);
  for (const channel of state.channels.list) {
    const key = channel.groupId ?? null;
    // A channel in a group this client has not heard of yet reads as
    // ungrouped rather than disappearing.
    (byGroup.get(key) ?? byGroup.get(null)).push(channel);
  }
  return [
    ...byGroup.get(null),
    ...groups.flatMap((group) => byGroup.get(group.id) ?? []),
  ];
}

/**
 * Send the whole tree. See Channels.arrange for why it is not a move.
 *
 * Nothing in state is touched before this: both orders are worked out in
 * local arrays and sent, so a refusal can redraw from what the server last
 * said rather than from a guess this client made.
 */
async function applyArrangement(ordered, groups = state.channels.groups) {
  try {
    await harmony.api.arrange(state.server, {
      groups: groups.map((g) => g.id),
      channels: ordered.map((c) => ({ id: c.id, groupId: c.groupId ?? null })),
    });
  } catch (err) {
    showChannelsError(err.message);
    // Redraw from what we last heard, so a refused drag does not leave the
    // sidebar showing an arrangement the server never accepted.
    renderChannels();
  }
}

/**
 * Move a channel, by rebuilding the order rather than computing indices.
 *
 * @param {number} id        the channel being dragged
 * @param {object} to        {beforeId} to land above a channel, or
 *                           {groupId} to land at the end of a group
 */
function moveChannel(id, to) {
  const ordered = orderedChannels();
  const moving = ordered.find((c) => c.id === id);
  if (!moving) return;

  const rest = ordered.filter((c) => c.id !== id);
  let index = rest.length;
  if (to.beforeId != null) {
    const anchor = rest.find((c) => c.id === to.beforeId);
    if (!anchor) return;
    moving.groupId = anchor.groupId ?? null;
    index = rest.indexOf(anchor);
  } else {
    moving.groupId = to.groupId ?? null;
    // The end of that group, which is the last channel belonging to it --
    // or, for an empty group, wherever the group's block begins.
    const last = rest.map((c, i) => [c, i])
      .filter(([c]) => (c.groupId ?? null) === moving.groupId)
      .pop();
    if (last) index = last[1] + 1;
    else if (moving.groupId === null) index = 0;
    else {
      // An empty group: everything before it in group order, plus the
      // ungrouped block, comes first.
      const before = new Set([null]);
      for (const g of state.channels.groups) {
        if (g.id === moving.groupId) break;
        before.add(g.id);
      }
      index = rest.filter((c) => before.has(c.groupId ?? null)).length;
    }
  }

  rest.splice(index, 0, moving);
  applyArrangement(rest);
}

/**
 * Move a group, and everything in it.
 *
 * The channels are not mentioned anywhere below, and they do not need to
 * be: positions are written from the order of the submitted list, and
 * orderedChannels() walks the groups in the order it is given. Ask it about
 * the new group order and the channels come out already following their
 * headings.
 *
 * @param {number} id        the group being dragged
 * @param {number|null} beforeId  the group to land above, or null for last
 */
function moveGroup(id, beforeId) {
  const groups = [...state.channels.groups];
  const from = groups.findIndex((g) => g.id === id);
  if (from < 0) return;

  const [moving] = groups.splice(from, 1);
  let index = groups.length;
  if (beforeId != null) {
    index = groups.findIndex((g) => g.id === beforeId);
    // The anchor was the group being dragged, or one this client has not
    // heard of. Either way there is nothing to be above.
    if (index < 0) return;
  }
  groups.splice(index, 0, moving);

  applyArrangement(orderedChannels(groups), groups);
}

/** The row for one channel, plus its member list where it has one. */
function channelNodes(channel) {
  const li = document.createElement('li');
  // Named, because the member list under a channel is an <li> too and
  // "every li in the sidebar" stopped meaning "every channel".
  li.className = 'channel-row';
  li.dataset.id = String(channel.id);
  /*
   * Two different things, marked separately, the way Discord does it.
   *
   * data-active is the voice channel you are CONNECTED to -- true for as
   * long as the call lasts, whatever you are looking at. data-viewing is the
   * channel whose content is on screen: the text channel you opened, or,
   * with no chat open, the voice channel's stage. Only data-viewing is the
   * highlight; it used to be data-active alone, so opening a text channel
   * highlighted nothing new and the voice channel stayed lit the whole call.
   */
  if (channel.id === state.voice.channelId) li.setAttribute('data-active', '');
  const viewing = state.chat.channelId ?? state.voice.channelId;
  if (channel.id === viewing) li.setAttribute('data-viewing', '');
  const mentions = state.mentioned.get(channel.id) ?? 0;
  if (mentions) {
    // The number itself is drawn by CSS from the attribute.
    li.dataset.mention = mentions > 99 ? '99+' : String(mentions);
    li.title = `${mentions} ${mentions === 1 ? 'message mentions' : 'messages mention'} you`;
  }

  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.dataset.kind = channel.kind;
  kind.textContent = channel.kind === 'voice' ? '\u{1F50A}' : '#';

  const name = document.createElement('span');
  name.className = 'channel-name';
  name.textContent = channel.name;

  li.append(kind, name);

  if (channel.locked) {
    const lock = document.createElement('span');
    lock.className = 'tag';
    lock.textContent = channel.unlocked ? 'unlocked' : 'locked';
    li.append(lock);
  }

  /*
   * No occupant count beside the name.
   *
   * The people are listed directly underneath, with their faces on. A
   * number saying there are two of them, a centimetre above two of them,
   * is the same fact twice -- and it was the thing crowding the name on a
   * narrow sidebar.
   *
   * state.channels.occupancy is still kept: it is a server push and it is
   * what tells the sidebar a channel has anybody in it at all, without
   * needing the whole roster for every channel.
   */

  if (isAdmin()) {
    /*
     * Rename and delete, on right-click rather than on the row.
     *
     * They used to be a pencil and a cross drawn into every row, which on
     * a sidebar of twenty channels is forty buttons -- all of them admin
     * actions, all of them beside the name you are reading and in front of
     * the name you are trying to click. A menu costs one more gesture to
     * reach something nobody does twice a week.
     */
    li.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // The hash only for a text channel: a voice one is a speaker in the
      // sidebar and calling it #voice here would name it something it is
      // not called anywhere else.
      openRowMenu(channel.kind === 'text' ? `#${channel.name}` : channel.name, [
        {
          label: 'Rename or set a password',
          title: 'Change the name, or put a password on it',
          run: () => editChannel(channel),
        },
        {
          label: 'Delete this channel',
          title: 'Removes the channel and everything written in it',
          danger: true,
          run: async () => {
            if (!await askConfirm(`Delete #${channel.name}?`, {
              text: 'Everything written in it goes too. This cannot be undone.',
              okLabel: 'Delete',
            })) return;
            try {
              await harmony.api.deleteChannel(state.server, channel.id);
            } catch (err) {
              showChannelsError(err.message);
            }
          },
        },
      ], event);
    });

    // The up/down arrows are gone: dragging replaced them, and keeping
    // both would mean two code paths writing the same positions.
    li.draggable = true;
    li.addEventListener('dragstart', (event) => {
      dragging = { kind: 'channel', id: channel.id };
      event.dataTransfer.effectAllowed = 'move';
      // Firefox will not start a drag without data on the transfer, and
      // Chromium is happy to be given some anyway.
      event.dataTransfer.setData('text/plain', String(channel.id));
      li.setAttribute('data-dragging', '');
    });
    li.addEventListener('dragend', () => {
      dragging = null;
      li.removeAttribute('data-dragging');
      clearDropMarks();
    });
    li.addEventListener('dragover', (event) => {
      if (dragging?.kind !== 'channel' || dragging.id === channel.id) return;
      event.preventDefault();
      clearDropMarks();
      li.setAttribute('data-drop-before', '');
    });
    li.addEventListener('drop', (event) => {
      if (dragging?.kind !== 'channel' || dragging.id === channel.id) return;
      event.preventDefault();
      event.stopPropagation();
      const id = dragging.id;
      dragging = null;
      clearDropMarks();
      moveChannel(id, { beforeId: channel.id });
    });
  }

  li.addEventListener('click', () => onChannelClick(channel));
  if (channel.kind === 'voice') acceptMemberDrop(li, channel, li);

  // Who is in this voice channel, under it, the way a sidebar shows it.
  //
  // Returned as a SECOND top-level node rather than nested inside the row:
  // the row has a click handler that joins the channel, and a nested list
  // would make every click on a member's name join it too.
  const members = state.channels.rosters[channel.id] ?? [];
  if (channel.kind !== 'voice' || members.length === 0) return [li];

  const list = document.createElement('li');
  list.className = 'channel-members';
  list.dataset.for = String(channel.id);
  // Dropping onto the people already in a channel means that channel too;
  // the highlight goes on its row, which is what the drop is about.
  acceptMemberDrop(list, channel, li);
  list.append(...members.map((member) => {
    const row = document.createElement('span');
    row.className = 'channel-member';
    row.append(avatarEl(faceOf(member.userId, member.nickname), 'tiny'));

    const who = document.createElement('span');
    who.className = 'member-name';
    who.textContent = displayOf(member.userId, member.nickname);
    row.append(who);

    // Exactly the indicators the voice pane shows, from the same helper --
    // the two lists are looked at side by side, and nothing is more
    // confusing than the same person reading differently in each.
    if (member.forceMuted) row.setAttribute('data-forced', '');
    else if (member.muted) row.setAttribute('data-muted', '');

    const status = document.createElement('span');
    status.className = 'status';
    renderStatus(status, member);
    row.append(status);

    // The same menu as the roster. Right-clicking somebody in the sidebar
    // is the natural thing to try, and an admin muting someone in a
    // channel they are not in is the main reason to want it.
    row.title = 'Right-click for volume and controls';
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPeerMenu(channel.id, member.mid, event);
    });

    /*
     * Drag somebody to another voice channel to move them.
     *
     * Admins only, because that is who the server lets move people -- the
     * same admin:move the right-click menu's "Move..." sends. Drawing it
     * for everybody would offer a drag that always ends in "not allowed".
     */
    if (isAdmin()) {
      row.draggable = true;
      row.title = 'Drag to another voice channel to move, or right-click for controls';
      row.addEventListener('dragstart', (event) => {
        event.stopPropagation();
        dragging = { kind: 'member', userId: member.userId, from: channel.id };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', `member:${member.userId}`);
        row.setAttribute('data-dragging', '');
      });
      row.addEventListener('dragend', () => {
        dragging = null;
        row.removeAttribute('data-dragging');
        clearDropMarks();
      });
    }
    return row;
  }));

  return [li, list];
}

/** What is being dragged right now, or null. */
let dragging = null;

/**
 * Make a node a place a dragged PERSON can be dropped, meaning "move them
 * into this voice channel". `mark` is what lights up while hovering.
 */
function acceptMemberDrop(node, channel, mark) {
  node.addEventListener('dragover', (event) => {
    if (dragging?.kind !== 'member' || dragging.from === channel.id) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    mark.setAttribute('data-drop-into', '');
  });
  node.addEventListener('drop', (event) => {
    if (dragging?.kind !== 'member') return;
    event.preventDefault();
    event.stopPropagation();
    const { userId, from } = dragging;
    dragging = null;
    clearDropMarks();
    if (from !== channel.id) moveMember(userId, channel.id);
  });
}

/** The same request as the peer menu's "Move...": the server does the rest. */
function moveMember(userId, toChannelId) {
  harmony.realtime
    .request('admin:move', { userId, toChannelId })
    .catch((err) => showChannelsError(err.message));
}

function clearDropMarks() {
  for (const node of el.channelItems.querySelectorAll('[data-drop-before], [data-drop-into]')) {
    node.removeAttribute('data-drop-before');
    node.removeAttribute('data-drop-into');
  }
}

/** A group heading: a fold, a name, and somewhere to drop things. */
function groupNode(group) {
  const li = document.createElement('li');
  li.className = 'channel-group';
  li.dataset.groupId = String(group.id);
  const collapsed = state.channels.collapsed.has(group.id);
  li.toggleAttribute('data-collapsed', collapsed);

  const fold = document.createElement('span');
  fold.className = 'group-fold';
  fold.textContent = collapsed ? '\u25B8' : '\u25BE';

  const name = document.createElement('span');
  name.className = 'group-name';
  name.textContent = group.name;

  li.append(fold, name);

  // A folded group hides its channels and their counts with them, so the
  // heading carries their total until it is opened.
  if (collapsed) {
    const total = state.channels.list
      .filter((c) => (c.groupId ?? null) === group.id)
      .reduce((sum, c) => sum + (state.mentioned.get(c.id) ?? 0), 0);
    if (total) li.dataset.mention = total > 99 ? '99+' : String(total);
  }

  li.addEventListener('click', () => {
    if (collapsed) state.channels.collapsed.delete(group.id);
    else state.channels.collapsed.add(group.id);
    renderChannels();
  });

  if (isAdmin()) {
    li.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openRowMenu(group.name, [
        {
          label: 'Rename this group',
          title: 'Change what the heading says',
          run: async () => {
            const answer = await ask({
              title: `Rename "${group.name}"`,
              okLabel: 'Save',
              fields: [{ name: 'name', label: 'Name', value: group.name, required: true }],
            });
            if (!answer?.name) return;
            try {
              await harmony.api.renameGroup(state.server, group.id, answer.name);
            } catch (err) {
              showChannelsError(err.message);
            }
          },
        },
        {
          label: 'Delete this group',
          title: 'The channels in it stay',
          danger: true,
          run: async () => {
            if (!await askConfirm(`Delete the group "${group.name}"?`, {
              // Worth saying plainly: every other delete in this app takes
              // its contents with it, and this one deliberately does not.
              text: 'The channels in it stay, and move back to the top of the list.',
              okLabel: 'Delete the group',
            })) return;
            try {
              await harmony.api.deleteGroup(state.server, group.id);
            } catch (err) {
              showChannelsError(err.message);
            }
          },
        },
      ], event);
    });

    li.draggable = true;
    li.addEventListener('dragstart', (event) => {
      dragging = { kind: 'group', id: group.id };
      event.dataTransfer.effectAllowed = 'move';
      // Firefox will not start a drag without data on the transfer.
      event.dataTransfer.setData('text/plain', `group:${group.id}`);
      li.setAttribute('data-dragging', '');
    });
    li.addEventListener('dragend', () => {
      dragging = null;
      li.removeAttribute('data-dragging');
      clearDropMarks();
    });

    /*
     * A heading is two different drop targets, and which one it is depends
     * on what is being dragged.
     *
     * A channel dropped on it goes INTO the group, at the end -- the only
     * way to reach an empty one or to add to a collapsed one. A group
     * dropped on it lands ABOVE it, which is how every other reorder in
     * this sidebar works. Two marks, so the difference is visible before
     * the mouse is released rather than after.
     */
    li.addEventListener('dragover', (event) => {
      if (dragging?.kind === 'channel') {
        event.preventDefault();
        clearDropMarks();
        li.setAttribute('data-drop-into', '');
        return;
      }
      if (dragging?.kind === 'group' && dragging.id !== group.id) {
        event.preventDefault();
        clearDropMarks();
        li.setAttribute('data-drop-before', '');
      }
    });
    li.addEventListener('drop', (event) => {
      if (dragging?.kind === 'channel') {
        event.preventDefault();
        event.stopPropagation();
        const id = dragging.id;
        dragging = null;
        clearDropMarks();
        moveChannel(id, { groupId: group.id });
        return;
      }
      if (dragging?.kind === 'group' && dragging.id !== group.id) {
        event.preventDefault();
        event.stopPropagation();
        const id = dragging.id;
        dragging = null;
        clearDropMarks();
        moveGroup(id, group.id);
      }
    });
  }

  return li;
}

// ---------------------------------------------------------------------------
// Right-clicking somebody in the member list
// ---------------------------------------------------------------------------

function closeMemberMenu() {
  el.memberMenu.hidden = true;
}

/**
 * The account menu.
 *
 * Deliberately NOT the peer menu. That one is about a voice connection --
 * volume, a local mute, a force-mute, moving somebody between channels --
 * and none of it means anything for a person who is not in a call, which
 * is most of this list most of the time. Everything here is about the
 * account, and all of it is permanent.
 */
function openMemberMenu(user, event) {
  closePeerMenu();

  const me = state.auth.user?.id;
  const theirRole = user.role ?? 'member';

  // The same asymmetry the server enforces: an admin may promote a member,
  // only the owner may demote one. See POST /api/accounts/:id/role.
  const canPromote = isAdmin() && theirRole === 'member';
  const canDemote = isOwner() && theirRole === 'admin';
  // Owner only, and never the owner. Granting admin is reversible and a
  // force-mute lasts until it is lifted; this is neither.
  const canRemove = isOwner() && theirRole !== 'owner' && user.id !== me;

  if (!canPromote && !canDemote && !canRemove) return;

  // The children, not the element: replaceWith would drop the node the
  // handle points at and the next open would write into a detached one.
  el.memberMenuAvatar.replaceChildren(
    ...avatarEl(faceOf(user.id, user.nickname)).childNodes,
  );
  el.memberMenuName.textContent = displayOf(user.id, user.nickname);

  const rows = [];
  const item = (label, title, run, danger = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ghost menu-item${danger ? ' danger' : ''}`;
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', run);
    return button;
  };

  if (canPromote || canDemote) {
    rows.push(item(
      canPromote ? 'Make admin' : 'Remove admin',
      canPromote
        ? 'They can manage channels, mute and move people'
        : 'Back to an ordinary member',
      async () => {
        closeMemberMenu();
        const next = canPromote ? 'admin' : 'member';
        if (!await askConfirm(
          canPromote
            ? `Make ${displayOf(user.id, user.nickname)} an admin?`
            : `Remove ${displayOf(user.id, user.nickname)}'s admin?`,
          {
            okLabel: canPromote ? 'Make admin' : 'Remove admin',
            text: canPromote
              ? 'They will be able to create and delete channels, force-mute and move '
                + 'anybody, and delete anybody\u0027s messages. Only you can take it back.'
              : 'They go back to being an ordinary member.',
          },
        )) return;
        try {
          await harmony.api.setRole(state.server, user.id, next);
        } catch (err) {
          showChannelsError(err.message);
        }
      },
    ));
  }

  if (canRemove) {
    if (rows.length) rows.push(document.createElement('hr'));
    rows.push(item(
      'Delete account',
      'Removes them and everything they have written',
      async () => {
        closeMemberMenu();
        const who = displayOf(user.id, user.nickname);
        /*
         * Two confirmations, and the second one makes them type the name.
         *
         * Everything else destructive in this app is one click and a yes,
         * because everything else is one channel or one message. This is a
         * person's entire history, there is no undo anywhere in the app,
         * and the rows in a member list are four pixels apart.
         */
        if (!await askConfirm(`Delete ${who}'s account?`, {
          okLabel: 'Continue',
          text: 'Their account and every message they have ever written are removed '
            + 'from the server. Pinned messages and attachments go with them. '
            + 'This cannot be undone.',
        })) return;

        const typed = await ask({
          title: `Type ${user.nickname} to confirm`,
          text: 'This is the last step.',
          okLabel: 'Delete the account',
          fields: [{ name: 'nickname', label: 'Nickname', required: true }],
        });
        if (typed?.nickname?.trim().toLowerCase() !== user.nickname) {
          if (typed) showChannelsError('That is not the right nickname. Nothing was deleted.');
          return;
        }

        try {
          const result = await harmony.api.deleteAccount(state.server, user.id);
          showChannelsError('');
          el.chatNote.textContent =
            `${who} removed, with ${result.messages} message${result.messages === 1 ? '' : 's'}.`;
          await refreshUsers();
        } catch (err) {
          showChannelsError(err.message);
        }
      },
      true,
    ));
  }

  el.memberMenuBody.replaceChildren(...rows);

  // Shown off-screen first, because a hidden element has no size and the
  // clamp below needs one. The same trick as the peer menu.
  el.memberMenu.style.left = '-9999px';
  el.memberMenu.style.top = '0px';
  el.memberMenu.hidden = false;
  const box = el.memberMenu.getBoundingClientRect();
  el.memberMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - box.width - 8))}px`;
  el.memberMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - box.height - 8))}px`;
}

// ---------------------------------------------------------------------------
// The server's own name and door
// ---------------------------------------------------------------------------

/** What the server last said about itself. */
const serverInfo = { name: 'Harmony', passwordRequired: false, restartRequired: false };

/**
 * Draw what the server says about itself.
 *
 * Called with nothing to re-decide the owner's button alone, which is what
 * a role change needs: being made owner has to make the control appear
 * without another round trip.
 */
function applyServerInfo(info) {
  if (info) Object.assign(serverInfo, info);
  el.serverName.textContent = serverInfo.name;
  // Shown only to the owner. Hidden rather than disabled: a control you
  // can see and cannot use is a question nobody else needs asked.
  el.serverSettings.hidden = !isOwner();
}

async function loadServerInfo() {
  try {
    const { server } = await harmony.api.serverInfo(state.server);
    applyServerInfo(server);
  } catch {
    // Not fatal: the brand falls back to what the markup says.
  }
}

function openServerDialog() {
  el.serverNameInput.value = serverInfo.name;
  el.serverPasswordInput.value = '';
  el.serverPasswordOff.checked = false;
  el.serverPasswordInput.disabled = false;
  el.serverPasswordNote.textContent = serverInfo.passwordRequired
    ? 'This server has a password. Leave this blank to keep the one it has.'
    : 'This server has no password. Type one here to start asking for it.';
  el.serverErrorLine.hidden = true;
  el.serverNote.hidden = true;
  el.serverDialog.showModal();
  el.serverNameInput.focus();
}

async function saveServerSettings() {
  const name = el.serverNameInput.value.trim();
  const off = el.serverPasswordOff.checked;
  const typed = el.serverPasswordInput.value;

  const body = { name };
  // An absent field and an empty string are different answers, and the
  // server treats them differently on purpose -- so an untouched box must
  // not be sent at all, or saving a rename would take the door off.
  if (off) body.password = '';
  else if (typed) body.password = typed;

  try {
    const { server } = await harmony.api.updateServer(state.server, body);
    applyServerInfo(server);

    /*
     * Tell this client the new key before anything else asks for it.
     *
     * The change takes effect on the very next request, including the
     * ones this client is about to make -- so without this the owner
     * locks themselves out the moment they press Save.
     */
    if (body.password !== undefined) {
      await harmony.api.setPassword(body.password);
      await harmony.settings.set({ password: body.password });
      state.settings = await harmony.settings.get();
    }

    el.serverDialog.close();
    el.chatNote.textContent = server.restartRequired
      ? 'Saved. The media relay keeps its old setting until the server is restarted.'
      : 'Saved.';
  } catch (err) {
    el.serverErrorLine.textContent = err.message;
    el.serverErrorLine.hidden = false;
  }
}

/**
 * Everybody with an account, online first.
 *
 * Drawn from state.users -- the accounts list, which already arrives for
 * the avatars and display names -- crossed with the online set the server
 * pushes. Nothing new is fetched, and nothing is inferred from voice
 * presence: somebody who leaves a voice channel is still here.
 */
function renderMembers() {
  if (el.memberList.hidden) return;

  const everybody = [...state.users.values()];
  const online = everybody
    .filter((u) => state.channels.online.has(u.id))
    .sort((a, b) => displayOf(a.id, a.nickname).localeCompare(displayOf(b.id, b.nickname)));
  const offline = everybody
    .filter((u) => !state.channels.online.has(u.id))
    .sort((a, b) => displayOf(a.id, a.nickname).localeCompare(displayOf(b.id, b.nickname)));

  el.memberCount.textContent = `${online.length} of ${everybody.length}`;

  const row = (user, off) => {
    const li = document.createElement('li');
    li.className = 'member-row';
    li.dataset.userId = String(user.id);
    if (off) li.setAttribute('data-off', '');

    li.append(avatarEl(user, 'tiny'));

    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = displayOf(user.id, user.nickname);
    li.append(name);

    if (user.role === 'owner' || user.role === 'admin') {
      const tag = document.createElement('span');
      tag.className = 'role-tag';
      tag.textContent = user.role;
      li.append(tag);
    }

    // The user object is read from state at click time rather than
    // captured here, for the same reason the roster rows do it: these rows
    // are rebuilt on every presence push, and a role captured at draw time
    // is one promotion out of date.
    li.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openMemberMenu(state.users.get(user.id) ?? user, event);
    });
    // Promised only to the people for whom the menu has anything on it.
    if (isAdmin()) li.title = 'Right-click for admin controls';
    return li;
  };

  const head = (text) => {
    const li = document.createElement('li');
    li.className = 'member-head';
    li.textContent = text;
    return li;
  };

  const nodes = [];
  // The headings are drawn even for an empty half, so the list does not
  // silently become "just the people who are here" on a quiet server.
  nodes.push(head(`Online \u2014 ${online.length}`));
  nodes.push(...online.map((u) => row(u, false)));
  if (offline.length) {
    nodes.push(head(`Offline \u2014 ${offline.length}`));
    nodes.push(...offline.map((u) => row(u, true)));
  }
  el.memberItems.replaceChildren(...nodes);
}

function renderChannels() {
  const byGroup = new Map([[null, []]]);
  for (const group of state.channels.groups) byGroup.set(group.id, []);
  for (const channel of state.channels.list) {
    const key = channel.groupId ?? null;
    (byGroup.get(key) ?? byGroup.get(null)).push(channel);
  }

  const nodes = [];
  for (const channel of byGroup.get(null)) nodes.push(...channelNodes(channel));
  for (const group of state.channels.groups) {
    nodes.push(groupNode(group));
    if (state.channels.collapsed.has(group.id)) continue;
    for (const channel of byGroup.get(group.id) ?? []) nodes.push(...channelNodes(channel));
  }

  el.channelItems.replaceChildren(...nodes);
}

async function onChannelClick(channel) {
  if (channel.kind !== 'voice') return openTextChannel(channel);
  // Clicking the channel you are already in is how you get back to the
  // streams after reading a text channel. It used to do nothing at all,
  // which left the chat covering the thing you were trying to watch with no
  // obvious way to put it away.
  if (channel.id === state.voice.channelId) {
    closeChat();
    return undefined;
  }
  return joinVoice(channel);
}

/**
 * Decide what the right-hand column is showing, and whether it exists.
 *
 * ONE function, called from everywhere that could change the answer, rather
 * than each caller toggling the two or three `hidden` flags it happens to
 * know about. The previous arrangement had joinVoice, closeChat,
 * openTextChannel and renderChannelVideo each setting a subset, which is why
 * opening a text channel during a screen share showed both.
 *
 * The stage holds the chat OR the mosaic, never both: they are two things
 * you look at, and the window is not big enough to look at two things.
 */
function applyStage() {
  const chatting = Boolean(state.chat.channelId);
  const tiles = el.channelVideo.childElementCount > 0;

  el.chatActive.hidden = !chatting;
  el.channelVideo.hidden = chatting || !tiles;

  const stage = chatting || tiles;
  el.channelStage.hidden = !stage;

  // Whether the middle column exists at all comes off these -- see the
  // comment on .channels-layout.
  el.channelsLayout.toggleAttribute('data-stage', stage);
  el.channelsLayout.toggleAttribute('data-voice', !el.voiceActive.hidden);

  // The panel lives in the sidebar now, which is on screen whether or not
  // you are in a call -- so it has to hide itself. It did not need to when
  // it sat inside #voice-active.
  el.voicePanel.hidden = el.voiceActive.hidden;
}

async function joinVoice(channel, password) {
  if (state.channels.joining) return;
  state.channels.joining = true;
  showChannelsError('');

  try {
    if (state.voice.channelId) await leaveVoice({ silent: true });

    const reply = await harmony.realtime.request('voice:join', {
      channelId: channel.id,
      ...(password ? { password } : {}),
    });

    if (reply.type !== 'voice:joined') {
      if (reply.error === 'password_required' || reply.error === 'bad_password') {
        state.channels.joining = false;
        const answer = await ask({
          title: `${channel.name} needs a password`,
          text: reply.error === 'bad_password' ? 'That one was not right.' : '',
          okLabel: 'Join',
          fields: [{ name: 'password', label: 'Password', type: 'password', required: true }],
        });
        if (answer?.password) return joinVoice(channel, answer.password);
        return;
      }
      if (reply.error === 'channel_full') {
        return showChannelsError(`${channel.name} is full (${reply.cap} people).`);
      }
      return showChannelsError(`Could not join: ${reply.error}`);
    }

    state.voice.configure({
      channelId: channel.id,
      mid: reply.mid,
      token: reply.token,
      whepBase: reply.whepBase,
      // The WHIP URLs for this membership's own camera and screen paths. The
      // client never builds them: they are minted with the slot baked in, and
      // the auth hook refuses a publish whose slot does not match.
      publish: reply.publish,
      iceServers: state.session?.iceServers ?? state.mosaic?.iceServers ?? [],
    });

    // Joining a voice channel puts the streams back on the stage. Clicking a
    // voice channel is the only way back from a text channel, so leaving the
    // chat up here would make the stage a one-way door again.
    closeChat();

    el.voiceName.textContent = channel.name;
    el.voiceIdle.hidden = true;
    el.voiceActive.hidden = false;
    applyVoiceConnection(true);
    // A new channel is a new room: without this, arriving somewhere with
    // five people in it plays five join sounds at once.
    resetCues();
    voiceCue('connect');
    applyStage();

    await state.voice.startMic(
      reply.publish.voice,
      // The voice preference, not the capture-card one. See settings.js.
      deviceForVoiceInput(),
    );
    // Tell the server the path is live, so other members know to subscribe.
    await harmony.realtime.request('voice:publishing', {
      channelId: channel.id, kind: 'v', on: true,
    });

    /*
     * Carry mute and deafen into the new channel.
     *
     * Presence is per membership and a fresh one starts unmuted, so
     * switching channels while muted left everybody in the new one seeing
     * you as live -- waiting for an answer from somebody whose microphone
     * was off. The local state was right the whole time, which is why it
     * was invisible from this side.
     */
    if (state.voice.muted || state.voice.deafened) {
      await harmony.realtime.request('voice:mute', {
        channelId: channel.id,
        muted: state.voice.muted,
        deafened: state.voice.deafened,
      }).catch(() => { /* the roster is cosmetic; the mic is already off */ });
    }

    applyVoiceButtons();
    renderVoiceRoster(reply.roster ?? []);
    renderChannelVideo();
    renderChannels();
    // Labels are only populated once a getUserMedia has been granted, which
    // startMic above has just done -- so this is the first moment the pickers
    // can show device names rather than blanks.
    await refreshVoiceDevices({ apply: false });
    await applyVoiceOutput(el.voiceOutput.value);

    // The speaking ring. 100 ms is the usual figure for this: slower and a
    // short word never lights it, faster and it costs more than it is worth
    // for something nobody can perceive.
    // Before the ring and the ping: the chain is built inside startMic, so
    // this is the first moment there is anything to apply them to.
    applyMicTuning();

    addTimer(setInterval(renderSpeaking, SPEAKING_POLL_MS), 'voice');

    /*
     * The ping is NOT on a per-join timer any more.
     *
     * It was, in the 'voice' group, which is cleared on leave and rebuilt
     * on join -- and switching channels does both in one go, which left it
     * stuck showing the previous channel's number. Rather than work out
     * which of the two transitions dropped it, the timer now lives for the
     * life of the app and asks whether there is a call rather than being
     * told; see startPingLoop. A transition cannot lose a timer that is
     * never torn down.
     *
     * Reset here so the last channel's figure is not shown as this one's
     * for the first few seconds.
     */
    clearPing();
    renderPing();

    // Renew the media tokens at half their life, so a missed tick still
    // leaves a wide margin and neither side has to trust the other's clock.
    const life = Number(reply.expiresInMs) || 10 * 60 * 1000;
    addTimer(
      setInterval(refreshVoiceTokens, Math.max(5_000, Math.floor(life / 2))),
      'voice',
    );

    // Reconcile subscriptions on a slow timer as well as on roster pushes.
    //
    // A publisher's path is not readable for a moment after its WHIP returns
    // 201 -- MediaMTX only marks it online once RTP arrives -- so an early
    // subscribe gets a 404. In a settled channel no further roster push ever
    // comes, so without this that peer is inaudible until somebody happens to
    // join or mute. Measured on a real 16-member channel.
    addTimer(setInterval(() => {
      if (!state.voice.channelId) return;

      // First drop anything that has quietly stopped delivering, so the
      // subscribe pass below sees it as missing and rebuilds it. Without
      // this, a peer whose path was rebuilt stays silent for ever.
      state.voice.reapStalled()
        .then((dead) => {
          if (dead.length) return state.voice.syncPeers();
          return undefined;
        })
        .catch(() => { /* the next tick tries again */ });

      if (state.voice.hasMissingPeers) {
        state.voice.syncPeers()
          .then((result) => {
            // A refused subscription is not the warm-up window: retrying it
            // with the same token would fail forever. Get a new one first.
            const refused = result?.missed?.some(
              (m) => m.reason === 'unauthorized' || m.reason === 'media_error',
            );
            if (refused) return refreshVoiceTokens();
            return undefined;
          })
          .catch(() => { /* retried on the next tick */ });
      }
      // Video has exactly the same warm-up window, and a camera turned on in
      // a settled channel produces one roster push -- which arrives before
      // the path is readable.
      if (state.voice.hasMissingVideo) {
        state.voice.syncVideo()
          .then((r) => { if (r.changed) renderChannelVideo(); })
          .catch(() => { /* retried on the next tick */ });
      }
    }, VOICE_RECONCILE_MS), 'voice');
  } catch (err) {
    showChannelsError(err.message);
    await leaveVoice({ silent: true }).catch(() => {});
  } finally {
    state.channels.joining = false;
  }
}

/**
 * Re-issue the channel's media tokens before they expire.
 *
 * A channel token lasts ten minutes by default and MediaMTX only consults
 * the auth hook when a session is SET UP. So an expired token never
 * interrupts anything already running -- it stops anything NEW. Ten minutes
 * into a call that means: you cannot hear anybody who joins or unmutes from
 * then on, you cannot start your camera, and a screen share fails with a
 * 401 that the client used to report as "the username reservation may have
 * expired".
 *
 * All three were the same missing timer. The server has always had the
 * handler and the client has always had retoken(); nothing called either.
 *
 * @returns {Promise<boolean>} whether the tokens are now fresh
 */
async function refreshVoiceTokens() {
  const channelId = state.voice.channelId;
  if (!channelId) return false;
  try {
    const reply = await harmony.realtime.request('voice:refresh', { channelId });
    if (reply.type !== 'voice:tokens') return false;
    state.voice.retoken(reply);
    return true;
  } catch {
    // The socket is down, which the reconnect path already handles by
    // rejoining -- and a rejoin issues fresh tokens anyway.
    return false;
  }
}

async function leaveVoice({ silent = false } = {}) {
  clearTimers('voice');
  const channelId = state.voice.channelId;
  // A screen share published into this channel has nowhere to go once we are
  // out of it, and its path stops being authorised the moment the slot is
  // released.
  if (state.share.target?.channelId === channelId) await teardown();
  await state.voice.leave();
  if (channelId && !silent) {
    // Not on a silent leave: that is the first half of moving to another
    // channel, whose own "connect" is the sound that move should make.
    voiceCue('disconnect');
    await harmony.realtime.request('voice:leave', { channelId }).catch(() => {});
  }
  state.channels.roster = [];
  resetCues();
  closePeerMenu();
  closeSoundpad();
  el.voiceActive.hidden = true;
  el.voiceIdle.hidden = state.chat.channelId !== null;
  renderChannelVideo();
  applyVoiceButtons();
  renderChannels();
}

/**
 * Name a button once, in both the places a button is named.
 *
 * The text is invisible -- font-size: 0 -- but it is still what the
 * accessibility tree announces and what voice-ui.mjs reads to know whether
 * the camera is on. The tooltip is the only one of the two a person sees.
 * Writing them apart is how a button ends up offering to start a camera
 * that is already running, so they are written together.
 */
function setButtonLabel(button, label) {
  button.textContent = label;
  button.title = label;
}

function applyVoiceButtons() {
  setButtonLabel(el.voiceMute, state.voice.muted ? 'Unmute mic' : 'Mute mic');
  el.voiceMute.toggleAttribute('data-on', state.voice.muted);
  setButtonLabel(el.voiceDeafen, state.voice.deafened ? 'Undeafen' : 'Deafen');
  el.voiceDeafen.toggleAttribute('data-on', state.voice.deafened);
  setButtonLabel(el.voiceCam, state.voice.camLive ? 'Stop camera' : 'Start camera');
  el.voiceCam.toggleAttribute('data-on', state.voice.camLive);

  // Both live on the strip at the bottom now, and both mean something only
  // while there is a microphone to mute. Outside a call they would set a
  // flag with nothing to apply it to and send a mute for a null channel.
  const live = Boolean(state.voice.channelId);
  el.voiceMute.disabled = !live;
  el.voiceDeafen.disabled = !live;

  const sharing = state.share.target?.channelId === state.voice.channelId
    && Boolean(state.voice.channelId);
  setButtonLabel(el.voiceScreen, sharing ? 'Change source or stop sharing' : 'Share screen here');
  el.voiceScreen.toggleAttribute('data-on', sharing);

  el.voiceSoundboard.toggleAttribute('data-on', !el.soundpad.hidden);
  el.voiceSoundboard.disabled = !state.voice.channelId;

  /*
   * What the strip at the bottom says about you.
   *
   * Deafened first: it is the one that surprises people, because it implies
   * muted as well and somebody reading "Muted" would not know they also
   * cannot hear anything.
   */
  const inVoice = Boolean(state.voice.channelId);
  el.selfStatus.textContent = !inVoice ? 'Online'
    : state.voice.deafened ? 'Deafened'
      : state.voice.muted ? 'Muted'
        : 'In voice';
  el.selfStatus.toggleAttribute('data-in-voice', inVoice);

  const channel = state.channels.list.find((c) => c.id === state.voice.channelId);
  el.voiceWhere.textContent = channel ? channel.name : '';

}

/*
 * The round trip to the relay, on the signal icon.
 *
 * Polled slowly. currentRoundTripTime is a smoothed value that ICE updates
 * on its own consent checks every couple of seconds, so reading it faster
 * returns the same number and reading it at all costs a getStats() walk.
 *
 * The thresholds are about what a conversation feels like rather than about
 * what a network graph looks like: under 60 ms nobody notices, past 150 ms
 * people start talking over each other because the gap between "they
 * stopped" and "I can hear that they stopped" is long enough to step into.
 */
const PING_POLL_MS = 4000;
const PING_OK_MS = 60;
const PING_BAD_MS = 150;

function clearPing() {
  el.voiceSignal.dataset.ping = 'Measuring\u2026';
  el.voiceSignal.removeAttribute('data-quality');
}

async function renderPing() {
  if (!state.voice.channelId) {
    clearPing();
    return;
  }
  const ms = await state.voice.rtt();
  // The channel can have changed while getStats was in flight; writing the
  // old connection's number onto the new one would be worse than nothing.
  if (!state.voice.channelId) return;
  if (ms === null) {
    el.voiceSignal.dataset.ping = 'Measuring\u2026';
    el.voiceSignal.dataset.quality = 'ok';
    el.voiceSignal.setAttribute('aria-label', 'Connection quality: measuring');
    return;
  }
  el.voiceSignal.dataset.ping = `${ms} ms to the relay`;
  el.voiceSignal.dataset.quality = ms <= PING_OK_MS ? 'good' : ms <= PING_BAD_MS ? 'ok' : 'bad';
  el.voiceSignal.setAttribute('aria-label', `Connection quality: ${ms} milliseconds`);
}

/** Connected, or trying to be. Driven by the socket, never by guesswork. */
function applyVoiceConnection(up) {
  el.voicePanel.dataset.state = up ? 'connected' : 'connecting';
  el.voiceState.textContent = up ? 'Voice connected' : 'Reconnecting\u2026';
  if (!up) {
    el.voiceSignal.dataset.ping = 'Reconnecting\u2026';
    el.voiceSignal.removeAttribute('data-quality');
  }
}

/**
 * What somebody's state is, as small glyphs.
 *
 * One helper for the sidebar and the voice pane, so the two can never
 * disagree about what a person is doing -- which they would within a week if
 * each built its own.
 *
 * A MICROPHONE and a PAIR OF HEADPHONES, not two shades of the same symbol.
 * They are different facts and the difference matters before you speak:
 * muted means nobody can hear you, deafened means you cannot hear anybody.
 * Both wear a slash drawn in CSS, so the state reads without relying on
 * colour alone.
 *
 * Muted and admin-muted stay the same glyph in different colours, because
 * those two DO mean the same thing to a listener -- this person is not
 * audible -- and the difference is only who decided, which the colour and
 * the tooltip carry.
 */
const STATUS = [
  { key: 'forced', glyph: '\u{1F3A4}', title: 'muted by an admin' },
  { key: 'muted', glyph: '\u{1F3A4}', title: 'muted themselves' },
  { key: 'deaf', glyph: '\u{1F3A7}', title: 'deafened -- cannot hear anybody' },
  { key: 'cam', glyph: '\u{1F4F7}', title: 'camera on' },
  { key: 'screen', glyph: '\u{1F5A5}', title: 'sharing a screen' },
];

function statusKeys(member) {
  const keys = [];
  if (member.forceMuted) keys.push('forced');
  else if (member.muted) keys.push('muted');
  // Alongside the mic, not instead of it. Deafening implies muting, and
  // showing only the headphones would hide that they are also silent.
  if (member.deafened) keys.push('deaf');
  if (member.publishing?.includes('c')) keys.push('cam');
  if (member.publishing?.includes('s')) keys.push('screen');
  return keys;
}

/** Fill a container with the glyphs for this member, reusing it in place. */
function renderStatus(container, member) {
  const keys = statusKeys(member);
  container.replaceChildren(...keys.map((key) => {
    const { glyph, title } = STATUS.find((x) => x.key === key);
    const span = document.createElement('span');
    span.className = 'status-dot';
    span.dataset.kind = key;
    span.textContent = glyph;
    span.title = title;
    return span;
  }));
  container.hidden = keys.length === 0;
}

/**
 * Build one roster row.
 *
 * Split from the update below because rows are REUSED: a volume slider
 * rebuilt underneath a finger stops moving, and a roster push arrives every
 * time anybody mutes. Only the parts that change are rewritten.
 */
function voiceRow(member) {
  const li = document.createElement('li');
  li.dataset.mid = String(member.mid);

  li.append(avatarEl(faceOf(member.userId, member.nickname)));

  const name = document.createElement('span');
  name.className = 'member-name';
  li.append(name);

  const status = document.createElement('span');
  status.className = 'status';
  li.append(status);

  /*
   * Everything you can do TO somebody is behind a right-click.
   *
   * It used to be on the row: a local mute, a volume slider, a percentage, a
   * force-mute button and a move dropdown, per person. Five controls and a
   * name in a column that is now a third of the window is not a layout, and
   * the slider in particular ended up about two centimetres wide.
   *
   * Nothing here captures the member object. Rows are reused across roster
   * pushes and slots are reused across joins, so the menu reads whoever the
   * row currently belongs to at the moment it is opened -- see the comment
   * on openPeerMenu.
   */
  li.title = 'Right-click for volume and controls';
  li.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openPeerMenu(state.voice.channelId, Number(li.dataset.mid), event);
  });

  return li;
}

/**
 * Show a volume, and show when it is doing something unusual.
 *
 * Past 100% the signal is being amplified rather than attenuated, which can
 * distort and is the first thing to suspect when somebody sounds bad. It is
 * worth making impossible to miss rather than leaving it to be read off a
 * slider position.
 *
 * Every volume slider in the app goes through here, so they all read the same:
 * the exact percentage beside the slider, the track filled up to the thumb, a
 * tick where 100% is, and amber -- thumb, fill and number -- once past it.
 *
 * The amber used to be `accent-color`, which did nothing at all: the
 * sliders are drawn by hand (`appearance: none`), and accent-color only
 * reaches the native one. The fill and the tick are painted from two custom
 * properties set here, because a range input has no CSS-visible value.
 */
function showVolume(slider, label, percent, muted = false) {
  slider.value = String(percent);
  const max = Number(slider.max) || 100;
  const boosted = percent > 100 && !muted;
  slider.style.setProperty('--fill', `${(percent / max) * 100}%`);
  slider.style.setProperty('--mark', `${(100 / max) * 100}%`);
  slider.toggleAttribute('data-boosted', boosted);
  if (!label) return;
  label.toggleAttribute('data-boosted', boosted);
  label.textContent = muted ? 'muted' : `${percent}%`;
  label.title = boosted
    ? 'Louder than the original. Amplified audio can distort.'
    : '';
}

/**
 * The menu you get by right-clicking somebody.
 *
 * Takes a channel and a SLOT rather than a member object, and looks the
 * person up when it opens. The roster arrives again on every mute, join and
 * leave, and a slot is handed to the next person to join once its previous
 * holder leaves, so a captured object can end up describing somebody else
 * entirely -- which is exactly how a volume set on one person used to land
 * on another.
 */
let peerMenuOpen = null;

function closePeerMenu() {
  el.peerMenu.hidden = true;
  peerMenuOpen = null;
}

function openPeerMenu(channelId, mid, event) {
  const roster = channelId === state.voice.channelId
    ? state.channels.roster
    : (state.channels.rosters[channelId] ?? []);
  const member = roster.find((m) => m.mid === mid);
  if (!member) return;
  // Both halves, because slots are per channel: mid 1 in the channel you are
  // in is you, and mid 1 in the one next door is somebody else entirely.
  if (channelId === state.voice.channelId && mid === state.voice.mid) return;

  peerMenuOpen = { channelId, mid };
  const userId = member.userId;

  el.peerMenuAvatar.replaceChildren(
    ...avatarEl(faceOf(userId, member.nickname)).childNodes,
  );
  el.peerMenuName.textContent = displayOf(userId, member.nickname);

  const rows = [];

  // Local audio, and only where it can do anything: turning somebody in
  // another channel down is a control that visibly does nothing.
  if (channelId === state.voice.channelId) {
    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'ghost menu-item peer-mute';

    const row = document.createElement('div');
    row.className = 'peer-menu-row peer-audio';
    const volume = document.createElement('input');
    volume.type = 'range';
    volume.className = 'peer-volume';
    volume.min = '0';
    volume.max = String(asPercent(MAX_GAIN));
    volume.step = '5';
    volume.title = 'How loudly you hear this person';
    const label = document.createElement('span');
    label.className = 'peer-volume-label';
    row.append(volume, label);

    const paint = () => {
      const muted = state.voice.peerMuted(userId);
      showVolume(volume, label, asPercent(state.voice.peerGain(userId)), muted);
      mute.textContent = muted ? 'Unmute for me' : 'Mute for me';
      mute.toggleAttribute('data-on', muted);
    };

    mute.addEventListener('click', () => {
      const now = state.voice.setPeerMuted(userId, !state.voice.peerMuted(userId));
      // Un-muting somebody who is still at zero would be a no-op that looks
      // like a broken button.
      if (!now && state.voice.peerGain(userId) === 0) state.voice.setPeerGain(userId, 1);
      paint();
      renderVoiceRoster(state.channels.roster);
    });
    volume.addEventListener('input', () => {
      const percent = Number(volume.value);
      state.voice.setPeerGain(userId, percent / 100);
      showVolume(volume, label, percent, false);
    });

    paint();
    rows.push(mute, row);
  }

  if (isAdmin()) {
    if (rows.length) rows.push(document.createElement('hr'));

    const force = document.createElement('button');
    force.type = 'button';
    force.className = 'ghost menu-item force-mute';
    force.textContent = member.forceMuted ? 'Unmute' : 'Force mute';
    force.addEventListener('click', () => {
      // Read the CURRENT roster rather than the member captured above: the
      // menu can sit open while somebody else mutes them.
      const live = (channelId === state.voice.channelId
        ? state.channels.roster
        : (state.channels.rosters[channelId] ?? [])).find((m) => m.mid === mid);
      harmony.realtime.request('admin:force-mute', {
        channelId, mid, muted: !live?.forceMuted,
      }).catch((err) => showChannelsError(err.message));
      closePeerMenu();
    });

    /**
     * Move somebody into another channel.
     *
     * A select rather than a button per channel: the server already accepts
     * any voice channel as a destination, and the list is as long as the
     * server's. Disconnecting is the same request with a null destination,
     * which is why it sits in the same control.
     */
    const move = document.createElement('select');
    move.className = 'move-select';
    move.title = 'Move this person';
    move.append(new Option('Move\u2026', ''));
    for (const channel of state.channels.list) {
      if (channel.kind !== 'voice' || channel.id === channelId) continue;
      move.append(new Option(channel.name, String(channel.id)));
    }
    move.append(new Option('Disconnect', 'none'));
    move.addEventListener('change', () => {
      const choice = move.value;
      move.value = '';
      if (!choice) return;
      harmony.realtime.request('admin:move', {
        userId,
        toChannelId: choice === 'none' ? null : Number(choice),
      }).catch((err) => showChannelsError(err.message));
      closePeerMenu();
    });

    rows.push(force, move);
  }

  /*
   * Handing out admin, and taking it back.
   *
   * An admin may promote a member; only the owner may demote anybody or
   * appoint another owner. The server enforces exactly this -- see the
   * comment on POST /api/accounts/:id/role for why the two directions are
   * not symmetric -- and what follows only decides which button to draw.
   *
   * The role comes from the accounts list rather than from the roster,
   * because the roster describes a membership of this channel and a role
   * is a property of the person.
   */
  const them = knownUser(userId);
  const theirRole = them?.role ?? 'member';
  const canPromote = isAdmin() && theirRole === 'member';
  const canDemote = isOwner() && theirRole === 'admin';

  if (canPromote || canDemote) {
    if (rows.length) rows.push(document.createElement('hr'));
    const role = document.createElement('button');
    role.type = 'button';
    role.className = 'ghost menu-item set-role';
    role.textContent = canPromote ? 'Make admin' : 'Remove admin';
    role.title = canPromote
      ? 'They can manage channels, mute and move people'
      : 'Back to an ordinary member';
    role.addEventListener('click', async () => {
      closePeerMenu();
      const next = canPromote ? 'admin' : 'member';
      if (!await askConfirm(
        canPromote
          ? `Make ${displayOf(userId, member.nickname)} an admin?`
          : `Remove ${displayOf(userId, member.nickname)}'s admin?`,
        {
          okLabel: canPromote ? 'Make admin' : 'Remove admin',
          text: canPromote
            ? 'They will be able to create and delete channels, force-mute and move anybody, '
              + 'and delete anybody\u0027s messages. Only you can take it back.'
            : 'They go back to being an ordinary member.',
        },
      )) return;
      try {
        await harmony.api.setRole(state.server, userId, next);
      } catch (err) {
        showChannelsError(err.message);
      }
    });
    rows.push(role);
  }

  // Nothing on offer -- an ordinary member right-clicking somebody in a
  // channel they are not in. A menu with no entries is worse than none.
  if (rows.length === 0) {
    peerMenuOpen = null;
    return;
  }
  el.peerMenuBody.replaceChildren(...rows);

  // Shown before measuring, off-screen, because a hidden element has no size
  // and the whole point of the clamp below is to keep it on screen.
  el.peerMenu.style.left = '-9999px';
  el.peerMenu.style.top = '0px';
  el.peerMenu.hidden = false;
  const box = el.peerMenu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - box.width - 8);
  const y = Math.min(event.clientY, window.innerHeight - box.height - 8);
  el.peerMenu.style.left = `${Math.max(8, x)}px`;
  el.peerMenu.style.top = `${Math.max(8, y)}px`;
}

/*
 * The little noises.
 *
 * Driven by diffing the roster rather than by a server event, because the
 * roster is already the single source of truth for who is in the channel
 * and a parallel set of join/leave events would be a second one that could
 * disagree with it. Everything that changes presence -- joining, leaving,
 * being moved by an admin, a socket dying -- shows up here for free.
 *
 * `lastCueRoster` is null until the first roster for a channel has been
 * seen, so arriving in a room of six people plays nothing. Only CHANGES
 * from a state you have already been shown are worth a sound.
 */
let lastCueRoster = null;

function resetCues() {
  lastCueRoster = null;
}

/** A voice-channel cue, unless they are switched off. */
function voiceCue(name) {
  if (state.settings?.voiceSounds !== false) playCue(name);
}

function playRosterCues(roster) {
  const now = new Map(roster.map((m) => [m.userId, m]));
  if (state.settings?.voiceSounds === false) {
    lastCueRoster = now;
    return;
  }
  const me = state.auth.user?.id;

  if (lastCueRoster === null) {
    lastCueRoster = now;
    return;
  }

  for (const userId of now.keys()) {
    if (!lastCueRoster.has(userId)) playCue('join');
  }
  for (const userId of lastCueRoster.keys()) {
    if (!now.has(userId)) playCue('leave');
  }
  /*
   * Somebody else starting or stopping a stream. Not you: your own share
   * plays its cue from startBroadcast and stopBroadcast, the moment it
   * actually happens, rather than when the server's roster echoes it back.
   */
  for (const [userId, member] of now) {
    const before = lastCueRoster.get(userId);
    if (!before || userId === me) continue;
    const wasSharing = (before.publishing ?? []).includes('s');
    const isSharing = (member.publishing ?? []).includes('s');
    if (isSharing && !wasSharing) playCue('streamStart');
    if (wasSharing && !isSharing) playCue('streamStop');
  }

  lastCueRoster = now;
}

function renderVoiceRoster(roster) {
  playRosterCues(roster);
  state.channels.roster = roster;
  el.voiceCount.textContent = `${roster.length} ${roster.length === 1 ? 'person' : 'people'}`;

  // Rows are reused rather than rebuilt. A roster push arrives on every mute,
  // join and leave; rebuilding would drop a half-dragged volume slider and
  // close an open move menu every time somebody else did anything.
  const existing = new Map(
    [...el.voiceRoster.children].map((li) => [li.dataset.mid, li]),
  );

  el.voiceRoster.replaceChildren(...roster.map((member) => {
    const li = existing.get(String(member.mid)) ?? voiceRow(member);
    li.dataset.userId = String(member.userId);

    const picture = avatarEl(faceOf(member.userId, member.nickname));
    li.querySelector('.avatar').replaceChildren(...picture.childNodes);

    li.querySelector('.member-name').textContent =
      displayOf(member.userId, member.nickname)
      + (member.mid === state.voice.mid ? ' (you)' : '');

    // Who can throw you out is worth being able to see without opening a
    // menu on every person in turn.
    const role = knownUser(member.userId)?.role;
    let badge = li.querySelector('.role-tag');
    if (role === 'owner' || role === 'admin') {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'tag role-tag';
        li.querySelector('.member-name').after(badge);
      }
      badge.textContent = role;
    } else if (badge) {
      badge.remove();
    }
    renderStatus(li.querySelector('.status'), member);

    // Greys their picture: you can still see them talking, which is the
    // point, but it should not look like audio that is failing.
    li.toggleAttribute('data-local-muted', state.voice.peerMuted(member.userId));

    return li;
  }));

  // An open menu follows the person it was opened on. Leaving it showing a
  // force-mute for somebody who has left is how an admin mutes a stranger.
  if (peerMenuOpen && !roster.some((m) => m.mid === peerMenuOpen.mid)) closePeerMenu();
}

/**
 * Paint the speaking ring.
 *
 * Polled rather than pushed: whether somebody is talking changes several
 * times a second, and an event per change would be a storm for something
 * that is only ever a CSS class. Reading an AnalyserNode is cheap, and this
 * touches one attribute per person.
 */
function renderSpeaking() {
  if (!state.voice.channelId) return;
  const speaking = state.voice.speakingMids();

  for (const li of el.voiceRoster.children) {
    li.toggleAttribute('data-speaking', speaking.has(Number(li.dataset.mid)));
  }

  // The sidebar too: it is the list you look at when you are in another
  // channel, and "who is talking in there" is most of why you would look.
  const members = state.channels.rosters[state.voice.channelId] ?? [];
  const list = el.channelItems.querySelector(
    `.channel-members[data-for="${state.voice.channelId}"]`,
  );
  if (!list) return;
  [...list.children].forEach((row, i) => {
    const member = members[i];
    row.toggleAttribute('data-speaking', Boolean(member) && speaking.has(member.mid));
  });
}

// ---------------------------------------------------------------------------
// Voice devices
//
// Two choices, remembered, and both of them hot-pluggable.
//
// The rule throughout is that a saved device id is a PREFERENCE rather than a
// requirement. Unplugging a headset mid-call falls back to the system default
// and keeps the preference, so plugging it back in picks it up again without
// anybody opening a menu -- which is what people mean by "it should just
// work", and the opposite of what storing "whatever is selected right now"
// would do.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Colour palettes
//
// Client side only. The whole mechanism is one attribute on <html>: the
// stylesheet defines each palette as a block of custom properties under
// :root[data-theme='x'], so switching is a single attribute write and
// nothing re-renders.
//
// The names and the three preview bands are duplicated here rather than
// read back out of the stylesheet. getComputedStyle could fetch them, but
// only for the palette currently applied -- showing a swatch means painting
// colours that are NOT in effect, and there is no way to ask the cascade
// for those.
// ---------------------------------------------------------------------------

const THEMES = [
  { id: 'midnight', name: 'Midnight', bands: ['#0f1116', '#1f232c', '#5b8cff'] },
  { id: 'dark', name: 'Dark', bands: ['#1e1f22', '#313338', '#5865f2'] },
  { id: 'onyx', name: 'Onyx', bands: ['#000000', '#141418', '#7c6cff'] },
  { id: 'ocean', name: 'Ocean', bands: ['#0b141c', '#172836', '#38bdf8'] },
  { id: 'forest', name: 'Forest', bands: ['#0e1512', '#1c2a23', '#3fb984'] },
  { id: 'ember', name: 'Ember', bands: ['#17100e', '#2c1f1a', '#ff7a4d'] },
  { id: 'lavender', name: 'Lavender', bands: ['#14111d', '#252036', '#a78bfa'] },
  { id: 'daylight', name: 'Daylight', bands: ['#f2f3f5', '#ebedef', '#3a6df0'] },
];

const DEFAULT_THEME = 'midnight';

/*
 * The Custom palette.
 *
 * Four colours somebody picks, and everything else in the variable block
 * worked out from them. Asking for all seventeen would be asking people to
 * hand-tune a hover state; asking for four is asking what they want the app
 * to look like. The derived ones follow the same relationships the built-in
 * palettes were drawn with -- borders a step from the panel towards the
 * text, muted text partway back to the background.
 */
const CUSTOM_FIELDS = [
  { key: 'bg', label: 'Background', variable: '--bg' },
  { key: 'surface', label: 'Panels', variable: '--surface' },
  { key: 'text', label: 'Text', variable: '--text' },
  { key: 'accent', label: 'Accent', variable: '--accent' },
];

/** Every property a custom palette writes, so switching away can remove them all. */
const CUSTOM_VARIABLES = [
  '--bg', '--surface', '--surface-2', '--border', '--border-strong', '--text', '--muted',
  '--accent', '--accent-rgb', '--accent-hover', '--tint-rgb', '--video-bg',
  '--danger', '--danger-soft', '--danger-rgb', '--live', '--live-rgb', '--warn',
];

const hexToRgb = (hex) => {
  const n = Number.parseInt(String(hex).replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbToHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
/** a, moved t of the way towards b. */
const mixHex = (a, b, t) => {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex(x.map((v, i) => v + (y[i] - v) * t));
};
const isLight = (hex) => {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
};

/** The whole variable block, from the four colours somebody picked. */
function customPalette({ bg, surface, text, accent }) {
  const light = isLight(bg);
  const vars = {
    '--bg': bg,
    '--surface': surface,
    '--surface-2': mixHex(surface, text, 0.06),
    '--border': mixHex(surface, text, 0.13),
    '--border-strong': mixHex(surface, text, 0.24),
    '--text': text,
    '--muted': mixHex(text, bg, 0.4),
    '--accent': accent,
    '--accent-rgb': hexToRgb(accent).join(' '),
    '--accent-hover': mixHex(accent, light ? '#000000' : '#ffffff', 0.14),
    // The one that decides whether every hover lightens or darkens. See the
    // comment at the top of styles.css.
    '--tint-rgb': light ? '0 0 0' : '255 255 255',
    '--video-bg': mixHex(bg, '#000000', light ? 0.88 : 0.5),
  };
  // Status colours are not picked -- red has to stay red -- but they have to
  // read against the background, so a light one gets the light palette's.
  if (light) {
    Object.assign(vars, {
      '--danger': '#c4303a', '--danger-soft': '#c4303a', '--danger-rgb': '196 48 58',
      '--live': '#1a9550', '--live-rgb': '26 149 80', '--warn': '#9a6a00',
    });
  }
  return vars;
}

/** The four colours of whatever palette is on screen right now. */
function currentColours() {
  const style = getComputedStyle(document.documentElement);
  const read = (name) => {
    const value = style.getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
  };
  return Object.fromEntries(CUSTOM_FIELDS.map((f) => [f.key, read(f.variable)]));
}

/**
 * Put a palette on.
 *
 * Tolerant of a name it does not know -- a settings file written by a later
 * build, or edited by hand -- because the alternative is an app that opens
 * with no colours at all over a spelling mistake.
 *
 * Custom is the one palette that is not in the stylesheet: its colours are
 * written onto <html> as inline custom properties, which outrank every
 * :root[data-theme] block. Any other palette removes them again, or they
 * would go on outranking it.
 */
function applyTheme(id, custom = state.settings?.customTheme) {
  const root = document.documentElement;
  for (const name of CUSTOM_VARIABLES) root.style.removeProperty(name);

  if (id === 'custom' && custom) {
    root.dataset.theme = 'custom';
    for (const [name, value] of Object.entries(customPalette(custom))) {
      root.style.setProperty(name, value);
    }
    return 'custom';
  }
  const theme = THEMES.some((t) => t.id === id) ? id : DEFAULT_THEME;
  root.dataset.theme = theme;
  return theme;
}

/** The Custom swatch's bands, painted from its own colours. */
function customBands(colours) {
  return colours ? [colours.bg, colours.surface, colours.accent] : ['#444444', '#666666', '#888888'];
}

/** Save the custom colours, a moment after the last change. */
let customSaveTimer = null;
function saveCustomTheme(colours) {
  clearTimeout(customSaveTimer);
  customSaveTimer = setTimeout(async () => {
    await harmony.settings.set({ theme: 'custom', customTheme: colours });
    state.settings = await harmony.settings.get();
  }, 300);
}

/**
 * The four pickers, shown while Custom is the palette.
 *
 * Applied on every movement of a picker, not on close, so the app itself is
 * the preview -- the point of choosing your own colours is seeing them on
 * the thing they colour.
 */
function renderCustomEditor(current) {
  el.themeCustom.hidden = current !== 'custom';
  if (current !== 'custom') return;

  const colours = { ...state.settings.customTheme };
  el.themeCustom.replaceChildren(...CUSTOM_FIELDS.map((field) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'color';
    input.value = colours[field.key];
    input.addEventListener('input', () => {
      colours[field.key] = input.value;
      applyTheme('custom', colours);
      const swatch = el.themeGrid.querySelector('[data-theme="custom"] .theme-bands');
      customBands(colours).forEach((c, i) => {
        if (swatch?.children[i]) swatch.children[i].style.background = c;
      });
      saveCustomTheme({ ...colours });
    });
    const name = document.createElement('span');
    name.textContent = field.label;
    label.append(input, name);
    return label;
  }), (() => {
    // A way back from a palette that turned out unreadable, which a
    // colour picker makes easy to do by accident.
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'ghost small theme-custom-reset';
    reset.textContent = 'Start again from Midnight';
    reset.addEventListener('click', async () => {
      applyTheme(DEFAULT_THEME);
      const fresh = currentColours();
      state.settings.customTheme = fresh;
      applyTheme('custom', fresh);
      await harmony.settings.set({ theme: 'custom', customTheme: fresh });
      state.settings = await harmony.settings.get();
      renderThemes();
    });
    return reset;
  })());
}

function renderThemes() {
  const current = applyTheme(state.settings?.theme ?? DEFAULT_THEME);
  const offered = [
    ...THEMES,
    { id: 'custom', name: 'Custom', bands: customBands(state.settings?.customTheme) },
  ];

  el.themeGrid.replaceChildren(...offered.map((theme) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-swatch';
    button.dataset.theme = theme.id;
    button.toggleAttribute('data-on', theme.id === current);

    const bands = document.createElement('span');
    bands.className = 'theme-bands';
    for (const colour of theme.bands) {
      const band = document.createElement('span');
      // Inline, and deliberately: these are the colours of a palette that
      // is NOT applied, so they cannot come from the cascade.
      band.style.background = colour;
      bands.append(band);
    }

    const name = document.createElement('span');
    name.textContent = theme.name;

    button.append(bands, name);
    button.addEventListener('click', async () => {
      // The first time, Custom starts from the palette you were on.
      if (theme.id === 'custom' && !state.settings.customTheme) {
        state.settings.customTheme = currentColours();
      }
      // Applied before it is saved. Writing settings is a round trip
      // through the main process, and a palette that takes a beat to appear
      // feels like a click that missed.
      applyTheme(theme.id);
      for (const other of el.themeGrid.children) {
        other.toggleAttribute('data-on', other.dataset.theme === theme.id);
      }
      renderCustomEditor(theme.id);
      await harmony.settings.set({
        theme: theme.id,
        ...(theme.id === 'custom' ? { customTheme: state.settings.customTheme } : {}),
      });
      state.settings = await harmony.settings.get();
      if (theme.id === 'custom') renderThemes();
    });
    return button;
  }));
  renderCustomEditor(current);
}

// ---------------------------------------------------------------------------
// Hotkeys
//
// Registered globally by the main process (src/main/hotkeys.js); this side
// decides what is bound, records new combinations, and acts when one fires.
// Bindings are Electron accelerators -- "Ctrl+Shift+M" -- built from the
// physical key (event.code), so they do not change with the keyboard layout
// the way event.key would.
// ---------------------------------------------------------------------------

const HOTKEY_ACTIONS = [
  { id: 'mute', label: 'Mute / unmute microphone' },
  { id: 'deafen', label: 'Deafen / undeafen' },
];

/** What the main process said about each binding at the last sync. */
let hotkeyStatus = new Map();

const HOTKEY_ERRORS = {
  in_use: 'Another program already uses this combination. Pick another.',
  duplicate: 'Bound to something else as well.',
  invalid: 'Not a combination Windows can register.',
};

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
]);

const CODE_KEYS = {
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv', NumpadDecimal: 'numdec', NumpadEnter: 'Enter',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace',
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', ScrollLock: 'Scrolllock', PrintScreen: 'PrintScreen',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  MediaPlayPause: 'MediaPlayPause', MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack', MediaStop: 'MediaStop',
  AudioVolumeMute: 'VolumeMute', AudioVolumeUp: 'VolumeUp', AudioVolumeDown: 'VolumeDown',
};

/*
 * Keys that may be bound with no modifier, or with Shift alone.
 *
 * Anything else -- a letter, a digit, Space -- would be taken from every
 * other program while Harmony runs: bind "M" and nobody on this machine can
 * type an M. Shift is not enough either, since Shift+M is how a capital M is
 * typed. These are the keys nobody types text with.
 */
const STANDALONE_KEY = /^(F([1-9]|1\d|2[0-4])|num\w+|Media\w+|Volume\w+|Insert|Scrolllock|PrintScreen)$/;

const KEY_NAMES = {
  numadd: 'Num +', numsub: 'Num -', nummult: 'Num *', numdiv: 'Num /', numdec: 'Num .',
  Scrolllock: 'Scroll Lock', PrintScreen: 'Print Screen', MediaPlayPause: 'Play/Pause',
  MediaNextTrack: 'Next track', MediaPreviousTrack: 'Previous track', MediaStop: 'Stop',
  VolumeMute: 'Volume mute', VolumeUp: 'Volume up', VolumeDown: 'Volume down',
  Super: 'Win',
};

function codeToKey(code) {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1];
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  m = /^Numpad(\d)$/.exec(code);
  if (m) return `num${m[1]}`;
  return CODE_KEYS[code] ?? null;
}

/** Readable form of an accelerator, for buttons and badges. */
function formatAccelerator(accelerator) {
  if (!accelerator) return '';
  return accelerator
    .split('+')
    .map((t) => KEY_NAMES[t] ?? t.replace(/^num(\d)$/, 'Num $1'))
    .join(' + ');
}

/**
 * Turn a keydown into an accelerator, or say why it cannot be one.
 * @returns {{accelerator?: string, partial?: boolean, error?: string, display: string}}
 */
function acceleratorFrom(event) {
  const mods = [];
  if (event.ctrlKey) mods.push('Ctrl');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (event.metaKey) mods.push(harmony.platform === 'darwin' ? 'Command' : 'Super');
  const display = formatAccelerator(mods.join('+'));

  if (MODIFIER_CODES.has(event.code)) return { partial: true, display };
  const key = codeToKey(event.code);
  if (!key) return { error: 'That key cannot be used as a hotkey.', display };

  const accelerator = [...mods, key].join('+');
  const strong = event.ctrlKey || event.altKey || event.metaKey;
  if (!strong && !STANDALONE_KEY.test(key)) {
    return {
      error: 'Add Ctrl or Alt. On its own this key would stop working in every other program while Harmony is open.',
      display: formatAccelerator(accelerator),
    };
  }
  return { accelerator, display: formatAccelerator(accelerator) };
}

/** Which server the soundpad bindings belong to. */
function hotkeyServer() {
  return state.server || state.settings?.serverUrl || '';
}

function clipHotkey(clipId) {
  return state.settings?.clipHotkeys?.[hotkeyServer()]?.[clipId] ?? '';
}

function hotkeyFor(id) {
  if (id.startsWith('clip:')) return clipHotkey(id.slice(5));
  return state.settings?.hotkeys?.[id] ?? '';
}

/**
 * Hand the main process everything that should be bound right now.
 *
 * Clips only for the server you are on and only for clips that still exist:
 * a deleted clip's binding is kept in settings (re-adding a clip does not
 * bring its id back, so it is harmless) but is not registered, so it does
 * not hold a key for nothing.
 */
async function syncHotkeys() {
  const bindings = HOTKEY_ACTIONS
    .map(({ id }) => ({ id, accelerator: hotkeyFor(id) }))
    .filter((b) => b.accelerator);
  for (const clip of state.soundpad?.clips ?? []) {
    const accelerator = clipHotkey(clip.id);
    if (accelerator) bindings.push({ id: `clip:${clip.id}`, accelerator });
  }
  try {
    const results = await harmony.hotkeys.set(bindings);
    hotkeyStatus = new Map(results.map((r) => [r.id, r]));
  } catch (err) {
    console.warn('[hotkeys] could not register:', err.message);
  }
  if (!el.devicesDialog.open) return;
  renderHotkeyList();
}

/**
 * Bind (or, with '', unbind) one action.
 *
 * One combination does one thing: binding a key that already belongs to
 * something else moves it, because both firing at once is never what
 * anybody meant.
 */
async function saveHotkey(id, accelerator) {
  const server = hotkeyServer();
  const hotkeys = { ...(state.settings.hotkeys ?? {}) };
  const allClips = { ...(state.settings.clipHotkeys ?? {}) };
  const clips = { ...(allClips[server] ?? {}) };
  const same = (a) => a && a.toLowerCase() === accelerator.toLowerCase();

  if (accelerator) {
    for (const key of Object.keys(hotkeys)) if (key !== id && same(hotkeys[key])) hotkeys[key] = '';
    for (const key of Object.keys(clips)) if (`clip:${key}` !== id && same(clips[key])) delete clips[key];
  }
  if (id.startsWith('clip:')) {
    if (accelerator) clips[id.slice(5)] = accelerator;
    else delete clips[id.slice(5)];
  } else {
    hotkeys[id] = accelerator;
  }
  allClips[server] = clips;

  await harmony.settings.set({ hotkeys, clipHotkeys: allClips });
  state.settings = await harmony.settings.get();
  await syncHotkeys();
  renderSoundpad();

  const result = hotkeyStatus.get(id);
  if (accelerator && result && !result.ok) {
    toast(`${formatAccelerator(accelerator)}: ${HOTKEY_ERRORS[result.error] ?? 'could not be registered.'}`);
  }
}

/**
 * Ask for a key combination.
 *
 * @returns {Promise<string|null>} an accelerator, '' to remove the binding,
 *   or null for "cancelled, change nothing".
 */
function recordHotkey(title) {
  return new Promise((resolve) => {
    el.hotkeyRecorderTitle.textContent = title;
    el.hotkeyCapture.textContent = 'Waiting for keys…';
    el.hotkeyRecorderError.hidden = true;
    // Every global hotkey released while recording. Windows delivers a
    // registered combination to us INSTEAD of to the focused window, so
    // without this, pressing one that is already bound would fire it rather
    // than reach this dialog. finish() hands them back via the caller.
    harmony.hotkeys.set([]).catch(() => {});

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      el.hotkeyRecorder.removeEventListener('cancel', onCancel);
      el.hotkeyRecorderClear.onclick = null;
      el.hotkeyRecorderCancel.onclick = null;
      if (el.hotkeyRecorder.open) el.hotkeyRecorder.close();
      resolve(value);
    };
    const onKey = (event) => {
      // Captured and swallowed, so Alt does not open a menu and Tab does
      // not move focus while somebody is pressing their combination.
      event.preventDefault();
      event.stopPropagation();
      const bare = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
      if (event.code === 'Escape' && bare) {
        finish(null);
        return;
      }
      const result = acceleratorFrom(event);
      if (result.partial) {
        el.hotkeyCapture.textContent = `${result.display} + …`;
        return;
      }
      el.hotkeyCapture.textContent = result.display || 'Waiting for keys…';
      if (result.error) {
        el.hotkeyRecorderError.textContent = result.error;
        el.hotkeyRecorderError.hidden = false;
        return;
      }
      el.hotkeyRecorderError.hidden = true;
      // A beat to show what was caught before the dialog goes.
      setTimeout(() => finish(result.accelerator), 300);
    };
    const onCancel = (event) => {
      event.preventDefault();
      finish(null);
    };

    document.addEventListener('keydown', onKey, true);
    el.hotkeyRecorder.addEventListener('cancel', onCancel);
    el.hotkeyRecorderClear.onclick = () => finish('');
    el.hotkeyRecorderCancel.onclick = () => finish(null);
    el.hotkeyRecorder.showModal();
  });
}

async function editHotkey(id, label) {
  const value = await recordHotkey(`Hotkey: ${label}`);
  // Cancelled: nothing changes, but the bindings released for recording
  // still have to be handed back.
  if (value === null) return syncHotkeys();
  return saveHotkey(id, value);
}

/** The mute and deafen rows in the settings dialog. */
function renderHotkeyList() {
  el.hotkeyList.replaceChildren(...HOTKEY_ACTIONS.map(({ id, label }) => {
    const row = document.createElement('div');
    row.className = 'hotkey-row';

    const name = document.createElement('span');
    name.className = 'hotkey-name';
    name.textContent = label;

    const bound = hotkeyFor(id);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost small hotkey-key';
    button.textContent = bound ? formatAccelerator(bound) : 'Not set';
    button.toggleAttribute('data-empty', !bound);
    button.title = bound ? 'Click to change' : 'Click, then press a combination';
    button.addEventListener('click', () => editHotkey(id, label));

    row.append(name, button);

    const status = hotkeyStatus.get(id);
    if (bound && status && !status.ok) {
      const problem = document.createElement('small');
      problem.className = 'hotkey-problem';
      problem.textContent = HOTKEY_ERRORS[status.error] ?? 'Could not be registered.';
      row.append(problem);
    }
    return row;
  }));
}

/**
 * A hotkey fired -- usually while a game, not Harmony, has focus.
 *
 * Mute and deafen go through their buttons, so a hotkey does exactly what a
 * click does: the same state, the same cue, the same message to the server.
 * The cue matters more here than anywhere: it is the only confirmation
 * somebody gets without alt-tabbing.
 */
harmony.hotkeys.onFired((id) => {
  if (id === 'mute' || id === 'deafen') {
    const button = id === 'mute' ? el.voiceMute : el.voiceDeafen;
    if (!state.voice.channelId || button.disabled) return;
    button.click();
    return;
  }
  if (id.startsWith('clip:')) {
    const clip = state.soundpad.clips.find((c) => String(c.id) === id.slice(5));
    if (clip) playSoundpadClip(clip);
  }
});

/** Devices seen at the last enumeration, so a change can be compared. */
let lastDevices = { inputs: [], outputs: [], cameras: [] };

const deviceNote = (text) => {
  el.voiceDeviceNote.textContent = text;
};

/**
 * Fill one picker, keeping the saved preference selected where it still
 * exists and falling back to the default where it does not.
 *
 * @returns {string} the device actually selected
 */
function fillDevicePicker(select, devices, preferred, defaultLabel) {
  const options = [
    { id: '', name: defaultLabel },
    ...devices.map((d, i) => ({ id: d.deviceId, name: d.label || `Device ${i + 1}` })),
  ];
  select.replaceChildren(...options.map(({ id, name }) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = name;
    return option;
  }));

  const available = devices.some((d) => d.deviceId === preferred);
  select.value = available ? preferred : '';
  // The preference is NOT rewritten here. It stays pointing at the device
  // that is missing, which is what lets it come back on its own.
  return select.value;
}

/**
 * Enumerate, repopulate both pickers, and apply anything that changed.
 *
 * Called on joining a channel and again on every devicechange. Idempotent:
 * applying a device that is already in use is a no-op, so the common case of
 * "a device appeared that we do not care about" costs one enumeration.
 */
async function refreshVoiceDevices({ apply = true } = {}) {
  // Re-read rather than trusting the copy in memory. A devicechange is the
  // one moment the preference genuinely matters, and settings can have been
  // written by another window or by a previous run of this one.
  state.settings = await harmony.settings.get();

  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch (err) {
    deviceNote(`Could not list audio devices: ${err.message}`);
    return;
  }

  // 'communications' is a Windows alias for the default, and listing it beside
  // the real device makes it look as though there are two of everything.
  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications');
  lastDevices = { inputs, outputs };

  // Cameras are listed here too, so that the device row is one place rather
  // than a microphone here and a webcam buried in the source picker. Their
  // labels stay blank until camera permission has been granted once, which
  // is why the fallback name is "Camera 2" rather than nothing.
  const cameras = devices.filter((d) => d.kind === 'videoinput');
  lastDevices = { inputs, outputs, cameras };

  const wantedIn = state.settings.voiceInputId ?? '';
  const wantedOut = state.settings.voiceOutputId ?? '';
  const wantedCam = state.settings.voiceCameraId ?? '';
  const chosenIn = fillDevicePicker(el.voiceInput, inputs, wantedIn, 'System default');
  const chosenOut = fillDevicePicker(el.voiceOutput, outputs, wantedOut, 'System default');
  const chosenCam = fillDevicePicker(el.voiceCamera, cameras, wantedCam, 'Default camera');

  // Chromium only exposes audiooutput once microphone permission has been
  // granted, and never on some Linux setups. An empty list is not a fault.
  el.voiceOutput.disabled = outputs.length === 0;
  el.voiceCamera.disabled = cameras.length === 0;

  const missing = [];
  if (wantedIn && chosenIn !== wantedIn) missing.push('microphone');
  if (wantedOut && chosenOut !== wantedOut) missing.push('output');
  if (wantedCam && chosenCam !== wantedCam) missing.push('camera');
  deviceNote(missing.length
    ? `Your chosen ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} unplugged. `
      + 'Using the system default until it is back.'
    : '');

  if (!apply) return;
  await applyVoiceInput(chosenIn);
  await applyVoiceOutput(chosenOut);
  await applyVoiceCamera(chosenCam);
}

/*
 * Sensitivity, 1..100, to an RMS threshold.
 *
 * Exponential, because loudness is. Linear, the bottom quarter of the
 * slider would cover everything between "a quiet room" and "someone
 * talking" and the top three quarters would all mean "nothing gets
 * through" -- which is a control that only works at one setting.
 *
 * 0.0008 is roughly a quiet room at normal gain; 60x that is a shout. The
 * speaking indicator's own threshold, SPEAK_ON in gain.js, is 0.0075 and
 * lands near the middle of this range, which is a useful sanity check that
 * the scale covers the right territory.
 */
const gateThreshold = (sensitivity) =>
  (sensitivity <= 0 ? 0 : 0.0008 * (60 ** (sensitivity / 100)));

/** Where that threshold sits on the meter, as a percentage of its width. */
const meterPercent = (rms) => Math.min(100, Math.sqrt(Math.max(0, rms) / 0.25) * 100);

const MIC_METER_MS = 60;

function applyMicTuning() {
  const gain = Number(state.settings.micGain ?? 100);
  const sensitivity = Number(state.settings.micSensitivity ?? 0);

  el.micGain.value = String(gain);
  el.micGainLabel.textContent = `${gain}%`;
  el.micGainLabel.toggleAttribute('data-boosted', gain > 100);

  el.micGate.value = String(sensitivity);
  el.micGateLabel.textContent = sensitivity === 0 ? 'Off' : String(sensitivity);

  const threshold = gateThreshold(sensitivity);
  el.micMeterMark.hidden = sensitivity === 0;
  el.micMeterMark.style.left = `${meterPercent(threshold)}%`;

  state.voice.setMicGain(gain / 100);
  state.voice.setMicThreshold(threshold);
}

/**
 * Drive the meter while the dialog is open, and only while it is open.
 *
 * Reading an analyser sixteen times a second is cheap, but doing it forever
 * for a bar nobody is looking at is a battery cost with no reader.
 */
let micMeterTimer = null;

function startMicMeter() {
  stopMicMeter();
  micMeterTimer = setInterval(() => {
    el.micMeterFill.style.width = `${meterPercent(state.voice.micLevel)}%`;
    el.micMeter.toggleAttribute('data-gated', !state.voice.micOpen);
  }, MIC_METER_MS);
}

function stopMicMeter() {
  if (micMeterTimer) clearInterval(micMeterTimer);
  micMeterTimer = null;
}

/** Point the microphone at a device, if we are publishing one. */
async function applyVoiceInput(deviceId) {
  if (!state.voice.micLive) return;
  // Already there: switching would cost a getUserMedia and a track swap for
  // nothing, and devicechange fires several times for one physical plug.
  if (state.voice.micDeviceId === deviceId) return;
  if (!deviceId && !state.settings.voiceInputId) return;

  const ok = await state.voice.switchMic(deviceId);
  if (!ok) deviceNote('That microphone could not be opened. Still using the previous one.');
}

async function applyVoiceOutput(deviceId) {
  const ok = await setOutputDevice(deviceId);
  if (!ok && deviceId) {
    deviceNote('This build cannot choose an output device; using the system default.');
  }
}

/**
 * Point the camera at a device, if one is running.
 *
 * Same shape as the microphone, and for the same reason: replaceTrack on the
 * live sender rather than a fresh publish, so nobody watching has to tear
 * their subscription down and rebuild it to see you switch webcam.
 */
async function applyVoiceCamera(deviceId) {
  if (!state.voice.camLive) return;
  if (state.voice.camDeviceId === deviceId) return;
  if (!deviceId && !state.settings.voiceCameraId) return;

  const stream = await openCamera(deviceId).catch(() => null);
  if (!stream) {
    deviceNote('That camera could not be opened. Still using the previous one.');
    return;
  }
  if (!await state.voice.switchCam(stream)) {
    stream.getTracks().forEach((t) => t.stop());
    deviceNote('That camera could not be opened. Still using the previous one.');
    return;
  }
  renderChannelVideo();
}

/**
 * React to hardware being plugged in or pulled out.
 *
 * Registered once at startup rather than per channel, because the event is
 * about the machine and not about the call -- and because removing and
 * re-adding a listener on every join is how one ends up with six of them.
 */
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (!state.voice.channelId) return;
  refreshVoiceDevices().catch((err) => console.warn('[devices]', err.message));
});

// ---------------------------------------------------------------------------
// The channel mosaic
//
// Every camera and screen share inside the voice channel you are in, opened
// automatically from the roster. It is the same WHEP subscription the flat
// mosaic uses, with two differences: the paths are channel-scoped
// (`vc-<cid>-<mid>-c` / `-s`) and the read token is the per-channel one, so a
// stream shared into a locked channel is not watchable by someone who never
// got in.
// ---------------------------------------------------------------------------

const KIND_LABEL = { c: 'camera', s: 'screen' };

const nameOfMid = (mid) => {
  const member = state.channels.roster.find((m) => m.mid === mid);
  return member ? displayOf(member.userId, member.nickname) : `slot ${mid}`;
};

/**
 * Draw the tiles.
 *
 * Nodes for tiles that are still wanted are REUSED rather than rebuilt:
 * reassigning a <video>'s srcObject restarts playback, so rebuilding the grid
 * on every roster push would make every tile stutter whenever anybody muted.
 */
/**
 * Your own camera and screen, as tiles alongside everybody else's.
 *
 * From the LOCAL stream, never by subscribing to our own path: that would
 * pay for a whole extra relay round trip to show something already in
 * memory, and add a second of delay to it.
 *
 * Worth having rather than clever to omit. Sharing a screen and seeing
 * nothing appear reads as "it did not work" -- there is no other feedback
 * that it did, because the one person who cannot see your tile is you.
 */
function ownChannelTiles() {
  const mine = [];
  if (state.voice.camStream) {
    mine.push({ mid: state.voice.mid, kind: 'c', stream: state.voice.camStream, own: true });
  }
  if (state.share.target?.channelId === state.voice.channelId && state.preview.stream) {
    mine.push({ mid: state.voice.mid, kind: 's', stream: state.preview.stream, own: true });
  }
  return mine;
}

/**
 * The handle on your own share, while you are listening to it.
 *
 * Module scope rather than per tile: tiles are rebuilt whenever the roster
 * changes, and a handle held in a closure would be lost on the next push
 * with the audio still playing and nothing left to stop it.
 */
let ownMonitor = null;

function stopOwnMonitor() {
  ownMonitor?.close();
  ownMonitor = null;
}

function renderChannelVideo() {
  const tiles = state.voice.channelId
    ? [...ownChannelTiles(), ...state.voice.videoTiles]
    : [];

  // Stopping the share leaves nothing to listen to, and a monitor left
  // open on a dead stream is a node graph nobody can reach to close.
  if (ownMonitor && !tiles.some((t) => t.own && t.kind === 's')) stopOwnMonitor();
  const existing = new Map(
    [...el.channelVideo.children].map((node) => [node.dataset.key, node]),
  );

  el.channelVideo.replaceChildren(...tiles.map((tile) => {
    const { mid, kind, stream, own } = tile;
    const key = own ? `me:${kind}` : tile.key;
    const caption = `${own ? 'you' : nameOfMid(mid)} \u00B7 ${KIND_LABEL[kind] ?? kind}`;

    const kept = existing.get(key);
    if (kept) {
      kept.querySelector('figcaption .tile-name').textContent = caption;
      // Changing source mints a new preview stream; a preview that is
      // showing follows it rather than freezing on the old capture.
      const shown = own ? kept.querySelector('video') : null;
      if (shown?.srcObject && shown.srcObject !== stream) shown.srcObject = stream;
      return kept;
    }

    const figure = document.createElement('figure');
    figure.className = 'channel-tile';
    figure.dataset.key = key;
    if (own) figure.setAttribute('data-own', '');

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    // Muted on purpose: a screen share's audio goes through gain.js like
    // every other incoming stream, so that deafen reaches it. Letting the
    // element play it too would double it.
    video.muted = true;
    video.srcObject = stream;

    /*
     * Your own tiles start HIDDEN.
     *
     * Everyone else's tile is the reason the mosaic exists. Your own is a
     * picture of the screen you are already looking at, composited every
     * frame on the same GPU as the game you are sharing -- so it costs
     * nothing until you ask for it.
     *
     * Asked for, it is the real thing: full resolution, full frame rate,
     * the same video element as everybody else's tile. It used to be a
     * canvas repainted twice a second, which answered "is it the right
     * window" and made everything else about your own stream impossible to
     * judge. Hidden means no srcObject at all, not a hidden element, so a
     * hidden preview is not composited.
     */
    if (own) {
      video.srcObject = null;
      video.hidden = true;
      figure.setAttribute('data-preview-off', '');

      const eye = document.createElement('button');
      eye.className = 'tile-btn';
      eye.type = 'button';
      eye.dataset.role = 'preview';
      eye.innerHTML = '&#128065;';
      eye.title = 'Show a preview of what you are sharing';
      eye.addEventListener('click', (event) => {
        event.stopPropagation();
        if (video.srcObject) {
          video.srcObject = null;
          video.hidden = true;
          figure.setAttribute('data-preview-off', '');
          eye.removeAttribute('data-on');
          eye.title = 'Show a preview of what you are sharing';
        } else {
          // Read now rather than captured at build time: the tile outlives
          // a change of source, and the stream with it.
          video.srcObject = ownChannelTiles().find((t) => t.kind === kind)?.stream ?? stream;
          video.hidden = false;
          video.play().catch(() => {});
          figure.removeAttribute('data-preview-off');
          eye.setAttribute('data-on', '');
          eye.title = 'Hide the preview';
        }
      });

      const cornerEye = document.createElement('span');
      cornerEye.className = 'tile-corner';
      cornerEye.append(eye);
      figure.append(cornerEye);
    }

    /*
     * Hear your own screen share.
     *
     * Top right, away from the controls in the caption, because this one
     * acts on YOUR speakers rather than on the tile -- and because it is
     * the only way to answer "is my game audio actually going out?"
     * without asking somebody.
     *
     * Safe where monitoring your own microphone would not be: a screen's
     * audio is not coming back in through a microphone, so there is no
     * loop to start. Routed into the playback context like everything
     * else, so the output picker and deafen both reach it.
     */
    if (own && kind === 's') {
      const corner = figure.querySelector('.tile-corner')
        ?? Object.assign(document.createElement('span'), { className: 'tile-corner' });
      const listen = document.createElement('button');
      listen.className = 'tile-btn';
      listen.type = 'button';
      listen.dataset.role = 'monitor';
      listen.innerHTML = '&#127911;';
      listen.title = 'Hear your own stream';
      listen.addEventListener('click', (event) => {
        event.stopPropagation();
        if (ownMonitor) {
          ownMonitor.close();
          ownMonitor = null;
        } else {
          ownMonitor = monitorStream(stream, 1);
        }
        listen.toggleAttribute('data-on', Boolean(ownMonitor));
        listen.title = ownMonitor ? 'Stop hearing your own stream' : 'Hear your own stream';
      });
      corner.append(listen);
      if (!corner.isConnected) figure.append(corner);
    }

    const label = document.createElement('figcaption');
    const name = document.createElement('span');
    name.className = 'tile-name';
    name.textContent = caption;
    label.append(name);

    /*
     * The same controls the flat mosaic has, because this IS a mosaic --
     * it just happens to be the channel's rather than the server's, and
     * somebody sharing a screen into a voice channel wants to make it big
     * and turn the game audio down exactly as they would anywhere else.
     */
    const controls = document.createElement('span');
    controls.className = 'tile-controls';

    // Volume only where there is something to turn down: a camera has no
    // audio, and your own tiles are local, never played back.
    if (!own && kind === 's') {
      const muteBtn = document.createElement('button');
      muteBtn.className = 'tile-btn';
      muteBtn.type = 'button';
      muteBtn.dataset.role = 'mute';
      muteBtn.innerHTML = '&#128266;';
      muteBtn.title = 'Mute this share';

      const volume = document.createElement('input');
      volume.type = 'range';
      volume.className = 'tile-volume';
      volume.min = '0';
      volume.max = String(asPercent(MAX_GAIN));
      volume.value = String(asPercent(state.voice.tileGain(key)));
      volume.title = 'Volume for this share';
      const level = document.createElement('span');
      level.className = 'tile-volume-label volume-value';

      const apply = (percent) => {
        state.voice.setTileGain(key, percent / 100);
        showVolume(volume, level, percent);
        muteBtn.innerHTML = percent === 0 ? '&#128263;' : '&#128266;';
      };
      showVolume(volume, level, Number(volume.value));
      volume.addEventListener('input', (event) => {
        event.stopPropagation();
        apply(Number(volume.value));
      });
      muteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const next = Number(volume.value) === 0 ? 100 : 0;
        volume.value = String(next);
        apply(next);
      });

      controls.append(muteBtn, volume, level);
    }

    const bigBtn = document.createElement('button');
    bigBtn.className = 'tile-btn';
    bigBtn.type = 'button';
    bigBtn.dataset.role = 'maximize';
    bigBtn.innerHTML = '&#10530;';
    bigBtn.title = 'Maximize, without leaving the channel';

    const fsBtn = document.createElement('button');
    fsBtn.className = 'tile-btn';
    fsBtn.type = 'button';
    fsBtn.dataset.role = 'fullscreen';
    fsBtn.innerHTML = '&#9974;';
    fsBtn.title = 'Fullscreen';

    const hideBtn = document.createElement('button');
    hideBtn.className = 'tile-btn';
    hideBtn.type = 'button';
    hideBtn.dataset.role = 'minimize';
    hideBtn.innerHTML = '&#8211;';
    hideBtn.title = 'Minimize to a strip';

    /*
     * Close, which is not the same thing as minimize.
     *
     * Minimize shrinks the tile and keeps paying for it -- the decoder, the
     * downstream bandwidth, the relay's egress. Close hangs the
     * subscription up, which is what you want when somebody is sharing a
     * game you are not watching, and leaves a square behind so you can pick
     * it back up without hunting for them in a list.
     */
    let closeBtn = null;
    if (!own) {
      closeBtn = document.createElement('button');
      closeBtn.className = 'tile-btn';
      closeBtn.type = 'button';
      closeBtn.dataset.role = 'close';
      closeBtn.innerHTML = '&#10005;';
      closeBtn.title = 'Stop watching this, and stop downloading it';
      closeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        state.voice.closeVideo(key);
        renderChannelVideo();
      });
    }

    const maximize = () => {
      const wasBig = figure.hasAttribute('data-big');
      for (const node of el.channelVideo.children) node.removeAttribute('data-big');
      if (!wasBig) figure.setAttribute('data-big', '');
      bigBtn.title = wasBig ? 'Maximize, without leaving the channel' : 'Back to the grid';
    };

    bigBtn.addEventListener('click', (event) => { event.stopPropagation(); maximize(); });
    fsBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleFullscreen(figure);
    });
    hideBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      figure.toggleAttribute('data-small');
      figure.removeAttribute('data-big');
    });

    controls.append(bigBtn, fsBtn, hideBtn);
    if (closeBtn) controls.append(closeBtn);
    label.append(controls);

    /*
     * The tile itself is NOT a maximize target.
     *
     * It was, on the reasoning that clicking the picture is what people
     * reach for before they find the button. In use that is wrong twice
     * over: the thing on the tile is a live screen somebody is watching,
     * so resizing it is the last thing a stray click should do -- and the
     * controls sit inside the tile, so every press of the volume slider
     * bubbled up and resized the video underneath the finger.
     *
     * stopPropagation on the controls would have fixed the second half
     * and left the first, and it is a rule that has to be remembered by
     * every control added later. Not having the handler cannot be
     * forgotten.
     */
    figure.append(video, label);
    return figure;
  }));

  /*
   * A square for every tile that is closed but still being published.
   *
   * Appended after the live tiles rather than kept in position, because the
   * grid reflows anyway and a square that holds an exact slot would need
   * the whole list to be ordered by something stabler than "who joined
   * first". Keeping them together at the end is honest about what they are.
   */
  for (const { key, mid, kind } of state.voice.closedTiles) {
    const node = document.createElement('figure');
    node.className = 'channel-tile ghost-tile';
    node.dataset.key = `closed:${key}`;
    node.title = 'Watch this again';

    const name = document.createElement('span');
    name.className = 'ghost-name';
    name.textContent = `${nameOfMid(mid)} \u00B7 ${KIND_LABEL[kind] ?? kind}`;

    const hint = document.createElement('span');
    hint.className = 'ghost-hint';
    hint.textContent = 'Closed \u00B7 click to watch again';

    node.append(name, hint);
    node.addEventListener('click', () => {
      state.voice.reopenVideo(key);
      renderChannelVideo();
      state.voice.syncVideo()
        .then((r) => { if (r.changed) renderChannelVideo(); })
        .catch(() => { /* the reconciliation tick comes back */ });
    });
    el.channelVideo.append(node);
  }

  // After the children exist, not before: applyStage counts them to decide
  // whether there is a stage at all.
  applyStage();
}

// ---------------------------------------------------------------------------
// Text channels
// ---------------------------------------------------------------------------

async function openTextChannel(channel) {
  state.chat.channelId = channel.id;
  // Whatever was waiting to be sent was waiting to be sent HERE. Carrying
  // it into the next channel is how a screenshot ends up in the wrong one.
  setPendingFile(null);
  applyComposer();
  // Opening it is reading it. The mark means "since I have been looking".
  state.mentioned.delete(channel.id);
  state.chat.searching = false;
  el.chatName.textContent = `#${channel.name}`;
  el.chatSearch.value = '';
  el.chatSearchClear.hidden = true;
  el.chatNote.textContent = '';
  el.voiceIdle.hidden = true;
  applyStage();
  renderChannels();

  try {
    const { messages, pinned } = await harmony.api.messages(state.server, channel.id);
    state.chat.messages = messages;
    state.chat.pinned = pinned;
    renderChat({ scrollToBottom: true });
    // Pinned attachments are part of the keep-set: they are the things
    // somebody decided were worth coming back to, so they survive eviction.
    await refreshKeepSet();
  } catch (err) {
    showChannelsError(err.message);
  }
}

function closeChat() {
  state.chat.channelId = null;
  if (el.voiceActive.hidden) el.voiceIdle.hidden = false;
  applyStage();
  // The highlight follows what is on screen, which just went back to the call.
  renderChannels();
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

/*
 * THE SERVER HAS THE SAME REGEX, in chat.js, and it is the one that
 * decides who gets notified. This copy only decides what is drawn. If one
 * changes the other has to, or a name will light up for the person writing
 * it and ping nobody.
 *
 * The body of the class is the nickname rule: a mention is a nickname and
 * never a display name, because display names may repeat and may contain
 * spaces, and "who did they mean" would have no answer.
 */
const MENTION_RE = /(?<![\w@])@([a-z0-9][a-z0-9_-]{0,23})/gi;

/** The one mention that is not a person. */
const EVERYONE = 'everyone';

const userByNickname = (nickname) =>
  [...state.users.values()].find((u) => u.nickname === nickname) ?? null;

/**
 * Draw one @name.
 *
 * Shows the display name while the text holds the nickname -- the same
 * split as everywhere else in the app: the nickname is the identity, the
 * display name is what people call each other. An @ that matches nobody is
 * left as plain text, because it is plain text: somebody wrote an address,
 * or a price, or nothing in particular.
 */
function mentionNode(raw, name) {
  const everyone = name === EVERYONE;
  const user = everyone ? null : userByNickname(name);
  if (!everyone && !user) return document.createTextNode(raw);

  const span = document.createElement('span');
  span.className = 'mention';
  span.textContent = everyone ? '@everyone' : `@${displayOf(user.id, user.nickname)}`;
  if (everyone || user.id === state.auth.user?.id) span.setAttribute('data-me', '');
  if (user) span.title = `@${user.nickname}`;
  return span;
}

/** True if this message is addressed to the person reading it. */
const mentionsMe = (message) => Boolean(
  message.mentionsEveryone || message.mentions?.includes(state.auth.user?.id),
);

/**
 * Ring for a message that names you.
 *
 * Driven by the push rather than by what is on screen, because the whole
 * point is the channel you are NOT looking at. Your own message never
 * rings: writing your own name is not news, and @everyone would otherwise
 * ring for the person who sent it.
 *
 * The server only pushes messages from channels you may read, so there is
 * nothing here about locked channels -- see toChannelReaders.
 */
function notifyMention(message) {
  if (!mentionsMe(message)) return;
  if (message.userId === state.auth.user?.id) return;

  if (message.channelId !== state.chat.channelId) {
    state.mentioned.set(message.channelId, (state.mentioned.get(message.channelId) ?? 0) + 1);
    renderChannels();
  }
  if (state.settings?.mentionSound !== false) playCue('mention');
}

// --- the suggestion list ---------------------------------------------------

/**
 * Where the @ being typed starts, or -1.
 *
 * Only the token the caret is actually in: typing a second name must not
 * re-open the list on the first one, and moving the caret away from a name
 * has to close it. The @ must start a word, which is the same rule the
 * mention regex uses, so the list cannot appear inside an email address.
 */
function mentionTokenStart() {
  const value = el.chatInput.value;
  const caret = el.chatInput.selectionStart ?? value.length;
  const at = value.lastIndexOf('@', caret - 1);
  if (at < 0) return -1;
  if (at > 0 && /[\w@]/.test(value[at - 1])) return -1;
  // Anything that cannot be in a nickname ends the token.
  if (/[^a-z0-9_-]/i.test(value.slice(at + 1, caret))) return -1;
  return at;
}

let mentionMatches = [];
let mentionActive = 0;

/** Everyone the typed fragment could mean, best first. */
function mentionCandidates(query) {
  const q = query.toLowerCase();
  const people = [...state.users.values()]
    .filter((u) => u.nickname.includes(q)
      || displayOf(u.id, u.nickname).toLowerCase().includes(q))
    // A name that STARTS with what you typed is what you meant far more
    // often than one that merely contains it.
    .sort((a, b) => {
      const rank = (u) => (u.nickname.startsWith(q) ? 0 : 1);
      return rank(a) - rank(b)
        || displayOf(a.id, a.nickname).localeCompare(displayOf(b.id, b.nickname));
    })
    .slice(0, 8)
    .map((u) => ({ nickname: u.nickname, label: displayOf(u.id, u.nickname), user: u }));

  // Last, not first: it is the loudest thing on the list and should not be
  // what a blind Enter picks.
  if (EVERYONE.startsWith(q)) {
    people.push({ nickname: EVERYONE, label: 'everyone', everyone: true });
  }
  return people;
}

function renderMentionList() {
  el.mentionItems.replaceChildren(...mentionMatches.map((match, index) => {
    const li = document.createElement('li');
    if (index === mentionActive) li.setAttribute('data-active', '');
    li.dataset.nickname = match.nickname;

    if (match.everyone) {
      const all = document.createElement('span');
      all.className = 'mention-name mention-all';
      all.textContent = '@everyone';
      const note = document.createElement('span');
      note.className = 'mention-nick';
      note.textContent = 'notifies the whole server';
      li.append(all, note);
    } else {
      li.append(avatarEl(faceOf(match.user.id, match.nickname), 'tiny'));
      const name = document.createElement('span');
      name.className = 'mention-name';
      name.textContent = match.label;
      li.append(name);
      // The nickname is shown even when it equals the display name,
      // because it is what actually goes in the message.
      const nick = document.createElement('span');
      nick.className = 'mention-nick';
      nick.textContent = `@${match.nickname}`;
      li.append(nick);
    }

    // pointerdown, not click: clicking moves focus out of the input first,
    // and the blur handler would close the list before the click landed.
    li.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      acceptMention(index);
    });
    li.addEventListener('pointerenter', () => {
      mentionActive = index;
      renderMentionList();
    });
    return li;
  }));
}

function closeMentions() {
  el.mentionPop.hidden = true;
  mentionMatches = [];
}

/** Open, update or close the list for whatever is under the caret. */
function updateMentions() {
  const at = mentionTokenStart();
  if (at < 0) return closeMentions();

  const caret = el.chatInput.selectionStart ?? el.chatInput.value.length;
  mentionMatches = mentionCandidates(el.chatInput.value.slice(at + 1, caret));
  if (!mentionMatches.length) return closeMentions();

  mentionActive = Math.min(mentionActive, mentionMatches.length - 1);
  el.mentionPop.hidden = false;
  renderMentionList();

  // Above the box, where the box is: the composer sits at the bottom of a
  // column whose width changes with the member list, so there is nothing
  // to anchor it to in CSS.
  const anchor = el.chatInput.getBoundingClientRect();
  const box = el.mentionPop.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, anchor.left),
    Math.max(8, window.innerWidth - box.width - 8),
  );
  const above = anchor.top - box.height - 6;
  el.mentionPop.style.left = `${left}px`;
  el.mentionPop.style.top = above >= 8
    ? `${above}px`
    : `${Math.min(anchor.bottom + 6, window.innerHeight - box.height - 8)}px`;
  return undefined;
}

/** Put the chosen nickname in, replacing what was typed of it. */
function acceptMention(index) {
  const match = mentionMatches[index];
  const at = mentionTokenStart();
  if (!match || at < 0) return closeMentions();

  const input = el.chatInput;
  const caret = input.selectionStart ?? input.value.length;
  // A trailing space, because the next thing typed is a word and not more
  // of the name -- and without it the list stays open over what follows.
  const insert = `@${match.nickname} `;
  input.value = input.value.slice(0, at) + insert + input.value.slice(caret);
  const after = at + insert.length;
  input.setSelectionRange(after, after);
  input.focus();
  return closeMentions();
}

// ---------------------------------------------------------------------------
// Emoji
// ---------------------------------------------------------------------------

/** Longest side a custom emoji is stored at. */
const EMOJI_PX = 128;
const EMOJI_MAX_BYTES = 256 * 1024;
/** How many of your last picks the picker keeps. */
const RECENT_EMOJI = 24;
/** A filtered grid stops here. Nobody scrolls past three hundred faces. */
const EMOJI_RESULT_CAP = 300;

/*
 * :name:
 *
 * Deliberately NOT allowing '-' or '+', because the server folds both into
 * '_' when it stores a name -- a trigger that cannot match anything is
 * worse than one that is not recognised at all, since it still looks like
 * it ought to work.
 */
const SHORTCODE_RE = /:([a-z0-9_]{2,32}):/gi;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_ONLY_RE =
  /^(?:\s|\p{Extended_Pictographic}|[\u200d\ufe0f\u{1F3FB}-\u{1F3FF}]|:[a-z0-9_]{2,32}:)+$/iu;

function setEmojis(list) {
  state.emojis.list = list ?? [];
  state.emojis.byName = new Map(state.emojis.list.map((e) => [e.name, e]));
  renderEmojiPicker();
  // Every message body is scanned against this map, so a message already on
  // screen showing :shrug: becomes a picture the moment one is added.
  if (state.chat.channelId) renderChat();
  refreshKeepSet();
}

async function loadEmojis() {
  try {
    const { emojis } = await harmony.api.emojis(state.server);
    setEmojis(emojis);
    // Warm the cache the same way the soundpad does: asking for the URL is
    // enough, because the protocol handler downloads on demand.
    for (const emoji of emojis) new Image().src = harmony.mediaUrl(emoji.hash);
  } catch {
    // Not fatal. Without them :name: stays text, which is what it looks like.
  }
}

/** An <img> for one custom emoji, sized by CSS rather than by attributes. */
function customEmojiImg(emoji, className = 'emoji-img') {
  const img = document.createElement('img');
  img.className = className;
  img.src = harmony.mediaUrl(emoji.hash);
  img.alt = `:${emoji.name}:`;
  img.title = `:${emoji.name}:`;
  img.loading = 'lazy';
  return img;
}

/**
 * Append one emoji -- a character or a :name: -- to an element.
 *
 * A custom emoji whose picture has been deleted falls back to its literal
 * text, which is why a reaction stores the name rather than a foreign key.
 * The count was somebody's, and it stays.
 */
function appendEmoji(target, value) {
  const match = /^:([a-z0-9_]{2,32}):$/i.exec(String(value ?? ''));
  const custom = match ? state.emojis.byName.get(match[1].toLowerCase()) : null;
  if (custom) target.append(customEmojiImg(custom));
  else target.append(document.createTextNode(String(value ?? '')));
}

/**
 * Emoji and mentions in a run of plain text.
 *
 * One scan for both kinds of token. Two passes would mean the second one
 * walking over nodes the first had already made, and a :name: inside
 * somebody's nickname deciding which pass won.
 *
 * Custom emoji beat the standard shortcode table. A server that calls
 * something :pizza: means ITS picture, and quietly showing the Unicode one
 * instead would be a worse surprise than the collision.
 *
 * `returns {number} how many emoji were substituted
 */
function renderPlain(target, text) {
  let last = 0;
  let replaced = 0;

  const TOKENS = new RegExp(`${SHORTCODE_RE.source}|${MENTION_RE.source}`, 'gi');
  for (let m = TOKENS.exec(text); m; m = TOKENS.exec(text)) {
    const [whole, shortcode, mention] = m;
    let node = null;

    if (shortcode) {
      const name = shortcode.toLowerCase();
      const custom = state.emojis.byName.get(name);
      const standard = custom ? null : emojiByShortcode(name);
      if (custom) node = customEmojiImg(custom);
      else if (standard) node = document.createTextNode(standard);
    } else if (mention) {
      const drawn = mentionNode(whole, mention.toLowerCase());
      // A text node back means it matched nobody, so leave the text where
      // it is rather than cutting it out and putting it back.
      if (drawn.nodeType !== Node.TEXT_NODE) node = drawn;
    }
    if (!node) continue;

    if (m.index > last) target.append(document.createTextNode(text.slice(last, m.index)));
    target.append(node);
    last = m.index + whole.length;
    if (shortcode) replaced += 1;
  }
  if (last < text.length) target.append(document.createTextNode(text.slice(last)));
  return replaced;
}

/*
 * Inline markdown.
 *
 * A short list on purpose. Everything here is something people type by
 * hand mid-sentence; tables, footnotes and reference links are things
 * people paste out of a document, and a chat line is not a document.
 *
 * Code comes FIRST in the alternation, because whatever is inside
 * backticks has to win -- `**not bold**` is the example everybody tries.
 * Both underscore forms are guarded by lookarounds so that snake_case and
 * a nickname like @big_tuna are left alone, which is the only reason the
 * underscore rules are worth having at all.
 */
const INLINE_MD = new RegExp([
  '(`[^`\\n]+`)',
  '(\\*\\*[^\\n]+?\\*\\*)',
  '((?<![\\w_])__[^\\n]+?__(?![\\w_]))',
  '(~~[^\\n]+?~~)',
  '(\\*[^*\\n]+?\\*)',
  '((?<![\\w_])_[^_\\n]+?_(?![\\w_]))',
  '(\\[[^\\]\\n]+\\]\\(https?://[^\\s)]+\\))',
  '(https?://[^\\s<]+)',
].join('|'), 'g');

/**
 * An anchor, or null if the URL is not one we will open.
 *
 * http and https only, and always target=_blank. The window-open handler
 * in main sends those to the system browser and denies the navigation; a
 * plain in-window click would instead navigate the RENDERER to the page,
 * replacing the whole app with somebody's link.
 */
function linkNode(href, label) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const a = document.createElement('a');
  a.href = url.href;
  a.target = '_blank';
  a.rel = 'noreferrer noopener';
  a.textContent = label ?? href;
  a.title = url.href;
  return a;
}

/**
 * Inline markdown, then emoji and mentions in whatever is left.
 *
 * matchAll rather than a loop on exec, and that is not a style choice: this
 * function RECURSES, into the inside of every bold and italic run. A /g
 * regex carries lastIndex, so an inner call would leave the outer loop
 * resuming at an offset into a different string. matchAll iterates over a
 * clone, so each level gets its own position.
 */
function renderInline(target, text) {
  let last = 0;
  let replaced = 0;
  const push = (from, to) => {
    if (to > from) replaced += renderPlain(target, text.slice(from, to));
  };

  for (const m of text.matchAll(INLINE_MD)) {
    const [whole, code, bold, boldUnder, strike, italic, italicUnder, link, bare] = m;
    let node = null;

    if (code) {
      node = document.createElement('code');
      node.className = 'md-code';
      // textContent, and no recursion: inside backticks nothing else
      // applies, which is the entire point of backticks.
      node.textContent = code.slice(1, -1);
    } else if (bold || boldUnder) {
      node = document.createElement('strong');
      renderInline(node, (bold ?? boldUnder).slice(2, -2));
    } else if (strike) {
      node = document.createElement('del');
      renderInline(node, strike.slice(2, -2));
    } else if (italic || italicUnder) {
      node = document.createElement('em');
      renderInline(node, (italic ?? italicUnder).slice(1, -1));
    } else if (link) {
      const close = link.indexOf('](');
      node = linkNode(link.slice(close + 2, -1), link.slice(1, close));
    } else if (bare) {
      node = linkNode(bare, bare);
    }
    // A link we will not open stays as the text it was.
    if (!node) continue;
    // A match the previous one already swallowed -- matchAll gives every
    // match from the clone's own scan, so this cannot happen today, but it
    // is one line against a silently duplicated run of text.
    if (m.index < last) continue;

    push(last, m.index);
    target.append(node);
    last = m.index + whole.length;
  }
  push(last, text.length);
  return replaced;
}

/**
 * Put a message body on the page.
 *
 * Text nodes and elements, never innerHTML -- and markdown is exactly the
 * feature that makes the shortcut tempting. "A chat message is the most
 * obvious place in the app for someone to try injecting markup" has only
 * become more true: there is now a parser between what somebody types and
 * what everybody sees, and the one thing it must never do is hand a string
 * to the HTML parser.
 *
 * Block structure is decided line by line, and the plain case is lines
 * joined by <br> rather than paragraphs: a two-line message should be two
 * lines, not two paragraphs with a blank one between them.
 *
 * `returns {boolean} whether the body was nothing but emoji
 */
/*
 * The block rules, named once.
 *
 * Shared between "does this line start a block" and "does the run of plain
 * lines stop here", which has to be the SAME question. When they were two
 * nearly-identical regexes, a line like "## " -- a heading marker with
 * nothing after it -- failed the first and matched the second, so the plain
 * run ended where it began, nothing was consumed, and the loop never
 * advanced. One set of constants cannot drift apart like that.
 */
const MD_FENCE = /^\s{0,3}```(\w*)\s*$/;
const MD_FENCE_END = /^\s{0,3}```\s*$/;
const MD_HEAD = /^(#{1,3})\s+(.+)$/;
const MD_QUOTE = /^\s{0,3}>\s?/;
const MD_BULLET = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/;

function renderBody(target, body) {
  const text = String(body ?? '');
  if (!text) return false;

  const lines = text.split('\n');
  let replaced = 0;
  let i = 0;

  const flow = (node, from, to) => {
    for (let n = from; n < to; n += 1) {
      if (n > from) node.append(document.createElement('br'));
      replaced += renderInline(node, lines[n]);
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // A fence runs to the closing one, or to the end of the message if
    // somebody never closed it -- which is far commoner than it should be
    // and must not swallow the rest of the parse.
    if (MD_FENCE.test(line)) {
      let end = i + 1;
      while (end < lines.length && !MD_FENCE_END.test(lines[end])) end += 1;
      const pre = document.createElement('pre');
      pre.className = 'md-block';
      const code = document.createElement('code');
      code.textContent = lines.slice(i + 1, end).join('\n');
      pre.append(code);
      target.append(pre);
      i = end + 1;
      continue;
    }

    const head = MD_HEAD.exec(line);
    if (head) {
      const node = document.createElement('span');
      node.className = 'md-head';
      node.dataset.level = String(head[1].length);
      replaced += renderInline(node, head[2]);
      target.append(node);
      i += 1;
      continue;
    }

    if (MD_QUOTE.test(line)) {
      const quote = document.createElement('blockquote');
      quote.className = 'md-quote';
      let end = i;
      const parts = [];
      while (end < lines.length && MD_QUOTE.test(lines[end])) {
        parts.push(lines[end].replace(MD_QUOTE, ''));
        end += 1;
      }
      parts.forEach((part, index) => {
        if (index) quote.append(document.createElement('br'));
        replaced += renderInline(quote, part);
      });
      target.append(quote);
      i = end;
      continue;
    }

    if (MD_BULLET.test(line)) {
      const ordered = /^\s{0,3}\d/.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      list.className = 'md-list';
      let end = i;
      while (end < lines.length && MD_BULLET.test(lines[end])) {
        const item = document.createElement('li');
        replaced += renderInline(item, lines[end].replace(MD_BULLET, ''));
        list.append(item);
        end += 1;
      }
      target.append(list);
      i = end;
      continue;
    }

    // A run of ordinary lines, kept together so the <br>s go between them
    // and not after the last one.
    //
    // lines[i] has just failed all four tests above, so the first step
    // always advances and the loop cannot stall.
    let end = i;
    while (end < lines.length
      && !MD_FENCE.test(lines[end])
      && !MD_HEAD.test(lines[end])
      && !MD_QUOTE.test(lines[end])
      && !MD_BULLET.test(lines[end])) end += 1;
    flow(target, i, end);
    i = end;
  }

  // "Only emoji" has to mean at least one emoji: a line of colons matches
  // the shape and is not something to enlarge.
  return Boolean(text.trim())
    && EMOJI_ONLY_RE.test(text)
    && (replaced > 0 || PICTOGRAPHIC.test(text));
}

/**
 * What goes with the next message, and the chip that says so.
 *
 * One function rather than three places setting state.chat.pendingFile,
 * because the preview URL has to be revoked when it stops being used. An
 * object URL that nothing revokes holds the whole blob in memory for the
 * life of the window, and pasting screenshots into a chat box is exactly
 * the habit that produces a hundred of them.
 */
let pendingPreview = null;

/**
 * Whether there is anything to send.
 *
 * The button is disabled rather than hidden: an arrow that comes and goes
 * as you type moves the two buttons beside it, and a control that moves
 * while you are reaching for it is worse than one that is briefly grey.
 */
function applyComposer() {
  el.chatSend.disabled = !el.chatInput.value.trim() && !state.chat.pendingFile;
}

function setPendingFile(file) {
  state.chat.pendingFile = file ?? null;

  if (pendingPreview) {
    URL.revokeObjectURL(pendingPreview);
    pendingPreview = null;
  }

  el.chatPending.hidden = !file;
  applyComposer();
  if (!file) {
    el.chatPendingThumb.hidden = true;
    el.chatPendingThumb.removeAttribute('src');
    el.chatPendingName.textContent = '';
    return;
  }

  el.chatPendingName.textContent = file.name;
  el.chatPendingName.title = file.name;
  if (file.type.startsWith('image/')) {
    pendingPreview = URL.createObjectURL(file);
    el.chatPendingThumb.src = pendingPreview;
    el.chatPendingThumb.hidden = false;
  } else {
    el.chatPendingThumb.hidden = true;
    el.chatPendingThumb.removeAttribute('src');
  }
}

/** The strip of reactions under a message. Drawn only when there are some. */
function reactionRow(message) {
  const row = document.createElement('div');
  row.className = 'reactions';

  for (const reaction of message.reactions ?? []) {
    const mine = Boolean(reaction.userIds?.includes(state.auth.user?.id));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reaction';
    if (mine) button.setAttribute('data-mine', '');
    // Read at click time rather than captured, for the same reason the
    // roster rows are: the row is rebuilt under you by everybody else's
    // reactions, and `mine` from render time would be stale.
    button.addEventListener('click', () => toggleReaction(message.id, reaction.emoji));
    button.title = (reaction.userIds ?? []).map((id) => displayOf(id, 'someone')).join(', ');

    appendEmoji(button, reaction.emoji);
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(reaction.count);
    button.append(count);
    row.append(button);
  }

  return row;
}

/**
 * React, or take it back. The server works out which.
 *
 * `on` is computed here from the live message rather than from what the
 * button looked like when it was drawn, so two quick clicks cannot leave
 * the two sides disagreeing about whether you reacted.
 */
async function toggleReaction(messageId, emoji) {
  const message = state.chat.messages.find((m) => m.id === messageId);
  const existing = message?.reactions?.find((r) => r.emoji === emoji);
  const mine = Boolean(existing?.userIds?.includes(state.auth.user?.id));
  try {
    await harmony.api.react(state.server, messageId, emoji, !mine);
    // Everyone gets message:reactions, including us -- so nothing is drawn
    // here. One path updates the strip, whoever caused it.
    if (!mine) rememberEmoji(emoji);
  } catch (err) {
    showChannelsError(err.message);
  }
}

/** Your last few picks, newest first. Local -- it is about your hands. */
function rememberEmoji(value) {
  const recent = [value, ...(state.settings.recentEmoji ?? []).filter((v) => v !== value)]
    .slice(0, RECENT_EMOJI);
  state.settings.recentEmoji = recent;
  harmony.settings.set({ recentEmoji: recent }).catch(() => { /* a convenience */ });
}

// --- the picker ------------------------------------------------------------

/** What to do with the emoji that gets chosen. Set by openEmojiPicker. */
let emojiPick = null;
let emojiFilter = '';
/** The generated grid, built once and kept: 1400 buttons is not free. */
let standardWrap = null;
let dynamicWrap = null;

function emojiCell(value, label, custom) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'emoji-cell';
  button.dataset.value = value;
  button.dataset.label = label;
  button.title = `:${label}:`;
  if (custom) button.append(customEmojiImg(custom, ''));
  else button.textContent = value;
  return button;
}

function emojiSection(label, cells) {
  const wrap = document.createDocumentFragment();
  const head = document.createElement('div');
  head.className = 'emoji-section-head';
  head.textContent = label;
  const grid = document.createElement('div');
  grid.className = 'emoji-section';
  grid.append(...cells);
  wrap.append(head, grid);
  return wrap;
}

/**
 * The custom and recent sections, which change, and the search results.
 *
 * Separated from the generated grid because that one does not change at
 * all: rebuilding fourteen hundred buttons every time somebody types a
 * letter is the difference between a picker that opens and one that
 * stutters.
 */
function renderEmojiPicker() {
  if (!dynamicWrap || el.emojiPop.hidden) return;

  const filter = emojiFilter;
  const nodes = [];

  if (filter) {
    const cells = [];
    for (const emoji of state.emojis.list) {
      if (emoji.name.includes(filter)) cells.push(emojiCell(`:${emoji.name}:`, emoji.name, emoji));
    }
    for (const section of EMOJI_SECTIONS) {
      for (const [ch, name] of section.items) {
        if (cells.length >= EMOJI_RESULT_CAP) break;
        if (name.includes(filter)) cells.push(emojiCell(ch, name, null));
      }
    }
    if (cells.length) nodes.push(emojiSection(`Matching "${el.emojiSearch.value}"`, cells));
    el.emojiEmpty.hidden = cells.length > 0;
    el.emojiEmpty.textContent = `Nothing called "${el.emojiSearch.value}".`;
  } else {
    el.emojiEmpty.hidden = true;

    if (state.emojis.list.length) {
      nodes.push(emojiSection('This server', state.emojis.list.map((emoji) => {
        const cell = emojiCell(`:${emoji.name}:`, emoji.name, emoji);
        // Yours, or anybody's if you are an admin -- the rule the server
        // enforces, so a button that appears always works.
        if (emoji.uploadedBy !== state.auth.user?.id && !isAdmin()) return cell;
        const wrap = document.createElement('span');
        wrap.className = 'emoji-cell-wrap';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'emoji-remove';
        remove.textContent = '\u00d7';
        remove.title = `Remove :${emoji.name}:`;
        remove.addEventListener('click', async (event) => {
          event.stopPropagation();
          if (!await askConfirm(`Remove :${emoji.name}:?`, {
            text: 'Reactions that used it keep their count and fall back to the text.',
            okLabel: 'Remove',
          })) return;
          try {
            await harmony.api.deleteEmoji(state.server, emoji.id);
          } catch (err) {
            showChannelsError(err.message);
          }
        });
        wrap.append(cell, remove);
        return wrap;
      })));
    }

    const recent = (state.settings.recentEmoji ?? []).slice(0, RECENT_EMOJI);
    if (recent.length) {
      nodes.push(emojiSection('Recent', recent.map((value) => {
        const match = /^:([a-z0-9_]{2,32}):$/i.exec(value);
        const custom = match ? state.emojis.byName.get(match[1].toLowerCase()) : null;
        // A custom emoji that has since been removed still sits in the
        // list; it is drawn as its text rather than dropped, because
        // silently losing something out of "recent" is confusing.
        return emojiCell(value, match ? match[1] : value, custom);
      })));
    }
  }

  dynamicWrap.replaceChildren(...nodes);
  standardWrap.hidden = Boolean(filter);
}

/**
 * Build the generated sections, a section at a time, out of idle time.
 *
 * Fourteen hundred buttons is about a tenth of a second of DOM work, and
 * doing it on the click meant the picker took that long to appear the first
 * time -- the one time a person has no idea whether it is coming.
 *
 * So it is started when the channels view opens and spread across idle
 * callbacks, and the picker never waits for it. Opening early is still
 * useful: searching builds its own small list and hides this one, so the
 * box at the top works before the grid under it has finished arriving.
 *
 * One section per callback rather than a fixed number of cells, because a
 * section boundary is the only place the grid is coherent -- stopping half
 * way through one would leave a heading with nothing under it if the build
 * were ever interrupted.
 */
function scheduleEmojiGrid() {
  if (standardWrap) return;

  dynamicWrap = document.createElement('div');
  standardWrap = document.createElement('div');
  el.emojiGrid.replaceChildren(dynamicWrap, standardWrap);

  const idle = window.requestIdleCallback
    ?? ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 0));

  let index = 0;
  const step = (deadline) => {
    do {
      const section = EMOJI_SECTIONS[index];
      standardWrap.append(emojiSection(section.label, section.items.map(
        ([ch, name]) => emojiCell(ch, name, null),
      )));
      index += 1;
      // At least one section per callback, or a busy machine never
      // finishes: timeRemaining() can be 0 on every single call.
    } while (index < EMOJI_SECTIONS.length && deadline.timeRemaining() > 4);

    if (index < EMOJI_SECTIONS.length) idle(step);
  };
  idle(step);
}

/**
 * Open the picker over something, and say where the answer goes.
 *
 * One popover for the composer and for every message, because it is the
 * same grid and the same search -- the only difference is the callback.
 * Measured and clamped for the same reason the soundboard is: it is fixed,
 * and a fixed element has no idea where its button is.
 */
function openEmojiPicker(anchorEl, onPick) {
  // Idempotent, and it does NOT wait: if the background build has not
  // finished, the picker opens with what there is and fills in behind.
  scheduleEmojiGrid();
  emojiPick = onPick;
  emojiFilter = '';
  el.emojiSearch.value = '';
  el.emojiPop.hidden = false;
  el.emojiPreview.replaceChildren();
  renderEmojiPicker();

  const anchor = anchorEl.getBoundingClientRect();
  const box = el.emojiPop.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, anchor.left - box.width / 2),
    Math.max(8, window.innerWidth - box.width - 8),
  );
  const above = anchor.top - box.height - 8;
  el.emojiPop.style.left = `${left}px`;
  el.emojiPop.style.top = above >= 8
    ? `${above}px`
    : `${Math.min(anchor.bottom + 8, window.innerHeight - box.height - 8)}px`;

  el.emojiSearch.focus();
}

function closeEmojiPicker() {
  el.emojiPop.hidden = true;
  emojiPick = null;
}

/**
 * Downscale a picked image and register it as an emoji.
 *
 * Fit, not cover -- unlike an avatar. An avatar is a circle and cropping it
 * is the point; an emoji's shape IS the joke, and cropping a wide one in
 * half ruins it.
 *
 * PNG rather than the avatar's JPEG, because an emoji without transparency
 * is a white rectangle sitting in a line of text.
 */
async function uploadCustomEmoji(file) {
  try {
    showChannelsError('');
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, EMOJI_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
    if (!blob) throw new Error('Could not read that image.');
    if (blob.size > EMOJI_MAX_BYTES) {
      throw new Error('That picture is too detailed to shrink into an emoji.');
    }

    const answer = await ask({
      title: 'Name this emoji',
      text: 'The name is the trigger: typing it between colons puts the picture '
        + 'in a message. Letters, numbers and underscores.',
      okLabel: 'Add',
      fields: [{
        name: 'name',
        label: 'Name',
        value: file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_')
          .slice(0, 32),
        required: true,
        maxlength: 32,
      }],
    });
    if (!answer?.name) return;

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const upload = await harmony.media.upload(state.server, bytes, 'image/png');
    await harmony.api.addEmoji(state.server, { name: answer.name, hash: upload.hash });
    // The server pushes the new list to everybody, this client included.
  } catch (err) {
    showChannelsError(err.message);
  }
}

/**
 * An attachment: the thing itself, and a line saying what it is called
 * with a button to keep it.
 *
 * The name line is there for every kind, including pictures. A picture you
 * can see still has a filename, and the filename is what you are about to
 * save it as.
 *
 * There used to be an <a href="harmony://app/media/..."> for anything that
 * was not image, video or audio. That was a bug as well as a gap: nothing
 * guards will-navigate, so clicking it navigated the RENDERER to the PDF
 * and replaced the entire app with it, with no way back but a restart.
 * Nothing here is a link.
 */
function attachmentNode(message) {
  // harmony://app/media/<hash> -- same-origin, so the CSP allows it, and the
  // main process downloads and verifies it on first use. See media-cache.js.
  const url = harmony.mediaUrl(message.attachmentHash);
  const wrap = document.createElement('span');
  wrap.className = 'attachment';
  const previewable = ['image', 'video', 'audio'].includes(message.mediaType);

  if (message.mediaType === 'image') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = message.attachmentName ?? 'attachment';
    img.loading = 'lazy';
    // Only images. A video has controls of its own and a click on it means
    // play, which is not something to take away for a bigger picture.
    img.className = 'expandable';
    img.title = 'Click to expand';
    img.addEventListener('click', () => openLightbox(message));
    wrap.append(img);
  } else if (message.mediaType === 'video') {
    const video = document.createElement('video');
    video.src = url;
    video.controls = true;
    wrap.append(video);
  } else if (message.mediaType === 'audio') {
    const audio = document.createElement('audio');
    audio.src = url;
    audio.controls = true;
    wrap.append(audio);
  }

  const bar = document.createElement('span');
  bar.className = 'attachment-bar';

  const name = document.createElement('span');
  name.className = 'attachment-name';
  // Messages posted before the server stored names have none, and saying
  // so is better than inventing one -- the save dialog will suggest
  // something derived from the content type.
  name.textContent = message.attachmentName ?? 'attachment';
  name.title = name.textContent;
  bar.append(name);
  wrap.append(bar);

  /*
   * The two things you do to a file, floating over its top-right corner.
   *
   * On the attachment rather than in the message badge above, because
   * that badge is about the MESSAGE -- react, pin, edit the words, delete
   * the lot -- and these are about the file. On a message with a picture
   * and a sentence, the two sets answer different questions and putting
   * them in one row makes you read all six to find either.
   */
  const tools = document.createElement('span');
  // Floating over the preview where there is one; on the end of the
  // filename line where there is not, since a PDF has nothing to float
  // over but the one thing the row says.
  tools.className = previewable ? 'attachment-tools' : 'attachment-tools inline';

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'msg-tool';
  save.dataset.glyph = '\u2b07';
  save.textContent = 'Save';
  save.title = 'Save a copy';
  save.addEventListener('click', async (event) => {
    event.stopPropagation();
    save.disabled = true;
    try {
      const result = await harmony.media.save(
        message.attachmentHash, message.attachmentName ?? '',
      );
      // Cancelling a save dialog is an answer, not a failure.
      if (!result.saved) return;
      el.chatNote.textContent = `Saved ${result.name}.`;
      // The one useful thing to do next, offered where the answer is.
      const show = document.createElement('button');
      show.type = 'button';
      show.className = 'ghost tiny';
      show.textContent = 'Show';
      show.addEventListener('click', () => harmony.media.reveal(result.path));
      el.chatNote.append(' ', show);
    } catch (err) {
      showChannelsError(err.message);
    } finally {
      save.disabled = false;
    }
  });
  tools.append(save);

  // Your own only, the same rule the server enforces for editing the
  // words: swapping somebody's picture under their name puts something in
  // their mouth, while deleting the message is visible to everyone.
  if (message.userId === state.auth.user?.id) {
    const swap = document.createElement('button');
    swap.type = 'button';
    swap.className = 'msg-tool';
    swap.dataset.glyph = '\u270E';
    swap.textContent = 'Replace';
    swap.title = 'Replace this file';
    swap.addEventListener('click', (event) => {
      event.stopPropagation();
      replaceAttachment(message);
    });
    tools.append(swap);
  }

  if (previewable) wrap.append(tools);
  else bar.append(tools);
  return wrap;
}

/**
 * Pick a new file for a message that already has one.
 *
 * Its own hidden input, created and thrown away per use rather than one
 * shared with the composer: the composer's input sets the PENDING
 * attachment for the next message, and sharing it would mean one change
 * event with two possible meanings.
 */
function replaceAttachment(message) {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.hidden = true;
  document.body.append(picker);

  picker.addEventListener('change', async () => {
    const file = picker.files?.[0] ?? null;
    picker.remove();
    if (!file) return;
    try {
      showChannelsError('');
      el.chatNote.textContent = `Uploading ${file.name}\u2026`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const upload = await harmony.media.upload(state.server, bytes, file.type);
      await harmony.api.setAttachment(state.server, message.id, {
        hash: upload.hash, name: file.name,
      });
      el.chatNote.textContent = '';
      // The server pushes message:updated to everyone, us included.
    } catch (err) {
      el.chatNote.textContent = '';
      showChannelsError(err.message);
    }
  }, { once: true });

  picker.click();
}

/**
 * A picture, full size, over everything.
 *
 * The <img> src is set to the SAME harmony:// URL the thumbnail uses, so
 * the file is already in the cache and already decoded -- opening one is
 * instant and costs no second download.
 */
let lightboxOf = null;

function openLightbox(message) {
  lightboxOf = message;
  el.lightboxImg.src = harmony.mediaUrl(message.attachmentHash);
  el.lightboxImg.alt = message.attachmentName ?? 'attachment';
  el.lightboxName.textContent = message.attachmentName ?? 'attachment';
  el.lightbox.hidden = false;
}

function closeLightbox() {
  el.lightbox.hidden = true;
  // Dropped, or the decoded bitmap of the last picture anybody looked at
  // stays in memory for as long as the app is open.
  el.lightboxImg.removeAttribute('src');
  lightboxOf = null;
}

/**
 * How close together two messages from the same person stay one block.
 *
 * Five minutes is long enough that a conversation reads as a conversation
 * and short enough that coming back after lunch starts a new one with your
 * name on it.
 */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * One message row.
 *
 * Three parts: the picture in a column of its own, the name and the time on
 * a line above, and the words below them. The whole row used to be one
 * line -- picture, name, words, time -- which reads fine for "hello" and
 * falls apart the moment anything is longer than the pane, because the
 * words wrap under the picture and the next message starts in the middle
 * of the last one.
 *
 * A run from the same person within GROUP_WINDOW_MS drops the picture and
 * the header and keeps only the words, with the time appearing in the
 * gutter on hover. Without that, a back-and-forth is mostly somebody's
 * name and face repeated at every line, which is the thing the layout was
 * meant to stop.
 *
 * @param {object} message
 * @param {object} [previous]  the message drawn immediately above this one
 */
function messageRow(message, previous) {
  const row = document.createElement('div');
  row.className = 'chat-msg';
  row.dataset.id = String(message.id);
  if (message.pinned) row.setAttribute('data-pinned', '');

  const grouped = Boolean(previous)
    && previous.userId === message.userId
    // A pin is a horizontal rule in all but name: it marks a message out,
    // and swallowing the one under it into the same block hides which one
    // was pinned.
    && !previous.pinned
    && !message.pinned
    && message.createdAt - previous.createdAt < GROUP_WINDOW_MS;
  if (grouped) row.setAttribute('data-grouped', '');

  const text = document.createElement('span');
  text.className = 'text';
  // Text nodes and images only -- see renderBody. A chat message is the most
  // obvious place in the app for someone to try injecting markup.
  if (renderBody(text, message.body)) row.setAttribute('data-emoji-only', '');
  if (message.editedAt) {
    // Inside .text, after the words, so it wraps with them rather than
    // sitting in a column of its own that every unedited row pays for.
    const edited = document.createElement('span');
    edited.className = 'edited-mark';
    edited.textContent = ' (edited)';
    edited.title = new Date(message.editedAt).toLocaleString();
    text.append(edited);
  }
  if (mentionsMe(message) && message.userId !== state.auth.user?.id) {
    row.setAttribute('data-mentions-me', '');
  }

  if (message.attachmentHash) text.append(attachmentNode(message));

  const when = document.createElement('span');
  when.className = 'when';
  when.textContent = new Date(message.createdAt).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit',
  });
  when.title = new Date(message.createdAt).toLocaleString();

  /*
   * The controls, as a badge that floats over the top-right corner.
   *
   * In the flow they were three labelled buttons on every row, so a quiet
   * channel read as a column of the word "Delete" rather than as a
   * conversation. Out of the flow they cost nothing until the pointer is
   * on the message.
   *
   * The LABEL stays as the button's textContent and is collapsed by
   * font-size: 0, with the glyph drawn from data-glyph -- the same trick
   * the voice panel uses, for the same two reasons: a screen reader still
   * reads "Delete", and the test that clicks these finds them by their
   * words.
   */
  const tools = document.createElement('span');
  tools.className = 'msg-tools';

  const react = document.createElement('button');
  react.className = 'msg-tool react-btn';
  react.dataset.glyph = '\u{1F600}';
  react.textContent = 'React';
  react.title = 'Add a reaction';
  react.addEventListener('click', () => openEmojiPicker(react, (value) => {
    closeEmojiPicker();
    toggleReaction(message.id, value);
  }));

  const pin = document.createElement('button');
  pin.className = 'msg-tool';
  pin.dataset.glyph = '\u{1F4CC}';
  pin.textContent = message.pinned ? 'Unpin' : 'Pin';
  pin.title = pin.textContent;
  if (message.pinned) pin.setAttribute('data-on', '');
  pin.addEventListener('click', async () => {
    try {
      await harmony.api.pinMessage(state.server, message.id, !message.pinned);
    } catch (err) {
      showChannelsError(err.message);
    }
  });

  tools.append(react, pin);

  /*
   * The left column, and what fills it.
   *
   * On a grouped row the picture is replaced by the timestamp, which is
   * invisible until the row is hovered: the column has to keep its width
   * either way, or every grouped line would sit a face's width to the left
   * of the one above it.
   */
  const gutter = grouped
    ? when
    : avatarEl(faceOf(message.userId, message.nickname), 'msg-avatar');
  if (grouped) when.classList.add('when-gutter');

  const main = document.createElement('div');
  main.className = 'msg-main';

  if (!grouped) {
    const head = document.createElement('div');
    head.className = 'msg-head';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = displayOf(message.userId, message.nickname);
    head.append(who, when);
    main.append(head);
  }
  main.append(text);

  /*
   * Editing, and only your own.
   *
   * An admin can delete anybody's message and cannot edit one, which is the
   * single place this app's admin powers are narrower rather than wider.
   * Deleting removes a message and everybody can see that it is gone;
   * editing would put words in somebody's mouth under their name, and
   * nothing on the screen could tell the difference.
   *
   * A dialog rather than editing in place, and the reason is renderChat:
   * it rebuilds every row from scratch on every push, so an in-place
   * editor would be destroyed mid-sentence by somebody else's message
   * arriving. Keeping it alive across that is a pile of state about
   * drafts and caret positions, and this is a friends' chat.
   */
  if (message.userId === state.auth.user?.id) {
    const change = document.createElement('button');
    change.className = 'msg-tool';
    change.dataset.glyph = '\u270E';
    change.textContent = 'Edit';
    change.title = 'Edit';
    change.addEventListener('click', async () => {
      const answer = await ask({
        title: 'Edit message',
        okLabel: 'Save',
        fields: [{
          name: 'body',
          label: 'Message',
          value: message.body,
          multiline: true,
          maxlength: 4000,
          required: !message.attachmentHash,
        }],
      });
      if (answer === null || answer.body === message.body) return;
      try {
        await harmony.api.editMessage(state.server, message.id, answer.body);
        // The server pushes message:updated to everyone, us included.
      } catch (err) {
        showChannelsError(err.message);
      }
    });
    tools.append(change);
  }
  row.append(gutter, main, tools);

  // Your own, or anybody's if you are an admin -- the same rule the server
  // enforces, so a button that appears always works.
  if (message.userId === state.auth.user?.id || isAdmin()) {
    const remove = document.createElement('button');
    remove.className = 'msg-tool msg-tool-danger';
    remove.dataset.glyph = '\u{1F5D1}';
    remove.textContent = 'Delete';
    remove.title = 'Delete';
    remove.addEventListener('click', async () => {
      if (!await askConfirm('Delete this message?', { okLabel: 'Delete' })) return;
      try {
        await harmony.api.deleteMessage(state.server, message.id);
        // The server pushes message:deleted to everyone, including us.
      } catch (err) {
        showChannelsError(err.message);
      }
    });
    tools.append(remove);
  }

  // Under the words rather than beside them, and inside the main column so
  // it lines up with them rather than with the picture.
  if (message.reactions?.length) main.append(reactionRow(message));

  return row;
}

/**
 * Render the log.
 *
 * The only subtle part is four lines: capture whether the pane was already at
 * the bottom BEFORE appending, and only auto-scroll if it was. Without that,
 * reading back through history gets yanked to the end by every new message
 * that arrives.
 */
function renderChat({ scrollToBottom = false } = {}) {
  const log = el.chatLog;
  const wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;

  // (m, i, all) rather than a bare reference to messageRow: map passes the
  // index as the second argument, which is now the "previous message"
  // parameter and would be a number.
  log.replaceChildren(
    ...state.chat.messages.map((m, i, all) => messageRow(m, all[i - 1])),
  );

  if (state.chat.pinned.length) {
    el.chatPinned.hidden = false;
    el.chatPinned.replaceChildren(
      ...state.chat.pinned.map((m) => {
        const line = document.createElement('button');
        line.type = 'button';
        line.className = 'pinned-line';
        line.title = 'Jump to this message';

        const who = document.createElement('strong');
        who.textContent = displayOf(m.userId, m.nickname);
        const what = document.createElement('span');
        what.textContent = m.body || '(attachment)';

        line.append(who, what);
        line.addEventListener('click', () => jumpToMessage(m.id));
        return line;
      }),
    );
  } else {
    el.chatPinned.hidden = true;
  }

  if (scrollToBottom || wasAtBottom) log.scrollTop = log.scrollHeight;
}

/**
 * Scroll to a message, loading older pages until it is there.
 *
 * A pinned message is pinned precisely because it is worth coming back to,
 * and by the time anybody comes back it is usually well above the page the
 * channel opens on. The strip used to be a list of text you could read and
 * not reach, which is the least useful half of a pin.
 *
 * The loop is bounded. `before` paging always makes progress -- each round
 * asks for messages older than the oldest one held -- but a pin whose
 * message has been deleted would otherwise page to the beginning of the
 * channel before giving up, and on a long channel that is a lot of
 * requests to discover there is nothing to show.
 */
const JUMP_MAX_PAGES = 20;

async function jumpToMessage(id) {
  const find = () => el.chatLog.querySelector(`.chat-msg[data-id="${id}"]`);
  let row = find();

  for (let page = 0; !row && page < JUMP_MAX_PAGES; page += 1) {
    const oldest = state.chat.messages[0]?.id;
    if (!oldest) break;
    let older;
    try {
      ({ messages: older } = await harmony.api.messages(
        state.server, state.chat.channelId, oldest,
      ));
    } catch (err) {
      el.chatNote.textContent = err.message;
      return;
    }
    if (!older?.length) break;
    state.chat.messages = [...older, ...state.chat.messages];
    // Without scrollToBottom: the whole point is to land somewhere that is
    // not the bottom, and renderChat would otherwise keep us there because
    // that is where we were when this started.
    renderChat();
    row = find();
  }

  if (!row) {
    el.chatNote.textContent = 'That message is no longer in this channel.';
    return;
  }

  el.chatNote.textContent = '';
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // A flash rather than a lasting highlight: it answers "which one" and
  // then stops competing with the message for attention.
  row.setAttribute('data-jumped', '');
  setTimeout(() => row.removeAttribute('data-jumped'), 1600);
}

async function sendMessage() {
  const body = el.chatInput.value.trim();
  const file = state.chat.pendingFile;
  if (!body && !file) return;

  el.chatInput.value = '';
  // Back to one row. Without this the box keeps the height of the message
  // that has just left it.
  growChatInput();
  applyComposer();
  // The list it was tracking has an empty box now, and nothing it could
  // offer would go anywhere.
  closeMentions();
  setPendingFile(null);
  el.chatNote.textContent = '';

  try {
    let attachmentHash = null;
    let attachmentName = null;
    if (file) {
      el.chatNote.textContent = `Uploading ${file.name}\u2026`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const upload = await harmony.media.upload(state.server, bytes, file.type);
      attachmentHash = upload.hash;
      attachmentName = file.name;
      el.chatNote.textContent = '';
    }
    await harmony.api.postMessage(state.server, state.chat.channelId, {
      body, attachmentHash, attachmentName,
    });
    // The server echoes it back over the socket, so nothing is appended here.
  } catch (err) {
    el.chatNote.textContent = err.message;
    el.chatInput.value = body; // give them their text back
    applyComposer();
  }
}

async function runSearch() {
  const query = el.chatSearch.value.trim();
  if (!query) {
    state.chat.searching = false;
    el.chatSearchClear.hidden = true;
    return openTextChannel(state.channels.list.find((c) => c.id === state.chat.channelId));
  }

  try {
    const { mode, results } = await harmony.api.search(state.server, state.chat.channelId, query);
    state.chat.searching = true;
    state.chat.messages = results.slice().reverse();
    el.chatSearchClear.hidden = false;
    renderChat({ scrollToBottom: true });
    el.chatNote.textContent = results.length
      // Worth saying: a 1-2 character query silently cannot use the trigram
      // index, so it falls back to a plain substring scan. Showing which ran
      // makes "why did that find nothing" answerable.
      ? `${results.length} result${results.length === 1 ? '' : 's'} (${mode})`
      : `No matches (${mode}).`;
  } catch (err) {
    el.chatNote.textContent = err.message;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Soundpad
// ---------------------------------------------------------------------------

async function loadSoundpad() {
  try {
    const { clips } = await harmony.api.soundpad(state.server);
    state.soundpad.clips = clips;
    renderSoundpad();
    syncHotkeys();
    // Clips must survive cache eviction: the first press of a button should
    // never be a 300 ms download, and they are small.
    await refreshKeepSet();
    // Warm the cache now rather than on the first click. The protocol handler
    // downloads on demand, so simply asking for each URL is enough.
    for (const clip of clips) {
      fetch(harmony.mediaUrl(clip.hash)).catch(() => { /* will retry on click */ });
    }
  } catch (err) {
    showChannelsError(err.message);
  }
}

/**
 * How loudly clips play here, as a gain.
 *
 * Read from settings every time rather than cached, for the same reason the
 * device pickers re-read them: a second window, or a previous run, can have
 * changed it, and the only thing worse than a volume that does not persist
 * is one that persists differently in two places.
 */
function soundpadGain() {
  const percent = state.settings.soundpadVolume;
  return Math.max(0, Math.min(MAX_GAIN, (typeof percent === 'number' ? percent : 100) / 100));
}

/** Paint the soundpad's own volume control from the saved setting. */
function applySoundpadVolume() {
  const percent = typeof state.settings.soundpadVolume === 'number'
    ? state.settings.soundpadVolume
    : 100;
  // Reuses the per-person treatment, including the amber warning past 100%:
  // a clip amplified three and a half times is exactly as likely to distort
  // as a person is, and it is the same slider doing the same thing.
  showVolume(el.soundpadVolume, el.soundpadVolumeLabel, percent, false);
  el.soundpadMute.innerHTML = percent === 0 ? '&#128263;' : '&#128266;';
  el.soundpadMute.title = percent === 0 ? 'Unmute the soundpad' : 'Mute the soundpad';
  el.soundpadMute.toggleAttribute('data-on', percent === 0);
}

/** What is typed in the search box, lower-cased once rather than per clip. */
let soundpadFilter = '';

/*
 * How big everything is drawn.
 *
 * Main owns the clamp -- it is the only place that can be sure of the
 * number, since the setting is a value in a file somebody can edit -- and
 * it hands back what it actually used. So the slider is drawn from main's
 * answer rather than from what was asked for, and a value out of range
 * corrects itself on screen instead of lying.
 */
const SCALE_DEFAULT = 115;

async function applyScale(percent, { save = true } = {}) {
  const used = await harmony.setScale(percent);
  el.uiScale.value = String(used);
  el.scaleValue.textContent = `${used}%`;
  if (save) {
    await harmony.settings.set({ uiScale: used });
    state.settings = await harmony.settings.get();
  }
  return used;
}

/**
 * Open the soundboard above the button that opened it.
 *
 * Measured and clamped rather than positioned by CSS, because the panel is
 * fixed -- it has to be, since the sidebar it is anchored to scrolls -- and
 * a fixed element has no idea where its button is.
 */
function openSoundpad() {
  el.soundpad.hidden = false;
  soundpadFilter = '';
  el.soundpadSearch.value = '';
  renderSoundpad();

  const anchor = el.voiceSoundboard.getBoundingClientRect();
  // Shown before measuring: a hidden element has no size, and the clamp
  // below needs one.
  const box = el.soundpad.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, anchor.left),
    Math.max(8, window.innerWidth - box.width - 8),
  );
  // Above the button where there is room, below it where there is not.
  const above = anchor.top - box.height - 8;
  el.soundpad.style.left = `${left}px`;
  el.soundpad.style.top = `${above >= 8 ? above : Math.min(anchor.bottom + 8, window.innerHeight - box.height - 8)}px`;

  el.soundpadSearch.focus();
  applyVoiceButtons();
}

function closeSoundpad() {
  el.soundpad.hidden = true;
  applyVoiceButtons();
}

/**
 * Play a clip for the whole channel. From a click or from a hotkey.
 *
 * Only the event is sent. Every client plays its own cached copy -- see the
 * Soundpad comment in the server's chat.js for why.
 */
function playSoundpadClip(clip, button = null) {
  if (!state.voice.channelId) {
    showChannelsError('Join a voice channel first.');
    return undefined;
  }
  // Acknowledged on the button rather than by closing the panel: people
  // fire several in a row, and a soundboard that shuts after one is a
  // soundboard you have to reopen to use.
  if (button) {
    button.setAttribute('data-playing', '');
    setTimeout(() => button.removeAttribute('data-playing'), 350);
  }
  return harmony.realtime
    .request('soundpad:play', { channelId: state.voice.channelId, clipId: clip.id })
    .catch((err) => showChannelsError(err.message));
}

function renderSoundpad() {
  el.soundpadAdd.hidden = !isAdmin();
  applySoundpadVolume();
  if (el.soundpad.hidden) return;

  const clips = state.soundpad.clips;
  const shown = soundpadFilter
    ? clips.filter((c) => c.name.toLowerCase().includes(soundpadFilter))
    : clips;

  el.soundpadEmpty.hidden = shown.length > 0;
  el.soundpadEmpty.textContent = clips.length === 0
    ? (isAdmin() ? 'No clips yet. Add one.' : 'Nobody has added any clips.')
    : `Nothing matching "${el.soundpadSearch.value}".`;

  el.soundpadGrid.replaceChildren(...shown.map((clip) => {
    const cell = document.createElement('span');
    cell.className = 'clip-cell';

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'clip-play';
    if (clip.emoji) {
      const emoji = document.createElement('span');
      emoji.className = 'clip-emoji';
      emoji.textContent = clip.emoji;
      play.append(emoji);
    }
    const name = document.createElement('span');
    name.className = 'clip-name';
    name.textContent = clip.name;
    play.append(name);
    play.title = clip.name;

    const bound = clipHotkey(clip.id);
    if (bound) {
      const key = document.createElement('span');
      key.className = 'clip-key';
      key.textContent = formatAccelerator(bound);
      play.append(key);
      play.title = `${clip.name} (${formatAccelerator(bound)})`;
    }

    play.addEventListener('click', () => playSoundpadClip(clip, play));

    // Hotkeys are personal, so this is for everybody, not only admins.
    cell.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const current = clipHotkey(clip.id);
      openRowMenu(clip.name, [
        {
          label: current ? `Change hotkey (${formatAccelerator(current)})` : 'Set hotkey',
          title: 'Play this clip from anywhere, even inside a game',
          run: () => editHotkey(`clip:${clip.id}`, clip.name),
        },
        ...(current ? [{
          label: 'Remove hotkey',
          title: 'Stop this combination playing the clip',
          run: () => saveHotkey(`clip:${clip.id}`, ''),
        }] : []),
      ], event);
    });

    cell.append(play);
    if (!isAdmin()) return cell;

    /*
     * Admin controls, layered on top of the clip rather than beside it.
     *
     * Beside, three buttons in an 8.5rem cell leave about two centimetres
     * for the name -- and the arrows are used once, when the clip is added,
     * while the clip itself is used constantly.
     *
     * Positions are read off the FULL list, not the filtered one: nudging a
     * clip while a search is active has to move it past the clip that is
     * really next, not past the next one you happen to be looking at.
     */
    const index = clips.indexOf(clip);
    const tools = document.createElement('span');
    tools.className = 'clip-tools';
    const tool = (glyph, title, run, disabled = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = glyph;
      b.title = title;
      b.disabled = disabled;
      b.addEventListener('click', (event) => {
        event.stopPropagation();
        run();
      });
      return b;
    };
    tools.append(
      tool('\u25C0', 'Move left', () => nudgeClip(clip.id, -1), index === 0),
      tool('\u25B6', 'Move right', () => nudgeClip(clip.id, 1), index === clips.length - 1),
      tool('\u270E', 'Rename', () => editClip(clip)),
      tool('\u2715', 'Delete', async () => {
        if (!await askConfirm(`Delete the clip "${clip.name}"?`, { okLabel: 'Delete' })) return;
        try {
          await harmony.api.deleteClip(state.server, clip.id);
        } catch (err) {
          showChannelsError(err.message);
        }
      }),
    );
    cell.append(tools);
    return cell;
  }));
}

/** Change a clip's label. The audio behind it is untouched. */
async function editClip(clip) {
  const answer = await ask({
    title: `Rename "${clip.name}"`,
    text: 'The emoji is optional, and is what makes a clip findable in a grid '
      + 'of twenty identical buttons.',
    okLabel: 'Save',
    fields: [
      { name: 'emoji', label: 'Emoji', value: clip.emoji ?? '', placeholder: '\u{1F4EF}' },
      { name: 'name', label: 'Name', value: clip.name, required: true, maxlength: 32 },
    ],
  });
  if (!answer?.name) return;
  try {
    await harmony.api.renameClip(state.server, clip.id, {
      name: answer.name, emoji: answer.emoji,
    });
  } catch (err) {
    showChannelsError(err.message);
  }
}

/**
 * Move a clip one place. The whole list is sent, as with the channels.
 *
 * Lost with MAX_CLIP_BYTES in the same rewrite, and invisible for the same
 * reason: its only callers are the two arrows inside renderSoundpad, so the
 * ReferenceError waited until somebody pressed one.
 */
async function nudgeClip(id, delta) {
  const ids = state.soundpad.clips.map((c) => c.id);
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ...ids.splice(from, 1));
  try {
    await harmony.api.reorderClips(state.server, ids);
  } catch (err) {
    showChannelsError(err.message);
  }
}

/*
 * The server's own per-clip ceiling, repeated here so the refusal happens
 * before a two-megabyte upload rather than after it.
 *
 * It was deleted along with the old soundpad markup when the pad became a
 * popover, and nothing noticed: the only reference is inside addSoundpadClip,
 * so the file picked up a ReferenceError that only fired when somebody
 * actually added a clip. Which is the argument for the test that caught it --
 * every other soundpad test puts clips in through the API.
 */
const MAX_CLIP_BYTES = 2 * 1024 * 1024;

async function addSoundpadClip(file) {
  try {
    el.channelsError.hidden = true;
    if (file.size > MAX_CLIP_BYTES) {
      throw new Error(
        `"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB. Clips are limited to `
        + `${MAX_CLIP_BYTES / 1024 / 1024} MB -- every client downloads every clip.`,
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const upload = await harmony.media.upload(state.server, bytes, file.type);
    const answer = await ask({
      title: 'Name this clip',
      text: 'The emoji is optional, and is what makes a clip findable in a grid '
        + 'of twenty identical buttons.',
      okLabel: 'Add',
      fields: [
        { name: 'emoji', label: 'Emoji', value: '', placeholder: '\u{1F4EF}' },
        {
          name: 'name',
          label: 'Name',
          value: file.name.replace(/\.[^.]+$/, '').slice(0, 32),
          required: true,
          maxlength: 32,
        },
      ],
    });
    if (!answer?.name) return;
    await harmony.api.addClip(state.server, {
      name: answer.name, emoji: answer.emoji, hash: upload.hash,
    });
  } catch (err) {
    showChannelsError(err.message);
  }
}

// ---------------------------------------------------------------------------
// Webcam
//
// A SECOND publish under `<nickname>-cam`, not a second track on the existing
// one: MediaMTX's WHIP cannot renegotiate an added track (measured in the
// Phase 0 spike -- PATCH accepts only ICE trickle fragments), so adding a
// camera to a live path would mean tearing it down and cutting the audio
// everyone is listening to.
//
// This reuses publish() untouched, which is also how the H.264 High-profile
// ordering is preserved here by construction rather than by copying it.
// ---------------------------------------------------------------------------

const CAMERA = { width: 640, height: 360, frameRate: 24, bitrate: 400_000 };

/**
 * Open a camera, preferring the chosen one.
 *
 * `exact` rather than `ideal` so that a device which is gone FAILS instead of
 * silently handing back a different webcam -- the caller falls back to the
 * default itself, and says so. The preference is never rewritten, which is
 * what lets a camera that is plugged back in be picked up again.
 */
const openCamera = (deviceId) => navigator.mediaDevices.getUserMedia({
  video: {
    width: { ideal: CAMERA.width },
    height: { ideal: CAMERA.height },
    frameRate: { ideal: CAMERA.frameRate },
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  },
});

async function startCamera() {
  if (state.camera.publication || state.voice.camLive) return;
  const nickname = state.auth.user?.nickname;
  if (!nickname) return showChannelsError('Sign in first.');

  try {
    const wanted = state.settings.voiceCameraId ?? '';
    let stream = wanted ? await openCamera(wanted).catch(() => null) : null;
    if (!stream) {
      if (wanted) deviceNote('Your chosen camera is unplugged. Using the default one.');
      stream = await openCamera('');
    }

    /*
     * Inside a voice channel the camera goes to the CHANNEL path.
     *
     * That is what makes it part of the channel mosaic: the other members
     * already hold a read token for this channel, and they learn there is
     * something to watch from the roster rather than from the flat stream
     * list. It also means a camera shared into a locked channel is not
     * visible to someone who never got in, which the flat `<nickname>-cam`
     * namespace cannot express.
     *
     * Outside one it falls back to the flat path, which is how a camera is
     * watchable from the ordinary mosaic by a client that knows nothing about
     * channels.
     */
    if (state.voice.channelId) {
      // A camera is usually started well into a call, which is exactly when
      // the join-time token has gone stale.
      await refreshVoiceTokens();
      await state.voice.startCam(stream, {
        bitrate: CAMERA.bitrate,
        framerate: CAMERA.frameRate,
      });
      await harmony.realtime.request('voice:publishing', {
        channelId: state.voice.channelId, kind: 'c', on: true,
      });
      applyVoiceButtons();
      renderChannelVideo();
      return undefined;
    }

    state.camera.stream = stream;

    // The server appends `-cam` to our authenticated nickname itself; we
    // cannot and must not name the path. `-cam` is refused as a registerable
    // nickname, so nobody else can ever hold this one.
    const session = await harmony.api.session(state.server, null, undefined, 'camera');
    if (session.role !== 'broadcaster') {
      throw new Error('Your camera path is already in use.');
    }

    state.camera.publication = await publish({
      url: session.whipUrl,
      stream: state.camera.stream,
      iceServers: session.iceServers,
      maxBitrate: CAMERA.bitrate,
      maxFramerate: CAMERA.frameRate,
      contentHint: 'motion',
    });

    // Its own heartbeat group, so stopping the camera does not disturb the
    // screen share's claim and vice versa.
    addTimer(
      setInterval(
        () => harmony.api.heartbeat(state.server, session.username, session.token).catch(() => {}),
        Math.max(5000, session.heartbeatMs ?? 10_000),
      ),
      'camera',
    );
    state.camera.session = session;
    el.voiceCam.textContent = 'Stop camera';
  } catch (err) {
    showChannelsError(err.message);
    await stopCamera();
  }
  return undefined;
}

async function stopCamera() {
  if (state.voice.camLive) {
    const channelId = state.voice.channelId;
    await state.voice.stopCam();
    if (channelId) {
      await harmony.realtime.request('voice:publishing', {
        channelId, kind: 'c', on: false,
      }).catch(() => { /* leaving the channel says the same thing */ });
    }
    applyVoiceButtons();
    renderChannelVideo();
    return;
  }

  clearTimers('camera');
  const publication = state.camera.publication;
  state.camera.publication = null;
  state.camera.stream?.getTracks().forEach((t) => t.stop());
  state.camera.stream = null;
  setButtonLabel(el.voiceCam, 'Start camera');

  if (publication) {
    publication.pc.close();
    if (publication.resourceUrl) await harmony.api.hangup(publication.resourceUrl).catch(() => {});
  }
  const session = state.camera.session;
  state.camera.session = null;
  if (session) {
    await harmony.api.release(state.server, session.username, session.token).catch(() => {});
  }
}

/**
 * Everything the server pushes.
 *
 * The roster is the single source of truth for who to subscribe to, which is
 * why syncPeers() is driven from here rather than from the join: a member who
 * unmutes ten minutes later is just another roster push.
 */
function onRealtimeEvent(msg) {
  switch (msg.type) {
    case 'presence':
      state.channels.online = new Set(msg.online ?? []);
      renderMembers();
      break;

    case 'channels':
      state.channels.list = msg.channels;
      // Always together. A client holding one and not the other would draw
      // channels into folders it has not heard of, or empty folders whose
      // channels it has not been told about.
      if (msg.groups) state.channels.groups = msg.groups;
      renderChannels();
      break;

    case 'voice:roster':
      // Kept for EVERY channel, not just ours: this is what the sidebar
      // draws, and it is the only way to see who is in a channel before
      // deciding whether to join it.
      state.channels.rosters[msg.channelId] = msg.roster;
      state.channels.occupancy[msg.channelId] = msg.roster.length;
      if (msg.channelId !== state.voice.channelId) {
        renderChannels();
        break;
      }
      renderVoiceRoster(msg.roster);
      renderChannels();
      state.voice.syncPeers(msg.roster).catch(() => { /* retried next push */ });
      state.voice.syncVideo(msg.roster)
        .then(() => renderChannelVideo())
        .catch(() => { /* the reconcile timer comes back */ });
      // Captions carry nicknames from the roster we just replaced.
      renderChannelVideo();

      // A force-mute arrives here and nowhere else. The Phase 0 spike measured
      // the victim's peer connection still reporting `connected` for about
      // nine seconds after the server kills their session, so connection state
      // cannot be what drives this -- the push has to.
      if (msg.roster.some((m) => m.mid === state.voice.mid && m.forceMuted)) {
        showChannelsError('An admin muted your microphone.');
      }
      break;

    case 'message':
      // Before the channel filter, on purpose: a mention in a channel you
      // are not looking at is the only one worth making a noise about.
      notifyMention(msg.message);
      if (msg.message.channelId === state.chat.channelId && !state.chat.searching) {
        state.chat.messages.push(msg.message);
        renderChat();
      }
      break;

    case 'message:updated':
      if (msg.message.channelId === state.chat.channelId) {
        const index = state.chat.messages.findIndex((m) => m.id === msg.message.id);
        if (index >= 0) state.chat.messages[index] = msg.message;
        state.chat.pinned = state.chat.pinned.filter((m) => m.id !== msg.message.id);
        if (msg.message.pinned) state.chat.pinned.unshift(msg.message);
        renderChat();
      }
      break;

    case 'message:deleted':
      if (msg.channelId === state.chat.channelId) {
        state.chat.messages = state.chat.messages.filter((m) => m.id !== msg.id);
        state.chat.pinned = state.chat.pinned.filter((m) => m.id !== msg.id);
        renderChat();
      }
      break;

    case 'message:reactions': {
      if (msg.channelId !== state.chat.channelId) break;
      // Both lists: a pinned message is a separate copy, and the strip in
      // the pinned pane would otherwise go stale until the next page load.
      for (const list of [state.chat.messages, state.chat.pinned]) {
        const target = list.find((m) => m.id === msg.id);
        if (target) target.reactions = msg.reactions;
      }
      renderChat();
      break;
    }

    case 'emojis':
      setEmojis(msg.emojis);
      break;

    case 'server':
      applyServerInfo(msg.server);
      break;

    /*
     * Your account is gone.
     *
     * The socket is closed by the server immediately after this, so there
     * is nothing to clean up -- but without a word the app would simply
     * stop working, with every request failing and no explanation.
     */
    case 'kicked':
      state.auth.user = null;
      showView('view-connect');
      showError(msg.reason === 'account removed'
        ? 'Your account was removed from this server.'
        : `Disconnected: ${msg.reason}`);
      break;

    case 'soundpad':
      state.soundpad.clips = msg.clips;
      renderSoundpad();
      syncHotkeys();
      break;

    /*
     * The whole roster at once, because somebody has gone.
     *
     * A user:updated cannot say "this person no longer exists" -- it
     * carries a user -- so a removal replaces the map rather than editing
     * it. Everything drawn from that map is drawn again.
     */
    case 'accounts':
      state.users = new Map(msg.users.map((u) => [u.id, u]));
      refreshKeepSet();
      renderVoiceRoster(state.channels.roster);
      renderChannels();
      renderMembers();
      renderChat();
      break;

    case 'user:updated':
      state.users.set(msg.user.id, msg.user);
      refreshKeepSet();
      if (msg.user.id === state.auth.user?.id) {
        state.auth.user = msg.user;
        renderOwnAvatar();
        el.channelsWho.textContent = msg.user.displayName || msg.user.nickname;
        el.channelsRole.textContent = msg.user.role === 'member' ? '' : msg.user.role;
        // Being made an admin has to reach the controls, not just the badge.
        el.channelAdd.hidden = !isAdmin();
        applyServerInfo();
        applyVoiceButtons();
      }
      // Names and pictures are drawn from this map in several places, and
      // the cheapest way to be sure none of them is stale is to draw them
      // all again.
      renderVoiceRoster(state.channels.roster);
      renderChannels();
      renderMembers();
      renderChat();
      break;

    case 'soundpad:play':
      // Deafened means deafened. The soundpad goes to the context's
      // destination directly rather than through a peer sink, so nothing
      // else would have silenced it -- which would make "Deafen" a button
      // that silences people but not airhorns.
      if (state.voice.deafened) break;
      // Into the PLAYBACK context, never the outgoing mix. See playSample().
      playSample(harmony.mediaUrl(msg.hash), { gain: soundpadGain() }).catch((err) =>
        showChannelsError(`Could not play "${msg.name}": ${err.message}`));
      break;

    case 'voice:moved':
      if (msg.channelId == null) {
        leaveVoice();
        showChannelsError(`${msg.by} disconnected you.`);
      } else {
        const target = state.channels.list.find((c) => c.id === msg.channelId);
        if (target) {
          showChannelsError(`${msg.by} moved you to ${target.name}.`);
          joinVoice(target);
        }
      }
      break;

    case 'streams':
      // Replaces the 3-second /api/streams poll. The slow reconciliation tick
      // in syncMosaic stays as a safety net for a dropped socket.
      state.lastStreams = msg.streams;
      if (document.getElementById('view-mosaic').hasAttribute('data-active')) {
        syncMosaic({ streams: msg.streams }).catch(() => { /* next tick retries */ });
      }
      break;

    case 'realtime:down':
      showChannelsError('Reconnecting\u2026');
      applyVoiceConnection(false);
      break;

    case 'realtime:up':
      showChannelsError('');
      applyVoiceConnection(true);
      // Everything the hello carries, not just the channel list: a client
      // that was away has missed every roster broadcast in between, and the
      // hello is the one message that brings the whole picture back.
      if (msg.channels) state.channels.list = msg.channels;
      if (msg.groups) state.channels.groups = msg.groups;
      if (msg.online) state.channels.online = new Set(msg.online);
      if (msg.rosters) state.channels.rosters = msg.rosters;
      if (msg.occupancy) state.channels.occupancy = msg.occupancy;
      renderChannels();

      // A reconnect means the server has forgotten our presence, because
      // presence IS the socket. Rejoin rather than appearing to be in a channel
      // nobody else can see us in.
      //
      // This had never once run: the event was emitted with its type
      // overwritten by the hello's own, so it arrived as 'hello-ok' and fell
      // through to default. A client that dropped came back connected but
      // silently out of its voice channel, still showing "Reconnecting...".
      if (state.voice.channelId) {
        const channel = state.channels.list.find((c) => c.id === state.voice.channelId);
        if (channel) joinVoice(channel);
      }
      break;

    case 'realtime:rejected':
      showChannelsError('This session expired. Sign in again.');
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Source picker
// ---------------------------------------------------------------------------

async function enterPicker() {
  state.excludeChoice = null;
  const target = state.share.target;
  el.pickerUsername.textContent = target ? `#${target.name}` : state.session.username;
  state.selectedSource = null;
  state.changingSource = false;
  el.startStream.disabled = true;
  el.startStream.textContent = 'Start streaming';
  el.pickerBack.textContent = 'Cancel';
  openPicker();
  await loadSources();
  updateAudioNote();

  // A channel share holds a SLOT, not a username: the slot is held by the
  // WebSocket being open, so there is nothing here to keep alive. Starting
  // the flat heartbeat anyway would renew a claim on the flat namespace that
  // this share is never going to use.
  if (target) return;

  // Hold the username while the user browses windows and picks a quality.
  addTimer(
    setInterval(() => {
      harmony.api
        .heartbeat(state.session.server, state.session.username, state.session.token)
        .catch(() => {});
    }, state.session.heartbeatMs ?? 10_000),
  );
}

/**
 * Share a screen into the voice channel you are in.
 *
 * The whole picker, encoder and stats path is reused unchanged -- only the
 * WHIP URL differs, which is the point of keeping the publish target in
 * state.share rather than reading it off state.session.
 */
async function shareScreenHere() {
  /*
   * Already sharing: ask, rather than stop.
   *
   * The same button starts a share and used to end it on the next press,
   * which made "I want to show a different window" a stop, a restart and a
   * second trip through the picker -- with everybody's tile going away and
   * coming back in between. Changing the source keeps the stream up and
   * swaps the picture under it.
   */
  if (state.share.target) {
    openRowMenu('Your stream', [
      {
        label: 'Change source',
        title: 'Show a different screen or window without ending the stream',
        run: () => openChangeSource(),
      },
      {
        label: 'Stop streaming',
        title: 'End the stream for everybody watching',
        danger: true,
        run: () => stopBroadcast(),
      },
    ], { clientX: 0, clientY: 0 }, { above: el.voiceScreen });
    return undefined;
  }
  if (!state.voice.channelId) {
    showChannelsError('Join a voice channel first.');
    return undefined;
  }
  if (!state.voice.publishUrls.screen) {
    showChannelsError('This channel did not give out a screen path. Rejoin it.');
    return undefined;
  }
  // Before reading publishUrls, not after: the picker is where somebody
  // spends thirty seconds choosing a window, and the URL captured here is
  // the one that gets published with.
  await refreshVoiceTokens();

  const channel = state.channels.list.find((c) => c.id === state.voice.channelId);
  state.share.target = {
    channelId: state.voice.channelId,
    url: state.voice.publishUrls.screen,
    name: channel?.name ?? 'this channel',
  };
  await enterPicker();
  return undefined;
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

  /*
   * Harmony first, and chosen unless the person has picked something else.
   *
   * A whole-screen share sends everything the machine plays -- and that
   * includes Harmony playing everybody else's voices, the soundpad and the
   * join sounds. Without this, the channel hears itself back out of your
   * stream, a beat late. Still a choice: picking "Nothing" shares it all.
   */
  const self = state.processes.find((p) => p.self);
  const others = state.processes.filter((p) => !p.self);
  if (self) {
    const option = document.createElement('option');
    option.value = String(self.pid);
    option.textContent = 'Harmony — voices, soundpad and sounds (recommended)';
    el.excludeApp.append(option);
  }
  for (const proc of others) {
    const option = document.createElement('option');
    option.value = String(proc.pid);
    option.textContent = `${proc.name} — ${proc.title.slice(0, 40)}`;
    el.excludeApp.append(option);
  }

  const wanted = state.excludeChoice ?? (self ? String(self.pid) : '');
  el.excludeApp.value = [...el.excludeApp.options].some((o) => o.value === wanted) ? wanted : '';
  // The list arrives after the picker has drawn its note (loadSources does
  // not wait for it), so the note has to catch up with the default here.
  updateAudioNote();
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

/**
 * The copy of the capture the preview shows.
 *
 * A clone, at the capture's own resolution and frame rate. It used to be
 * constrained to 960x540 at 10 fps, which kept the preview cheap and made it
 * useless for judging what viewers actually get. The preview is hidden until
 * asked for instead (state.preview.hiddenByUser, and the eye on your own
 * channel tile), and a hidden preview has no srcObject, so it costs nothing.
 *
 * Still a clone rather than the published track: stopping the preview must
 * never be able to stop the stream.
 */
async function previewCopy(track) {
  return track.clone();
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

  const preset = pickerPreset();
  const priority = PRIORITY[el.livePriority.value] ?? PRIORITY.sharp;
  const plan = audioPlan();

  el.startStream.disabled = true;
  el.startStream.textContent = 'Going live…';
  // Backing out halfway through going live would tear down a publish that
  // is still being set up. Escape is routed through this button too.
  el.pickerBack.disabled = true;

  const resolution = segmentedValue(el.resolution);
  const framerate = Number(segmentedValue(el.framerate));
  await harmony.settings.set({ resolution, framerate, windowAudioFallback: el.fallback.value });

  try {
    // Video first: picking a capture source is what grants the user activation
    // an AudioContext needs to leave the suspended state.
    const { track: videoTrack, rawStream, previewTrack } = await acquireVideo(source, preset, plan);
    state.live.rawStream = rawStream;
    state.live.source = source;
    state.preview.stream = new MediaStream([previewTrack]);
    state.preview.hiddenByUser = true;

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

    // Choosing a source can take a while, and a channel token minted before
    // the picker opened may have expired while a window was being chosen.
    if (state.share.target) {
      await refreshVoiceTokens();
      state.share.target.url = state.voice.publishUrls.screen || state.share.target.url;
    }

    const { pc, resourceUrl } = await publish({
      url: state.share.target ? state.share.target.url : state.session.whipUrl,
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

    /*
     * A successful WHIP handshake is not proof of being on air. MediaMTX
     * answers the offer before it decides whether this publisher may have the
     * path, so if the name is already taken at the media-server level the
     * connection comes up and the stream then goes nowhere. Confirm the server
     * actually sees us live rather than trusting the 201.
     *
     * Not for a channel share: /api/streams deliberately filters `vc-*` out,
     * so the check could only ever fail. The equivalent there is telling the
     * channel we are publishing, which is what makes everyone else subscribe.
     */
    if (state.share.target) {
      await harmony.realtime.request('voice:publishing', {
        channelId: state.share.target.channelId, kind: 's', on: true,
      });
    } else {
      await confirmLive();
    }

    // Re-read rather than trusting what boot() saw: the GPU process reports
    // roughly 300ms after the window loads, and boot() runs before that. Main
    // caches the answer, so this is free once it has settled.
    refreshGpuStatus();

    applyPreviewVisibility();
    el.broadcastTitle.textContent = state.share.target
      ? `Sharing in ${state.share.target.name}`
      : `Live as ${state.session.username}`;
    if (state.share.target) el.viewerCount.textContent = '';
    applyVoiceButtons();
    renderChannelVideo();
    el.broadcastAudioNote.textContent = audioNote;
    el.broadcastStats.textContent = 'Connecting…';
    voiceCue('streamStart');
    el.liveResolution.value = resolution;
    el.liveFramerate.value = String(framerate);
    updateMonitorButton();
    /*
     * A channel share goes BACK TO THE CHANNEL rather than to the broadcast
     * screen.
     *
     * The broadcast screen is the right place for a flat share, where there
     * is nothing else going on. Here there is: the roster, the chat and
     * everyone else's video. Parking the sharer on a preview of their own
     * screen would take all of that away from them the moment they started
     * sharing, which is the opposite of what a voice channel is for. The
     * preview is also the expensive thing to paint, and Chromium stops
     * compositing it as soon as the view is inactive.
     */
    showView(state.share.target ? 'view-channels' : 'view-broadcast');

    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        stopBroadcast(`Connection ${pc.connectionState}.`);
      }
    });

    addTimer(setInterval(updateBroadcastStats, 1000));
  } catch (err) {
    const wasChannel = Boolean(state.share.target);
    await teardown();
    const text = err.name === 'NotAllowedError' ? 'Screen capture was blocked.' : err.message;
    if (wasChannel) {
      showChannelsError(text);
      showView('view-channels');
    } else {
      showError(text);
      showView('view-connect');
    }
  } finally {
    el.startStream.disabled = false;
    el.startStream.textContent = 'Start streaming';
    el.pickerBack.disabled = false;
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

  // A channel share is not in /api/streams at all -- `vc-*` is filtered out
  // so a 1.0.0 client does not list thirty paths it cannot name. The channel
  // roster is the count that means anything there.
  if (state.share.target) {
    const n = state.channels.roster.length;
    el.viewerCount.textContent = `${Math.max(0, n - 1)} in the channel`;
    return;
  }

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
  el.pickerBack.disabled = true;
  // The live bar is what changeLiveSource reads, so the picker's rows are
  // carried over to it first.
  el.liveResolution.value = segmentedValue(el.resolution);
  el.liveFramerate.value = segmentedValue(el.framerate);
  try {
    await changeLiveSource(source);
    state.changingSource = false;
    // A channel share lives in the channel; only a flat share has a
    // broadcast screen to go back to.
    showView(state.share.target ? 'view-channels' : 'view-broadcast');
    if (state.share.target) renderChannelVideo();
  } catch (err) {
    el.audioNote.textContent =
      err.name === 'NotAllowedError' ? 'That source was not allowed.' : err.message;
    el.audioNote.toggleAttribute('data-warn', true);
  } finally {
    el.startStream.disabled = false;
    el.startStream.textContent = state.changingSource ? 'Use this source' : 'Start streaming';
    el.pickerBack.disabled = false;
  }
}

/** Apply the resolution, frame rate and priority selectors to a live stream. */
async function applyLiveQuality() {
  const preset = livePreset();
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

  await harmony.settings.set({
    resolution: el.liveResolution.value,
    framerate: Number(el.liveFramerate.value),
    priority: el.livePriority.value,
  });
}

/**
 * Swap what is being streamed without interrupting the broadcast.
 *
 * replaceTrack() changes the sender's source in place, so there is no
 * renegotiation and viewers keep the same connection -- the picture simply
 * becomes something else.
 */
async function changeLiveSource(source) {
  const preset = livePreset();
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
  const wasChannel = Boolean(state.share.target);
  if (isBroadcasting()) voiceCue('streamStop');
  await teardown();
  if (wasChannel) {
    if (reason) showChannelsError(reason);
    showView('view-channels');
    applyVoiceButtons();
    renderChannelVideo();
    return;
  }
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
    // Muted element, gain node does the playing -- same arrangement as the
    // mosaic tiles, and for the same reason: 100% is not always loud enough.
    el.remote.muted = true;
    state.watch.sink?.close();
    state.watch.sink = createSink(stream);
    applyWatchAudio();

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

  const { ghosts } = state.mosaic;
  for (const node of ghosts.values()) node.hidden = Boolean(maximized);

  // Squares count. They occupy a cell, so leaving them out of the fit would
  // size every real tile as though the grid had more room than it has.
  const count = maximized && tiles.has(maximized) ? 1 : tiles.size + ghosts.size;
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
  for (const node of state.mosaic.ghosts.values()) {
    node.classList.toggle('compact', best.tileW < COMPACT_TILE_WIDTH);
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
  el.mosaicLeave.textContent = (() => {
    if (isBroadcasting() && !state.share.target) return 'Back to my stream';
    return state.auth.user ? 'Back to channels' : 'Leave';
  })();
  el.mosaicGrid.replaceChildren();
  showVolume(el.mosaicVolume, el.mosaicVolumeLabel, 100);
  el.mosaicMute.innerHTML = '&#128266;';
  showView('view-mosaic');

  await syncMosaic();
  // Streams come and go while you watch; the grid follows. This used to be the
  // only mechanism and ran every 3 seconds. The server now pushes the list on
  // change, so this is demoted to a reconciliation net for the case the socket
  // is down -- which is also why it is not removed outright.
  addTimer(setInterval(syncMosaic, MOSAIC_RECONCILE_MS), 'mosaic');
  addTimer(setInterval(updateMosaicMeta, 1000), 'mosaic');
}

/**
 * How often to reconcile the mosaic against the server by polling.
 *
 * Fifteen seconds rather than three, because the authoritative path is now a
 * push. This only has to cover a socket that has quietly died, and the
 * realtime watchdog already notices that within 35 s.
 */
const MOSAIC_RECONCILE_MS = 15_000;

/**
 * How often to retry voice subscriptions that did not come up.
 *
 * Short, because the gap it covers is a peer being silently inaudible, and
 * cheap, because it does nothing at all unless something is actually missing.
 */
/**
 * The saved microphone, or undefined for the system default.
 *
 * Returns undefined rather than '' because getUserMedia treats an explicit
 * empty deviceId as a constraint that nothing satisfies.
 */
function deviceForVoiceInput() {
  const wanted = state.settings.voiceInputId;
  if (!wanted) return undefined;
  // Only if it is actually there; otherwise the exact-device constraint
  // throws and the join fails rather than falling back.
  return lastDevices.inputs.some((d) => d.deviceId === wanted) ? wanted : undefined;
}

const VOICE_RECONCILE_MS = 4000;
const SPEAKING_POLL_MS = 100;

// One timer, started once, never cleared. See the comment in joinVoice.
setInterval(() => { renderPing(); }, PING_POLL_MS);

async function syncMosaic({ streams: pushed } = {}) {
  let streams = pushed;
  let iceServers;

  if (!streams) {
    try {
      ({ streams, iceServers } = await harmony.api.streams(state.server));
    } catch {
      return; // transient; the next tick retries
    }
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

  /*
   * A square for every stream that is closed but still live.
   *
   * Driven from the same stream list as the tiles, so a closed stream whose
   * owner stops sharing loses its square too -- a permanent placeholder for
   * something nobody is broadcasting any more is an invitation to click on
   * nothing.
   */
  const live = new Set(streams.map((x) => x.username));
  for (const [username, node] of [...state.mosaic.ghosts]) {
    if (closed.has(username) && live.has(username)) continue;
    node.remove();
    state.mosaic.ghosts.delete(username);
  }
  for (const username of closed) {
    if (!live.has(username) || state.mosaic.ghosts.has(username)) continue;
    const node = ghostTile(username);
    state.mosaic.ghosts.set(username, node);
    el.mosaicGrid.append(node);
  }

  const count = state.mosaic.tiles.size;
  el.mosaicCount.textContent = `${count} ${count === 1 ? 'stream' : 'streams'}`;
  layoutMosaic();

  const empty = el.mosaicGrid.querySelector('.empty');
  if (!count && state.mosaic.ghosts.size) {
    empty?.remove();
  } else if (!count && !empty) {
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
  // Permanently muted: the element only ever shows the picture, and gain.js
  // plays the sound. Leaving it unmuted would play everything twice.
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
  volume.max = String(asPercent(MAX_GAIN));
  volume.title = `Volume for ${username}`;
  const level = document.createElement('span');
  level.className = 'tile-volume-label volume-value';
  showVolume(volume, level, 100);

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

  controls.append(muteBtn, volume, level, clipBtn, maxBtn, fsBtn, closeBtn);
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
    // balance them rather than being forced to pick just one. `sink` is the
    // gain node that actually plays it, created once the stream arrives.
    volume: 1,
    muted: false,
    sink: null,
  };
  state.mosaic.tiles.set(username, entry);

  // Controls sit inside the tile, so stop their clicks reaching it.
  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    entry.muted = !entry.muted;
    muteBtn.innerHTML = entry.muted ? '&#128263;' : '&#128266;';
    muteBtn.title = `${entry.muted ? 'Unmute' : 'Mute'} ${username}`;
    showVolume(volume, level, Number(volume.value), entry.muted);
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
    showVolume(volume, level, Number(volume.value), entry.muted);
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
      entry.sink = createSink(stream);
      status.hidden = true;
      // applyTileAudio owns the level; setting it here as well once cost every
      // tile its sound, by throwing before it could run.
      applyTileAudio();
    })
    .catch((err) => {
      if (state.mosaic.tiles.get(username) !== entry) return;
      spinner.remove();
      entry.statusText.textContent = err.code === 'not_live' ? 'Stream ended' : err.message;
    });
}

/** The empty square a closed stream leaves behind. Click it to come back. */
function ghostTile(username) {
  const node = document.createElement('div');
  // `tile` as well, so it inherits the 16:9 box, the border and the grid
  // sizing. A square that is not the same shape as the tiles around it
  // does not hold a place; it makes the grid jump, which is the thing
  // this exists to prevent.
  node.className = 'tile ghost-tile';
  node.dataset.username = username;
  node.title = `Reopen ${username}`;

  const name = document.createElement('span');
  name.className = 'ghost-name';
  name.textContent = username;

  const hint = document.createElement('span');
  hint.className = 'ghost-hint';
  hint.textContent = 'Closed \u00B7 click to watch again';

  node.append(name, hint);
  node.addEventListener('click', () => reopenTile(username));
  return node;
}

/**
 * Dismiss one stream from the mosaic.
 *
 * The CONNECTION is torn down, not just hidden -- a tile you cannot see
 * should not still cost you a decoder and the bandwidth of a 1080p stream --
 * but the square stays where it was. Closing something to glance past it
 * used to cost you your place in the grid, with + Add stream the only way
 * back.
 *
 * The name is remembered so the periodic sync does not simply reopen it
 * three seconds later.
 */
function closeTile(username) {
  const { mosaic } = state;
  mosaic.closed.add(username);
  mosaic.selection?.delete(username);
  if (mosaic.maximized === username) mosaic.maximized = null;
  removeTile(username);

  if (!mosaic.ghosts.has(username)) {
    const node = ghostTile(username);
    mosaic.ghosts.set(username, node);
    el.mosaicGrid.append(node);
  }

  const count = mosaic.tiles.size;
  el.mosaicCount.textContent = `${count} ${count === 1 ? 'stream' : 'streams'}`;
  layoutMosaic();
}

/** Put a closed stream back, from its own square. */
function reopenTile(username) {
  const { mosaic } = state;
  mosaic.closed.delete(username);
  // Into the selection too, where there is one: a mosaic opened on a chosen
  // set filters by it, so forgetting this would reopen the tile and have the
  // next sync close it again, which reads as a button that does not work.
  mosaic.selection?.add(username);
  mosaic.ghosts.get(username)?.remove();
  mosaic.ghosts.delete(username);
  syncMosaic().catch(() => { /* the periodic tick retries */ });
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
  entry.sink?.close();
  entry.sink = null;
  if (entry.pc) hangup(entry.pc, entry.resourceUrl);
  entry.el.remove();
}

/** The single-stream viewer's level, mirrored onto the element for inspection. */
function applyWatchAudio() {
  const { volume, muted, sink } = state.watch;
  const gain = muted ? 0 : Math.min(MAX_GAIN, volume);
  sink?.set(gain);
  el.remote.dataset.gain = String(gain);
  el.remote.dataset.muted = String(muted);

  showVolume(el.volume, el.volumeLabel, asPercent(volume), muted);
  el.toggleMute.innerHTML = muted ? '&#128263;' : '&#128266;';
  el.toggleMute.title = muted ? 'Unmute' : 'Mute';
}

/**
 * Every tile can be heard at once; the master control scales them all.
 * Effective volume is the tile's own level times the master level.
 *
 * The element stays muted and a GainNode does the playing, which is what allows
 * a level above 100% -- see gain.js. `dataset.gain` mirrors the result so the
 * effective level is visible to anything inspecting the DOM, including tests,
 * now that `video.volume` no longer means anything.
 */
function applyTileAudio() {
  const { master } = state.mosaic;
  for (const entry of state.mosaic.tiles.values()) {
    const silent = entry.muted || master.muted;
    const gain = silent ? 0 : Math.min(MAX_GAIN, entry.volume * master.volume);
    entry.sink?.set(gain);
    entry.video.dataset.gain = String(gain);
    entry.video.dataset.muted = String(silent);
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

  if (isBroadcasting() && !state.share.target) {
    showView('view-broadcast');
    return;
  }
  // Somebody signed in came from the channels, and that is where Leave has
  // to put them back. Sending them to the connect screen -- which is what
  // this did -- drops a signed-in person at a login form with no obvious way
  // back into the channel they were in a moment ago.
  if (state.auth.user) {
    showView('view-channels');
    renderChannels();
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
  const watching = el.watchView === active;
  el.watchFullscreen.innerHTML = watching ? '&#10005;' : '&#9974;';
  el.watchFullscreen.title = watching ? 'Exit fullscreen (Esc)' : 'Fullscreen';

  // Start every fullscreen session with the chrome out of the way; the pointer
  // reaching for the bottom of the screen is what brings it back.
  document.querySelectorAll('.hud-visible').forEach((n) => n.classList.remove('hud-visible'));
});

/**
 * Reveal the controls when the pointer goes looking for them.
 *
 * Fullscreen is for watching, so the bars are hidden by default -- but they
 * have to be reachable, and the two things people reach for are volume and the
 * way out. Bottom-edge proximity is the convention every video player uses, so
 * it needs no explaining.
 */
const HUD_ZONE_PX = 120;

document.addEventListener('mousemove', (event) => {
  const fs = document.fullscreenElement;
  if (!fs) return;
  const rect = fs.getBoundingClientRect();
  // A share of the height as well as a fixed band, so the target is not
  // uncomfortably thin on a 4K screen.
  const zone = Math.max(HUD_ZONE_PX, rect.height * 0.15);
  fs.classList.toggle('hud-visible', event.clientY >= rect.bottom - zone);
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

  /*
   * A channel share is torn down differently from a flat one, in two ways
   * that both matter.
   *
   * It has to tell the channel it stopped, or every other member keeps a
   * subscription open to a path with nothing coming out of it. And it must
   * NOT release the flat username claim below: that claim belongs to this
   * sign-in, not to this share, and giving it back here would quietly drop
   * the name while the person is still signed in under it.
   */
  const channelShare = state.share.target;
  state.share.target = null;
  if (channelShare) {
    await harmony.realtime
      .request('voice:publishing', { channelId: channelShare.channelId, kind: 's', on: false })
      .catch(() => { /* leaving the channel says the same thing */ });
  }

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
  state.watch.sink?.close();
  state.watch.sink = null;

  // Give the username back at once rather than waiting for the claim to lapse.
  if (state.session?.token && !channelShare) {
    await harmony.api
      .release(state.session.server, state.session.username, state.session.token)
      .catch(() => {});
    state.lastClaim = null;
  }
  if (!channelShare) state.session = null;
  state.selectedSource = null;
}

/**
 * A snapshot of this client's view of the call.
 *
 * Deliberately a permanent part of the app rather than a test-only hook.
 * Every voice bug reported so far -- one-way audio, a stuck reconnect, a
 * channel nobody could hear -- looked identical from the UI, and answering
 * "did you subscribe, and is the audio routed" needed a guess each time.
 * It exposes nothing the person cannot already see on their own screen.
 */
window.__harmony = () => ({
  signedInAs: state.auth.user?.nickname ?? null,
  view: document.querySelector('.view[data-active]')?.id ?? null,
  voice: state.voice.diagnostics(),
  sharing: state.share.target?.channelId ?? null,
  channels: state.channels.list.map((c) => `${c.kind}:${c.id}:${c.name}`),
});

/** What our microphone is putting on the wire. Async; see publishStats. */
window.__harmonyPublish = () => state.voice.publishStats();

/** What each voice subscription is receiving. Async; see subscribeStats. */
window.__harmonySubs = () => state.voice.subscribeStats();

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

el.continue.addEventListener('click', startSession);

// --- channels and voice ---------------------------------------------------

harmony.realtime.onEvent(onRealtimeEvent);

/*
 * Show or hide the member column.
 *
 * The attribute lives on the layout rather than only on the panel,
 * because an empty grid track still reserves its width -- the same reason
 * the stage column collapses when there is nothing on it.
 */
function applyMemberList(show) {
  el.memberList.hidden = !show;
  el.channelsLayout.toggleAttribute('data-members', show);
  el.channelsMembers.toggleAttribute('data-on', show);
  if (show) renderMembers();
}

el.serverSettings.addEventListener('click', () => openServerDialog());
el.serverCancel.addEventListener('click', () => el.serverDialog.close());
el.serverForm.addEventListener('submit', (event) => {
  // The dialog's own method="dialog" would close it before the save was
  // even attempted, and a failure would have nowhere to be shown.
  event.preventDefault();
  saveServerSettings();
});
el.serverPasswordOff.addEventListener('change', () => {
  // Typing a password and ticking "no password" is two contradictory
  // answers, so the box goes away rather than being quietly ignored.
  el.serverPasswordInput.disabled = el.serverPasswordOff.checked;
  if (el.serverPasswordOff.checked) el.serverPasswordInput.value = '';
});

// Same dismissal as the peer menu: pointerdown, captured, so it closes on
// the way down even if the press lands on something that stops bubbling.
document.addEventListener('pointerdown', (event) => {
  if (el.memberMenu.hidden) return;
  if (el.memberMenu.contains(event.target)) return;
  closeMemberMenu();
}, true);
document.addEventListener('pointerdown', (event) => {
  if (el.rowMenu.hidden) return;
  if (el.rowMenu.contains(event.target)) return;
  closeRowMenu();
}, true);
// Scrolling the list out from under it would leave it pointing at nothing.
el.channelItems.addEventListener('scroll', () => closeRowMenu());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeMemberMenu();
    closeRowMenu();
  }
});
window.addEventListener('blur', () => closeRowMenu());
el.memberItems.addEventListener('scroll', () => closeMemberMenu());
window.addEventListener('blur', () => closeMemberMenu());

el.channelsMembers.addEventListener('click', async () => {
  const show = el.memberList.hidden;
  applyMemberList(show);
  await harmony.settings.set({ showMembers: show });
  state.settings = await harmony.settings.get();
});


el.channelsSignout.addEventListener('click', async () => {
  await leaveVoice({ silent: true }).catch(() => {});
  await harmony.realtime.disconnect();
  await harmony.api.logout(state.server).catch(() => {});
  state.auth.user = null;
  await adoptSession('');
  showView('view-connect');
});

el.voiceMute.addEventListener('click', async () => {
  const before = state.voice.muted;
  const muted = state.voice.setMuted(!before);
  // From what actually happened, not from what was asked: an admin's mute
  // can refuse the unmute, and a cue saying otherwise would be a lie told
  // to somebody who is not looking at the screen.
  if (muted !== before) voiceCue(muted ? 'mute' : 'unmute');
  applyVoiceButtons();
  await harmony.realtime
    .request('voice:mute', {
      channelId: state.voice.channelId, muted, deafened: state.voice.deafened,
    })
    .catch(() => { /* local mute still applies */ });
});

el.voiceDeafen.addEventListener('click', () => {
  // Deafening implies muting: being able to hear nobody while still talking is
  // never what anyone means by it, and it is how people end up broadcasting a
  // conversation they think is private.
  state.voice.setDeafened(!state.voice.deafened);
  if (state.voice.deafened && !state.voice.muted) state.voice.setMuted(true);
  voiceCue(state.voice.deafened ? 'deafen' : 'undeafen');
  harmony.realtime
    .request('voice:mute', {
      channelId: state.voice.channelId,
      muted: state.voice.muted,
      deafened: state.voice.deafened,
    })
    .catch(() => { /* local state still applies */ });
  applyVoiceButtons();
});

el.voiceLeave.addEventListener('click', () => leaveVoice());

el.askForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const missing = [...el.askFields.querySelectorAll('[required]')]
    .find((input) => !input.value.trim());
  if (missing) {
    el.askError.textContent = 'That one cannot be empty.';
    el.askError.hidden = false;
    missing.focus();
    return;
  }
  const values = {};
  // textarea too. Without it a multi-line field builds, fills and submits
  // perfectly and its value is silently dropped on the way out.
  for (const input of el.askFields.querySelectorAll('input, select, textarea')) {
    values[input.name] = input.value;
  }
  closeAsk(values);
});
el.askCancel.addEventListener('click', () => closeAsk(null));
// Esc closes a <dialog> without submitting, and the promise must still settle.
el.ask.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeAsk(null);
});

/**
 * Your display name.
 *
 * Server-side only, and deliberately nothing like the nickname. The
 * nickname is an identity -- folded, unique, what you log in with, and what
 * a MediaMTX path is built from. This is a label: any character, capitals
 * included, and two people may pick the same one. Clearing it puts the
 * nickname back, which is why the field is not required.
 */
el.selfName.addEventListener('click', async () => {
  const me = state.auth.user;
  if (!me) return;
  const answer = await ask({
    title: 'Your display name',
    text: `Shown to everybody on this server. Leave it empty to go back to "${me.nickname}". `
      + 'Capitals, spaces and accents are all fine.',
    okLabel: 'Save',
    fields: [{
      name: 'displayName',
      label: 'Display name',
      value: me.customName ? me.displayName : '',
      placeholder: me.nickname,
      maxlength: 32,
    }],
  });
  if (answer === null) return;
  try {
    const { user } = await harmony.api.setDisplayName(state.server, answer.displayName ?? '');
    state.auth.user = { ...state.auth.user, ...user };
    state.users.set(user.id, user);
    // The broadcast repaints everybody else; this repaints us without
    // waiting for our own message to come back round.
    el.channelsWho.textContent = user.displayName || user.nickname;
    renderVoiceRoster(state.channels.roster);
    renderChannels();
    renderChat();
  } catch (err) {
    showChannelsError(err.message);
  }
});

el.avatarButton.addEventListener('click', () => el.avatarFile.click());
el.avatarFile.addEventListener('change', () => {
  const file = el.avatarFile.files?.[0];
  // Reset first, so picking the same file twice in a row still fires 'change'.
  el.avatarFile.value = '';
  if (file) setOwnAvatar(file);
});

el.voiceInput.addEventListener('change', async () => {
  await harmony.settings.set({ voiceInputId: el.voiceInput.value });
  state.settings = await harmony.settings.get();
  deviceNote('');
  await applyVoiceInput(el.voiceInput.value);
});

el.voiceOutput.addEventListener('change', async () => {
  await harmony.settings.set({ voiceOutputId: el.voiceOutput.value });
  state.settings = await harmony.settings.get();
  deviceNote('');
  await applyVoiceOutput(el.voiceOutput.value);
});

el.voiceScreen.addEventListener('click', () => shareScreenHere());

/*
 * The soundpad's volume.
 *
 * Written on 'change' rather than 'input' -- dragging a slider fires input
 * for every pixel, and each one is a settings file write. The label follows
 * 'input' so it still moves under the finger.
 */
el.soundpadVolume.addEventListener('input', () => {
  showVolume(
    el.soundpadVolume, el.soundpadVolumeLabel, Number(el.soundpadVolume.value), false,
  );
});
el.soundpadVolume.addEventListener('change', async () => {
  await harmony.settings.set({ soundpadVolume: Number(el.soundpadVolume.value) });
  state.settings = await harmony.settings.get();
  applySoundpadVolume();
});
el.soundpadMute.addEventListener('click', async () => {
  const now = Number(el.soundpadVolume.value);
  // Unmuting from zero goes back to 100, not to zero-but-not-muted, which
  // is a button that does nothing.
  await harmony.settings.set({ soundpadVolume: now === 0 ? 100 : 0 });
  state.settings = await harmony.settings.get();
  applySoundpadVolume();
});

/*
 * The device pickers.
 *
 * A plain <dialog> rather than ask(): the three selects already exist, they
 * are already wired, and they apply as you change them. There is nothing to
 * collect and nothing to answer -- the only thing the dialog adds is
 * somewhere to put them.
 *
 * Re-enumerated on open rather than only on devicechange, because a device
 * can have appeared while the app was in the background and this is the
 * exact moment somebody wants to see it.
 */
// Applied as it moves; saved, and previewed, when it is let go.
el.soundVolume.addEventListener('input', () => {
  const percent = Number(el.soundVolume.value);
  showVolume(el.soundVolume, el.soundVolumeLabel, percent);
  setCueVolume(percent / 100);
});
el.soundVolume.addEventListener('change', async () => {
  playCue('join');
  await harmony.settings.set({ soundVolume: Number(el.soundVolume.value) });
  state.settings = await harmony.settings.get();
});

el.voiceSounds.addEventListener('change', async () => {
  await harmony.settings.set({ voiceSounds: el.voiceSounds.checked });
  state.settings = await harmony.settings.get();
  // A preview of what you just turned on, so the switch has an effect you
  // can hear rather than one you have to wait for somebody else to cause.
  if (el.voiceSounds.checked) playCue('join');
});

el.voiceConfig.addEventListener('click', () => {
  el.devicesDialog.showModal();
  renderThemes();
  el.voiceSounds.checked = state.settings?.voiceSounds !== false;
  el.mentionSound.checked = state.settings?.mentionSound !== false;
  showVolume(el.soundVolume, el.soundVolumeLabel, state.settings?.soundVolume ?? 100);
  renderHotkeyList();
  // No save: this is drawing the dialog from what is already stored, and
  // writing it back on every open is a write for nothing.
  applyScale(state.settings?.uiScale ?? SCALE_DEFAULT, { save: false });
  applyMicTuning();
  startMicMeter();
  refreshVoiceDevices().catch((err) => deviceNote(err.message));
});
el.devicesDialog.addEventListener('close', stopMicMeter);

/*
 * Input volume and sensitivity.
 *
 * Applied on 'input' so the meter and your own voice respond as you drag,
 * and written on 'change' so one drag is one settings write rather than
 * forty.
 */
const micTuningInput = () => {
  state.settings.micGain = Number(el.micGain.value);
  state.settings.micSensitivity = Number(el.micGate.value);
  applyMicTuning();
};
const micTuningSave = () => harmony.settings
  .set({ micGain: Number(el.micGain.value), micSensitivity: Number(el.micGate.value) })
  .then(() => harmony.settings.get())
  .then((settings) => { state.settings = settings; })
  .catch(() => { /* it is applied either way; it just will not persist */ });

el.micGain.addEventListener('input', micTuningInput);
el.micGate.addEventListener('input', micTuningInput);
el.micGain.addEventListener('change', micTuningSave);
el.micGate.addEventListener('change', micTuningSave);

el.voiceSoundboard.addEventListener('click', () => {
  if (el.soundpad.hidden) openSoundpad();
  else closeSoundpad();
});

el.soundpadSearch.addEventListener('input', () => {
  soundpadFilter = el.soundpadSearch.value.trim().toLowerCase();
  renderSoundpad();
});

/*
 * Dismissing it, the same way the right-click menu is dismissed.
 *
 * The button is excluded as well as the panel: without that, pressing it
 * while the panel is open closes it here on the way down and the button's
 * own handler reopens it on the way up, so it never shuts.
 */
document.addEventListener('pointerdown', (event) => {
  if (el.soundpad.hidden) return;
  if (el.soundpad.contains(event.target)) return;
  if (el.voiceSoundboard.contains(event.target)) return;
  // A clip's right-click menu, and the hotkey recorder it opens, both act on
  // the soundpad -- closing it under them would hide the very badge the
  // person is setting.
  if (el.rowMenu.contains(event.target)) return;
  if (el.hotkeyRecorder.contains(event.target)) return;
  closeSoundpad();
}, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.soundpad.hidden) closeSoundpad();
});

el.voiceCamera.addEventListener('change', async () => {
  await harmony.settings.set({ voiceCameraId: el.voiceCamera.value });
  state.settings = await harmony.settings.get();
  deviceNote('');
  await applyVoiceCamera(el.voiceCamera.value);
});

/*
 * Dismissing the right-click menu.
 *
 * pointerdown rather than click, so it closes on the way down like every
 * other menu; capture, so it still closes when the press lands on something
 * that stops propagation. The menu itself is excluded, or dragging its
 * volume slider would close it on the first pixel.
 */
document.addEventListener('pointerdown', (event) => {
  if (el.peerMenu.hidden) return;
  if (el.peerMenu.contains(event.target)) return;
  closePeerMenu();
}, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePeerMenu();
});
// Scrolling the roster out from under it would leave it pointing at nothing.
el.voiceRoster.addEventListener('scroll', () => closePeerMenu());
window.addEventListener('blur', () => closePeerMenu());

el.voiceCam.addEventListener('click', () =>
  (state.camera.publication || state.voice.camLive ? stopCamera() : startCamera()));

el.soundpadAdd.addEventListener('click', () => el.soundpadFile.click());
el.soundpadFile.addEventListener('change', () => {
  const file = el.soundpadFile.files?.[0];
  el.soundpadFile.value = '';
  if (file) addSoundpadClip(file);
});

// --- chat -----------------------------------------------------------------

el.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage();
});

/*
 * The suggestion list follows the caret, not just the keystrokes.
 *
 * selectionchange rather than only 'input', because clicking into the
 * middle of a half-typed name has to open the list and clicking out of one
 * has to close it -- neither of which fires an input event.
 */
el.chatInput.addEventListener('input', () => {
  growChatInput();
  applyComposer();
  updateMentions();
});
document.addEventListener('selectionchange', () => {
  if (document.activeElement === el.chatInput) updateMentions();
});
el.chatInput.addEventListener('blur', () => closeMentions());

/**
 * Grow the box to fit what is in it.
 *
 * height:auto first, or scrollHeight only ever reports the taller of what
 * it is and what it was, and the box can grow but never shrink again. The
 * ceiling is the max-height in CSS rather than a number here, so there is
 * one place that decides how tall it may get.
 */
function growChatInput() {
  el.chatInput.style.height = 'auto';
  el.chatInput.style.height = `${el.chatInput.scrollHeight}px`;
}

el.chatInput.addEventListener('keydown', (event) => {
  if (!el.mentionPop.hidden) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      mentionActive = (mentionActive + step + mentionMatches.length) % mentionMatches.length;
      renderMentionList();
      return;
    }
    // Enter and Tab both take the highlighted name. Enter has to be stopped
    // from reaching the form, or choosing a name also sends the message.
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      acceptMention(mentionActive);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMentions();
      return;
    }
  }

  /*
   * Enter sends; Shift+Enter breaks the line.
   *
   * The opposite of a textarea's own behaviour, so it has to be taken over
   * rather than added to. isComposing is not optional: with an IME, Enter
   * is how a candidate is accepted, and sending the message on it would
   * make the app unusable in half the world.
   */
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    el.chatForm.requestSubmit();
  }
});

/*
 * input, not change: the whole point of a size control is watching the app
 * resize as you drag it. The write to settings.json goes with it, which is
 * a few writes during a drag and is still cheaper than remembering to
 * commit on release and getting it wrong when the pointer leaves the
 * window mid-drag.
 */
el.uiScale.addEventListener('input', () => applyScale(Number(el.uiScale.value)));

const nudgeScale = (delta) => applyScale(Number(el.uiScale.value) + delta);
el.scaleDown.addEventListener('click', () => nudgeScale(-5));
el.scaleUp.addEventListener('click', () => nudgeScale(5));
el.scaleReset.addEventListener('click', () => applyScale(SCALE_DEFAULT));

el.mentionSound.addEventListener('change', async () => {
  await harmony.settings.set({ mentionSound: el.mentionSound.checked });
  state.settings = await harmony.settings.get();
  // Played on the way on, so the setting demonstrates itself. The same
  // thing the voice sounds box does.
  if (el.mentionSound.checked) playCue('mention');
});

el.chatEmoji.addEventListener('click', () => {
  if (!el.emojiPop.hidden) return closeEmojiPicker();
  return openEmojiPicker(el.chatEmoji, (value) => {
    // Inserted at the caret, not appended: an emoji chosen half way through
    // a sentence belongs where the sentence was.
    const input = el.chatInput;
    const at = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? at;
    input.value = input.value.slice(0, at) + value + input.value.slice(end);
    const after = at + value.length;
    input.setSelectionRange(after, after);
    input.focus();
    rememberEmoji(value);
  });
});

el.emojiSearch.addEventListener('input', () => {
  emojiFilter = el.emojiSearch.value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  renderEmojiPicker();
});

el.emojiGrid.addEventListener('click', (event) => {
  const cell = event.target.closest('.emoji-cell');
  if (!cell || !emojiPick) return;
  const pick = emojiPick;
  pick(cell.dataset.value);
});

/*
 * The name of whatever the pointer is over.
 *
 * The only place a :shortcode: is ever shown, which for a custom emoji is
 * the whole point of having one -- nobody can type a trigger they have
 * never seen.
 */
el.emojiGrid.addEventListener('mouseover', (event) => {
  const cell = event.target.closest('.emoji-cell');
  if (!cell) return;
  const big = document.createElement('span');
  big.className = 'big';
  appendEmoji(big, cell.dataset.value);
  const name = document.createElement('span');
  name.textContent = `:${cell.dataset.label}:`;
  el.emojiPreview.replaceChildren(big, name);
});

el.emojiAdd.addEventListener('click', () => el.emojiFile.click());
el.emojiFile.addEventListener('change', () => {
  const file = el.emojiFile.files?.[0];
  el.emojiFile.value = '';
  if (file) uploadCustomEmoji(file);
});

// Anywhere else closes it. The grid and the button are excluded, or opening
// it would immediately close it again.
document.addEventListener('click', (event) => {
  if (el.emojiPop.hidden) return;
  if (el.emojiPop.contains(event.target)) return;
  if (el.chatEmoji.contains(event.target)) return;
  // The button that just opened it. Without this the same click that
  // opens the picker from a message reaches this handler and closes it.
  if (event.target.closest?.('.react-btn')) return;
  closeEmojiPicker();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.emojiPop.hidden) closeEmojiPicker();
});

el.chatAttach.addEventListener('click', () => el.chatFile.click());

el.chatFile.addEventListener('change', () => {
  const file = el.chatFile.files?.[0] ?? null;
  // No note: the chip inside the box says what is attached, and it says it
  // where the thing will actually be sent from.
  if (file) setPendingFile(file);
  // Reset, so picking the same file twice in a row still fires 'change'.
  el.chatFile.value = '';
});

// Anywhere on the backdrop closes it, including the picture: at full size
// the picture IS most of the backdrop, and having to find an edge to click
// is the thing that makes a lightbox feel like a trap.
el.lightbox.addEventListener('click', () => closeLightbox());
el.lightboxClose.addEventListener('click', () => closeLightbox());
el.lightboxSave.addEventListener('click', async (event) => {
  event.stopPropagation();
  const message = lightboxOf;
  if (!message) return;
  try {
    const result = await harmony.media.save(
      message.attachmentHash, message.attachmentName ?? '',
    );
    if (result.saved) el.chatNote.textContent = `Saved ${result.name}.`;
  } catch (err) {
    showChannelsError(err.message);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.lightbox.hidden) closeLightbox();
});

el.chatPendingClear.addEventListener('click', () => {
  setPendingFile(null);
  el.chatInput.focus();
});

/*
 * Paste a picture straight into the box.
 *
 * clipboardData.files rather than walking .items: a screenshot arrives as
 * one entry in both, and files is already a FileList of exactly the things
 * that are files. The text half of a paste is left alone -- copying a
 * picture out of a web page puts BOTH an image and its HTML on the
 * clipboard, and preventDefault is called only when an image was actually
 * taken, so pasting ordinary text still pastes ordinary text.
 *
 * A pasted image has no name of its own ("image.png", every time), so it
 * gets a dated one here. Three screenshots in a row would otherwise all be
 * called the same thing in the folder somebody downloads them to.
 */
el.chatInput.addEventListener('paste', (event) => {
  const file = [...(event.clipboardData?.files ?? [])]
    .find((f) => f.type.startsWith('image/'));
  if (!file) return;

  event.preventDefault();
  const extension = file.type.split('/')[1]?.split('+')[0] ?? 'png';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  setPendingFile(new File([file], `pasted-${stamp}.${extension}`, { type: file.type }));
});

let searchTimer = null;
el.chatSearch.addEventListener('input', () => {
  // Debounced: every keystroke is a round trip and a full-text query
  // otherwise, and the answer for a half-typed word is never useful.
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(), 250);
});

el.chatSearchClear.addEventListener('click', () => {
  el.chatSearch.value = '';
  runSearch();
});

/*
 * The list itself is the "no group" drop target.
 *
 * Without it there is no way to take a channel back OUT of a group: every
 * other target is a channel or a heading, and both of those are inside one
 * once the sidebar has any. Dropping on the empty space below everything
 * puts it back at the end of the ungrouped block.
 */
/*
 * The empty space under the list.
 *
 * For a channel it means "out of every group", which is the only way back
 * out of one. For a group it means last, which is the only way to reach the
 * bottom -- there is no heading below the last heading to drop above.
 */
el.channelItems.addEventListener('dragover', (event) => {
  // A person dropped anywhere but a voice channel goes nowhere, and the
  // cursor should say so rather than promise a move.
  if (!dragging) return;
  if (dragging.kind === 'member') {
    clearDropMarks();
    return;
  }
  event.preventDefault();
});
el.channelItems.addEventListener('drop', (event) => {
  if (!dragging || dragging.kind === 'member') return;
  event.preventDefault();
  const { kind, id } = dragging;
  dragging = null;
  clearDropMarks();
  if (kind === 'channel') moveChannel(id, { groupId: null });
  else if (kind === 'group') moveGroup(id, null);
});

el.channelAdd.addEventListener('click', async () => {
  // One dialog with three fields, rather than three questions in a row and
  // a confirm box asking somebody to remember that "OK means voice".
  const answer = await ask({
    title: 'New channel',
    okLabel: 'Create',
    fields: [
      { name: 'name', label: 'Name', placeholder: 'Game Night', required: true },
      {
        name: 'kind',
        label: 'Kind',
        // A group is in the same menu rather than behind its own button:
        // it is the same question -- what are you adding to the sidebar --
        // and two buttons beside each other reading "+ New" and "+ Group"
        // is a thing people have to read twice.
        options: [
          { value: 'voice', label: 'Voice channel' },
          { value: 'text', label: 'Text channel' },
          { value: 'group', label: 'Group (a folder)' },
        ],
      },
      { name: 'password', label: 'Password', type: 'password', placeholder: 'Open to everyone' },
    ],
  });
  if (!answer?.name) return;
  const { name, kind } = answer;
  const password = answer.password || undefined;
  try {
    if (kind === 'group') await harmony.api.createGroup(state.server, name);
    else await harmony.api.createChannel(state.server, { kind, name, password });
    // The server broadcasts the new list to everyone, including us.
  } catch (err) {
    showChannelsError(err.message);
  }
});
el.username.addEventListener('keydown', (e) => e.key === 'Enter' && startSession());
el.serverUrl.addEventListener('keydown', (e) => e.key === 'Enter' && startSession());
el.password.addEventListener('keydown', (e) => e.key === 'Enter' && startSession());
el.accountPassword.addEventListener('keydown', (e) => e.key === 'Enter' && startSession());
el.accountConfirm.addEventListener('keydown', (e) => e.key === 'Enter' && startSession());

/**
 * Normalise the username box on the way out of it, not on every keystroke.
 *
 * On 'blur' and not 'input' deliberately: rewriting the value mid-word moves
 * the caret and makes typing a name with a space in it feel broken, even though
 * the result is the same. Waiting until they leave the field shows the stored
 * form without fighting them for the cursor.
 */
el.username.addEventListener('blur', () => {
  const folded = normalizeName(el.username.value);
  if (folded !== el.username.value) el.username.value = folded;
});

el.authModeToggle.addEventListener('click', async () => {
  // While a saved session is in force this button is the only way out of it,
  // because the account fields are hidden. Signing out puts the form back.
  if (state.auth.user) {
    await harmony.api.logout(state.server || el.serverUrl.value.trim()).catch(() => {});
    state.auth.user = null;
    await adoptSession('');
    state.auth.mode = 'login';
    showError('');
    applyAuthMode();
    el.accountPassword.focus();
    return;
  }
  state.auth.mode = state.auth.mode === 'register' ? 'login' : 'register';
  showError('');
  applyAuthMode();
  el.accountPassword.focus();
});

// Reflect the initial state once at startup, so the labels and
// data-auth-mode are never stale before the first server probe.
applyAuthMode();

el.rememberAccount.addEventListener('change', async () => {
  await harmony.settings.set({
    rememberAccount: el.rememberAccount.checked,
    // Unticking it has to forget what is already stored, or "remember me" is a
    // setting that only ever points one way.
    sessionToken: el.rememberAccount.checked ? state.auth.token : '',
  });
});
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
el.excludeApp.addEventListener('change', () => {
  // Remembered for as long as this picker is open, so Refresh does not put
  // Harmony back after somebody deliberately chose otherwise.
  state.excludeChoice = el.excludeApp.value;
  updateAudioNote();
});
el.audioInput.addEventListener('change', () => {
  harmony.settings.set({ audioInputId: el.audioInput.value }).catch(() => {});
  updateAudioNote();
});

el.startStream.addEventListener('click', () => {
  // The picker doubles as "change source" once a broadcast is running.
  if (state.changingSource) return applySourceChange();
  return startBroadcast();
});

el.liveResolution.addEventListener('change', applyLiveQuality);
el.liveFramerate.addEventListener('change', applyLiveQuality);

for (const group of [el.resolution, el.framerate]) {
  group.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (button) pickSegmented(group, button.dataset.value);
  });
}

// Escape, and anything else that would close the window from outside, means
// the same as Cancel -- which knows where to go back to. Closing the dialog
// directly would leave a channel share's target set, or a flat share's
// username claimed, with nothing on screen to finish or undo either.
el.picker.addEventListener('cancel', (event) => {
  event.preventDefault();
  if (!el.pickerBack.disabled) el.pickerBack.click();
});
el.livePriority.addEventListener('change', applyLiveQuality);

/**
 * Reopen the picker to swap what a running stream shows.
 *
 * From the broadcast screen's "Change source" and, for a share into a voice
 * channel, from the screen button's menu. Either way nothing is torn down:
 * applySourceChange() replaces the track under the existing connection.
 */
async function openChangeSource() {
  state.excludeChoice = null;
  state.changingSource = true;
  state.selectedSource = null;
  el.startStream.disabled = true;
  el.startStream.textContent = 'Use this source';
  el.pickerBack.textContent = 'Back to stream';
  el.pickerUsername.textContent = state.share.target
    ? `#${state.share.target.name}`
    : state.session.username;
  pickSegmented(el.resolution, el.liveResolution.value);
  pickSegmented(el.framerate, el.liveFramerate.value);
  openPicker();
  await loadSources();
  updateAudioNote();
}

el.changeSource.addEventListener('click', () => openChangeSource());

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
    showView(state.share.target ? 'view-channels' : 'view-broadcast');
    return;
  }
  // Backing out of a channel share: drop the target and go back to the
  // channel, which is where they came from. Nothing was published, so there
  // is nothing to tear down but the intent.
  if (state.share.target) {
    state.share.target = null;
    applyVoiceButtons();
    showView('view-channels');
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
  showVolume(el.mosaicVolume, el.mosaicVolumeLabel, value);
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

el.watchFullscreen.addEventListener('click', () => toggleFullscreen(el.watchView));
el.remote.addEventListener('dblclick', () => toggleFullscreen(el.watchView));

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
  state.watch.muted = !state.watch.muted;
  applyWatchAudio();
});

el.volume.addEventListener('input', () => {
  state.watch.volume = Number(el.volume.value) / 100;
  if (state.watch.volume > 0) state.watch.muted = false;
  applyWatchAudio();
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
