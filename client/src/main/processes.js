// Process tables and trees, for the platforms that have no per-process audio
// API of their own (macOS and Linux).
//
// Excluding an application's audio has to exclude the whole tree under it,
// not just the PID the person picked: an Electron app -- Harmony itself, but
// also Discord, Chrome and most things people want out of a stream -- plays its
// sound from a child process, so excluding only the parent excludes nothing.
// Windows' process loopback takes the tree as an option; here it is worked out.

const { execFile } = require('node:child_process');
const path = require('node:path');

/** `ps -axo pid=,ppid=,comm=` -> [{pid, ppid, command}]. Pure, for the tests. */
function parsePs(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return rows;
}

/** The root and every process beneath it. Pure, for the tests. */
function descendants(rows, root) {
  const children = new Map();
  for (const { pid, ppid } of rows) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const found = new Set([root]);
  const queue = [root];
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (!found.has(child)) {
        found.add(child);
        queue.push(child);
      }
    }
  }
  return found;
}

function table() {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,comm='],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : parsePs(stdout)),
    );
  });
}

/** The pids that make up one application. Just the one, if `ps` is no help. */
async function tree(pid) {
  return descendants(await table(), pid);
}

/**
 * This process, marked, and always present in the list.
 *
 * It is the entry the picker selects by default: a whole-screen share would
 * otherwise send everybody's voices back into the channel. Same shape the
 * Windows listing produces, which is what the renderer reads.
 */
function withSelf(list) {
  const rest = list.filter((entry) => entry.pid !== process.pid);
  const self = list.find((entry) => entry.pid === process.pid) ?? {};
  return [...rest, { title: '', ...self, pid: process.pid, name: 'Harmony', self: true }]
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** "/Applications/Some App.app/Contents/MacOS/x" -> "Some App", else null. */
function appBundleName(command) {
  const match = /\/([^/]+)\.app\/Contents\/MacOS\//.exec(command);
  return match ? match[1] : null;
}

/** Where people install things, as opposed to where the system keeps its own. */
const USER_APP_ROOTS = ['/Applications/', '/System/Applications/', '/Users/', '/Volumes/', '/opt/'];

/**
 * The applications running on a Mac, one per bundle.
 *
 * macOS has no cheap "who owns a window" either, and the Windows list is a
 * proxy for the same question, so this is too: running .app bundles that were
 * installed by somebody, which is Discord, a browser or a game and not the
 * Dock or the login window. Helper processes live deeper in the bundle
 * (Contents/Frameworks/...) and do not match.
 */
async function macApps() {
  const byName = new Map();
  for (const { pid, command } of await table()) {
    const name = appBundleName(command);
    if (!name || command.includes('/Contents/Frameworks/')) continue;
    if (!USER_APP_ROOTS.some((root) => command.startsWith(root))) continue;
    if (!byName.has(name) || pid < byName.get(name).pid) {
      byName.set(name, { pid, name, title: path.dirname(path.dirname(path.dirname(command))) });
    }
  }
  return [...byName.values()];
}

module.exports = { parsePs, descendants, tree, table, withSelf, appBundleName, macApps };
