// The channels view, driven through the real client.
//
// Everything else that covers this layer talks to the server directly or
// imports a module in isolation. That is how 2.0.0 shipped a complete,
// well-tested accounts API that was `undefined` at runtime, and then shipped
// routes with no control in front of them at all: a passing test proved the
// server could do it, never that anybody could ask.
//
// So this clicks. It launches the packaged renderer against a real control
// server, signs in, and uses the sidebar, the chat pane, the avatar button
// and the admin controls the way a person would.
//
// MediaMTX is stubbed -- nothing here publishes or subscribes, and a stub
// keeps the run to a few seconds. The media path has its own suites
// (e2e.mjs, channel-video.mjs).
//
//   node client/test/channels-ui.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverEntry = resolve(repoRoot, 'server', 'src', 'index.js');

const HARMONY_PORT = 18130;
const FAKE_MTX_PORT = 20010;
const DEBUG_PORT = 9411;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-ui-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-ui-profile-'));
const { check, summary } = reporter();
const procs = [];
let fakeMtx = null;
let serverLog = '';
let ownerKey = null;
let cdp = null;

function cleanup() {
  for (const p of procs) {
    try { p.kill(); } catch { /* already gone */ }
  }
  try { fakeMtx?.close(); } catch { /* already closed */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

// ---------------------------------------------------------------------------

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
      if (serverLog.includes('control server on')) {
        clearTimeout(timer);
        done(p);
      }
    });
    p.stderr.on('data', (b) => (serverLog += b.toString()));
  });
}

/** The visible names in the sidebar, in the order they are drawn. */
const CHANNEL_NAMES =
  "return [...document.querySelectorAll('#channel-items li.channel-row')]"
  + ".map((li) => li.querySelector('.channel-name')?.textContent);";

/**
 * Drag one channel onto another, or onto a group heading.
 *
 * Synthetic DragEvents rather than a real pointer drag: the handlers key
 * off a module-level `dragging` set in dragstart, so nothing here depends
 * on the OS drag loop. A DataTransfer is still constructed because
 * dragstart writes to it.
 */
const dragChannel = (cdp, name, onto) => cdp.evaluate(`
  const rows = [...document.querySelectorAll('#channel-items li.channel-row')];
  const from = rows.find((li) => li.querySelector('.channel-name').textContent === ${JSON.stringify(name)});
  const target = ${JSON.stringify(onto.group ?? null)}
    ? [...document.querySelectorAll('#channel-items li.channel-group')]
      .find((li) => li.querySelector('.group-name').textContent === ${JSON.stringify(onto.group ?? '')})
    : rows.find((li) => li.querySelector('.channel-name').textContent === ${JSON.stringify(onto.before ?? '')});
  if (!from || !target) return { ok: false, from: Boolean(from), target: Boolean(target) };

  // Where over the target: a heading takes a channel on its lower half as
  // "into the group", and on its upper half as "above it".
  const box = target.getBoundingClientRect();
  const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height * 0.8 };
  const dt = new DataTransfer();
  from.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
  target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, ...at }));
  target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, ...at }));
  from.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
  return { ok: true };
`);

/** Type into an input and fire the events the app listens for. */
const setInput = (id, value) =>
  `const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)}; `
  + `i.dispatchEvent(new Event('input', {bubbles:true})); `
  + `i.dispatchEvent(new Event('change', {bubbles:true}));`;

/**
 * Fill in the app's own dialog and press its button.
 *
 * NOTHING IS STUBBED, and that is the point. This test used to replace
 * window.prompt before clicking, which meant it proved the code worked
 * against a browser that has prompt() -- and Electron does not. Every
 * feature behind a prompt (naming a channel, naming a clip, entering a
 * channel password) was unreachable in the shipped app and the suite was
 * perfectly green. Replacing a platform function in a test is how that
 * happens.
 *
 * `param {Record<string, string>} values keyed by field name
 */
const answerDialog = (cdp, values = {}) => cdp.evaluate(`
  const dialog = document.getElementById('ask');
  if (!dialog.open) return { ok: false, reason: 'no dialog is open' };
  const wanted = ${JSON.stringify(values)};
  for (const [name, value] of Object.entries(wanted)) {
    const input = dialog.querySelector(` + "`[name=\"${name}\"]`" + `);
    if (!input) return { ok: false, reason: 'no field called ' + name };
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  document.getElementById('ask-ok').click();
  return { ok: true };
`);

/** Wait for the dialog to be showing. */
const dialogOpen = (cdp) => waitFor(
  cdp,
  "document.getElementById('ask').open === true",
  { label: 'the dialog opening' },
);

