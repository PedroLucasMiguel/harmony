// The only bridge between the renderer and Node. Every capability is an
// explicit, narrow method -- the renderer never sees ipcRenderer itself.
//
// Each method resolves with main's { ok, data } | { ok, error } envelope,
// untouched. Nothing is thrown here on purpose: an Error crossing
// contextBridge arrives in the renderer stripped of its custom properties, so
// the renderer rebuilds it on its own side instead (src/renderer/bridge.js).

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('harmony', {
  platform: process.platform,

  settings: {
    get: invoke('settings:get'),
    set: invoke('settings:set'),
  },

  gpu: {
    status: invoke('gpu:status'),
  },

  /** The debug log: a text file for working out why a call stutters. See main/debug-log.js. */
  debug: {
    start: invoke('debug:start'),
    stop: invoke('debug:stop'),
    status: invoke('debug:status'),
    event: invoke('debug:event'),
    open: invoke('debug:open'),
  },

  relaunch: invoke('app:relaunch'),
  setScale: invoke('app:scale'),

  logos: {
    ensure: invoke('logos:ensure'),
  },

  version: invoke('app:version'),

  secrets: {
    protect: invoke('secrets:protect'),
    reveal: invoke('secrets:reveal'),
  },

  updates: {
    get: invoke('updates:get'),
    check: invoke('updates:check'),
    download: invoke('updates:download'),
    install: invoke('updates:install'),
    open: invoke('updates:open'),

    /**
     * The update status changed: a check started or finished, a download
     * moved, an update is ready. Always the whole status, never a delta.
     * @param {(status: object) => void} handler
     * @returns {() => void} unsubscribe
     */
    onStatus(handler) {
      const listener = (_event, status) => handler(status);
      ipcRenderer.on('updates:status', listener);
      return () => ipcRenderer.removeListener('updates:status', listener);
    },
  },

  /** The words the main process shows itself, in the language in use (main/strings.js). */
  strings: {
    set: invoke('strings:set'),
  },

  /** The tray icon and the taskbar thumbnail's buttons (main/voice-tray.js). */
  voiceTray: {
    setPictures: invoke('voice-tray:pictures'),
    setState: invoke('voice-tray:state'),
    /**
     * A button on the thumbnail or in the tray menu: 'mute', 'deafen', 'leave'.
     * @returns {() => void} unsubscribe
     */
    onCommand(handler) {
      const listener = (_event, command) => handler(command);
      ipcRenderer.on('voice-tray:command', listener);
      return () => ipcRenderer.removeListener('voice-tray:command', listener);
    },
  },

  ptt: {
    set: invoke('ptt:set'),
    openSettings: invoke('ptt:open-settings'),
    resetAccess: invoke('ptt:reset-access'),
    /** The key went down (true) or up (false), whichever application had focus. */
    onState: (handler) => {
      const listener = (_event, held) => handler(held);
      ipcRenderer.on('ptt:state', listener);
      return () => ipcRenderer.removeListener('ptt:state', listener);
    },
  },

  hotkeys: {
    set: invoke('hotkeys:set'),

    /**
     * A global hotkey fired, whichever application had focus.
     * @param {(id: string) => void} handler
     * @returns {() => void} unsubscribe
     */
    onFired(handler) {
      const listener = (_event, id) => handler(id);
      ipcRenderer.on('hotkey:fired', listener);
      return () => ipcRenderer.removeListener('hotkey:fired', listener);
    },
  },

  /**
   * Fires when the window is minimised or restored.
   * @param {(visible: boolean) => void} handler
   */
  onWindowVisibility(handler) {
    const listener = (_event, visible) => handler(visible);
    ipcRenderer.on('window:visibility', listener);
    return () => ipcRenderer.removeListener('window:visibility', listener);
  },

  permissions: {
    screen: invoke('permissions:screen-status'),
    openScreenSettings: invoke('permissions:screen-settings'),
    resetScreen: invoke('permissions:screen-reset'),
  },

  sources: {
    list: invoke('sources:list'),
    processes: invoke('sources:processes'),
    select: invoke('sources:select'),
    clear: invoke('sources:clear'),
  },

  audio: {
    availability: invoke('audio:availability'),
    start: invoke('audio:start'),
    stop: invoke('audio:stop'),

    /**
     * Raw interleaved S16LE stereo 48 kHz PCM from the native capture.
     * @param {(chunk: Uint8Array) => void} handler
     * @returns {() => void} unsubscribe
     */
    onPcm(handler) {
      const listener = (_event, chunk) => handler(chunk);
      ipcRenderer.on('audio:pcm', listener);
      return () => ipcRenderer.removeListener('audio:pcm', listener);
    },
  },

  clips: {
    save: invoke('clips:save'),
    reveal: invoke('clips:reveal'),
  },

  media: {
    setServer: invoke('media:server'),
    keep: invoke('media:keep'),
    stats: invoke('media:stats'),
    upload: invoke('media:upload'),
    uploadOpen: invoke('media:upload-open'),
    uploadChunk: invoke('media:upload-chunk'),
    uploadFinish: invoke('media:upload-finish'),
    uploadCancel: invoke('media:upload-cancel'),
    save: invoke('media:save'),
    /**
     * How far a save has got: { hash, received, total }.
     * @returns {() => void} unsubscribe
     */
    onProgress(handler) {
      const listener = (_event, progress) => handler(progress);
      ipcRenderer.on('media:progress', listener);
      return () => ipcRenderer.removeListener('media:progress', listener);
    },
    reveal: invoke('media:reveal'),
  },

  realtime: {
    connect: invoke('realtime:connect'),
    request: invoke('realtime:request'),
    disconnect: invoke('realtime:disconnect'),

    /**
     * Server-pushed frames: roster changes, channel edits, stream lists.
     * @param {(msg: object) => void} handler
     * @returns {() => void} unsubscribe
     */
    onEvent(handler) {
      const listener = (_event, msg) => handler(msg);
      ipcRenderer.on('realtime:event', listener);
      return () => ipcRenderer.removeListener('realtime:event', listener);
    },
  },

  // Every network request goes through main -- see src/main/api.js.
  api: {
    setPassword: invoke('api:password'),
    setSessionToken: invoke('api:session-token'),
    register: invoke('api:register'),
    login: invoke('api:login'),
    logout: invoke('api:logout'),
    changePassword: invoke('api:change-password'),
    recoveryStatus: invoke('api:recovery-status'),
    setRecovery: invoke('api:recovery-set'),
    clearRecovery: invoke('api:recovery-clear'),
    recoveryStart: invoke('api:recovery-start'),
    recoveryVerify: invoke('api:recovery-verify'),
    recoveryReset: invoke('api:recovery-reset'),
    me: invoke('api:me'),
    setAvatar: invoke('api:set-avatar'),
    setBanner: invoke('api:set-banner'),
    setJoinSound: invoke('api:set-join-sound'),
    setNameFont: invoke('api:set-name-font'),
    setNameColor: invoke('api:set-name-color'),
    badges: invoke('api:badges'),
    createBadge: invoke('api:create-badge'),
    updateBadge: invoke('api:update-badge'),
    deleteBadge: invoke('api:delete-badge'),
    setUserBadges: invoke('api:set-user-badges'),
    roster: invoke('api:roster'),
    setRole: invoke('api:set-role'),
    setDisplayName: invoke('api:set-display-name'),
    renameClip: invoke('api:rename-clip'),
    createGroup: invoke('api:create-group'),
    renameGroup: invoke('api:rename-group'),
    deleteGroup: invoke('api:delete-group'),
    arrange: invoke('api:arrange'),
    channels: invoke('api:channels'),
    createChannel: invoke('api:create-channel'),
    updateChannel: invoke('api:update-channel'),
    deleteChannel: invoke('api:delete-channel'),
    reorderChannels: invoke('api:reorder-channels'),
    roles: invoke('api:roles'),
    createRole: invoke('api:create-role'),
    updateRole: invoke('api:update-role'),
    deleteRole: invoke('api:delete-role'),
    reorderRoles: invoke('api:reorder-roles'),
    setUserRoles: invoke('api:set-user-roles'),
    kickUser: invoke('api:kick-user'),
    banUser: invoke('api:ban-user'),
    updateGroup: invoke('api:update-group'),
    messages: invoke('api:messages'),
    dmRequest: invoke('api:dm-request'),
    dmUpload: invoke('api:dm-upload'),
    dmDownload: invoke('api:dm-download'),
    postMessage: invoke('api:post-message'),
    pinMessage: invoke('api:pin-message'),
    deleteMessage: invoke('api:delete-message'),
    editMessage: invoke('api:edit-message'),
    setAttachment: invoke('api:set-attachment'),
    search: invoke('api:search'),
    deleteAccount: invoke('api:delete-account'),
    serverInfo: invoke('api:server-info'),
    updateServer: invoke('api:update-server'),
    react: invoke('api:react'),
    emojis: invoke('api:emojis'),
    addEmoji: invoke('api:add-emoji'),
    deleteEmoji: invoke('api:delete-emoji'),
    soundpad: invoke('api:soundpad'),
    addClip: invoke('api:add-clip'),
    deleteClip: invoke('api:delete-clip'),
    reorderClips: invoke('api:reorder-clips'),
    health: invoke('api:health'),
    probe: invoke('api:probe'),
    streams: invoke('api:streams'),
    session: invoke('api:session'),
    heartbeat: invoke('api:heartbeat'),
    release: invoke('api:release'),
    sdp: invoke('api:sdp'),
    hangup: invoke('api:hangup'),
  },
});
