// A call that goes on while another server is open.
//
// Pedro joins the voice channel of server A, then opens server B. The call must
// not break: Ana, still on A, goes on hearing and seeing him; the call bar says
// where the call is; its controls reach A (mute shows in A's roster); clicking it
// comes back to A with the call's panel; and leaving from the bar ends it.
//
// Server A has a real MediaMTX; server B a stub (nothing is published there).
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/server-rail-voice.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverEntry = resolve(repoRoot, 'server', 'src', 'index.js');
const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN ?? join(homedir(), 'mediamtx', 'mediamtx');

const PORT_A = 18170;
const PORT_B = 18171;
const MTX_API = 9898;
const MTX_WEBRTC = 8790;
const MTX_ICE = 8090;
const FAKE_MTX_B = 20050;
const DEBUG_PEDRO = 9430;
const DEBUG_ANA = 9431;
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;

const { check, summary } = reporter();
const procs = [];
const closers = [];
process.on('exit', () => {
  procs.forEach((p) => { try { p.kill('SIGKILL'); } catch { /* gone */ } });
  closers.forEach((c) => { try { c(); } catch { /* gone */ } });
});
process.on('SIGINT', () => process.exit(130));

if (!existsSync(MEDIAMTX_BIN)) {
  console.log(`skipped: no MediaMTX at ${MEDIAMTX_BIN} (set MEDIAMTX_BIN)`);
  process.exit(0);
}

