// A server's name and picture, changed by its owner: the sidebar, the rail and the picture editor.
//
// What each check is here for:
//   - the settings and the server dialogs scroll, and their Done button is on the screen. Their pages sat
//     in a flex column that could not shrink, so on a phone the pages were taller than the dialog, the
//     dialog clipped them and nothing past the first screen could be reached;
//   - a swipe that closes a drawer finishes when it starts on a person or a channel. Closing the member
//     drawer rebuilt its rows under the finger, the touch went to a row that was no longer in the page,
//     and the drawer was left stuck part way;
//   - the call controls take a row of the dock, not a fifth of the screen.
//
//   node client/test/mobile-layout.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18172;
const FAKE_MTX_PORT = 20072;
const DEBUG_PORT = 9472;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-sinfo-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-sinfo-profile-'));
const { check, summary } = reporter();
const procs = [];
let fakeMtx = null;
let serverLog = '';
let ownerKey = null;

process.on('exit', () => {
  for (const p of procs) { try { p.kill(); } catch { /* gone */ } }
  try { fakeMtx?.close(); } catch { /* closed */ }
});

function startFakeMediaMtx() {
  return new Promise((done) => {
    fakeMtx = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
    });
    fakeMtx.listen(FAKE_MTX_PORT, '127.0.0.1', done);
  });
}

function startHarmonyServer() {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        HARMONY_PORT: String(HARMONY_PORT),
        HARMONY_HOST: '127.0.0.1',
        HARMONY_DATA_DIR: dataDir,
        HARMONY_MEDIAMTX_API: `http://127.0.0.1:${FAKE_MTX_PORT}`,
        HARMONY_SIGNALING_URL: 'http://127.0.0.1:8889',
        HARMONY_POLL_INTERVAL_MS: '500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(p);
    const timer = setTimeout(() => fail(new Error('server did not start')), 15_000);
    p.stdout.on('data', (b) => {
      serverLog += b.toString();
      const match = /^\s*│\s+([A-Za-z0-9_-]{20,})\s+│$/m.exec(serverLog);
      if (match) ownerKey = match[1];
      if (serverLog.includes('control server on')) { clearTimeout(timer); done(p); }
    });
    p.stderr.on('data', (b) => (serverLog += b.toString()));
  });
}

const setInput = (id, value) =>
  `{ const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)}; `
  + 'i.dispatchEvent(new Event(\'input\', {bubbles:true})); i.dispatchEvent(new Event(\'change\', {bubbles:true})); }';

