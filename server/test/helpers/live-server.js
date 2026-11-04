// A real server on a real port, with a stand-in for MediaMTX's API, for the tests that go through HTTP and the
// socket. Each test file gives it ports of its own: node --test runs the files in parallel.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'src', 'index.js');

export const b64 = (n) => randomBytes(n).toString('base64url');
export const sealed = (n = 64) => b64(n);

export function liveServer({ port, mtxPort, env = {} }) {
  const BASE = `http://127.0.0.1:${port}`;
  const WS_URL = `ws://127.0.0.1:${port}/ws`;
  let fakeMtx;
  let child;
  let ownerKey = null;
  const self = {
    BASE,
    dataDir: null,
    tokens: {},
    ids: {},
    keyOf: {},

    async start(nicknames) {
      self.dataDir = mkdtempSync(resolve(tmpdir(), '.harmony-live-'));
      await new Promise((done) => {
        fakeMtx = http.createServer((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
        });
        fakeMtx.listen(mtxPort, '127.0.0.1', done);
      });
      await new Promise((done, fail) => {
        child = spawn(process.execPath, [serverEntry], {
          env: {
            ...process.env,
            HARMONY_PORT: String(port),
            HARMONY_HOST: '127.0.0.1',
            HARMONY_DATA_DIR: self.dataDir,
            HARMONY_MEDIAMTX_API: `http://127.0.0.1:${mtxPort}`,
            HARMONY_POLL_INTERVAL_MS: '500',
            HARMONY_SIGNALING_URL: 'http://media.test:8889',
            ...env,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timer = setTimeout(() => fail(new Error('server did not start')), 10_000);
        let out = '';
        child.stdout.on('data', (b) => {
          out += b.toString();
          const match = /^\s*│\s+([A-Za-z0-9_-]{20,})\s+│$/m.exec(out);
          if (match) ownerKey = match[1];
          if (out.includes('control server on')) {
            clearTimeout(timer);
            done();
          }
        });
        child.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));
      });
      for (const [index, nick] of nicknames.entries()) {
        const r = await self.api('/api/accounts/register', {
          method: 'POST',
          body: { nickname: nick, password: 'hunter22', ...(index === 0 ? { ownerKey } : {}) },
        });
        self.tokens[nick] = r.body.token;
        self.ids[nick] = r.body.user.id;
      }
    },

    async stop() {
      await new Promise((done) => {
        if (!child || child.exitCode !== null) return done();
        child.once('exit', done);
        child.kill('SIGTERM');
        setTimeout(() => { child.kill('SIGKILL'); done(); }, 4000).unref();
        return undefined;
      });
      await new Promise((done) => fakeMtx.close(done));
      rmSync(self.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },

    async api(path, { method = 'GET', body, token, raw } = {}) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(raw ? { 'Content-Type': 'application/octet-stream' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        ...(raw ? { body: raw } : {}),
      });
      const buffer = Buffer.from(await res.arrayBuffer());
      let json = null;
      try { json = JSON.parse(buffer.toString()); } catch { /* binary or empty */ }
      return { status: res.status, body: json, buffer, headers: res.headers };
    },

    connect(token) {
      const ws = new WebSocket(WS_URL);
      const inbox = [];
      const waiters = [];
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        inbox.push(msg);
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          if (waiters[i].match(msg)) {
            waiters[i].resolve(msg);
            waiters.splice(i, 1);
          }
        }
      });
      return {
        ws,
        inbox,
        next(match, { timeoutMs = 5000 } = {}) {
          const found = inbox.find(match);
          if (found) return Promise.resolve(found);
          return new Promise((done, fail) => {
            const timer = setTimeout(
              () => fail(new Error(`timed out; saw ${JSON.stringify(inbox.map((m) => m.type))}`)),
              timeoutMs,
            );
            waiters.push({ match, resolve: (m) => { clearTimeout(timer); done(m); } });
          });
        },
        /** The next one after what has been seen so far. */
        fresh(match, opts) {
          const seen = inbox.length;
          const after = (m) => inbox.indexOf(m) >= seen && match(m);
          return this.next(after, opts);
        },
        async request(payload) {
          const rid = Math.random().toString(36).slice(2);
          ws.send(JSON.stringify({ ...payload, rid }));
          return this.next((m) => m.rid === rid);
        },
        async hello(extra = {}) {
          if (ws.readyState !== WebSocket.OPEN) {
            await new Promise((done) => ws.addEventListener('open', done, { once: true }));
          }
          return this.request({ type: 'hello', token, ...extra });
        },
        close() {
          ws.close();
          return new Promise((done) => ws.addEventListener('close', done, { once: true }));
        },
      };
    },

    async publishKey(who) {
      const r = await self.api('/api/keys', {
        method: 'POST', body: { publicKey: b64(32), wrapped: b64(73) }, token: self.tokens[who],
      });
      assert.equal(r.status, 201);
      self.keyOf[who] = r.body.key.id;
      return r.body.key;
    },
  };
  return self;
}

/** Nothing matching arrives within `ms`. */
export async function silent(client, match, ms = 300) {
  const seen = client.inbox.length;
  await new Promise((done) => setTimeout(done, ms));
  assert.equal(client.inbox.slice(seen).find(match), undefined, 'that should not have reached this socket');
}
