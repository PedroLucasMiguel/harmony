// Updates, from the project's GitHub Releases.
//
// Releases are built by .github/workflows/release.yml whenever a v* tag is
// pushed. Each one carries the installers plus the latest.yml /
// latest-linux.yml that electron-updater reads to know what is current.
//
// Nothing downloads on its own. A check finds a newer version and says so;
// the person decides. Two ways that plays out:
//
//   Windows, Linux AppImage   electron-updater: download on request, then
//                             install on restart -- or on the next quit,
//                             whichever comes first. The NSIS installer is
//                             per-user and never elevates, so this needs no
//                             admin prompt, same as the first install did.
//
//   macOS                     notify only. Squirrel.Mac refuses to apply an
//                             update that is not signed with an Apple
//                             Developer ID, and these builds are not -- so
//                             the "update" is opening the release page.
//
// Builds that cannot update themselves at all -- `npm start`, or a Linux
// build run from anywhere but its AppImage -- report 'unsupported' and never
// touch the network.

const { app, net, shell } = require('electron');

const OWNER = 'PedroLucasMiguel';
const REPO = 'harmony';

/** Late enough that a check never competes with the app opening. */
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * What the renderer is told, whole, every time anything changes.
 *
 * state: idle | checking | available | downloading | ready | latest | error | unsupported
 * manual: true when "updating" means downloading by hand (macOS)
 */
let status = { state: 'idle', current: app.getVersion() };
let notify = () => {};
/** electron-updater's autoUpdater; loaded only where it can actually work. */
let updater = null;
let timer = null;

const releasePage = (version) =>
  version
    ? `https://github.com/${OWNER}/${REPO}/releases/tag/v${version}`
    : `https://github.com/${OWNER}/${REPO}/releases/latest`;

function set(patch) {
  status = { current: app.getVersion(), ...patch };
  notify(status);
}

/** Why this build cannot update itself, or null when it can. */
function unsupportedReason() {
  if (!app.isPackaged) return 'Updates apply to an installed build, not a development run.';
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    return 'Only the AppImage build updates itself.';
  }
  return null;
}

/** Major.minor.patch, numerically. A pre-release suffix is ignored. */
function newer(candidate, current) {
  const parts = (v) => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function loadUpdater() {
  if (updater) return updater;
  // Required here, not at the top: it is only ever needed in an installed
  // build, and loading it costs startup time a development run need not pay.
  ({ autoUpdater: updater } = require('electron-updater'));
  updater.autoDownload = false;
  // Once the person has chosen to download it, quitting installs it too.
  updater.autoInstallOnAppQuit = true;
  updater.logger = null;

  updater.on('update-available', (info) => {
    set({ state: 'available', version: info.version, url: releasePage(info.version) });
  });
  updater.on('update-not-available', () => set({ state: 'latest' }));
  updater.on('download-progress', (progress) => {
    set({
      state: 'downloading',
      version: status.version,
      url: status.url,
      percent: Math.floor(progress.percent ?? 0),
    });
  });
  updater.on('update-downloaded', (info) => {
    set({ state: 'ready', version: info.version, url: releasePage(info.version) });
  });
  updater.on('error', (err) => {
    // A failed download goes back to "available", so it can be retried.
    set({
      state: 'error',
      version: status.version,
      url: status.url,
      error: err?.message ?? String(err),
    });
  });
  return updater;
}

/** macOS: ask the GitHub API what the latest release is. */
async function checkManually() {
  const response = await net.fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`,
    { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Harmony' } },
  );
  if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
  const release = await response.json();
  const version = String(release.tag_name ?? '').replace(/^v/, '');
  if (version && newer(version, app.getVersion())) {
    set({ state: 'available', version, url: release.html_url || releasePage(version), manual: true });
  } else {
    set({ state: 'latest' });
  }
}

async function check() {
  const reason = unsupportedReason();
  if (reason) {
    set({ state: 'unsupported', error: reason });
    return status;
  }
  // Already found, fetching or fetched: checking again would only lose that.
  if (['checking', 'downloading', 'ready'].includes(status.state)) return status;

  set({ state: 'checking' });
  try {
    if (process.platform === 'darwin') {
      await checkManually();
    } else {
      // The events above set the outcome; this only has to not throw.
      await loadUpdater().checkForUpdates();
    }
  } catch (err) {
    set({ state: 'error', error: err?.message ?? String(err) });
  }
  return status;
}

async function download() {
  if (status.manual || process.platform === 'darwin') return open();
  if (!['available', 'error'].includes(status.state) || !status.version) return status;
  set({ state: 'downloading', version: status.version, url: status.url, percent: 0 });
  try {
    await loadUpdater().downloadUpdate();
  } catch (err) {
    set({ state: 'error', version: status.version, url: status.url, error: err?.message ?? String(err) });
  }
  return status;
}

/** Restart into the downloaded version: a silent install, then relaunch. */
function install() {
  if (status.state !== 'ready' || !updater) return false;
  // On the next tick, so the IPC reply gets back before the app goes.
  setImmediate(() => updater.quitAndInstall(true, true));
  return true;
}

/** The release page: the whole of an update on macOS, release notes elsewhere. */
async function open() {
  await shell.openExternal(status.url || releasePage(status.version));
  return status;
}

/**
 * Start checking: once shortly after launch, then every few hours.
 * @param {(status: object) => void} onStatus
 */
function start(onStatus) {
  notify = onStatus;
  const reason = unsupportedReason();
  if (reason) {
    set({ state: 'unsupported', error: reason });
    return;
  }
  setTimeout(() => check(), FIRST_CHECK_MS).unref?.();
  timer = setInterval(() => check(), CHECK_EVERY_MS);
  timer.unref?.();
}

module.exports = {
  start,
  check,
  download,
  install,
  open,
  get: () => status,
};
