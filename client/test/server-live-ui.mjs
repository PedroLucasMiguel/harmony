// The server's settings are live: nothing on any page waits for a Save. Every change is checked where it counts, on the
// server, a moment after it is made -- and the places that must NOT send something yet (a password still being typed,
// half a colour) are checked not to.
//
//   node client/test/server-live-ui.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'src', 'index.js');
const { check, summary } = reporter();
const PORT = 18193, MTX = 20093, DBG = 9484, BASE = `http://127.0.0.1:${PORT}`;
const procs = []; let log = '', ownerKey = null, token = null;
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } }));
http.createServer((_q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{"itemCount":0,"pageCount":0,"items":[]}'); }).listen(MTX, '127.0.0.1');
const server = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, HARMONY_PORT: String(PORT), HARMONY_HOST: '127.0.0.1', HARMONY_DATA_DIR: mkdtempSync(join(tmpdir(), 'sl-')),
    HARMONY_MEDIAMTX_API: `http://127.0.0.1:${MTX}`, HARMONY_SIGNALING_URL: 'http://127.0.0.1:8889', HARMONY_POLL_INTERVAL_MS: '500' }, stdio: ['ignore', 'pipe', 'pipe'] });
procs.push(server);
await new Promise((ok) => server.stdout.on('data', (b) => { log += b; const m = /^\s*│\s+([A-Za-z0-9_-]{20,})\s+│$/m.exec(log); if (m) ownerKey = m[1]; if (log.includes('control server on')) ok(); }));
const api = async (path, body, password) => {
  const r = await fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(password ? { 'X-Harmony-Password': password } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(path + ' ' + JSON.stringify(j)); return j;
};
token = (await api('/api/accounts/register', { nickname: 'tester', password: 'hunter22', ownerKey })).token;

// What there is to change.
const group = (await api('/api/channels/groups', { name: 'Team' })).group;
const alpha = (await api('/api/channels', { kind: 'text', name: 'alpha' })).channel;
await api('/api/channels', { kind: 'text', name: 'beta' });
const helper = (await api('/api/roles', { name: 'Helper', color: '#336699', permissions: ['users.kick'] })).role;
const other = (await api('/api/roles', { name: 'Other', color: '#996633' })).role;
const star = (await api('/api/badges', { name: 'Star', description: 'shiny', emoji: '⭐' })).badge;

const app = launchApp({ port: DBG, userDataDir: mkdtempSync(join(tmpdir(), 'sl-p-')) }); procs.push(app);
const cdp = await attach(await findPage(DBG)); await sleep(1200);
const set = (id, v, events = ['input', 'change']) => cdp.evaluate(`const i=document.getElementById(${JSON.stringify(id)}); i.value=${JSON.stringify(v)}; ${JSON.stringify(events)}.forEach((e) => i.dispatchEvent(new Event(e,{bubbles:true}))); return true;`);
await set('server-url', BASE); await sleep(1500); await set('username', 'tester'); await set('account-password', 'hunter22');
await cdp.evaluate("document.getElementById('continue').click(); return true;");
await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'channels' }); await sleep(900);

