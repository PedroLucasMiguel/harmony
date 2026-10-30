// One realtime connection per server, and credentials that stay with their server.
//
// The app holds a list of servers, several of them live at once. What this file
// protects: a frame says which server it came from, a request goes to the
// server it names, asking again for a connection already kept does not open a
// second socket, and one server's token never reaches another.
//
//   node --test client/test/realtime-hub.test.mjs

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('../../server/node_modules/ws');
const { RealtimeHub } = require('../src/main/realtime-hub.js');
const api = require('../src/main/api.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A stub Harmony server: a socket that says hello and answers `whoami`, and one HTTP route that echoes the credentials it was sent. */
function stub(name) {
  const accepted = [];
  const seen = [];
  const http = createServer((req, res) => {
    seen.push({ auth: req.headers.authorization ?? '', door: req.headers['x-harmony-password'] ?? '' });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ name }));
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
    accepted.push(ws);
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === 'hello') ws.send(JSON.stringify({ type: 'hello-ok', rid: msg.rid, who: name }));
      if (msg.type === 'whoami') ws.send(JSON.stringify({ type: 'whoami-ok', rid: msg.rid, name }));
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', rid: msg.rid }));
    });
    ws.on('error', () => {});
  }));
  return {
    name, accepted, seen, http, wss,
    listen: () => new Promise((done) => http.listen(0, '127.0.0.1', () => done(http.address().port))),
    push: (payload) => accepted.forEach((ws) => ws.send(JSON.stringify(payload))),
    close: async () => {
      accepted.forEach((ws) => { try { ws.terminate(); } catch { /* gone */ } });
      wss.close();
      await new Promise((done) => http.close(done));
    },
  };
}

const a = stub('A');
const b = stub('B');
let urlA;
let urlB;

before(async () => {
  urlA = `http://127.0.0.1:${await a.listen()}`;
  urlB = `http://127.0.0.1:${await b.listen()}`;
});

after(async () => {
  await a.close();
  await b.close();
});

describe('the realtime hub', () => {
  it('keeps a connection per server and tags every frame with its server', async () => {
    const hub = new RealtimeHub();
    const events = [];
    hub.on('event', (e) => events.push(e));

    const [helloA, helloB] = await Promise.all([hub.connect(urlA, 'ta'), hub.connect(urlB, 'tb')]);
    assert.equal(helloA.who, 'A');
    assert.equal(helloB.who, 'B');

    a.push({ type: 'channels', n: 1 });
    b.push({ type: 'channels', n: 2 });
    await sleep(200);

    const forA = events.find((e) => e.type === 'channels' && e.n === 1);
    const forB = events.find((e) => e.type === 'channels' && e.n === 2);
    assert.equal(forA.server, api.credKey(urlA));
    assert.equal(forB.server, api.credKey(urlB));
    hub.disconnect();
  });

  it('sends a request to the server it names', async () => {
    const hub = new RealtimeHub();
    await Promise.all([hub.connect(urlA, 'ta'), hub.connect(urlB, 'tb')]);
    assert.equal((await hub.request(urlA, 'whoami')).name, 'A');
    assert.equal((await hub.request(urlB, 'whoami')).name, 'B');
    // However the address is written.
    assert.equal((await hub.request(urlB.toUpperCase().replace('HTTP', 'http') + '/', 'whoami')).name, 'B');
    await assert.rejects(hub.request('http://127.0.0.1:1', 'whoami'), /Not connected/);
    hub.disconnect();
  });

  it('does not open a second socket for a connection it already keeps', async () => {
    const hub = new RealtimeHub();
    const before = a.accepted.length;
    const first = await hub.connect(urlA, 'ta');
    const again = await hub.connect(urlA, 'ta');
    await sleep(200);
    assert.equal(a.accepted.length, before + 1, 'one socket for two connects');
    assert.equal(again.who, first.who);
    hub.disconnect();
  });

  it('disconnects one server and leaves the others', async () => {
    const hub = new RealtimeHub();
    await Promise.all([hub.connect(urlA, 'ta'), hub.connect(urlB, 'tb')]);
    hub.disconnect(urlA);
    assert.equal(hub.connected(urlA), false);
    assert.equal(hub.connected(urlB), true);
    await assert.rejects(hub.request(urlA, 'whoami'), /Not connected/);
    assert.equal((await hub.request(urlB, 'whoami')).name, 'B');
    hub.disconnect();
    assert.equal(hub.connected(urlB), false);
  });
});

describe('credentials', () => {
  it('go only to the server they were set for', async () => {
    api.setCredentials(urlA, { password: 'door-a', token: 'token-a' });
    api.setCredentials(urlB, { password: 'door-b', token: 'token-b' });
    a.seen.length = 0;
    b.seen.length = 0;

    await api.health(urlA);
    await api.health(urlB);

    assert.deepEqual(a.seen, [{ auth: 'Bearer token-a', door: 'door-a' }]);
    assert.deepEqual(b.seen, [{ auth: 'Bearer token-b', door: 'door-b' }]);
  });

  it('are not sent to a server nobody set them for', async () => {
    const c = stub('C');
    const urlC = `http://127.0.0.1:${await c.listen()}`;
    await api.health(urlC);
    await api.dmRequest(urlC, 'GET', '/api/dms');
    assert.deepEqual(c.seen, [{ auth: '', door: '' }, { auth: '', door: '' }]);
    await c.close();
  });

  it('are found however the address is written', async () => {
    api.setSessionToken('only-token', urlA.replace('http://', '').toUpperCase());
    a.seen.length = 0;
    await api.health(`${urlA}/`);
    assert.equal(a.seen[0].auth, 'Bearer only-token');
  });

  it('a probe sends the password it is given and never the session token', async () => {
    a.seen.length = 0;
    await api.probe(urlA, 'someone-elses-door');
    assert.deepEqual(a.seen, [{ auth: '', door: 'someone-elses-door' }]);
  });
});
