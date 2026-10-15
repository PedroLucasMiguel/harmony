// The system tray icon, the buttons on the taskbar thumbnail, and closing the
// window to the tray rather than quitting.
//
// Closing the window keeps Harmony running: a call goes on, hotkeys keep
// working, and a mention still makes its sound. The tray icon is the way back
// in and the way out (Quit). The first time the window goes, a balloon says
// so -- once, ever, remembered in settings.json -- because an app that seems
// to have closed but is still in a call is the worst way to find out.
//
// What the icon shows comes from the page: the app's own icon outside a
// call; inside one a grey tile that turns green while you talk, with a red
// badge while muted or deafened. The pictures are drawn by the page too (see
// src/renderer/tray-icons.js) and handed over once.
//
// The thumbnail buttons -- mute, deafen, disconnect, as Discord has them --
// exist only on Windows and only during a call.

const {
  app, Menu, Notification, Tray, nativeImage, nativeTheme, powerMonitor,
} = require('electron');
const path = require('node:path');

const settings = require('./settings');

/** @type {Tray|null} */
let tray = null;
/** @type {() => (Electron.BrowserWindow|null)} */
let getWindow = () => null;
/** @type {(command: 'mute'|'deafen'|'leave') => void} */
let sendCommand = () => {};

/** Set once anything has asked the app to really quit. */
let quitting = false;

/** The page's pictures, as nativeImages. Null until the page sends them. */
let pictures = null;

let voice = { inVoice: false, muted: false, deafened: false, speaking: false, channel: '' };

/** What the thumbnail buttons were last set to, so speaking does not reset them. */
let thumbarKey = '';

const appIcon = () => {
  if (process.platform === 'win32') {
    // Every size the tray can ask for, already drawn.
    return nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));
  }
  const full = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, buffer: full.resize({ width: 16, height: 16 }).toPNG() });
  img.addRepresentation({ scaleFactor: 2, buffer: full.resize({ width: 32, height: 32 }).toPNG() });
  return img;
};

/** [{ scale, size, dataURL }] from the page into one image with every scale. */
function fromPage(reps) {
  const img = nativeImage.createEmpty();
  for (const { scale, size, dataURL } of reps ?? []) {
    img.addRepresentation({ scaleFactor: scale, width: size, height: size, dataURL });
  }
  return img;
}