const until = async (fn, label, ms = 6000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return false; await sleep(150); } };
const serverNow = async () => (await api('/api/server')).server;
const rolesNow = async () => (await api('/api/roles')).roles;
const roleNow = async (id) => (await rolesNow()).find((r) => r.id === id);
const channelNow = async (id) => (await api('/api/channels')).channels.find((c) => c.id === id);
const badgeNow = async () => (await api('/api/badges')).badges.find((b) => b.id === star.id);
const click = (sel) => cdp.evaluate(`document.querySelector(${JSON.stringify(sel)}).click(); return true;`);
const tab = async (name) => { await click(`#server-dialog .settings-tab[data-tab="${name}"]`); await sleep(200); };
const tick = (container, label) => cdp.evaluate(`const row = [...document.querySelectorAll(${JSON.stringify(container + ' label.check')})].find((l) => l.textContent.includes(${JSON.stringify(label)})); row.querySelector('input').click(); return true;`);
const shot = async (name) => { if (!process.env.SHOT_DIR) return; const { mkdirSync, writeFileSync } = await import('node:fs'); mkdirSync(process.env.SHOT_DIR, { recursive: true });
  writeFileSync(join(process.env.SHOT_DIR, `${name}.png`), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
const state = (id) => cdp.evaluate(`return document.getElementById(${JSON.stringify(id)}).dataset.state ?? null;`);

await click('#server-settings');
await waitFor(cdp, "document.getElementById('server-dialog').open", { label: 'the dialog' });

// ================================================================================================ General
check('the General page has no Save button', await cdp.evaluate("return !document.getElementById('server-save') && !document.querySelector('#server-form button[type=submit]');"));
await set('server-name-input', 'Live Name', ['input']);
check('a name typed is the server\'s a moment after the typing stops, with nobody pressing anything', await until(async () => (await serverNow()).name === 'Live Name', 'name'));
await shot('general-pre');
check('and the page says "Saved", with the dialog still open', await until(async () => (await state('server-status')) === 'saved', 'saved') && await cdp.evaluate("return document.getElementById('server-dialog').open;"));
await set('server-max-file', '52428800', ['change']);
check('a menu is sent as it is chosen: the largest file', await until(async () => (await serverNow()).maxFileBytes === 52428800, 'max file'));
await set('server-storage', '4', ['change']);
check('the space for files, when its box is let go of', await until(async () => Math.abs((await serverNow()).storageBytes - 4 * 1024 ** 3) < 2 * 1024 ** 2, 'storage'));

// A password is not sent as it is typed: half of one would lock everybody out.
await set('server-password-input', 'sec', ['input']);
await sleep(1800);
check('a password still being typed is not sent', (await (await fetch(`${BASE}/api/health`)).json()).passwordRequired === false);
await set('server-password-input', 'secret-123', ['input', 'change']);
check('it is sent when the box is let go of', await until(async () => (await (await fetch(`${BASE}/api/health`)).json()).passwordRequired === true, 'password set'));
check('and the page, which is told the new key, still works (the box is emptied, the note says so)', await until(async () => cdp.evaluate("return document.getElementById('server-password-input').value === '' && /has a password/i.test(document.getElementById('server-password-note').textContent) && !document.getElementById('server-password-off').checked;"), 'password note'));
await click('#server-password-off');
check('ticking "No password at all" takes it off at once', await until(async () => (await (await fetch(`${BASE}/api/health`)).json()).passwordRequired === false, 'password off'));
check('and the switch stays ticked, as that is how it is', await cdp.evaluate("return document.getElementById('server-password-off').checked;"));

// ================================================================================================ Roles
await tab('roles');
await click(`#roles-list .admin-item[data-role-id="${helper.id}"]`);
await waitFor(cdp, "!document.getElementById('roles-editor').hidden && document.getElementById('role-name').value === 'Helper'", { label: 'the role editor' });
check('an existing role has no Save, nor Create', await cdp.evaluate("return document.getElementById('role-save').hidden;"));
// Finding a role in the list.
await set('roles-filter', 'oth', ['input']);
check('the role list can be searched: only the roles that match stay', await cdp.evaluate("return [...document.querySelectorAll('#roles-list .admin-item')].map((li) => li.textContent.trim()).join('|');") === 'Other');
check('and while it is, the arrows are off (the order is not changed past roles that are hidden)', await cdp.evaluate("return [...document.querySelectorAll('#roles-list .admin-item button')].every((b) => b.disabled);"));
await set('roles-filter', 'zzz', ['input']);
check('nothing matching says so', await cdp.evaluate("return document.querySelector('#roles-list .admin-empty')?.textContent.length > 3 && !document.querySelector('#roles-list .admin-item');"));
check('the role being edited stays in the editor while it is hidden from the list', await cdp.evaluate("return document.getElementById('role-name').value === 'Helper' && !document.getElementById('roles-editor').hidden;"));
await set('roles-filter', '', ['input']);
check('cleared, every role is back, with its arrows', await cdp.evaluate("return document.querySelectorAll('#roles-list .admin-item').length === 2 && [...document.querySelectorAll('#roles-list .admin-item button')].some((b) => !b.disabled);"));
await tick('#role-permissions', 'Ban');
check('a permission ticked is the role\'s, by itself', await until(async () => (await roleNow(helper.id)).permissions.includes('users.ban'), 'ban'));
check('and the page says "Saved"', await until(async () => (await state('server-status')) === 'saved', 'role saved'));
await shot('roles');
await tick('#role-permissions', 'Kick');
check('one unticked is gone from it', await until(async () => !(await roleNow(helper.id)).permissions.includes('users.kick'), 'no kick'));
await set('role-name', 'Helper 2', ['input']);
check('a name typed is sent when the typing stops', await until(async () => (await roleNow(helper.id)).name === 'Helper 2', 'role name'));
await set('role-color-hex', '#12', ['input']);
await sleep(1500);
check('half a colour is not sent, and says nothing about it', (await roleNow(helper.id)).color === '#336699' && await cdp.evaluate("return document.getElementById('role-error').hidden;"));
await set('role-color-hex', '#33aa55', ['input']);
check('a whole one is', await until(async () => (await roleNow(helper.id)).color === '#33aa55', 'role colour'));
await tick('#role-assignable', 'Other');
check('and the roles it can hand out', await until(async () => (await roleNow(helper.id)).assignable.includes(other.id), 'assignable'));
// Changing what is on show sends what was changed first.
await set('role-name', 'Helper 3', ['input']);
await click(`#roles-list .admin-item[data-role-id="${other.id}"]`);
check('going to another role straight after typing does not lose it', await until(async () => (await roleNow(helper.id)).name === 'Helper 3', 'flushed on select'));
await waitFor(cdp, "document.getElementById('role-name').value === 'Other'", { label: 'the other role in the editor' });
// Closing the dialog sends what is waiting.
await tick('#role-permissions', 'Delete any message');
await click('#server-cancel');
check('closing the dialog straight after a change does not lose it', await until(async () => (await roleNow(other.id)).permissions.includes('messages.delete'), 'flushed on close'));
await waitFor(cdp, "!document.getElementById('server-dialog').open", { label: 'the dialog closing on Done' });
await click('#server-settings');
await waitFor(cdp, "document.getElementById('server-dialog').open", { label: 'the dialog, again' });

// ================================================================================================ Channels
await tab('channels');
await click(`#chan-list .admin-item[data-channel-id="${alpha.id}"]`);
await waitFor(cdp, "!document.getElementById('chan-editor').hidden && document.getElementById('chan-name').value === 'alpha'", { label: 'the channel editor' });
check('an existing channel has no Save either', await cdp.evaluate("return document.getElementById('chan-save').hidden;"));
await set('chan-name', 'alpha-two', ['input']);
check('a channel\'s name typed is sent when the typing stops', await until(async () => (await channelNow(alpha.id)).name === 'alpha-two', 'channel name'));
await tick('#chan-roles', 'Other');
check('a role ticked limits it at once', await until(async () => (await channelNow(alpha.id)).roles.includes(other.id), 'channel role'));
await tick('#chan-roles', 'Other');
check('and unticked lets everybody in again', await until(async () => (await channelNow(alpha.id)).roles.length === 0, 'channel role off'));
await set('chan-password', 'pw', ['input']);
await sleep(1500);
check('a channel\'s password is not sent while it is typed', (await channelNow(alpha.id)).locked === false);
await set('chan-password', 'pw-one-two', ['input', 'change']);
check('it is when the box is let go of', await until(async () => (await channelNow(alpha.id)).locked === true, 'channel locked'));
await cdp.evaluate("document.getElementById('chan-password-off').click(); return true;");
check('and "Remove the password" takes it off at once', await until(async () => (await channelNow(alpha.id)).locked === false, 'channel unlocked'));
await set('chan-group', String(group.id), ['change']);
check('choosing a group puts the channel in it', await until(async () => (await channelNow(alpha.id)).groupId === group.id, 'channel grouped'));
// A new one waits for Create: making one tells everybody.
await click('#chan-new-text');
await waitFor(cdp, "document.getElementById('chan-subject').textContent.includes('New text')", { label: 'a new channel' });
check('a channel that does not exist yet has a Create button, and nothing is made by typing its name', await cdp.evaluate("return !document.getElementById('chan-save').hidden;"));
await set('chan-name', 'made-here', ['input']);
await sleep(1500);
check('typing its name makes nothing', !(await api('/api/channels')).channels.some((c) => c.name === 'made-here'));
await click('#chan-save');
check('Create makes it', await until(async () => (await api('/api/channels')).channels.some((c) => c.name === 'made-here'), 'created'));
check('and once it is made, it is live like the rest (no Create any more)', await until(async () => cdp.evaluate("return document.getElementById('chan-save').hidden;"), 'create gone'));
// A group
await click(`#chan-list .admin-item[data-group-id="${group.id}"]`);
await waitFor(cdp, "document.getElementById('chan-name').value === 'Team'", { label: 'the group editor' });
await set('chan-name', 'Crew', ['input']);
check('a group renames the same way', await until(async () => (await api('/api/channels')).groups.find((g) => g.id === group.id).name === 'Crew', 'group name'));

// ================================================================================================ Badges
await tab('badges');
await click(`#badges-list .admin-item[data-badge-id="${star.id}"]`);
await waitFor(cdp, "!document.getElementById('badges-editor').hidden && document.getElementById('badge-name').value === 'Star'", { label: 'the badge editor' });
check('an existing badge has no Save either', await cdp.evaluate("return document.getElementById('badge-save').hidden;"));
await set('badge-name', 'Gold Star', ['input']);
check('its name, as it is typed', await until(async () => (await badgeNow()).name === 'Gold Star', 'badge name'));
await set('badge-description', 'very shiny', ['input']);
check('its description', await until(async () => (await badgeNow()).description === 'very shiny', 'badge description'));
await set('badge-emoji', '🏆', ['input']);
check('its emoji', await until(async () => (await badgeNow()).emoji === '🏆', 'badge emoji'));
await set('badge-name', '', ['input']);
await sleep(1500);
check('an empty name is not sent, and does not complain while it is retyped', (await badgeNow()).name === 'Gold Star' && await cdp.evaluate("return document.getElementById('badge-error').hidden;"));
await set('badge-name', 'Gold Star 2', ['input']);
check('and the next one is', await until(async () => (await badgeNow()).name === 'Gold Star 2', 'badge name again'));
await click('#badges-new');
await waitFor(cdp, "!document.getElementById('badges-editor').hidden", { label: 'a new badge' });
check('a badge that does not exist yet has Create', await cdp.evaluate("return !document.getElementById('badge-save').hidden;"));

app.kill();
const failed = summary();
process.exit(failed ? 1 : 0);
