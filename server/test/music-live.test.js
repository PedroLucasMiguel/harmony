// Music Buddy through a running server: the owner's switch, who may use it, what the resolve route answers, and the
// socket -- added, controlled and listened to by the people in one voice channel, and by nobody else.
//
// yt-dlp is a fake (test/fixtures/fake-ytdlp.mjs), so nothing here leaves the machine. MediaMTX is stubbed.
//
//   node --test server/test/music-live.test.js

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', 'src', 'index.js');
const FAKE_YTDLP = resolve(here, 'fixtures', 'fake-ytdlp.mjs');

// Unique across the suite: node --test runs these files in PARALLEL.
const FAKE_MTX_PORT = 20700;
const FAKE_SPOTIFY_PORT = 20701;
const HARMONY_PORT = 18700;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;
const WS_URL = `ws://127.0.0.1:${HARMONY_PORT}/ws`;

let fakeMtx;
let fakeSpotify;
let child;
let dataDir;
let ownerKey = null;
const tokens = {};
const ids = {};
let voiceChannelId;
let otherVoiceId;

function startFakeMediaMtx() {
  return new Promise((done) => {
    fakeMtx = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
    });
    fakeMtx.listen(FAKE_MTX_PORT, '127.0.0.1', done);
  });
}

/** Spotify's embed pages, from fixtures: a playlist, a single track, one whose page has changed shape, and a 404. */
function startFakeSpotify() {
  return new Promise((done) => {
    const page = (name) => readFileSync(resolve(here, 'fixtures', name), 'utf8');
    fakeSpotify = http.createServer((req, res) => {
      const [, , kind, id] = req.url.split('?')[0].split('/');
      const body = id === 'bbbbbbbbbbbbbbbbbbbbbb' ? page('spotify-changed.html')
        : kind === 'playlist' || kind === 'album' ? page('spotify-playlist.html')
          : kind === 'track' && id === '4uLU6hMCjMI75M1A2tKUQC' ? page('spotify-track.html') : null;
      res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html' });
      res.end(body ?? 'not found');
    });
    fakeSpotify.listen(FAKE_SPOTIFY_PORT, '127.0.0.1', done);
  });
}

