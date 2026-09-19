// Just enough Chrome DevTools Protocol to drive a running Electron renderer.
// Node's built-in WebSocket means no dependency for this.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const appDir = resolve(here, '..');
export const electronBin = resolve(
  appDir,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Launch the app with debugging enabled. Returns the child process.
 *
 * Set HARMONY_BIN to a packaged build to run the same tests against it -- worth
 * doing at least once per release, because asar packaging is what breaks native
 * module loading.
 */
export function launchApp({ port, userDataDir, onStderr, extraArgs = [] }) {
  const env = { ...process.env };
  // Some shells export this; it would run Electron as plain Node and the app
  // would never start.
  delete env.ELECTRON_RUN_AS_NODE;

  const packaged = process.env.HARMONY_BIN;
  const bin = packaged || electronBin;
  const args = packaged ? [] : [appDir];
  args.push(`--remote-debugging-port=${port}`);
  if (userDataDir) args.push(`--user-data-dir=${userDataDir}`);
  // Chromium switches a particular test wants, e.g. forcing software encoding
  // so a run can be compared against the hardware one.
  args.push(...extraArgs);

  // HARMONY_MAP_HOST=host:ip pins a hostname to an address for this run. Needed
  // to test a public hostname from inside the server's own LAN when the router
  // does not hairpin. TLS still validates, because SNI and the certificate name
  // are unchanged -- only the address lookup is redirected.
  if (process.env.HARMONY_MAP_HOST) {
    const [host, ip] = process.env.HARMONY_MAP_HOST.split(':');
    args.push(`--host-resolver-rules=MAP ${host} ${ip}`);
  }

  const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (b) => onStderr?.(b.toString()));
  return child;
}

export async function findPage(port, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith('harmony://'));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* not listening yet */
    }
    await sleep(400);
  }
  throw new Error(`no renderer appeared on port ${port}`);
}

/** @returns {{evaluate: (expr: string) => Promise<any>, close: () => void}} */
export async function attach(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
  });

  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP socket failed')), { once: true });
  });

  const send = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  return {
    /**
     * Run an async body in the renderer; `return` its result.
     *
     * `userGesture` marks the call as user-initiated, which some APIs insist on
     * -- requestFullscreen() refuses without it, exactly as it would if nobody
     * had clicked.
     */
    async evaluate(expression, { userGesture = false } = {}) {
      const res = await send('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
        userGesture,
      });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description ?? 'renderer threw');
      }
      return res.result.value;
    },
    /** Raw CDP, for the things Runtime.evaluate cannot reach. */
    send,

    /**
     * Resize the viewport as a user dragging the window would, so CSS media
     * queries and resize handlers both fire. window.resizeTo() cannot do this:
     * a page may only resize a window that script opened.
     */
    async setViewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    },
    async clearViewport() {
      await send('Emulation.clearDeviceMetricsOverride');
    },

    close: () => ws.close(),
  };
}

/** Poll an expression in the renderer until it is truthy. */
export async function waitFor(cdp, expression, { timeoutMs = 30_000, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(`return ${expression};`);
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

/** Wait for a local condition (not in the renderer). */
export async function waitUntil(fn, { timeoutMs = 30_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

export function reporter() {
  const results = [];
  return {
    results,
    check(name, ok, detail = '') {
      results.push({ name, ok });
      console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` -- ${detail}` : ''}`);
      return ok;
    },
    summary() {
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\n${results.length - failed}/${results.length} checks passed`);
      return failed;
    },
  };
}
