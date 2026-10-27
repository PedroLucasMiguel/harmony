// Compiles the macOS audio-capture helper (native/mac/harmony-audio-capture.swift).
//
//   node scripts/build-native.js              build it; fail if that is not possible
//   node scripts/build-native.js --if-stale   only when missing or older than its source,
//                                             and only warn on failure (what `npm start` uses)
//
// One universal binary, because electron-builder makes an x64 and an arm64 app
// from the same checkout and the helper has to run in both. Nothing happens on
// other platforms: Windows has the loopback-capture addon, Linux has no helper.
//
// Needs Xcode or the command line tools for swiftc. Output goes to
// build/native/, where src/main/audio-mac.js looks in a checkout and where
// electron-builder.yml copies it from for a packaged app.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const NAME = 'harmony-audio-capture';
const root = path.join(__dirname, '..');
const source = path.join(root, 'native', 'mac', `${NAME}.swift`);
const outDir = path.join(root, 'build', 'native');
const output = path.join(outDir, NAME);

const staleOnly = process.argv.includes('--if-stale');

function bail(message) {
  if (staleOnly) {
    console.warn(`[native] ${message}`);
    process.exit(0);
  }
  console.error(`[native] ${message}`);
  process.exit(1);
}

if (process.platform !== 'darwin') process.exit(0);

if (staleOnly && fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) {
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });

const slices = [];
for (const arch of ['arm64', 'x86_64']) {
  const slice = `${output}-${arch}`;
  // macOS 13: the first release with audio in ScreenCaptureKit. The helper
  // checks nothing itself; audio-mac.js refuses to start it on anything older.
  const built = spawnSync(
    'xcrun',
    ['swiftc', '-O', '-target', `${arch}-apple-macos13.0`, '-o', slice, source],
    { stdio: 'inherit' },
  );
  if (built.error || built.status !== 0) {
    bail(`could not compile ${NAME} for ${arch}. Is Xcode (or its command line tools) installed?`);
  }
  slices.push(slice);
}

const joined = spawnSync('lipo', ['-create', '-output', output, ...slices], { stdio: 'inherit' });
for (const slice of slices) fs.rmSync(slice, { force: true });
if (joined.error || joined.status !== 0) bail('lipo could not join the two architectures.');

// A fresh ad-hoc signature on the joined file: lipo invalidates the ones the
// linker put on each slice, and an arm64 binary with no valid signature is
// killed on launch.
const signed = spawnSync('codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' });
if (signed.error || signed.status !== 0) bail('codesign failed on the helper.');

console.log(`[native] built ${path.relative(root, output)}`);
