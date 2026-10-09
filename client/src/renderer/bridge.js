// Renderer-side view of the preload bridge.
//
// The preload hands back main's { ok, data } | { ok, error } envelopes as plain
// objects. They are turned into real Errors *here*, in the renderer's own
// JavaScript world, because an Error thrown across contextBridge arrives with
// its custom properties stripped -- `err.code` would be undefined, and the UI
// depends on it to tell "stream is not live yet, keep waiting" apart from
// "something is actually broken".

const raw = window.harmony;

function unwrap(result) {
  if (!result || typeof result !== 'object' || !('ok' in result)) return result;
  if (result.ok) return result.data;

  const error = new Error(result.error.message);
  error.code = result.error.code;
  error.status = result.error.status;
  throw error;
}

const lift = (fn) => async (...args) => unwrap(await fn(...args));

export const harmony = {
  platform: raw.platform,

  settings: {
    get: lift(raw.settings.get),
    set: lift(raw.settings.set),
  },

  gpu: {
    status: lift(raw.gpu.status),
  },

  relaunch: lift(raw.relaunch),
  setScale: lift(raw.setScale),
  logos: {
    ensure: lift(raw.logos.ensure),
  },
  version: lift(raw.version),
  updates: {
    get: lift(raw.updates.get),
    check: lift(raw.updates.check),
    download: lift(raw.updates.download),
    install: lift(raw.updates.install),
    open: lift(raw.updates.open),
    onStatus: (handler) => raw.updates.onStatus(handler),
  },
  hotkeys: {
    set: lift(raw.hotkeys.set),
    onFired: (handler) => raw.hotkeys.onFired(handler),
  },
  onWindowVisibility: (handler) => raw.onWindowVisibility(handler),

  sources: {
    list: lift(raw.sources.list),
    processes: lift(raw.sources.processes),
    select: lift(raw.sources.select),
    clear: lift(raw.sources.clear),
  },

  audio: {
    availability: lift(raw.audio.availability),
    start: lift(raw.audio.start),
    stop: lift(raw.audio.stop),
    onPcm: (handler) => raw.audio.onPcm(handler),
  },

  clips: {
    save: lift(raw.clips.save),
    reveal: lift(raw.clips.reveal),
  },

  // Every method is listed by hand rather than mapped over raw.api, because
  // lift() has to wrap each one and the push-style subscriptions (onPcm,
  // onEvent) must NOT be wrapped. The cost of that is this list: a method
  // added to the preload and forgotten here is simply undefined at runtime,
  // with no error until something calls it.
  api: {
    setPassword: lift(raw.api.setPassword),
    setSessionToken: lift(raw.api.setSessionToken),
    health: lift(raw.api.health),
    probe: lift(raw.api.probe),
    streams: lift(raw.api.streams),
    session: lift(raw.api.session),
    heartbeat: lift(raw.api.heartbeat),
    release: lift(raw.api.release),
    sdp: lift(raw.api.sdp),
    hangup: lift(raw.api.hangup),

    register: lift(raw.api.register),
    login: lift(raw.api.login),
    logout: lift(raw.api.logout),
    me: lift(raw.api.me),
    setAvatar: lift(raw.api.setAvatar),
    roster: lift(raw.api.roster),
    setRole: lift(raw.api.setRole),
    setDisplayName: lift(raw.api.setDisplayName),
    renameClip: lift(raw.api.renameClip),
    createGroup: lift(raw.api.createGroup),
    renameGroup: lift(raw.api.renameGroup),
    deleteGroup: lift(raw.api.deleteGroup),
    arrange: lift(raw.api.arrange),

    channels: lift(raw.api.channels),
    createChannel: lift(raw.api.createChannel),
    updateChannel: lift(raw.api.updateChannel),
    deleteChannel: lift(raw.api.deleteChannel),
    reorderChannels: lift(raw.api.reorderChannels),

    messages: lift(raw.api.messages),
    postMessage: lift(raw.api.postMessage),
    pinMessage: lift(raw.api.pinMessage),
    deleteMessage: lift(raw.api.deleteMessage),
    editMessage: lift(raw.api.editMessage),
    setAttachment: lift(raw.api.setAttachment),
    search: lift(raw.api.search),
    deleteAccount: lift(raw.api.deleteAccount),
    serverInfo: lift(raw.api.serverInfo),
    updateServer: lift(raw.api.updateServer),
    react: lift(raw.api.react),
    emojis: lift(raw.api.emojis),
    addEmoji: lift(raw.api.addEmoji),
    deleteEmoji: lift(raw.api.deleteEmoji),
    soundpad: lift(raw.api.soundpad),
    addClip: lift(raw.api.addClip),
    deleteClip: lift(raw.api.deleteClip),
    reorderClips: lift(raw.api.reorderClips),
  },

  media: {
    setServer: lift(raw.media.setServer),
    keep: lift(raw.media.keep),
    stats: lift(raw.media.stats),
    upload: lift(raw.media.upload),
    save: lift(raw.media.save),
    reveal: lift(raw.media.reveal),
  },

  /**
   * The URL for a cached file.
   *
   * Usable directly as an <img src> or <audio src>: the protocol handler in
   * main downloads and verifies it on first use, so the renderer never needs
   * to know whether it is already on disk.
   */
  mediaUrl: (hash) => `harmony://app/media/${hash}`,

  realtime: {
    connect: lift(raw.realtime.connect),
    request: lift(raw.realtime.request),
    disconnect: lift(raw.realtime.disconnect),
    onEvent: (handler) => raw.realtime.onEvent(handler),
  },
};
