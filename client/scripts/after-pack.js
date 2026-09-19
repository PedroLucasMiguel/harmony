// Strip files Electron ships that Harmony provably does not use.
//
// The app's own code is under a megabyte; essentially all of the download is
// the Chromium runtime. These are the parts of it that can go without changing
// what the app can do. Everything here is measured in `npm run build` output --
// if a removal ever breaks a machine, delete the entry and rebuild.

const fs = require('node:fs');
const path = require('node:path');

/**
 * DirectX shader compilation for WebGPU.
 *
 * Harmony renders video elements and a little CSS; it has no WebGPU, no WebGL
 * beyond what the compositor does for itself, and no shaders of its own.
 * Chromium loads these lazily and disables WebGPU when they are absent, which
 * costs this app nothing. Together they are the single biggest saving after
 * the locales.
 */
const REMOVE_FILES = ['dxcompiler.dll', 'dxil.dll'];

/** Prebuilt native binaries for platforms this package is not for. */
function pruneForeignPrebuilds(appOutDir, platformName, log) {
  const root = path.join(
    appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'loopback-capture',
    'prebuilds',
  );
  if (!fs.existsSync(root)) return 0;

  const keep = { win32: 'win32-', darwin: 'darwin-', linux: 'linux-' }[platformName] ?? '';
  let freed = 0;
  for (const entry of fs.readdirSync(root)) {
    if (keep && entry.startsWith(keep)) continue;
    const target = path.join(root, entry);
    freed += dirSize(target);
    fs.rmSync(target, { recursive: true, force: true });
    log(`  pruned prebuild ${entry}`);
  }
  return freed;
}

function dirSize(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.size;
  return fs
    .readdirSync(target)
    .reduce((sum, child) => sum + dirSize(path.join(target, child)), 0);
}

exports.default = async function afterPack({ appOutDir, electronPlatformName }) {
  const log = (line) => console.log(line);
  let freed = 0;

  for (const name of REMOVE_FILES) {
    const target = path.join(appOutDir, name);
    if (!fs.existsSync(target)) continue;
    freed += fs.statSync(target).size;
    fs.rmSync(target);
    log(`  removed ${name}`);
  }

  freed += pruneForeignPrebuilds(appOutDir, electronPlatformName, log);

  if (freed) log(`  after-pack freed ${(freed / 1e6).toFixed(1)} MB before compression`);
};
