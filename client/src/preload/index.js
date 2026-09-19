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

  relaunch: invoke('app:relaunch'),

  /**
   * Fires when the window is minimised or restored.
   * @param {(visible: boolean) => void} handler
   */
  onWindowVisibility(handler) {
    const listener = (_event, visible) => handler(visible);
    ipcRenderer.on('window:visibility', listener);
    return () => ipcRenderer.removeListener('window:visibility', listener);
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

  // Every network request goes through main -- see src/main/api.js.
  api: {
    setPassword: invoke('api:password'),
    health: invoke('api:health'),
    streams: invoke('api:streams'),
    session: invoke('api:session'),
    heartbeat: invoke('api:heartbeat'),
    release: invoke('api:release'),
    sdp: invoke('api:sdp'),
    hangup: invoke('api:hangup'),
  },
});
