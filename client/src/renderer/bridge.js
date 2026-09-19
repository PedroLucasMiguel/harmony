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

  api: {
    setPassword: lift(raw.api.setPassword),
    health: lift(raw.api.health),
    streams: lift(raw.api.streams),
    session: lift(raw.api.session),
    heartbeat: lift(raw.api.heartbeat),
    release: lift(raw.api.release),
    sdp: lift(raw.api.sdp),
    hangup: lift(raw.api.hangup),
  },
};