// ---------------------------------------------------------------------------

async function run() {
  console.log('Starting the control server and the client…\n');
  await startFakeMediaMtx();
  await startHarmonyServer();

  const app = launchApp({ port: DEBUG_PORT, userDataDir });
  procs.push(app);
  cdp = await attach(await findPage(DEBUG_PORT));
  await sleep(1200);

  // --- registering as the owner, from the connect screen ----------------
  await cdp.evaluate(`${setInput('server-url', BASE)} return true;`);
  await sleep(1500);

  // No toggle: a server with accounts but nobody registered opens in REGISTER
  // mode already, and clicking the toggle would switch it to sign-in and fail
  // with "wrong nickname or password" -- which is what it did the first time.
  const opening = await cdp.evaluate(`
    return {
      button: document.getElementById('continue').textContent,
      ownerField: !document.getElementById('owner-key-field').hidden,
    };
  `);
  check(
    'a server with no accounts opens straight into "create account"',
    opening.button === 'Create account' && opening.ownerField === true,
    `${opening.button}, owner key ${opening.ownerField ? 'shown' : 'hidden'}`,
  );

  await cdp.evaluate(`${setInput('username', 'Pedro Lucas')} return true;`);
  await cdp.evaluate(`${setInput('account-password', 'hunter22')} return true;`);
  await cdp.evaluate(`${setInput('account-confirm', 'hunter22')} return true;`);
  await cdp.evaluate(`${setInput('owner-key', ownerKey)} return true;`);
  await cdp.evaluate("document.getElementById('continue').click(); return true;");

  const inChannels = await waitFor(
    cdp,
    "document.querySelector('.view[data-active]')?.id === 'view-channels'",
    { label: 'the channels view' },
  );
  check('registering with the owner key lands in the channels view', inChannels === true);

  const whoami = await cdp.evaluate(`
    return {
      who: document.getElementById('channels-who').textContent,
      role: document.getElementById('channels-role').textContent,
      // A name typed with a capital and a space is stored folded.
      avatar: document.getElementById('channels-avatar').textContent,
      addVisible: !document.getElementById('channel-add').hidden,
    };
  `);
  check(
    'the owner is shown, with the folded nickname and their initials',
    whoami.who === 'pedrolucas' && whoami.role === 'owner' && whoami.avatar === 'PE',
    `${whoami.who} / ${whoami.role} / "${whoami.avatar}"`,
  );
  check('an admin is offered the "+ New" button', whoami.addVisible === true, '');

  // --- the sidebar ------------------------------------------------------
  const sidebar = await cdp.evaluate(`
    const rows = [...document.querySelectorAll('#channel-items li.channel-row')];
    return rows.map((li) => ({
      name: li.querySelector('.channel-name')?.textContent,
      // Nothing admin-shaped in the row itself any more; it is all behind
      // a right-click. A row with buttons in it is the regression.
      buttons: li.querySelectorAll('button').length,
      draggable: li.draggable,
    }));
  `);
  check(
    'the seeded channels are listed',
    sidebar.length === 2 && sidebar[0].name === 'general' && sidebar[1].name === 'voice',
    sidebar.map((r) => r.name).join(', '),
  );
  check(
    'a channel row carries no buttons of its own',
    sidebar.every((r) => r.buttons === 0),
    `${sidebar[0].buttons} buttons in the first row`,
  );

  /*
   * The admin controls, where they live now.
   *
   * A real contextmenu event rather than a click on something: the menu
   * is opened by the browser's own gesture and there is no other way in,
   * so a test that reached the handler any other way would prove nothing
   * about whether anybody can.
   */
  await cdp.evaluate(`
    const row = document.querySelector('#channel-items li.channel-row');
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 60, clientY: 120,
    }));
    return true;
  `);
  await waitFor(cdp, "!document.getElementById('row-menu').hidden", {
    label: 'the channel menu',
  });
  const rowMenu = await cdp.evaluate(`
    return {
      name: document.getElementById('row-menu-name').textContent,
      items: [...document.querySelectorAll('#row-menu-body button')]
        .map((b) => b.textContent),
    };
  `);
  check(
    'right-clicking a channel offers rename and delete, and moving it for those who cannot drag',
    rowMenu.name === '#general'
      && rowMenu.items.includes('Rename or set a password')
      && rowMenu.items.includes('Delete this channel')
      && rowMenu.items.every((i) => ['Move up', 'Move down', 'Rename or set a password', 'Delete this channel'].includes(i)),
    `${rowMenu.name}: ${rowMenu.items.join(', ')}`,
  );
  await cdp.evaluate(`
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    return true;
  `);
  check(
    'an admin can pick a row up',
    sidebar.every((r) => r.draggable === true),
    sidebar.map((r) => r.draggable).join(', '),
  );

  // --- creating a channel -----------------------------------------------
  await cdp.evaluate("document.getElementById('channel-add').click(); return true;");
  await dialogOpen(cdp);

  const dialogShape = await cdp.evaluate(`
    const dialog = document.getElementById('ask');
    return {
      title: document.getElementById('ask-title').textContent,
      fields: [...dialog.querySelectorAll('[name]')].map((i) => i.name),
    };
  `);
  check(
    'asking for a new channel opens the app\u0027s own dialog, not a prompt',
    dialogShape.fields.join(',') === 'name,kind,password',
    `"${dialogShape.title}" with [${dialogShape.fields}]`,
  );

  await answerDialog(cdp, { name: 'Game Night', kind: 'voice', password: '' });
  await waitFor(cdp, "document.querySelectorAll('#channel-items li.channel-row').length === 3", {
    label: 'the new channel',
  });
  const names = await cdp.evaluate(
    CHANNEL_NAMES,
  );
  check(
    'an admin can create a channel, and the name is kept as typed',
    names.length === 3 && names.includes('Game Night'),
    names.join(', '),
  );

  // --- reordering, by dragging ------------------------------------------
  const dragged = await dragChannel(cdp, 'Game Night', { before: 'voice' });
  await sleep(700);
  const reordered = await cdp.evaluate(CHANNEL_NAMES);
  check(
    'dragging a channel onto another drops it above, for everybody',
    dragged.ok === true && reordered[1] === 'Game Night',
    `${JSON.stringify(dragged)} -> ${reordered.join(', ')}`,
  );

  // --- groups -----------------------------------------------------------
  //
  // A group is a heading with a fold, not a container: deleting one leaves
  // its channels where they were. That is the ON DELETE SET NULL in schema
  // v7, and it is the opposite of every other delete in this app, so it is
  // worth pinning.
  await cdp.evaluate("document.getElementById('channel-add').click(); return true;");
  await dialogOpen(cdp);
  await answerDialog(cdp, { name: 'Hangouts', kind: 'group', password: '' });
  await waitFor(
    cdp,
    "document.querySelectorAll('#channel-items li.channel-group').length === 1",
    { label: 'the group appearing' },
  );
  check('an admin can create a group', true, 'Hangouts');

  const intoGroup = await dragChannel(cdp, 'Game Night', { group: 'Hangouts' });
  await sleep(700);
  const placed = await cdp.evaluate(`
    const nodes = [...document.querySelectorAll('#channel-items > li')];
    return nodes.map((li) => (li.classList.contains('channel-group')
      ? 'GROUP:' + li.querySelector('.group-name').textContent
      : (li.querySelector('.channel-name')?.textContent ?? null))).filter(Boolean);
  `);
  check(
    'dragging a channel onto a group heading puts it in the group',
    intoGroup.ok === true
      && placed.indexOf('Game Night') === placed.indexOf('GROUP:Hangouts') + 1,
    placed.join(' | '),
  );

  await cdp.evaluate(`
    document.querySelector('#channel-items li.channel-group').click();
    return true;
  `);
  const collapsed = await cdp.evaluate(CHANNEL_NAMES);
  check(
    'collapsing a group hides what is inside it, and nothing else',
    !collapsed.includes('Game Night') && collapsed.includes('general'),
    collapsed.join(', '),
  );

  // Deleting the group must NOT delete gamenight with it.
  await cdp.evaluate(`
    document.querySelector('#channel-items li.channel-group').dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 60, clientY: 160,
      }),
    );
    return true;
  `);
  await waitFor(cdp, "!document.getElementById('row-menu').hidden", {
    label: 'the group menu',
  });
  await cdp.evaluate(`
    const items = [...document.querySelectorAll('#row-menu-body button')];
    items[items.length - 1].click();
    return true;
  `);
  await dialogOpen(cdp);
  await answerDialog(cdp);
  await sleep(700);
  const survived = await cdp.evaluate(CHANNEL_NAMES);
  check(
    'deleting a group leaves its channels behind',
    survived.includes('Game Night')
      && (await cdp.evaluate(
        "return document.querySelectorAll('#channel-items li.channel-group').length;",
      )) === 0,
    survived.join(', '),
  );

  // --- a profile picture ------------------------------------------------
  //
  // The file input is driven directly rather than through the OS dialog:
  // everything after the picker -- the canvas downscale, the upload, the
  // route and the repaint -- is what was missing and what is being tested.
  const avatar = await cdp.evaluate(`
    const canvas = document.createElement('canvas');
    canvas.width = 600; canvas.height = 400;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#c0ffee'; ctx.fillRect(0, 0, 600, 400);
    ctx.fillStyle = '#300'; ctx.fillRect(100, 80, 300, 200);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const file = new File([blob], 'me.png', { type: 'image/png' });

    const input = document.getElementById('avatar-file');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Wait for the round trip: upload, then the avatar route, then repaint.
    for (let i = 0; i < 60; i += 1) {
      const img = document.querySelector('#channels-avatar img');
      if (img) {
        await img.decode().catch(() => {});
        return {
          src: img.src,
          w: img.naturalWidth,
          h: img.naturalHeight,
          error: document.getElementById('channels-error').textContent,
        };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { src: null, error: document.getElementById('channels-error').textContent };
  `);
  check(
    'picking a picture uploads it and the bar repaints with it',
    typeof avatar.src === 'string' && avatar.src.startsWith('harmony://app/media/'),
    avatar.src ?? `no image; error: "${avatar.error}"`,
  );
  check(
    'it was downscaled to a 256px square before upload, and decodes from the cache',
    avatar.w === 256 && avatar.h === 256,
    `${avatar.w}x${avatar.h}`,
  );

  // --- the chat pane ----------------------------------------------------
  await cdp.evaluate(`
    const rows = [...document.querySelectorAll('#channel-items li.channel-row')];
    rows.find((li) => li.textContent.includes('general')).click();
    return true;
  `);
  await waitFor(cdp, "!document.getElementById('chat-active').hidden", { label: 'the chat pane' });

  await cdp.evaluate(`${setInput('chat-input', 'hello from the ui test')} return true;`);
  await cdp.evaluate("document.getElementById('chat-form').requestSubmit(); return true;");
  await waitFor(cdp, "document.querySelectorAll('#chat-log .chat-msg').length > 0", {
    label: 'the message appearing',
  });

  const row = await cdp.evaluate(`
    const msg = document.querySelector('#chat-log .chat-msg');
    const img = msg.querySelector('.who .avatar img');
    if (img) await img.decode().catch(() => {});
    return {
      text: msg.querySelector('.text').textContent,
      who: msg.querySelector('.who').textContent,
      hasAvatar: Boolean(img),
      avatarDecoded: img ? img.naturalWidth : 0,
      buttons: [...msg.querySelectorAll('button')].map((b) => b.textContent),
    };
  `);
  check(
    'a posted message comes back over the socket and renders',
    row.text === 'hello from the ui test' && row.who === 'pedrolucas',
    `${row.who}: ${row.text}`,
  );
  check(
    "the author's picture is drawn on the message, from the local cache",
    row.hasAvatar === true && row.avatarDecoded === 256,
    `avatar ${row.avatarDecoded}px`,
  );
  check(
    'a message you can delete offers Pin and Delete',
    row.buttons.includes('Pin') && row.buttons.includes('Delete'),
    row.buttons.join(', '),
  );

  // --- pinning ----------------------------------------------------------
  await cdp.evaluate(`
    const msg = document.querySelector('#chat-log .chat-msg');
    [...msg.querySelectorAll('button')].find((b) => b.textContent === 'Pin').click();
    return true;
  `);
  await sleep(800);
  const pinned = await cdp.evaluate(`
    return {
      stripShown: !document.getElementById('chat-pinned').hidden,
      strip: document.getElementById('chat-pinned').textContent,
      label: [...document.querySelectorAll('#chat-log .chat-msg button')]
        .map((b) => b.textContent).join(','),
    };
  `);
  check(
    'pinning a message puts it in the strip and flips the button',
    pinned.stripShown === true && pinned.label.includes('Unpin'),
    pinned.strip.trim(),
  );

  /*
   * And the strip has to be reachable, not just readable.
   *
   * A pin is pinned because it is worth coming back to, and the strip was
   * a list of text you could read and not reach -- which is the less
   * useful half of a pin. Clicking a line scrolls to the message and
   * flashes it.
   *
   * This channel is short enough that the message is already loaded, so
   * what is checked here is the control and the landing, not the paging
   * back through older pages that a long channel would need.
   */
  const jumped = await cdp.evaluate(`
    const line = document.querySelector('#chat-pinned .pinned-line');
    if (!line) return { clicked: false };
    line.click();
    await new Promise((r) => setTimeout(r, 200));
    const row = document.querySelector('#chat-log .chat-msg[data-jumped]');
    return {
      clicked: true,
      landedOn: row ? row.textContent.slice(0, 40) : null,
    };
  `);
  check(
    'clicking a pinned message jumps to it',
    jumped.clicked === true && jumped.landedOn !== null,
    jumped.clicked ? `landed on "${jumped.landedOn}"` : 'the strip has no clickable line',
  );

  // --- searching --------------------------------------------------------
  await cdp.evaluate(`${setInput('chat-search', 'hello')} return true;`);
  await sleep(900);
  const searched = await cdp.evaluate(`
    return {
      note: document.getElementById('chat-note').textContent,
      hits: document.querySelectorAll('#chat-log .chat-msg').length,
    };
  `);
  check(
    'search finds the message and says which index answered',
    searched.hits === 1 && searched.note.includes('fts'),
    `${searched.hits} hit: "${searched.note}"`,
  );

  await cdp.evaluate("document.getElementById('chat-search-clear').click(); return true;");
  await sleep(700);

  // --- deleting ---------------------------------------------------------
  //
  // The route existed and was tested in 2.0.0. Nothing called it.
  await cdp.evaluate(`
    const msg = document.querySelector('#chat-log .chat-msg');
    [...msg.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click();
    return true;
  `);
  await dialogOpen(cdp);
  await answerDialog(cdp);
  await sleep(900);
  const afterDelete = await cdp.evaluate(`
    return {
      rows: document.querySelectorAll('#chat-log .chat-msg').length,
      strip: document.getElementById('chat-pinned').hidden,
      error: document.getElementById('channels-error').textContent,
    };
  `);
  check(
    'deleting a message removes it, and takes it out of the pinned strip',
    afterDelete.rows === 0 && afterDelete.strip === true,
    `${afterDelete.rows} rows left; error: "${afterDelete.error}"`,
  );

  // --- emoji, shortcodes and reactions -----------------------------------
  //
  // Through the picker, not through the API. The whole point of the picker
  // is that it is reachable, and every part of this feature that can be
  // wrong -- the popover opening, a cell inserting at the caret, a typed
  // :name: becoming a character, a reaction counting -- is on this path.
  await cdp.evaluate("document.getElementById('chat-emoji').click(); return true;");
  await waitFor(cdp, "!document.getElementById('emoji-pop').hidden", {
    label: 'the emoji picker',
  });
  const picker = await cdp.evaluate(`
    return {
      cells: document.querySelectorAll('#emoji-grid .emoji-cell').length,
      sections: document.querySelectorAll('#emoji-grid .emoji-section-head').length,
    };
  `);
  check(
    'the emoji button opens a picker with the whole set in it',
    picker.cells > 1000 && picker.sections >= 6,
    `${picker.cells} emoji in ${picker.sections} sections`,
  );

  await cdp.evaluate(`${setInput('emoji-search', 'pizza')} return true;`);
  await sleep(300);
  const filtered = await cdp.evaluate(`
    const cells = [...document.querySelectorAll('#emoji-grid .emoji-cell')]
      .filter((c) => c.offsetParent !== null);
    return { count: cells.length, first: cells[0]?.dataset.value ?? null };
  `);
  check(
    'searching narrows it to what matches the name',
    filtered.count > 0 && filtered.count < 40,
    `${filtered.count} matching, first ${filtered.first}`,
  );

  await cdp.evaluate(`
    [...document.querySelectorAll('#emoji-grid .emoji-cell')]
      .filter((c) => c.offsetParent !== null)[0].click();
    return true;
  `);
  await sleep(300);
  const inserted = await cdp.evaluate(
    "return document.getElementById('chat-input').value;",
  );
  check(
    'picking one puts it in the box',
    inserted.length > 0,
    JSON.stringify(inserted),
  );

  // A typed shortcode, which is the half of this that has no picker.
  await cdp.evaluate(`${setInput('chat-input', 'nice :grinning_face: one')} return true;`);
  await cdp.evaluate("document.getElementById('chat-form').requestSubmit(); return true;");
  await waitFor(cdp, "document.querySelectorAll('#chat-log .chat-msg').length > 0", {
    label: 'the emoji message',
  });
  const rendered = await cdp.evaluate(`
    const msg = [...document.querySelectorAll('#chat-log .chat-msg')].pop();
    return { text: msg.querySelector('.text').textContent };
  `);
  check(
    'a typed :shortcode: comes out as the emoji, not as the text',
    rendered.text.includes('\u{1F600}') && !rendered.text.includes(':grinning_face:'),
    JSON.stringify(rendered.text),
  );

  // Reacting. The button sits with Pin and Delete rather than on the strip,
  // because the strip only exists once there is something on it.
  await cdp.evaluate(`
    const msg = [...document.querySelectorAll('#chat-log .chat-msg')].pop();
    msg.querySelector('.react-btn').click();
    return true;
  `);
  await waitFor(cdp, "!document.getElementById('emoji-pop').hidden", {
    label: 'the picker, opened from a message',
  });
  await cdp.evaluate(`
    [...document.querySelectorAll('#emoji-grid .emoji-cell')]
      .filter((c) => c.offsetParent !== null)[0].click();
    return true;
  `);
  await waitFor(cdp, "document.querySelectorAll('#chat-log .reaction').length > 0", {
    label: 'the reaction appearing',
  });
  const reacted = await cdp.evaluate(`
    const msg = [...document.querySelectorAll('#chat-log .chat-msg')].pop();
    const chips = [...msg.querySelectorAll('.reaction')];
    return {
      chips: chips.length,
      count: chips[0]?.querySelector('.count')?.textContent,
      mine: chips[0]?.hasAttribute('data-mine') ?? false,
    };
  `);
  check(
    'reacting adds one chip, counted, and marked as yours',
    reacted.chips === 1 && reacted.count === '1' && reacted.mine === true,
    `${reacted.chips} chips, count ${reacted.count}, mine ${reacted.mine}`,
  );

  // Clicking the same one again is the way back, and it has to leave
  // nothing behind -- a chip reading 0 is the classic version of this bug.
  await cdp.evaluate(`
    [...document.querySelectorAll('#chat-log .chat-msg')].pop()
      .querySelector('.reaction').click();
    return true;
  `);
  await sleep(900);
  const unreacted = await cdp.evaluate(
    "return document.querySelectorAll('#chat-log .reaction').length;",
  );
  check(
    'clicking your own reaction takes it back, chip and all',
    unreacted === 0,
    `${unreacted} chips left`,
  );

  // --- mentions ----------------------------------------------------------
  //
  // The suggestion list is the half that can only be tested by typing: it
  // keys off where the caret is, not off the value, so setting the box and
  // firing 'input' is exactly the path a person takes.
  await cdp.evaluate(`
    const input = document.getElementById('chat-input');
    input.focus();
    input.value = 'hey @pedro';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await waitFor(cdp, "!document.getElementById('mention-pop').hidden", {
    label: 'the mention suggestions',
  });
  const suggestions = await cdp.evaluate(`
    const rows = [...document.querySelectorAll('#mention-items li')];
    return {
      count: rows.length,
      nicknames: rows.map((li) => li.dataset.nickname),
      active: rows.findIndex((li) => li.hasAttribute('data-active')),
    };
  `);
  check(
    'typing an @ suggests who you might mean, with one already highlighted',
    suggestions.count > 0 && suggestions.nicknames.includes('pedrolucas')
      && suggestions.active === 0,
    `${suggestions.count}: ${suggestions.nicknames.join(', ')}`,
  );

  // @everyone is offered, and offered LAST -- it is the loudest thing on
  // the list and should not be what a blind Enter picks.
  await cdp.evaluate(`
    const input = document.getElementById('chat-input');
    input.value = '@e';
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await sleep(300);
  const withEveryone = await cdp.evaluate(
    "return [...document.querySelectorAll('#mention-items li')]"
    + ".map((li) => li.dataset.nickname);",
  );
  check(
    '@everyone is on the list, and never first',
    withEveryone.includes('everyone') && withEveryone[0] !== 'everyone',
    withEveryone.join(', '),
  );

  // Enter takes the highlighted name and must NOT also send the message.
  await cdp.evaluate(`
    const input = document.getElementById('chat-input');
    input.value = 'hello @pedro';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await sleep(300);
  // Counted before, not assumed to be zero: earlier blocks left messages in
  // the log, and "nothing was sent" means nothing NEW.
  const sentBefore = await cdp.evaluate(
    "return document.querySelectorAll('#chat-log .chat-msg').length;",
  );
  await cdp.evaluate(`
    document.getElementById('chat-input').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    return true;
  `);
  await sleep(300);
  const accepted = await cdp.evaluate(`
    return {
      value: document.getElementById('chat-input').value,
      listOpen: !document.getElementById('mention-pop').hidden,
      sent: document.querySelectorAll('#chat-log .chat-msg').length,
    };
  `);
  check(
    'Enter completes the name instead of sending the message',
    accepted.value === 'hello @pedrolucas ' && accepted.listOpen === false
      && accepted.sent === sentBefore,
    `"${accepted.value}", list open ${accepted.listOpen}, ${accepted.sent} sent`,
  );

  await cdp.evaluate("document.getElementById('chat-form').requestSubmit(); return true;");
  await waitFor(cdp, "document.querySelectorAll('#chat-log .chat-msg').length > 0", {
    label: 'the mention message',
  });
  const drawn = await cdp.evaluate(`
    const msg = [...document.querySelectorAll('#chat-log .chat-msg')].pop();
    const chip = msg.querySelector('.mention');
    return {
      chip: chip?.textContent ?? null,
      mine: chip?.hasAttribute('data-me') ?? false,
      // Your OWN message never marks the row, however many times it says
      // your name: writing it is not news.
      rowMarked: msg.hasAttribute('data-mentions-me'),
    };
  `);
  check(
    'a mention is drawn as a chip, and your own message does not flag itself',
    drawn.chip !== null && drawn.mine === true && drawn.rowMarked === false,
    `chip ${JSON.stringify(drawn.chip)}, row marked ${drawn.rowMarked}`,
  );

  // An @ that matches nobody stays plain text, and so does an email
  // address -- nothing to notify, so nothing to highlight.
  await cdp.evaluate(
    `${setInput('chat-input', 'write to me@example.test and @nobodyatall')} return true;`,
  );
  await cdp.evaluate("document.getElementById('chat-form').requestSubmit(); return true;");
  await sleep(900);
  const plain = await cdp.evaluate(`
    const msg = [...document.querySelectorAll('#chat-log .chat-msg')].pop();
    return {
      chips: msg.querySelectorAll('.mention').length,
      text: msg.querySelector('.text').textContent,
    };
  `);
  check(
    'an email address and an unknown name are left as text',
    plain.chips === 0,
    `${plain.chips} chips in ${JSON.stringify(plain.text)}`,
  );

  // --- the soundpad -----------------------------------------------------
  /*
   * The first clip goes in THROUGH THE UI -- the file input and the naming
   * dialog -- because that path used window.prompt and therefore threw the
   * instant anybody tried it. Adding clips straight through the API, which
   * is what this test did, exercised everything except the part that was
   * broken.
   */
  await cdp.evaluate(`
    const bytes = new TextEncoder().encode('OggS\u0000\u0002ui clip');
    const file = new File([bytes], 'airhorn.ogg', { type: 'audio/ogg' });
    const input = document.getElementById('soundpad-file');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  await dialogOpen(cdp);
  const clipDialog = await cdp.evaluate(`
    return {
      title: document.getElementById('ask-title').textContent,
      suggested: document.querySelector('#ask-fields [name="name"]')?.value ?? null,
    };
  `);
  check(
    'adding a soundpad clip asks for a name in the dialog, not a prompt',
    clipDialog.suggested === 'airhorn',
    `"${clipDialog.title}" suggesting "${clipDialog.suggested}"`,
  );
  await answerDialog(cdp, { name: 'airhorn' });

  /*
   * Open the pad, because it is a popover now and renderSoundpad does
   * nothing while it is hidden.
   *
   * The button is deliberately disabled outside a call -- a clip plays into
   * a voice channel, and there is no channel to play it into -- and this
   * suite stubs MediaMTX and never joins one. So it is enabled here to
   * reach the panel. That is the one thing in this file that a person could
   * not do, and it is the price of keeping the media path out of a suite
   * that runs in seconds.
   */
  await cdp.evaluate(`
    const button = document.getElementById('voice-soundboard');
    button.disabled = false;
    button.click();
    return true;
  `);
  await waitFor(
    cdp,
    "document.querySelectorAll('#soundpad-grid .clip-cell').length === 1",
    { label: 'the clip appearing' },
  );
  check('the named clip appears on the soundpad', true, 'added through the UI');

  const clips = await cdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    const server = ${JSON.stringify(BASE)};
    // A minimal Ogg: the server checks the declared type and the size, not
    // the bytes, and nothing here plays it.
    const bytes = new TextEncoder().encode('OggS\\u0000\\u0002ui test clip');
    for (const name of ['first', 'second']) {
      const up = await harmony.media.upload(server, bytes, 'audio/ogg');
      await harmony.api.addClip(server, { name, hash: up.hash + '' });
    }
    return true;
  `).catch((e) => ({ error: String(e) }));

  // Both clips share one hash (same bytes), so the second add must still work:
  // content addressing deduplicates the FILE, not the clip.
  await sleep(900);
  const pad = await cdp.evaluate(`
    return {
      shown: !document.getElementById('soundpad').hidden,
      cells: document.querySelectorAll('#soundpad-grid .clip-cell').length,
      names: [...document.querySelectorAll('#soundpad-grid .clip-cell .clip-name')]
        .map((b) => b.textContent),
    };
  `);
  check(
    'soundpad clips appear with their reorder arrows for an admin',
    pad.shown === true && pad.cells === 3,
    `${pad.cells} clips: ${pad.names.join(', ')}${clips?.error ? ` (${clips.error})` : ''}`,
  );

  await cdp.evaluate(`
    const cells = [...document.querySelectorAll('#soundpad-grid .clip-cell')];
    // .clip-tools, not the first button in the cell: the first button IS the
    // clip now, and clicking it tries to play into a channel this suite is
    // not in. The admin controls are layered over the clip rather than
    // beside it, because three buttons beside an 8.5rem cell left about two
    // centimetres for the name.
    cells[1].querySelector('.clip-tools button').click();   // move left
    return true;
  `);
  await sleep(900);
  const padOrder = await cdp.evaluate(
    "return [...document.querySelectorAll('#soundpad-grid .clip-cell .clip-name')]"
    + ".map((b) => b.textContent);",
  );
  check(
    'an admin can reorder the soundpad',
    padOrder[0] === 'first',
    padOrder.join(', '),
  );

  // --- nothing threw along the way --------------------------------------
  const errors = await cdp.evaluate(
    "return document.getElementById('channels-error').textContent;",
  );
  check('the channels view reports no error after all of that', errors === '', `"${errors}"`);

  // --- "stay signed in" ---------------------------------------------------
  //
  // Restart the app against the SAME profile directory and it must come back
  // signed in, with nothing to type.
  //
  // This shipped broken in a way no test could see, because no test had ever
  // restarted the app: the token was saved and restored and handed to every
  // request, but the connect screen gates on `state.auth.user`, which only a
  // fresh sign-in ever set. So a saved session still demanded the password
  // and the setting looked like it simply was not saving.
  cdp.close();
  app.kill();
  await sleep(1500);

  const again = launchApp({ port: DEBUG_PORT + 1, userDataDir });
  procs.push(again);
  const cdp2 = await attach(await findPage(DEBUG_PORT + 1));
  await sleep(2500);

  const restored = await cdp2.evaluate(`
    return {
      view: document.querySelector('.view[data-active]')?.id,
      server: document.getElementById('server-url').value,
      username: document.getElementById('username').value,
      accountFieldsHidden: document.getElementById('account-fields').hidden,
      hint: document.getElementById('username-hint').textContent,
      toggle: document.getElementById('auth-mode-toggle').textContent,
      passwordTyped: document.getElementById('account-password').value,
    };
  `);
  check(
    'a restarted client comes back knowing who it is, with no password to type',
    // The fields stay on screen -- they always do now -- but empty, and the
    // hint says who you already are. An empty box you need not fill in is
    // fine; one that vanishes and reappears is not.
    restored.hint.includes('Signed in as pedrolucas')
      && restored.accountFieldsHidden === false
      && restored.passwordTyped === '',
    `hint="${restored.hint}", fields hidden=${restored.accountFieldsHidden}`,
  );
  check(
    'the server address and nickname come back too',
    restored.server === BASE && restored.username === 'pedrolucas',
    `${restored.server} as ${restored.username}`,
  );
  check(
    'and it offers a way out, since the fields are hidden',
    restored.toggle === 'Sign out',
    `toggle reads "${restored.toggle}"`,
  );

  // Pressing Continue has to get straight in, which is the whole point.
  await cdp2.evaluate("document.getElementById('continue').click(); return true;");
  const backIn = await waitFor(
    cdp2,
    "document.querySelector('.view[data-active]')?.id === 'view-channels'",
    { label: 'getting back in without a password' },
  ).catch(() => false);
  check(
    'Continue goes straight back into the channels, no password asked',
    Boolean(backIn),
    backIn ? 'signed in from the saved session' : 'was asked to log in again',
  );
}

run()
  .catch((err) => check('channels-ui run completed', false, err.message))
  .finally(async () => {
    cdp?.close();
    cleanup();
    await sleep(600);
    for (const dir of [dataDir, userDataDir]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    }
    const failed = summary();
    if (failed) console.error(`\n--- harmony server ---\n${serverLog.slice(-2500)}`);
    process.exit(failed ? 1 : 0);
  });