function showWindow() {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quit() {
  quitting = true;
  app.quit();
}

function trayImage() {
  if (!voice.inVoice || !pictures) return appIcon();
  if (voice.deafened) return pictures.tray.deafened;
  if (voice.muted) return pictures.tray.muted;
  return voice.speaking ? pictures.tray.speaking : pictures.tray.voice;
}

function tooltip() {
  if (!voice.inVoice) return 'Harmony';
  const where = voice.channel ? ` — ${voice.channel}` : '';
  const how = voice.deafened ? ' (deafened)' : voice.muted ? ' (muted)' : '';
  return `Harmony${where}${how}`;
}

function menu() {
  return Menu.buildFromTemplate([
    { label: 'Open Harmony', click: showWindow },
    { type: 'separator' },
    {
      label: 'Mute',
      type: 'checkbox',
      checked: voice.muted,
      enabled: voice.inVoice,
      click: () => command('mute'),
    },
    {
      label: 'Deafen',
      type: 'checkbox',
      checked: voice.deafened,
      enabled: voice.inVoice,
      click: () => command('deafen'),
    },
    { label: 'Disconnect', visible: voice.inVoice, click: () => command('leave') },
    { type: 'separator' },
    { label: 'Quit Harmony', click: quit },
  ]);
}

/*
 * A click on a checkbox ticks it at once, whatever the page then decides --
 * and the page may refuse (an admin's mute). The menu is rebuilt from what
 * is known straight away, and again when the page reports what happened.
 */
function command(name) {
  sendCommand(name);
  tray?.setContextMenu(menu());
}

/** What the menu and tooltip were last built from: talking changes neither. */
let menuKey = '';

function applyTray() {
  if (!tray) return;
  tray.setImage(trayImage());
  // Speaking flips several times a second; rebuilding the menu that often
  // would snap it shut under the pointer of somebody using it.
  const key = `${voice.inVoice}:${voice.muted}:${voice.deafened}:${voice.channel}`;
  if (key === menuKey) return;
  menuKey = key;
  tray.setToolTip(tooltip());
  tray.setContextMenu(menu());
}

function applyThumbar({ force = false } = {}) {
  if (process.platform !== 'win32') return;
  const win = getWindow();
  if (!win || win.isDestroyed()) return;

  // The system's theme, not the app's: the thumbnail is drawn by Windows,
  // light or dark with the taskbar.
  const ink = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI === false ? 'light' : 'dark';
  const key = voice.inVoice && pictures ? `${ink}:${voice.muted}:${voice.deafened}` : '';
  if (key === thumbarKey && !force) return;
  thumbarKey = key;

  if (!key) {
    win.setThumbarButtons([]);
    return;
  }
  const set = pictures.buttons[ink];
  // false while the window is hidden; 'show' puts them on again.
  const ok = win.setThumbarButtons([
    {
      tooltip: voice.muted ? 'Unmute' : 'Mute',
      icon: voice.muted ? set.micOff : set.mic,
      click: () => sendCommand('mute'),
    },
    {
      tooltip: voice.deafened ? 'Undeafen' : 'Deafen',
      icon: voice.deafened ? set.deafenOff : set.deafen,
      click: () => sendCommand('deafen'),
    },
    {
      tooltip: 'Disconnect',
      icon: set.leave,
      click: () => sendCommand('leave'),
    },
  ]);
  if (!ok) thumbarKey = '';
}

/** Said once, ever: the window closed, the app did not. */
function firstCloseHint() {
  if (settings.read().trayHintShown) return;
  settings.write({ trayHintShown: true });
  const title = 'Harmony is still running';
  const content = 'It keeps going down here, calls included. Right-click this icon to quit.';
  if (process.platform === 'win32' && tray) {
    tray.displayBalloon({ iconType: 'custom', icon: appIcon(), title, content });
  } else if (Notification.isSupported()) {
    new Notification({ title, body: content.replace('down here', 'in the tray') }).show();
  }
}

/**
 * Put the icon in the tray. Once, at startup.
 *
 * @param {object} opts
 * @param {() => (Electron.BrowserWindow|null)} opts.window
 * @param {(command: string) => void} opts.onCommand
 */
function start({ window, onCommand }) {
  getWindow = window;
  sendCommand = onCommand;

  // The id the installer's shortcut carries (electron-builder.yml), so the
  // balloon is from "Harmony" and groups with the pinned taskbar icon.
  if (process.platform === 'win32') app.setAppUserModelId('com.harmony.client');

  tray = new Tray(appIcon());
  tray.on('click', showWindow);
  applyTray();

  app.on('before-quit', () => { quitting = true; });
  // Shutting the machine down is quitting too. A window that answered the
  // system's close by hiding would hold up the shutdown.
  powerMonitor.on('shutdown', () => { quitting = true; });
  nativeTheme.on('updated', () => applyThumbar());
}

/**
 * A new window: closing it hides it instead, and its thumbnail gets the
 * buttons -- again after every hide, which is when Windows forgets them.
 */
function attach(win) {
  thumbarKey = '';
  // Windows' log-off and shutdown, which arrive as a close. See start().
  win.on('query-session-end', () => { quitting = true; });
  win.on('session-end', () => { quitting = true; });
  win.on('close', (event) => {
    if (quitting || !tray) return;
    event.preventDefault();
    win.hide();
    firstCloseHint();
  });
  win.on('show', () => applyThumbar({ force: true }));
  win.on('restore', () => applyThumbar({ force: true }));
}

/** The page's pictures, sent once after it loads. */
function setPictures(data) {
  const convert = (group) => Object.fromEntries(
    Object.entries(group ?? {}).map(([name, reps]) => [name, fromPage(reps)]),
  );
  pictures = {
    tray: convert(data?.tray),
    buttons: { dark: convert(data?.buttons?.dark), light: convert(data?.buttons?.light) },
  };
  applyTray();
  applyThumbar({ force: true });
  return true;
}

/** Where the page says the call is: in one or not, muted, deafened, talking. */
function setState(next) {
  voice = {
    inVoice: Boolean(next?.inVoice),
    muted: Boolean(next?.muted),
    deafened: Boolean(next?.deafened),
    speaking: Boolean(next?.speaking),
    channel: String(next?.channel ?? '').slice(0, 100),
  };
  applyTray();
  applyThumbar();
  return true;
}

module.exports = { start, attach, setPictures, setState, showWindow, quit };