async function startMediaMtx() {
  const dir = mkdtempSync(join(tmpdir(), 'harmony-rv-mtx-'));
  const config = join(dir, 'mediamtx.yml');
  copyFileSync(join(repoRoot, 'server', 'mediamtx.yml'), config);
  const p = spawn(MEDIAMTX_BIN, [config], {
    env: {
      ...process.env,
      MTX_AUTHHTTPADDRESS: `${BASE_A}/mediamtx/auth`,
      MTX_WEBRTCADDRESS: `:${MTX_WEBRTC}`,
      MTX_APIADDRESS: `127.0.0.1:${MTX_API}`,
      MTX_WEBRTCLOCALUDPADDRESS: `:${MTX_ICE}`,
      MTX_WEBRTCLOCALTCPADDRESS: `:${MTX_ICE}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(p);
  let log = '';
  p.stdout.on('data', (b) => (log += b.toString()));
  p.stderr.on('data', (b) => (log += b.toString()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (new RegExp(`\\[WebRTC\\].*:${MTX_WEBRTC}`).test(log)) return;
    await sleep(200);
  }
  throw new Error('MediaMTX did not start');
}

function startServer(port, env) {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        HARMONY_PORT: String(port),
        HARMONY_HOST: '127.0.0.1',
        HARMONY_DATA_DIR: mkdtempSync(join(tmpdir(), 'harmony-rv-')),
        HARMONY_POLL_INTERVAL_MS: '400',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(p);
    const timer = setTimeout(() => fail(new Error(`server on ${port} did not start`)), 15_000);
    let log = '';
    let ownerKey = null;
    p.stdout.on('data', (b) => {
      log += b.toString();
      const match = /^\s*│\s+([A-Za-z0-9_-]{20,})\s+│$/m.exec(log);
      if (match) ownerKey = match[1];
      if (log.includes('control server on')) { clearTimeout(timer); done(() => ownerKey); }
    });
    p.stderr.on('data', (b) => (log += b.toString()));
  });
}

const api = async (base, path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function signIn(page, base, nickname) {
  await page.evaluate(`${setInput('server-url', base)} return true;`);
  await sleep(1500);
  await page.evaluate(`${setInput('username', nickname)} ${setInput('account-password', 'hunter22')}
    document.getElementById('continue').click(); return true;`);
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: `${nickname} signing in to ${base}` });
  await sleep(800);
}

const FAKE_DEVICES = ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

/** Who is in the voice room, as server A says. */
const roster = async (token) => {
  const { body } = await api(BASE_A, '/api/channels', { token });
  const room = body.channels.find((c) => c.kind === 'voice');
  return body.rosters?.[room.id] ?? [];
};

const bar = (page) => page.evaluate(`
  const b = document.getElementById('call-bar');
  return { hidden: b.hidden, text: document.getElementById('call-bar-return').textContent, state: b.dataset.state };`);

async function run() {
  console.log('Starting MediaMTX, two servers and two clients…\n');
  await startMediaMtx();
  const ownerKeyA = await startServer(PORT_A, {
    HARMONY_MEDIAMTX_API: `http://127.0.0.1:${MTX_API}`,
    HARMONY_SIGNALING_URL: `http://127.0.0.1:${MTX_WEBRTC}`,
  });
  const fake = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
  });
  closers.push(() => fake.close());
  await new Promise((done) => fake.listen(FAKE_MTX_B, '127.0.0.1', done));
  const ownerKeyB = await startServer(PORT_B, {
    HARMONY_MEDIAMTX_API: `http://127.0.0.1:${FAKE_MTX_B}`,
    HARMONY_SIGNALING_URL: 'http://127.0.0.1:8889',
  });

  const tokenPedroA = (await api(BASE_A, '/api/accounts/register', { method: 'POST', body: { nickname: 'pedro', password: 'hunter22', ownerKey: ownerKeyA() } })).body.token;
  await api(BASE_B, '/api/accounts/register', { method: 'POST', body: { nickname: 'pedro', password: 'hunter22', ownerKey: ownerKeyB() } });
  const tokenAna = (await api(BASE_A, '/api/accounts/register', { method: 'POST', body: { nickname: 'ana', password: 'hunter22' } })).body.token;
  void tokenPedroA;

  // Ana: on A, in the voice channel, and she stays there.
  const ana = launchApp({ port: DEBUG_ANA, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-rv-ana-')), extraArgs: FAKE_DEVICES });
  procs.push(ana);
  const anaPage = await attach(await findPage(DEBUG_ANA));
  await sleep(1500);
  await signIn(anaPage, BASE_A, 'ana');
  await anaPage.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')]
    .find((li) => li.querySelector('.channel-name')?.textContent === 'voice').click(); return true;`);
  await waitFor(anaPage, "!document.getElementById('voice-active').hidden", { label: 'Ana in the room', timeoutMs: 40_000 });

  // Pedro: on A, in the voice channel...
  const pedroApp = launchApp({ port: DEBUG_PEDRO, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-rv-pedro-')), extraArgs: FAKE_DEVICES });
  procs.push(pedroApp);
  const page = await attach(await findPage(DEBUG_PEDRO));
  await sleep(1500);
  await signIn(page, BASE_A, 'pedro');
  await page.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')]
    .find((li) => li.querySelector('.channel-name')?.textContent === 'voice').click(); return true;`);
  await waitFor(page, "!document.getElementById('voice-active').hidden && document.querySelectorAll('#voice-roster li').length >= 2", { label: 'Pedro in the room', timeoutMs: 40_000 });
  check('with the call on server A, there is no call bar', (await bar(page)).hidden === true);

  // ...then opens server B.
  await page.evaluate("document.querySelector('#server-rail .rail-add').click(); return true;");
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-connect'", { label: 'the connect screen' });
  check('opening the form for another server does not end the call', (await roster(tokenAna)).length === 2, JSON.stringify((await roster(tokenAna)).map((m) => m.nickname)));
  check('and the call bar says where it is', (await bar(page)).hidden === false && (await bar(page)).text.includes('voice'), JSON.stringify(await bar(page)));
  await signIn(page, BASE_B, 'pedro');

  check('with server B open, the call bar is there', (await bar(page)).hidden === false, JSON.stringify(await bar(page)));
  check('and says the call is connected', (await bar(page)).state === 'connected', JSON.stringify(await bar(page)));
  check('the voice panel of A is not drawn over B', await page.evaluate("return document.getElementById('voice-active').hidden"));
  check('Ana still has Pedro in the room', (await roster(tokenAna)).some((m) => m.nickname === 'pedro'), JSON.stringify((await roster(tokenAna)).map((m) => m.nickname)));
  check('A\'s bubble on the rail shows the call', await page.evaluate(`return document.querySelector('#server-rail .rail-item[data-server*="${PORT_A}"]').hasAttribute('data-in-call')`));

  // The bar's controls reach A.
  await page.evaluate("document.getElementById('call-bar-mute').click(); return true;");
  await waitFor(page, "document.getElementById('call-bar-mute').hasAttribute('data-on')", { label: 'the mute button lit' });
  let muted = false;
  for (let i = 0; i < 40 && !muted; i += 1) {
    muted = (await roster(tokenAna)).find((m) => m.nickname === 'pedro')?.muted === true;
    if (!muted) await sleep(150);
  }
  check('muting from the bar mutes him on server A', muted);
  await page.evaluate("document.getElementById('call-bar-mute').click(); return true;");
  await sleep(600);

  // And back.
  await page.evaluate("document.getElementById('call-bar-return').click(); return true;");
  await waitFor(page, "!document.getElementById('voice-active').hidden && document.querySelectorAll('#voice-roster li').length >= 2",
    { label: 'back on server A with the call', timeoutMs: 30_000 });
  check('clicking the bar comes back to A with the call\'s panel', true);
  check('the call bar is put away there', (await bar(page)).hidden === true);
  check('and the call never dropped', (await roster(tokenAna)).some((m) => m.nickname === 'pedro'));

  // Leaving from the bar ends it.
  await page.evaluate("document.querySelector('#server-rail .rail-item[data-server*=\"" + PORT_B + "\"]').click(); return true;");
  await waitFor(page, "!document.getElementById('call-bar').hidden", { label: 'the bar on server B again', timeoutMs: 30_000 });
  await page.evaluate("document.getElementById('call-bar-leave').click(); return true;");
  await waitFor(page, "document.getElementById('call-bar').hidden", { label: 'the bar going away' });
  let gone = false;
  for (let i = 0; i < 40 && !gone; i += 1) {
    gone = !(await roster(tokenAna)).some((m) => m.nickname === 'pedro');
    if (!gone) await sleep(150);
  }
  check('leaving from the bar takes him out of the room on A', gone);
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = summary();
    setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 300);
  });
