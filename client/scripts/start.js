// `npm start`, proof against ELECTRON_RUN_AS_NODE.
//
// That variable makes the Electron binary behave as plain Node: no app, no
// BrowserWindow, no renderer. The first thing to touch `app` then throws,
// which in this project is settings.js on line 9:
//
//   TypeError: Cannot read properties of undefined (reading 'getPath')
//
// It reads like a bug in the app and is a bug in the environment. Plenty of
// tools set it for their own child processes -- VS Code and anything
// embedding Electron among them -- and it is inherited by every terminal
// those tools open, so a developer can hit this without having typed it.
//
// client/test/cdp.mjs has deleted it since the test harness was written,
// with the same comment. `npm start` had no such protection, which is why
// the tests kept passing while the app would not open.
//
// Nothing here is Electron-specific beyond the spawn: this file runs under
// plain Node, so `require('electron')` returns the path to the binary
// rather than the module.

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

// macOS: the audio helper, when it is missing or older than its source. Never
// fatal here -- without it the app still runs, and says why on the picker.
spawnSync(process.execPath, [path.join(__dirname, 'build-native.js'), '--if-stale'], { stdio: 'inherit' });

const electron = require('electron');

const env = { ...process.env };
const wasSet = env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RUN_AS_NODE;

if (wasSet) {
  console.warn(
    '[start] ELECTRON_RUN_AS_NODE was set in this shell and has been ignored.\n'
    + '        With it, Electron runs as plain Node and the app cannot open.',
  );
}

const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

// Pass the exit code through, so a crash is still a failure to whatever ran
// this -- npm, a shell script, CI.
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : code ?? 0);
});
