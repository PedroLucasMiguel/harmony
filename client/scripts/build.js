// `npm run build`, with the compression level chosen on purpose.
//
//   npm run build            fast: 7-Zip level 3   (~10 s, ~107 MB installer)
//   npm run build:release    small: 7-Zip level 9  (~75 s,  ~86 MB installer)
//
// Measured on this project's ~300 MB win-unpacked, with the 7-Zip that
// electron-builder bundles:
//
//   level 9   72.3 s   85.9 MB
//   level 7   77.0 s   94.5 MB
//   level 5   40.4 s   96.1 MB
//   level 3    5.6 s  107.4 MB
//
// Nearly all of a build used to be that one 7-Zip call at level 9. Level 3
// is thirteen times faster for a quarter more size, which is the right
// trade for the build you make ten times while trying something; level 9 is
// still there for the one you hand out.
//
// Why a script: electron-builder ALWAYS archives the NSIS payload at -mx=9.
// The `compression` key in electron-builder.yml does not reach it -- only
// "store" does, which means no compression at all. The one override is the
// ELECTRON_BUILDER_COMPRESSION_LEVEL environment variable, and setting an
// environment variable inline in an npm script does not work in cmd.exe.
//
// Anything after the mode is passed through to electron-builder, so
// `node scripts/build.js release --win zip` works. An explicit
// ELECTRON_BUILDER_COMPRESSION_LEVEL in the environment still wins.

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const LEVELS = { fast: '3', release: '9' };

const args = process.argv.slice(2);
const mode = args[0] in LEVELS ? args.shift() : 'fast';

const env = { ...process.env };
env.ELECTRON_BUILDER_COMPRESSION_LEVEL ??= LEVELS[mode];
// Same reason as scripts/start.js: inherited from some tools' terminals, and
// it turns every Electron binary electron-builder runs into plain Node.
delete env.ELECTRON_RUN_AS_NODE;

// The macOS audio helper has to exist before the app is packaged: a mac build
// that quietly lacked it would ship an "exclude this app" picker that cannot
// do anything. (A no-op everywhere but macOS.)
const native = spawnSync(process.execPath, [path.join(__dirname, 'build-native.js')], { stdio: 'inherit' });
if (native.status !== 0) process.exit(native.status ?? 1);

const cli = require.resolve('electron-builder/cli.js');
const targets = args.length ? args : ['--win', 'nsis'];

console.log(
  `[build] ${mode}: 7-Zip level ${env.ELECTRON_BUILDER_COMPRESSION_LEVEL}, ${targets.join(' ')}`,
);

const child = spawn(process.execPath, [cli, ...targets], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env,
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : code ?? 0);
});
