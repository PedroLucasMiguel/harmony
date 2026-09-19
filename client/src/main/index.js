const { app, BrowserWindow, desktopCapturer, ipcMain, net, protocol, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const settings = require('./settings');
const sources = require('./sources');
const appAudio = require('./app-audio');
const api = require('./api');
const clips = require('./clips');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const MODULES_DIR = path.join(__dirname, '..', '..', 'node_modules');

// Chromium throttles renderers whose window is hidden, minimised or covered by
// another window: timers drop to roughly once a second and the WebRTC encoder
// slows to match. For an ordinary app that saves battery. For a screen sharer it
// means the stream collapses the moment the broadcaster switches to the thing
// they are sharing -- which is always. All three of these must be off.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// The UI is served over a custom scheme rather than file://, because a file://
// document is an opaque origin: ES modules and AudioWorklet.addModule() both
// fail CORS there. Marking the scheme secure also makes it a secure context,
// which getDisplayMedia() requires.
//
// Must run before app 'ready'.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'harmony',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

/** @type {BrowserWindow|null} */
let win = null;

/**
 * The source the user picked in our own UI, parked here for
 * setDisplayMediaRequestHandler -- that handler cannot prompt, so the choice
 * has to be made before getDisplayMedia() is called.
 * @type {Electron.DesktopCapturerSource|null}
 */
let pendingSource = null;

/**
 * Whether to attach Chromium's own system-wide loopback audio. Only used when
 * the native per-application capture is unavailable -- see src/main/app-audio.js.
 */
let pendingLoopbackAudio = false;

function registerProtocol() {
  protocol.handle('harmony', async (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';

    // `vendor/...` serves ES modules straight from node_modules, so third-party
    // libraries stay managed by npm instead of being copied into the repo.
    const underVendor = rel.startsWith('vendor/');
    const root = underVendor ? MODULES_DIR : RENDERER_DIR;
    const target = path.join(root, underVendor ? rel.slice('vendor/'.length) : rel);

    // Never serve anything outside the directory we chose.
    if (target !== root && !target.startsWith(root + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    // Small enough to sit in a corner of a second monitor. The layout has
    // breakpoints down to this size; below it things genuinely stop fitting.
    minWidth: 560,
    minHeight: 420,
    backgroundColor: '#0f1116',
    title: 'Harmony',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Belt and braces with the command-line switches above: this is the
      // per-window form of the same thing.
      backgroundThrottling: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL('harmony://app/index.html');

  // In a dev run, renderer errors would otherwise vanish into DevTools nobody
  // has open. Warnings and errors only -- this is not a console mirror.
  if (!app.isPackaged) {
    win.webContents.on('console-message', (event) => {
      if (event.level === 'warning' || event.level === 'error') {
        console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
      }
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[renderer] failed to load ${url}: ${desc} (${code})`);
    });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    appAudio.stop();
    win = null;
  });
}

app.whenReady().then(() => {
  registerProtocol();

  // getDisplayMedia() resolves to whatever the user already chose in our picker.
  // Passing {} denies the request.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      if (!pendingSource) return callback({});
      // Normally video only: audio comes from the native capture pipeline,
      // which can scope itself to a single application. Chromium's loopback is
      // system-wide, so it is used solely as a fallback the user opted into.
      callback(
        pendingLoopbackAudio
          ? { video: pendingSource, audio: 'loopback' }
          : { video: pendingSource },
      );
    },
    { useSystemPicker: false },
  );

  // 'fullscreen' belongs here too: Electron gates HTML fullscreen behind a
  // permission, and denying it makes element.requestFullscreen() hang forever
  // rather than reject -- a silent failure that looks like a broken button.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'display-capture', 'audioCapture', 'fullscreen'].includes(permission));
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  appAudio.stop();
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/**
 * Every handler answers with the same envelope: { ok, data } or { ok, error }.
 *
 * Errors are not thrown across the boundary because an Error crossing
 * contextBridge loses its custom properties -- `err.code` arrives undefined in
 * the renderer, and the UI switches on exactly that. A plain object survives
 * structured cloning intact; the renderer turns it back into a real Error on
 * its own side (see src/renderer/bridge.js).
 */
const handle = (channel, fn) => {
  ipcMain.handle(channel, async (...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return {
        ok: false,
        error: { message: err.message, code: err.code ?? 'error', status: err.status ?? 0 },
      };
    }
  });
};

handle('settings:get', () => settings.read());
handle('settings:set', (_e, patch) => settings.write(patch ?? {}));

handle('sources:list', () => sources.list());
handle('sources:processes', () => sources.listProcesses());

handle('sources:select', async (_e, sourceId, options = {}) => {
  const all = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 1, height: 1 },
  });
  pendingSource = all.find((s) => s.id === sourceId) ?? null;
  pendingLoopbackAudio = Boolean(options.loopbackAudio);
  return Boolean(pendingSource);
});

handle('sources:clear', () => {
  pendingSource = null;
  pendingLoopbackAudio = false;
  return true;
});

handle('audio:availability', () => appAudio.availability());

handle('audio:start', (_e, opts) => {
  const target = win;
  return appAudio.start(opts, (chunk) => {
    if (target && !target.isDestroyed()) target.webContents.send('audio:pcm', chunk);
  });
});

handle('clips:save', (_e, data, label) => clips.save(data, label));
handle('clips:reveal', (_e, file) => clips.reveal(file));

handle('audio:stop', () => {
  appAudio.stop();
  return true;
});

handle('api:password', (_e, value) => api.setPassword(value));
handle('api:health', (_e, server) => api.health(server));
handle('api:streams', (_e, server) => api.streams(server));
handle('api:session', (_e, server, username, token) => api.session(server, username, token));
handle('api:heartbeat', (_e, server, u, t) => api.heartbeat(server, u, t));
handle('api:release', (_e, server, u, t) => api.release(server, u, t));
handle('api:sdp', (_e, url, offer) => api.sdpExchange(url, offer));
handle('api:hangup', (_e, resourceUrl) => api.deleteResource(resourceUrl).then(() => true));