function startHarmony() {
  return new Promise((done, fail) => {
    child = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        HARMONY_PORT: String(HARMONY_PORT),
        HARMONY_HOST: '127.0.0.1',
        HARMONY_DATA_DIR: dataDir,
        HARMONY_MEDIAMTX_API: `http://127.0.0.1:${FAKE_MTX_PORT}`,
        HARMONY_POLL_INTERVAL_MS: '500',
        HARMONY_SIGNALING_URL: 'http://media.test:8889',
        HARMONY_YTDLP_BIN: FAKE_YTDLP,
        FAKE_DURATION: '60',
        HARMONY_MUSIC_NO_THUMBNAILS: '1',
        // Spotify's pages are read from the fake above, which is on this machine.
        HARMONY_SPOTIFY_BASE: `http://127.0.0.1:${FAKE_SPOTIFY_PORT}`,
        HARMONY_LINKS_ALLOW_PRIVATE: '1',
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
}

const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: method === 'GET' && body ? 'POST' : method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
};
const post = (path, token, body = {}) => api(path, { method: 'POST', body, token });

function connect(token) {
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
  const client = {
    ws,
    inbox,
    /** The next message that matches, one already received or one still to come. */
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
    /** A message that arrives AFTER this call. */
    fresh(match, options) {
      const from = inbox.length;
      return {
        wait: () => client.next((m) => inbox.indexOf(m) >= from && match(m), options),
      };
    },
    async request(payload) {
      const rid = Math.random().toString(36).slice(2);
      ws.send(JSON.stringify({ ...payload, rid }));
      return client.next((m) => m.rid === rid);
    },
    async hello() {
      if (ws.readyState !== WebSocket.OPEN) {
        await new Promise((done, fail) => {
          ws.addEventListener('open', done, { once: true });
          ws.addEventListener('close', () => fail(new Error('closed')), { once: true });
        });
      }
      return client.request({ type: 'hello', token });
    },
    join: (channelId) => client.request({ type: 'voice:join', channelId }),
    leave: (channelId) => client.request({ type: 'voice:leave', channelId }),
    close: () => ws.close(),
  };
  return client;
}

const states = (client) => client.inbox.filter((m) => m.type === 'music:state');
const lastState = (client) => states(client).at(-1);
/** The next state (one already received counts) that satisfies `test`. */
const waitState = async (client, test, options) => (await client.next((m) => m.type === 'music:state' && test(m.state, m), options)).state;

const search = (text) => ({ input: text });
const items = (n, from = 1) => Array.from({ length: n }, (_, i) => ({
  source: `yt:${String(from + i).padStart(2, '0')}abcdefghi`.slice(0, 14), title: `Song ${from + i}`, artist: 'Artist', durationMs: 60_000,
}));

before(async () => {
  dataDir = mkdtempSync(resolve(tmpdir(), 'harmony-music-live-'));
  await startFakeMediaMtx();
  await startFakeSpotify();
  await startHarmony();

  const reg = async (nickname, extra = {}) => {
    const res = await post('/api/accounts/register', null, { nickname, password: 'hunter22', ...extra });
    tokens[nickname] = res.body.token;
    ids[nickname] = res.body.user.id;
  };
  await reg('boss', { ownerKey });
  await reg('dj');
  await reg('fan');
  await reg('late');

  const channels = (await api('/api/channels', { token: tokens.boss })).body.channels;
  voiceChannelId = channels.find((c) => c.kind === 'voice').id;
  otherVoiceId = (await post('/api/channels', tokens.boss, { kind: 'voice', name: 'Elsewhere' })).body.channel.id;

  const role = (await post('/api/roles', tokens.boss, { name: 'DJ', permissions: ['music.control'] })).body.role;
  await post(`/api/accounts/${ids.dj}/roles`, tokens.boss, { roles: [role.id] });
});

after(async () => {
  await new Promise((done) => {
    if (!child || child.exitCode !== null) return done();
    child.once('exit', done);
    child.kill('SIGTERM');
    setTimeout(() => { child.kill('SIGKILL'); done(); }, 4000).unref();
  });
  await new Promise((done) => fakeMtx.close(done));
  await new Promise((done) => fakeSpotify.close(done));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---------------------------------------------------------------------------

describe('the owner\'s switch', () => {
  it('is off until the owner turns it on, and says yt-dlp is there', async () => {
    const view = (await api('/api/server', { token: tokens.fan })).body.server;
    assert.equal(view.musicEnabled, false);
    assert.equal(view.musicAvailable, true);
    assert.equal((await post('/api/music/resolve', tokens.boss, search('anything'))).status, 409);
  });

  it('is the owner\'s to turn on', async () => {
    assert.equal((await post('/api/server', tokens.dj, { musicEnabled: true })).status, 403);
    const res = await post('/api/server', tokens.boss, { musicEnabled: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.server.musicEnabled, true);
  });
});

describe('who may use it', () => {
  it('the owner and a role with the permission may; a plain member may not', async () => {
    assert.equal((await post('/api/music/resolve', tokens.boss, search('x'))).status, 200);
    assert.equal((await post('/api/music/resolve', tokens.dj, search('x'))).status, 200);
    const refused = await post('/api/music/resolve', tokens.fan, search('x'));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'forbidden');
  });

  it('the permission is a tick on a role like any other', async () => {
    const roles = (await api('/api/roles', { token: tokens.boss })).body.roles;
    assert.deepEqual(roles.find((r) => r.name === 'DJ').permissions, ['music.control']);
    const bad = await post('/api/roles', tokens.boss, { name: 'X', permissions: ['music.dance'] });
    assert.equal(bad.status, 400);
  });
});

describe('what a link or words are', () => {
  it('searches', async () => {
    const res = await post('/api/music/resolve', tokens.dj, search('daft punk'));
    assert.equal(res.body.kind, 'search');
    assert.equal(res.body.items.length, 3);
    assert.match(res.body.items[0].source, /^yt:[\w-]{11}$/);
    assert.equal(res.body.items[0].durationMs, 60_000);
  });

  it('reads a video link, and offers the playlist it was opened from', async () => {
    const res = await post('/api/music/resolve', tokens.dj, search('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghijklmnop'));
    assert.equal(res.body.kind, 'youtube-video');
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].source, 'yt:dQw4w9WgXcQ');
    assert.equal(res.body.playlist, 'PLabcdefghijklmnop');
  });

  it('lists a playlist', async () => {
    const res = await post('/api/music/resolve', tokens.dj, search('https://www.youtube.com/playlist?list=PLabcdefghijklmnop'));
    assert.equal(res.body.kind, 'youtube-playlist');
    assert.equal(res.body.items.length, 4);
  });

  it('refuses other places', async () => {
    const other = await post('/api/music/resolve', tokens.dj, search('https://vimeo.com/123'));
    assert.equal(other.status, 400);
    assert.equal(other.body.error, 'unsupported');
    const empty = await post('/api/music/resolve', tokens.dj, search('   '));
    assert.equal(empty.body.error, 'empty');
  });

  it('lists what a Spotify playlist, album or track holds', async () => {
    const playlist = await post('/api/music/resolve', tokens.boss, search('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'));
    assert.equal(playlist.body.kind, 'spotify-playlist');
    assert.equal(playlist.body.items.length, 3);
    assert.deepEqual(playlist.body.items[0], { source: 'sp:7bxaFZ1O3cHkgLKMsdC3xR', title: 'Loser', artist: 'Tame Impala', durationMs: 223069, thumbHash: null });
    const album = await post('/api/music/resolve', tokens.boss, search('https://open.spotify.com/album/37i9dQZF1DXcBWIGoYBM5M'));
    assert.equal(album.body.items.length, 3);
    const track = await post('/api/music/resolve', tokens.boss, search('spotify:track:4uLU6hMCjMI75M1A2tKUQC'));
    assert.equal(track.body.items.length, 1);
    assert.equal(track.body.items[0].artist, 'Rick Astley');
  });

  it('says so when Spotify\'s page is not what it reads, or is not there', async () => {
    const changed = await post('/api/music/resolve', tokens.boss, search('https://open.spotify.com/playlist/bbbbbbbbbbbbbbbbbbbbbb'));
    assert.equal(changed.status, 502);
    assert.equal(changed.body.error, 'spotify_changed');
    const missing = await post('/api/music/resolve', tokens.boss, search('https://open.spotify.com/track/cccccccccccccccccccccc'));
    assert.equal(missing.status, 502);
  });

  it('slows down somebody who asks too fast', async () => {
    let last;
    for (let i = 0; i < 30; i += 1) last = await post('/api/music/resolve', tokens.boss, search(`q${i}`));
    assert.equal(last.status, 429);
    assert.ok(last.body.retryAfterSec >= 1);
  });
});

describe('in a voice channel', () => {
  let boss;
  let dj;
  let fan;

  before(async () => {
    [boss, dj, fan] = ['boss', 'dj', 'fan'].map((n) => connect(tokens[n]));
    await Promise.all([boss.hello(), dj.hello(), fan.hello()]);
    // The owner stays out of the channel for now.
    assert.equal((await dj.join(voiceChannelId)).type, 'voice:joined');
    assert.equal((await fan.join(voiceChannelId)).type, 'voice:joined');
  });

  after(() => { boss.close(); dj.close(); fan.close(); });

  it('a member without the permission cannot add or control', async () => {
    const add = await fan.request({ type: 'music:add', channelId: voiceChannelId, items: items(1) });
    assert.deepEqual([add.type, add.error], ['voice:error', 'forbidden']);
    const control = await fan.request({ type: 'music:control', channelId: voiceChannelId, action: 'pause' });
    assert.equal(control.error, 'forbidden');
  });

  it('somebody not in the channel cannot, even with the permission', async () => {
    const add = await boss.request({ type: 'music:add', channelId: voiceChannelId, items: items(1) });
    assert.equal(add.error, 'not_in_channel');
  });

  it('what is added is fetched, and then plays for everybody in the channel -- and for nobody else', async () => {
    const added = await dj.request({ type: 'music:add', channelId: voiceChannelId, items: items(3) });
    assert.deepEqual([added.type, added.added], ['voice:ok', 3]);
    const playing = await waitState(fan, (s) => s.status === 'playing');
    assert.equal(playing.queue.length, 3);
    assert.ok(playing.queue[0].hash, 'the file the clients will play');
    assert.equal(playing.current, playing.queue[0].id);
    assert.equal(playing.queue[0].addedBy, 'dj');
    await waitState(dj, (s) => s.status === 'playing');
    assert.equal(states(boss).length, 0, 'the owner is not in the channel and hears nothing of it');
  });

  it('the file is an ordinary upload every member can fetch', async () => {
    const hash = lastState(fan).state.queue[0].hash;
    const res = await fetch(`${BASE}/api/uploads/${hash}`, { headers: { Authorization: `Bearer ${tokens.fan}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/webm');
    assert.ok((await res.arrayBuffer()).byteLength > 1000, 'real audio, not a placeholder');
  });

  it('anybody in the channel can read the server\'s clock, for working out how long a push takes to arrive', async () => {
    const reply = await fan.request({ type: 'music:clock', channelId: voiceChannelId });
    assert.equal(reply.type, 'music:clock');
    assert.ok(Math.abs(reply.serverNow - Date.now()) < 3000);
    assert.equal((await boss.request({ type: 'music:clock', channelId: voiceChannelId })).error, 'not_in_channel');
  });

  it('a listener can ask where the music is, but cannot change it', async () => {
    const sync = await fan.request({ type: 'music:sync', channelId: voiceChannelId });
    assert.equal(sync.type, 'music:sync');
    assert.equal(sync.music.state.status, 'playing');
    assert.ok(Math.abs(sync.music.serverNow - Date.now()) < 5000);
  });

  it('pause, resume, shuffle, repeat and next reach everyone as one snapshot each', async () => {
    const paused = fan.fresh((m) => m.type === 'music:state' && m.state.status === 'paused');
    assert.equal((await dj.request({ type: 'music:control', channelId: voiceChannelId, action: 'pause' })).type, 'voice:ok');
    const p = (await paused.wait()).state;
    assert.ok(p.positionMs >= 0);

    await dj.request({ type: 'music:control', channelId: voiceChannelId, action: 'resume' });
    await waitState(fan, (s, m) => s.status === 'playing' && m.state.rev > p.rev);

    await dj.request({ type: 'music:control', channelId: voiceChannelId, action: 'shuffle', on: true });
    await waitState(fan, (s) => s.shuffle === true);
    await dj.request({ type: 'music:control', channelId: voiceChannelId, action: 'repeat', mode: 'all' });
    await waitState(fan, (s) => s.repeat === 'all');
    const bad = await dj.request({ type: 'music:control', channelId: voiceChannelId, action: 'repeat', mode: 'sometimes' });
    assert.equal(bad.error, 'bad_mode');

    const before = lastState(fan).state.current;
    await dj.request({ type: 'music:control', channelId: voiceChannelId, action: 'next' });
    const after = await waitState(fan, (s) => s.current !== before && s.status === 'playing');
    assert.notEqual(after.current, before);
  });

  it('the queue is edited live: moved, mixed again, a song put next, one removed -- everybody sees each change', async () => {
    // The authoritative snapshot, asked for, rather than whichever push happened to arrive last.
    const snap = async () => (await dj.request({ type: 'music:sync', channelId: voiceChannelId })).music.state;
    const edit = async (action) => {
      const reply = await dj.request({ type: 'music:control', channelId: voiceChannelId, ...action });
      assert.equal(reply.type, 'voice:ok', JSON.stringify({ reply, action }));
      const now = await snap();
      // Every listener is sent the same snapshot as the one who asked.
      const heard = await waitState(fan, (s) => s.rev === now.rev);
      assert.deepEqual(heard.queue.map((t) => t.id), now.queue.map((t) => t.id), 'the listener sees the same queue');
      return now;
    };
    // More to play than to mix needs: five songs, with the first of them playing.
    assert.equal((await dj.request({ type: 'music:add', channelId: voiceChannelId, items: items(2, 10) })).type, 'voice:ok');
    await edit({ action: 'shuffle', on: false });
    await edit({ action: 'play', id: (await snap()).queue[0].id });
    const before = (await snap()).queue.map((t) => t.id);
    const last = before.at(-1);
    let state = await edit({ action: 'move', id: last, index: 0 });
    assert.equal(state.queue[0].id, last, 'moved to the top');
    // Any song that is not the one playing (nor the one just moved to the top, if that is not the current one).
    const other = state.queue.map((t) => t.id).filter((id) => id !== state.current && id !== state.queue[0].id).at(-1);
    state = await edit({ action: 'next-up', id: other });
    assert.equal(state.queue.findIndex((t) => t.id === other), state.queue.findIndex((t) => t.id === state.current) + 1);
    const titlesBefore = state.queue.map((t) => t.title).sort();
    state = await edit({ action: 'reshuffle' });
    assert.deepEqual(state.queue.map((t) => t.title).sort(), titlesBefore, 'the same songs');
    const victim = state.queue.find((t) => t.id !== state.current).id;
    state = await edit({ action: 'remove', id: victim });
    assert.equal(state.queue.length, before.length - 1);
    assert.ok(!state.queue.some((t) => t.id === victim));
    await dj.request({ type: 'music:add', channelId: voiceChannelId, items: items(1, 5) });
    assert.equal((await snap()).queue.length, before.length, 'one out, one in');
  });

  it('somebody who joins in the middle is told where the music is as they join', async () => {
    const late = connect(tokens.late);
    await late.hello();
    const joined = await late.join(voiceChannelId);
    assert.equal(joined.type, 'voice:joined');
    assert.equal(joined.music.state.status, 'playing');
    assert.equal(joined.music.state.queue.length, 5);
    assert.ok(joined.music.serverNow > 0);
    // ...and somebody joining another channel is told of none.
    const elsewhere = await late.join(otherVoiceId);
    assert.equal(elsewhere.music, null);
    late.close();
  });

  it('a track that cannot be fetched is passed over, and the channel is told', async () => {
    const bad = [{ source: 'yt:badbadbadba', title: 'Broken', artist: '', durationMs: 5000 }];
    await dj.request({ type: 'music:add', channelId: voiceChannelId, items: bad, next: true });
    await dj.request({ type: 'music:control', channelId: voiceChannelId, action: 'next' });
    const error = await fan.next((m) => m.type === 'music:error');
    assert.equal(error.title, 'Broken');
    const moved = await waitState(fan, (s) => s.status === 'playing' && s.queue.find((t) => t.id === s.current)?.title !== 'Broken');
    assert.ok(moved.current);
  });

  it('a Spotify song is looked for on YouTube when its turn comes, and plays from there', async () => {
    const resolved = await post('/api/music/resolve', tokens.dj, search('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'));
    assert.equal(resolved.status, 200);
    const rev = lastState(fan).state.rev;
    await dj.request({ type: 'music:add', channelId: voiceChannelId, items: resolved.body.items, next: true });
    await dj.request({ type: 'music:control', channelId: voiceChannelId, action: 'next' });
    const state = await waitState(fan, (s) => s.rev > rev && s.status === 'playing' && s.queue.find((t) => t.id === s.current)?.source === 'sp:4uLU6hMCjMI75M1A2tKUQC');
    const track = state.queue.find((t) => t.id === state.current);
    assert.equal(track.title, 'Never Gonna Give You Up');
    assert.equal(track.artist, 'Rick Astley');
    assert.ok(track.hash, 'a file to play, fetched through YouTube');
  });

  it('the queue can be cleared, and with nobody left in the channel nothing of it is kept', async () => {
    await dj.request({ type: 'music:control', channelId: voiceChannelId, action: 'clear' });
    const cleared = await waitState(fan, (s) => s.queue.length === 0);
    assert.equal(cleared.status, 'idle');
    await dj.request({ type: 'music:add', channelId: voiceChannelId, items: items(1, 20) });
    await waitState(fan, (s) => s.status === 'playing' && s.queue.length === 1);
    await dj.leave(voiceChannelId);
    await fan.leave(voiceChannelId);
    const again = connect(tokens.late);
    await again.hello();
    const joined = await again.join(voiceChannelId);
    assert.equal(joined.music, null, 'the music ended with the last listener');
    again.close();
  });

  it('turning the feature off ends it, and the controls answer that it is off', async () => {
    await dj.join(voiceChannelId);
    await dj.request({ type: 'music:add', channelId: voiceChannelId, items: items(1, 30) });
    await waitState(dj, (s) => s.status === 'playing' && s.queue.some((t) => t.title === 'Song 30'));
    const told = dj.fresh((m) => m.type === 'server:info' && m.info.musicEnabled === false);
    assert.equal((await post('/api/server', tokens.boss, { musicEnabled: false })).status, 200);
    assert.equal((await told.wait()).info.musicEnabled, false, 'everybody is told the view, under a name the client keeps');
    const refused = await dj.request({ type: 'music:add', channelId: voiceChannelId, items: items(1, 40) });
    assert.equal(refused.error, 'music_off');
    assert.equal((await post('/api/music/resolve', tokens.dj, search('x'))).status, 409);
    const sync = await dj.request({ type: 'music:sync', channelId: voiceChannelId });
    assert.equal(sync.error, 'music_off');
  });
});