async function run() {
  await startFakeMediaMtx();
  await startHarmonyServer();
  const app = launchApp({ port: DEBUG_PORT, userDataDir });
  procs.push(app);
  const cdp = await attach(await findPage(DEBUG_PORT));
  await sleep(1200);

  await cdp.evaluate(`${setInput('server-url', BASE)} return true;`);
  await sleep(1500);
  for (const [id, value] of [['username', 'Pedro Lucas'], ['account-password', 'hunter22'],
    ['account-confirm', 'hunter22'], ['owner-key', ownerKey]]) {
    await cdp.evaluate(`${setInput(id, value)} return true;`);
  }
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'");


  // A picture: a 600 x 400 PNG with a red stripe, made in the page.
  const picture = (color) => `(async () => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 400; const g = c.getContext('2d');
    g.fillStyle = ${JSON.stringify(color)}; g.fillRect(0, 0, 600, 400); g.fillStyle = '#fff'; g.fillRect(250, 0, 100, 400);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return new File([blob], 'logo.png', { type: 'image/png' }); })()`;
  // The picker is an input that is never in the page: it is answered from here.
  await cdp.evaluate(`
    window.__file = await ${picture('#c0392b')};
    const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== 'file') return click.call(this);
      const dt = new DataTransfer(); dt.items.add(window.__file);
      Object.defineProperty(this, 'files', { value: dt.files });
      this.dispatchEvent(new Event('change'));
    };
    return true;`);

  const look = () => cdp.evaluate(`
    const rail = document.querySelector('#server-rail .rail-item[data-server]');
    return {
      sidebarName: document.getElementById('server-name').textContent,
      sidebarLogo: document.querySelector('#server-icon img')?.src ?? null,
      railLogo: rail?.querySelector('.server-badge img')?.src ?? null,
      railName: rail?.getAttribute('aria-label') ?? rail?.title ?? rail?.textContent ?? null,
      railInitial: rail?.querySelector('.server-badge span')?.textContent ?? null,
    };`);
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => console.log('  [exception]', (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300)));

  await cdp.evaluate("document.getElementById('server-settings').click(); return true;");
  await sleep(600);
  await cdp.evaluate(`${setInput('server-name-input', 'Renamed Place')} return true;`);

  // --- the picture goes through the editor, as a profile picture does -----------------------------------------------------------
  await cdp.evaluate("document.getElementById('server-logo-pick').click(); return true;");
  await waitFor(cdp, "document.querySelector('dialog.image-editor[open]')", { label: 'the picture editor', timeoutMs: 15_000 });
  const editor = await cdp.evaluate(`
    const d = document.querySelector('dialog.image-editor[open]');
    const mask = d.querySelector('.ie-mask').getBoundingClientRect();
    return {
      title: d.querySelector('h3').textContent, shape: d.querySelector('.ie-mask').dataset.shape,
      square: Math.abs(mask.width - mask.height) < 1.5, zoom: Boolean(d.querySelector('.ie-zoom')), turn: Boolean(d.querySelector('.ie-rotate')),
      quarter: d.querySelectorAll('.ie-tool').length,
    };`);
  check('picking a picture opens the same editor as a profile picture: zoom, turn, quarter turns', editor.zoom && editor.turn && editor.quarter >= 2, JSON.stringify(editor));
  check('with a square to crop to, named for the server', editor.shape === 'rect' && editor.square && /server/i.test(editor.title), JSON.stringify(editor));
  // zoom in a little, so that the crop is not just the whole picture
  await cdp.evaluate("const z = document.querySelector('dialog.image-editor[open] .ie-zoom'); z.value = 30; z.dispatchEvent(new Event('input', { bubbles: true })); return true;");
  await cdp.evaluate("document.querySelector('dialog.image-editor[open] .ie-save').click(); return true;");
  await waitFor(cdp, "!document.querySelector('dialog.image-editor[open]') && document.querySelector('#server-logo-preview img')", { label: 'the picture staged', timeoutMs: 15_000 });
  const staged = await cdp.evaluate(`
    const img = document.querySelector('#server-logo-preview img');
    await img.decode();
    return { w: img.naturalWidth, h: img.naturalHeight, png: img.src.startsWith('data:image/png') };`);
  check('what is kept is a 256 px square PNG', staged.w === 256 && staged.h === 256 && staged.png, JSON.stringify(staged));
  check('the server dialog is still there under the editor', await cdp.evaluate("return document.getElementById('server-dialog').open"), '');

  // --- the storage box ---------------------------------------------------------------------------------------------------------------------
  const storage = await cdp.evaluate("const i = document.getElementById('server-storage'); return { value: i.value, valid: i.validity.valid }");
  check('the space for files, as the server reports it, is accepted by the box', storage.valid, JSON.stringify(storage));
  await cdp.evaluate(`${setInput('server-storage', '0.01')} document.getElementById('server-form').requestSubmit(); return true;`);
  await sleep(600);
  const refused = await cdp.evaluate("const e = document.getElementById('server-error'); return { open: document.getElementById('server-dialog').open, shown: !e.hidden, text: e.textContent }");
  check('a value it will not take is said on the dialog, not silently ignored', refused.open && refused.shown && refused.text.length > 5, JSON.stringify(refused));
  // No Save: the box is let go of, and it is sent. The dialog stays, saying so.
  await cdp.evaluate(`${setInput('server-storage', '3')} return true;`);
  await waitFor(cdp, "document.getElementById('server-status').dataset.state === 'saved' && !document.getElementById('server-status').hidden", { label: 'the page saying it is saved', timeoutMs: 15_000 });
  check('and a whole number of GB saves by itself, with the error gone and the dialog still open', await cdp.evaluate("return document.getElementById('server-error').hidden && document.getElementById('server-dialog').open"), '');
  check('there is no Save button on the page', await cdp.evaluate("return !document.getElementById('server-save')"), '');

  // --- everything follows at once, with no switching away ----------------------------------------------------------------
  await waitFor(cdp, "document.querySelector('#server-icon img')", { label: 'the logo beside the name', timeoutMs: 15_000 });
  await waitFor(cdp, "document.querySelector('#server-rail .rail-item[data-server] .server-badge img')", { label: 'the logo on the rail', timeoutMs: 15_000 });
  const seen = await look();
  check('the name beside the logo changed', seen.sidebarName === 'Renamed Place', JSON.stringify(seen));
  check('and the rail names the server by it', seen.railName === 'Renamed Place', JSON.stringify(seen));
  check('the logo is on the sidebar and on the rail', Boolean(seen.sidebarLogo) && Boolean(seen.railLogo) && seen.railInitial === null, JSON.stringify(seen));
  check('and is the same picture in both', seen.sidebarLogo === seen.railLogo, JSON.stringify(seen));

  // --- taking it away, the same ------------------------------------------------------------------------------------------------------------
  await cdp.evaluate("document.getElementById('server-settings').click(); return true;");
  await sleep(500);
  await cdp.evaluate("document.getElementById('server-logo-remove').click(); return true;");
  await waitFor(cdp, "!document.querySelector('#server-icon img') && !document.querySelector('#server-rail .rail-item[data-server] .server-badge img')", { label: 'the logo going from both', timeoutMs: 15_000 });
  check('removing it takes it from the sidebar and the rail at once', true, JSON.stringify(await look()));
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  const failed = summary();
  setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
});
