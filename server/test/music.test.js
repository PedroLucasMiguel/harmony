// Music Buddy's parts, one at a time:
//
//   - classify: what a link or some words are, and what is never let through to yt-dlp
//   - the room: shuffle, repeat, next and previous, as arithmetic on a clock that is passed in
//   - the service: fetching before playing, the end of a track, passing over what cannot be fetched, letting go of files
//   - yt-dlp and the library, against a fake yt-dlp (test/fixtures/fake-ytdlp.mjs): arguments, limits, the cache
//
//   node --test server/test/music.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, watchUrl, playlistUrl } from '../src/music/classify.js';
import { MusicRoom, RESTART_AFTER_MS } from '../src/music/room.js';
import { Music } from '../src/music/service.js';
import { YtDlp, MusicError } from '../src/music/ytdlp.js';
import { MusicLibrary } from '../src/music/library.js';
import { Spotify, entityOf, tracksOfEntity } from '../src/music/spotify.js';
import { Chat } from '../src/chat.js';
import { ensureDataDir, openDatabase } from '../src/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(here, 'fixtures', 'fake-ytdlp.mjs');

const V = 'dQw4w9WgXcQ';
const fixture = (name) => readFileSync(resolve(here, 'fixtures', name), 'utf8');

// ------------------------------------------------------------------------------------------------------------ classify
describe('classify', () => {
  it('reads the usual forms of a YouTube video', () => {
    for (const link of [
      `https://www.youtube.com/watch?v=${V}`,
      `https://youtube.com/watch?v=${V}&t=42s`,
      `https://m.youtube.com/watch?v=${V}`,
      `https://music.youtube.com/watch?v=${V}`,
      `https://youtu.be/${V}`,
      `https://youtu.be/${V}?si=abc`,
      `https://www.youtube.com/shorts/${V}`,
      `https://www.youtube.com/embed/${V}`,
      `www.youtube.com/watch?v=${V}`,
      `youtube.com/watch?v=${V}`,
    ]) {
      const found = classify(link);
      assert.equal(found.kind, 'youtube-video', link);
      assert.equal(found.id, V, link);
    }
  });

  it('keeps the playlist a video was opened from, for it to be offered', () => {
    const found = classify(`https://www.youtube.com/watch?v=${V}&list=PLabcdefghijklmnop`);
    assert.deepEqual(found, { kind: 'youtube-video', id: V, list: 'PLabcdefghijklmnop' });
  });

  it('reads a playlist link', () => {
    assert.deepEqual(classify('https://www.youtube.com/playlist?list=PLabcdefghijklmnop'), { kind: 'youtube-playlist', id: 'PLabcdefghijklmnop' });
  });

  it('reads Spotify tracks, albums and playlists, with a language prefix, and a URI', () => {
    const id = '4uLU6hMCjMI75M1A2tKUQC';
    assert.deepEqual(classify(`https://open.spotify.com/track/${id}?si=xyz`), { kind: 'spotify-track', id });
    assert.deepEqual(classify(`https://open.spotify.com/intl-pt/album/${id}`), { kind: 'spotify-album', id });
    assert.deepEqual(classify(`https://open.spotify.com/embed/playlist/${id}`), { kind: 'spotify-playlist', id });
    assert.deepEqual(classify(`spotify:track:${id}`), { kind: 'spotify-track', id });
  });

  it('takes anything that is not a link for words to look for, cleaned', () => {
    assert.deepEqual(classify('  daft   punk\n around the world '), { kind: 'search', query: 'daft punk around the world' });
    assert.equal(classify('x'.repeat(500)).query.length, 120);
    // Something that starts like an option is only words: it is never put where yt-dlp could take it for one.
    assert.deepEqual(classify('--exec rm -rf /'), { kind: 'search', query: '--exec rm -rf /' });
  });

  it('refuses links to anywhere else, and to ids that are not ids', () => {
    for (const link of [
      'https://vimeo.com/123456',
      'https://evil.example/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'http://127.0.0.1:8080/x',
      'file:///etc/passwd',
      'https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ%20--exec',
      'https://open.spotify.com/track/not-an-id',
      'https://open.spotify.com/show/4uLU6hMCjMI75M1A2tKUQC',
    ]) {
      assert.equal(classify(link).kind, 'refused', link);
    }
    assert.equal(classify('').reason, 'empty');
    assert.equal(classify(null).reason, 'empty');
  });

  it('builds the addresses yt-dlp is given from ids only', () => {
    assert.equal(watchUrl(V), `https://www.youtube.com/watch?v=${V}`);
    assert.equal(playlistUrl('PLabcdefghijklmnop'), 'https://www.youtube.com/playlist?list=PLabcdefghijklmnop');
  });
});

// -------------------------------------------------------------------------------------------------------------- room
/** A deterministic "random": the next number of a fixed list, round and round. */
const sequence = (...numbers) => {
  let i = 0;
  return () => numbers[i++ % numbers.length];
};

const song = (n, durationMs = 10_000) => ({ source: `yt:${String(n).padStart(11, 'a')}`, title: `Song ${n}`, artist: 'A', durationMs });
const titles = (room) => room.tracks.map((t) => t.title);

function started(count = 4, options = {}) {
  const room = new MusicRoom(options);
  const made = room.add(Array.from({ length: count }, (_, i) => song(i + 1)), { addedBy: 'ana' });
  room.play(made[0].id);
  room.ready(made[0].id, 1000, { hash: 'h1' });
  return { room, made };
}

describe('MusicRoom', () => {
  it('starts a track loading, and its clock runs only once its file is there', () => {
    const room = new MusicRoom();
    const [first] = room.add([song(1)], { addedBy: 'ana' });
    assert.equal(room.status, 'idle');
    room.play(first.id);
    assert.equal(room.status, 'loading');
    assert.equal(room.elapsedMs(5000), 0);
    room.ready(first.id, 5000, { hash: 'h' });
    assert.equal(room.status, 'playing');
    assert.equal(room.elapsedMs(7500), 2500);
    assert.equal(room.remainingMs(7500), 7500);
  });

  it('pauses where it is and resumes from there', () => {
    const { room } = started();
    assert.ok(room.pause(4000));
    assert.equal(room.elapsedMs(99_000), 3000);
    assert.ok(room.resume(10_000));
    assert.equal(room.elapsedMs(12_000), 5000);
    assert.equal(room.pause(0) && room.pause(0), false, 'pausing twice is nothing');
  });

  it('seeks, playing or paused, and not past the end', () => {
    const { room } = started();
    room.seek(6000, 2000);
    assert.equal(room.elapsedMs(2000), 6000);
    room.pause(2000);
    room.seek(1000, 2000);
    assert.equal(room.elapsedMs(50_000), 1000);
    room.seek(10 ** 9, 2000);
    assert.ok(room.elapsedMs(2000) < 10_000);
  });

  it('goes to the next track, and stops after the last', () => {
    const { room, made } = started(3);
    assert.equal(room.next(), made[1].id);
    assert.equal(room.next(), made[2].id);
    assert.equal(room.next(), null);
    assert.equal(room.status, 'idle');
    assert.equal(room.current, null);
  });

  it('repeat all wraps round; repeat one repeats when a track runs out but not when Next is pressed', () => {
    const { room, made } = started(2);
    room.setRepeat('all');
    room.next();
    assert.equal(room.next(), made[0].id, 'wraps');

    room.setRepeat('one');
    assert.equal(room.next({ auto: true }), made[0].id, 'the track that ran out plays again');
    assert.equal(room.next({ auto: false }), made[1].id, 'Next still goes on');
  });

  it('Previous restarts a track that has played a while, and goes back from the start of one', () => {
    const { room, made } = started(3);
    room.next();
    room.ready(made[1].id, 20_000, { hash: 'h2' });
    assert.equal(room.previous(20_000 + RESTART_AFTER_MS + 1), made[1].id, 'restarts');
    room.ready(made[1].id, 30_000, { hash: 'h2' });
    assert.equal(room.previous(30_500), made[0].id, 'goes back');
    assert.equal(room.previous(31_000), made[0].id, 'and at the first there is nowhere to go');
  });

  it('shuffle keeps the current track and what was played, and mixes what is to come', () => {
    const { room, made } = started(6, { random: sequence(0.9, 0.1, 0.5, 0.3) });
    room.next(); // Song 2 is current, Song 1 played
    room.setShuffle(true);
    const order = titles(room);
    assert.deepEqual(order.slice(0, 2), ['Song 1', 'Song 2']);
    assert.deepEqual([...order.slice(2)].sort(), ['Song 3', 'Song 4', 'Song 5', 'Song 6']);
    assert.notDeepEqual(order, ['Song 1', 'Song 2', 'Song 3', 'Song 4', 'Song 5', 'Song 6'], 'it did mix them');
    assert.equal(room.current.id, made[1].id);
  });

  it('shuffle off puts the order the songs were added in back, keeping the current one', () => {
    const { room } = started(5, { random: sequence(0.9, 0.1, 0.5) });
    room.setShuffle(true);
    room.next();
    const now = room.current.title;
    room.setShuffle(false);
    assert.deepEqual(titles(room), ['Song 1', 'Song 2', 'Song 3', 'Song 4', 'Song 5']);
    assert.equal(room.current.title, now);
  });

  it('starts a new lap of a shuffled queue in a new order when repeating all', () => {
    const { room } = started(4, { random: sequence(0.2, 0.7, 0.1) });
    room.setRepeat('all');
    room.setShuffle(true);
    const lap = titles(room);
    for (let i = 0; i < 3; i += 1) room.next();
    room.next(); // wraps
    assert.equal(titles(room).length, lap.length);
    assert.deepEqual([...titles(room)].sort(), [...lap].sort());
  });

  it('adds to the end, or right after the current track, or among what is left when shuffled', () => {
    const { room } = started(3, { random: sequence(0.0) });
    room.add([song(9)], { addedBy: 'bruno' });
    assert.equal(titles(room).at(-1), 'Song 9');
    room.add([song(8)], { next: true, addedBy: 'bruno' });
    assert.equal(titles(room)[1], 'Song 8');

    room.setShuffle(true);
    room.add([song(7)], { addedBy: 'bruno' });
    const at = titles(room).indexOf('Song 7');
    assert.ok(at >= 1, 'never before the current track');
  });

  it('mixes what is still to come again, on demand, keeping what was played and the current track', () => {
    const { room } = started(8, { random: sequence(0.9, 0.1, 0.6, 0.3, 0.8) });
    room.next();
    room.next(); // Songs 1 and 2 played, Song 3 current
    const before = titles(room);
    assert.ok(room.reshuffle());
    const after = titles(room);
    assert.deepEqual(after.slice(0, 3), ['Song 1', 'Song 2', 'Song 3']);
    assert.deepEqual([...after.slice(3)].sort(), [...before.slice(3)].sort());
    assert.notDeepEqual(after, before, 'it did mix them');
    assert.equal(room.shuffle, false, 'the switch is not touched');
    // With shuffle off the new order is the order from now on: turning shuffle on and off does not undo it.
    room.setShuffle(true);
    room.setShuffle(false);
    assert.deepEqual(titles(room), after);
  });

  it('mixes again when shuffle is on, and has nothing to do with fewer than two to come', () => {
    const { room } = started(5, { random: sequence(0.2, 0.9, 0.4) });
    room.setShuffle(true);
    const once = titles(room);
    room.reshuffle();
    assert.notDeepEqual(titles(room), once);
    room.setShuffle(false);
    assert.deepEqual(titles(room), ['Song 1', 'Song 2', 'Song 3', 'Song 4', 'Song 5'], 'the original order is still what it goes back to');
    const small = started(2).room;
    assert.equal(small.reshuffle(), false);
  });

  it('puts a track right after the current one', () => {
    const { room, made } = started(5);
    assert.ok(room.playNext(made[4].id));
    assert.deepEqual(titles(room).slice(0, 3), ['Song 1', 'Song 5', 'Song 2']);
    assert.equal(room.playNext(made[0].id), false, 'the current track is already where it is');
    assert.equal(room.playNext('nope'), false);
  });

  it('removes a track, and the one that was current hands over to the one that follows it', () => {
    const { room, made } = started(3);
    assert.equal(room.remove(made[2].id).removed.id, made[2].id);
    const { wasCurrent } = room.remove(made[0].id);
    assert.ok(wasCurrent);
    assert.equal(room.status, 'idle');
    assert.equal(room.next(), made[1].id, 'what slid into its place');
    assert.equal(room.remove('nope').removed, null);
  });

  it('moves a track within the order, and clears', () => {
    const { room, made } = started(4);
    room.move(made[3].id, 1);
    assert.deepEqual(titles(room), ['Song 1', 'Song 4', 'Song 2', 'Song 3']);
    assert.equal(room.clear().length, 4);
    assert.ok(room.isEmpty);
    assert.equal(room.status, 'idle');
  });

  it('numbers every change, and gives listeners one snapshot of it all', () => {
    const { room } = started(2);
    const before = room.rev;
    room.setRepeat('all');
    assert.equal(room.rev, before + 1);
    const snap = room.snapshot();
    assert.equal(snap.status, 'playing');
    assert.equal(snap.startedAt, 1000);
    assert.equal(snap.repeat, 'all');
    assert.equal(snap.queue.length, 2);
    assert.equal(snap.queue[0].hash, 'h1');
    assert.equal(snap.current, snap.queue[0].id);
  });
});

// ----------------------------------------------------------------------------------------------------------- service
/** A clock and timers that move when told to. */
function clock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    /** Move time on, running whatever falls due, in order. */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        // Let what the timer started (a load) settle before the next one.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
      }
      now = target;
    },
    get pending() { return timers.size; },
  };
}

/** A library that "fetches" at once, remembering what is held. */
function fakeLibrary({ failing = [], slow = null, duration = 10_000 } = {}) {
  const held = new Map();
  const asked = [];
  return {
    held,
    asked,
    has: (hash) => Boolean(hash),
    hold: (hash) => held.set(hash, (held.get(hash) ?? 0) + 1),
    drop: (hash) => held.set(hash, (held.get(hash) ?? 0) - 1),
    async ensure(source) {
      asked.push(source);
      if (slow) await slow(source);
      if (failing.some((f) => source.includes(f))) throw new MusicError('failed', 'nope');
      return { hash: `hash-${source}`, durationMs: duration, title: '', artist: '' };
    },
  };
}

const settle = () => new Promise((r) => setImmediate(r));
const ana = { id: 1, nickname: 'ana' };

function rig(options = {}) {
  const time = clock();
  const sent = [];
  const library = options.library ?? fakeLibrary();
  const music = new Music({
    library, push: (channelId, payload) => sent.push({ channelId, ...payload }), ...time, ...options.music,
  });
  const last = (type = 'music:state') => sent.filter((m) => m.type === type).at(-1);
  return { time, sent, library, music, last };
}

describe('Music (the service)', () => {
  it('starts the music when the first track is added, once its file is there', async () => {
    const { music, last, time } = rig();
    assert.deepEqual(music.add(7, ana, [song(1), song(2)]), { ok: true, added: 2 });
    assert.equal(last().state.status, 'loading');
    await settle();
    const state = last().state;
    assert.equal(state.status, 'playing');
    assert.equal(state.startedAt, time.now());
    assert.equal(last().serverNow, time.now());
    assert.equal(state.queue.length, 2);
    assert.ok(state.queue[0].hash);
  });

  it('fetches the next tracks before they are wanted', async () => {
    const { music, library } = rig();
    music.add(7, ana, [song(1), song(2), song(3), song(4)]);
    await settle();
    await settle();
    assert.equal(library.asked.length, 3, 'the current one and the next two');
  });

  it('moves on by itself when a track ends, using the length it was fetched with', async () => {
    const { music, last, time } = rig();
    music.add(7, ana, [song(1), song(2)]);
    await settle();
    const first = last().state.current;
    await time.advance(9_000);
    assert.equal(last().state.current, first, 'not yet');
    await time.advance(2_000);
    await settle();
    assert.notEqual(last().state.current, first);
    assert.equal(last().state.status, 'playing');
  });

  it('stops after the last track, and starts again when something is added', async () => {
    const { music, last, time } = rig();
    music.add(7, ana, [song(1)]);
    await settle();
    await time.advance(11_000);
    await settle();
    assert.equal(last().state.status, 'idle');
    assert.equal(last().state.current, null);
    music.add(7, ana, [song(2)]);
    await settle();
    assert.equal(last().state.status, 'playing');
  });

  it('pause stops the end timer; resume sets it again for what is left', async () => {
    const { music, last, time } = rig();
    music.add(7, ana, [song(1), song(2)]);
    await settle();
    const first = last().state.current;
    await time.advance(4_000);
    music.control(7, 'pause');
    await time.advance(60_000);
    assert.equal(last().state.current, first, 'paused, so nothing ended');
    music.control(7, 'resume');
    await time.advance(5_000);
    assert.equal(last().state.current, first, '6 s were left, 5 passed');
    await time.advance(1_500);
    await settle();
    assert.notEqual(last().state.current, first);
  });

  it('passes over a track that cannot be fetched, and says so', async () => {
    const library = fakeLibrary({ failing: ['aaaaaaaaaa2'] });
    const { music, last, sent } = rig({ library });
    music.add(7, ana, [song(1), song(2), song(3)]);
    await settle();
    await settle();
    music.control(7, 'next');
    await settle();
    await settle();
    const error = sent.find((m) => m.type === 'music:error');
    assert.ok(error, 'told the channel');
    assert.equal(error.reason, 'failed');
    assert.equal(last().state.queue.find((t) => t.id === last().state.current).title, 'Song 3', 'went past it');
  });

  it('does not loop for ever when every track fails', async () => {
    const library = fakeLibrary({ failing: ['a'] });
    const { music, last } = rig({ library });
    music.add(7, ana, [song(1), song(2)]);
    music.control(7, 'repeat', { mode: 'all' });
    for (let i = 0; i < 10; i += 1) await settle();
    assert.equal(last().state.status, 'idle');
  });

  it('refuses sources that are not YouTube or Spotify ids, and a full queue', () => {
    const { music } = rig({ music: { maxQueue: 3 } });
    assert.equal(music.add(7, ana, [{ source: 'https://evil.example/x', title: 'x' }]).ok, false);
    assert.equal(music.add(7, ana, [{ source: 'yt:short' }]).error, 'nothing_to_add');
    assert.equal(music.add(7, ana, [song(1), song(2), song(3)]).ok, true);
    assert.equal(music.add(7, ana, [song(4)]).error, 'queue_full');
  });

  it('cleans what it is told about a track', async () => {
    const { music, last } = rig();
    music.add(7, ana, [{ source: 'yt:aaaaaaaaaaa', title: `  a\u0000 very\n bad ${'x'.repeat(400)}`, artist: 'A‮ B', durationMs: 'soon', thumbHash: '../../etc' }]);
    const [track] = last().state.queue;
    assert.ok(track.title.length <= 200);
    assert.ok(!/[\u0000\n‮]/.test(track.title + track.artist));
    assert.equal(track.thumbHash, null);
    assert.equal(track.durationMs, null, 'a length that is not a number is not believed');
    await settle();
    assert.equal(last().state.queue[0].durationMs, 10_000, 'the length it was fetched with is');
  });

  it('holds a file while a track that needs it is queued, and lets go when it leaves, when cleared, and when the room empties', async () => {
    const { music, library, last } = rig();
    music.add(7, ana, [song(1), song(2)]);
    await settle();
    await settle();
    const held = () => [...library.held.values()].reduce((a, b) => a + b, 0);
    assert.equal(held(), 2);
    const second = last().state.queue[1].id;
    music.control(7, 'remove', { id: second });
    assert.equal(held(), 1);
    music.add(8, ana, [song(5)]);
    await settle();
    assert.equal(held(), 2);
    music.onRoster(8, []);
    assert.equal(held(), 1, 'an emptied voice channel lets its files go');
    music.control(7, 'clear');
    assert.equal(held(), 0);
    assert.equal(music.snapshot(7), null);
  });

  it('gives a late joiner the state, and nothing for a channel with no music', async () => {
    const { music, time } = rig();
    assert.equal(music.snapshot(7), null);
    music.add(7, ana, [song(1)]);
    await settle();
    await time.advance(3000);
    const snap = music.snapshot(7);
    assert.equal(snap.state.status, 'playing');
    assert.equal(snap.serverNow, time.now());
  });

  it('removing the current track goes on to the next', async () => {
    const { music, last } = rig();
    music.add(7, ana, [song(1), song(2), song(3)]);
    await settle();
    music.control(7, 'remove', { id: last().state.current });
    await settle();
    assert.equal(last().state.queue.length, 2);
    assert.equal(last().state.queue.find((t) => t.id === last().state.current).title, 'Song 2');
  });

  it('controls: shuffle, repeat, move, play, seek, previous, and errors for what is not there', async () => {
    const { music, last } = rig();
    music.add(7, ana, [song(1), song(2), song(3)]);
    await settle();
    assert.equal(music.control(7, 'shuffle', { on: true }).ok, true);
    assert.equal(last().state.shuffle, true);
    assert.equal(music.control(7, 'repeat', { mode: 'all' }).ok, true);
    assert.equal(last().state.repeat, 'all');
    assert.equal(music.control(7, 'repeat', { mode: 'sometimes' }).error, 'bad_mode');
    assert.equal(music.control(7, 'play', { id: 'nope' }).error, 'no_such_track');
    assert.equal(music.control(7, 'dance').error, 'unknown_action');
    assert.equal(music.control(99, 'pause').error, 'nothing_playing');
    music.control(7, 'seek', { positionMs: 4000 });
    assert.ok(last().state.positionMs !== undefined);
    const target = last().state.queue.at(-1).id;
    music.control(7, 'play', { id: target });
    await settle();
    assert.equal(last().state.current, target);
    music.control(7, 'prev');
    await settle();
    assert.notEqual(last().state.current, target);
  });

  it('reshuffle and "play next" are controls like the rest', async () => {
    const { music, last } = rig({ music: { random: sequence(0.1, 0.8, 0.5, 0.3) } });
    music.add(7, ana, [song(1), song(2), song(3), song(4)]);
    await settle();
    const rev = last().state.rev;
    assert.equal(music.control(7, 'reshuffle').ok, true);
    assert.ok(last().state.rev > rev);
    assert.equal(last().state.queue[0].title, 'Song 1', 'the current one stays first');
    const target = last().state.queue.at(-1);
    assert.equal(music.control(7, 'next-up', { id: target.id }).ok, true);
    assert.equal(last().state.queue[1].id, target.id);
    assert.equal(music.control(7, 'next-up', { id: 'nope' }).error, 'no_such_track');
    assert.equal(rig().music.control(7, 'reshuffle').error, 'nothing_playing');
  });

  it('tells the channel where the music is every ten seconds while it plays, and not while it is paused', async () => {
    const { music, sent, time } = rig({ library: fakeLibrary({ duration: 120_000 }) });
    music.add(7, ana, [song(1, 120_000)]);
    await settle();
    const ticks = () => sent.filter((m) => m.type === 'music:tick');
    assert.equal(ticks().length, 0);
    await time.advance(10_100);
    assert.equal(ticks().length, 1);
    const tick = ticks()[0];
    assert.equal(tick.status, 'playing');
    assert.ok(tick.serverNow >= 1_010_000 - 1 && tick.serverNow <= time.now(), 'the server\'s clock when it was sent');
    assert.ok(tick.startedAt > 0 && tick.rev > 0);
    await time.advance(10_000);
    assert.equal(ticks().length, 2);
    music.control(7, 'pause');
    await time.advance(60_000);
    assert.equal(ticks().length, 2, 'silent while paused');
    music.control(7, 'resume');
    await time.advance(10_100);
    assert.equal(ticks().length, 3, 'and again once it plays');
  });

  it('stopAll ends every channel', async () => {
    const { music, library } = rig();
    music.add(7, ana, [song(1)]);
    music.add(8, ana, [song(2)]);
    await settle();
    music.stopAll();
    assert.equal(music.snapshot(7), null);
    assert.equal([...library.held.values()].reduce((a, b) => a + b, 0), 0);
  });
});

// ----------------------------------------------------------------------------------------------- yt-dlp and library
describe('YtDlp and MusicLibrary (against a fake yt-dlp)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harmony-music-'));
  const log = join(dir, 'calls.log');
  process.env.FAKE_LOG = log;
  const ytdlp = new YtDlp({ bin: FAKE, tmpDir: join(dir, 'tmp'), maxSeconds: 900 });
  const dataDir = ensureDataDir(join(dir, 'data'));
  const db = openDatabase({ dataDir });
  const chat = new Chat(db, { dataDir, maxDiskBytes: 64 * 1024 * 1024 });
  const library = new MusicLibrary({ db, chat, ytdlp, thumbnails: false });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

  it('reports its version, and that it can be told where a JavaScript runtime is', async () => {
    assert.equal(await ytdlp.version(), '2099.01.01');
    assert.equal(ytdlp.available, true);
  });

  it('is not available when there is no such program', async () => {
    const missing = new YtDlp({ bin: join(dir, 'nope'), tmpDir: join(dir, 'tmp2') });
    assert.equal(await missing.version(), null);
    assert.equal(missing.available, false);
    await assert.rejects(() => missing.search('x'), (e) => e instanceof MusicError && e.code === 'unavailable');
  });

  it('searches, with the words after "--" and never as an option', async () => {
    const items = await ytdlp.search('--exec boom', 5);
    assert.equal(items.length, 3);
    assert.equal(items[0].source, '01abcdefghi'.replace(/^/, 'yt:'));
    assert.equal(items[0].durationMs, 30_000);
    const call = calls().at(-1);
    const at = call.indexOf('--');
    assert.ok(at > 0 && call[at + 1] === 'ytsearch5:--exec boom');
    assert.ok(call.includes('--ignore-config'));
    assert.ok(call.includes('--js-runtimes'), 'Node is offered as the JavaScript runtime');
  });

  it('lists a playlist and reads a video, from ids it built the addresses of', async () => {
    const list = await ytdlp.playlist('PLabcdefghijklmnop', 50);
    assert.equal(list.length, 4);
    assert.ok(calls().at(-1).includes('https://www.youtube.com/playlist?list=PLabcdefghijklmnop'));
    const one = await ytdlp.video(V);
    assert.equal(one.source, `yt:${V}`);
    await assert.rejects(() => ytdlp.video('not an id; rm -rf'), (e) => e.code === 'bad_input');
    await assert.rejects(() => ytdlp.search('   '), (e) => e.code === 'bad_input');
  });

  it('fetches audio into a directory of its own, which done() removes', async () => {
    const got = await ytdlp.fetchAudio(V);
    assert.ok(existsSync(got.path) && got.path.endsWith('.webm'));
    assert.equal(got.durationMs, 30_000);
    assert.ok(got.bytes > 0);
    const call = calls().at(-1);
    assert.ok(call.includes('--max-filesize') && call.includes('--match-filter'));
    assert.equal(call[call.indexOf('--match-filter') + 1], 'duration<=900');
    got.done();
    assert.equal(existsSync(got.path), false);
  });

  it('allows four hours by default, with a file size to fit and time to download it', async () => {
    const long = new YtDlp({ bin: FAKE, tmpDir: join(dir, 'tmp-long') });
    const got = await long.fetchAudio(V);
    const call = calls().at(-1);
    assert.equal(call[call.indexOf('--match-filter') + 1], 'duration<=14400');
    assert.equal(call[call.indexOf('--max-filesize') + 1], '481M');
    got.done();
  });

  it('says what went wrong: too long, unavailable', async () => {
    await assert.rejects(() => ytdlp.fetchAudio('longlonglon'), (e) => e.code === 'too_long');
    await assert.rejects(() => ytdlp.fetchAudio('badbadbadba'), (e) => e instanceof MusicError && e.code === 'failed');
  });

  it('keeps a fetched track as an upload, finds it again without fetching, and fetches once for two askers', async () => {
    const before = calls().filter((c) => c.includes('--print-json')).length;
    const [a, b] = await Promise.all([library.ensure('yt:AAAAAAAAAAA'), library.ensure('yt:AAAAAAAAAAA')]);
    assert.equal(a.hash, b.hash);
    assert.equal(calls().filter((c) => c.includes('--print-json')).length, before + 1, 'one download');
    assert.ok(chat.fileInfo(a.hash));
    assert.equal(chat.fileInfo(a.hash).content_type, 'audio/webm');
    const again = await library.ensure('yt:AAAAAAAAAAA');
    assert.equal(again.hash, a.hash);
    assert.equal(calls().filter((c) => c.includes('--print-json')).length, before + 1, 'still one');
    assert.equal(again.durationMs, 30_000);
  });

  it('does not keep a track there is no room for, and says so', async () => {
    // A server of its own, with a disk of one byte: nothing the fake serves is in it already.
    const tightDir = ensureDataDir(join(dir, 'tight'));
    const tightDb = openDatabase({ dataDir: tightDir });
    const full = new MusicLibrary({ db: tightDb, chat: new Chat(tightDb, { dataDir: tightDir, maxDiskBytes: 1 }), ytdlp, thumbnails: false });
    await assert.rejects(() => full.ensure('yt:CCCCCCCCCCC'), (e) => e instanceof MusicError && e.code === 'server_full');
  });

  it('fetches again when the file was swept to make room', async () => {
    const { hash } = await library.ensure('yt:BBBBBBBBBBB');
    // Eviction takes unreferenced files; the way to have it is to take the file away.
    rmSync(chat.pathFor(hash));
    db.prepare('DELETE FROM uploads WHERE hash = ?').run(hash);
    const before = calls().filter((c) => c.includes('--print-json')).length;
    const fresh = await library.ensure('yt:BBBBBBBBBBB');
    assert.equal(calls().filter((c) => c.includes('--print-json')).length, before + 1);
    assert.ok(chat.fileInfo(fresh.hash));
  });

  it('refuses a source that is not a YouTube id', async () => {
    await assert.rejects(() => library.ensure('https://example.com/x'), (e) => e.code === 'bad_input');
    await assert.rejects(() => library.ensure('yt:../../etc'), (e) => e.code === 'bad_input');
  });

  it('holds and drops references on the file', async () => {
    const { hash } = await library.ensure('yt:CCCCCCCCCCC');
    const refs = () => db.prepare('SELECT refs FROM uploads WHERE hash = ?').get(hash).refs;
    const before = refs();
    library.hold(hash);
    assert.equal(refs(), before + 1);
    library.drop(hash);
    assert.equal(refs(), before);
  });

  it('empties its temporary directory when it starts', () => {
    writeFileSync(join(dir, 'tmp', 'left-behind'), 'x');
    new YtDlp({ bin: FAKE, tmpDir: join(dir, 'tmp') });
    assert.deepEqual(readdirSync(join(dir, 'tmp')), []);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------- Spotify
describe('Spotify', () => {
  it('reads the songs a playlist lists, with who made them and how long they are', () => {
    const tracks = tracksOfEntity(entityOf(fixture('spotify-playlist.html')));
    assert.equal(tracks.length, 3);
    assert.deepEqual(tracks[0], { spotifyId: '7bxaFZ1O3cHkgLKMsdC3xR', title: 'Loser', artist: 'Tame Impala', durationMs: 223069 });
  });

  it('reads a single track, with all its artists', () => {
    const tracks = tracksOfEntity(entityOf(fixture('spotify-track.html')));
    assert.deepEqual(tracks, [{ spotifyId: '4uLU6hMCjMI75M1A2tKUQC', title: 'Never Gonna Give You Up', artist: 'Rick Astley', durationMs: 213573 }]);
  });

  it('says so when the page is not the shape it reads, rather than guessing', () => {
    assert.equal(tracksOfEntity(entityOf(fixture('spotify-changed.html'))), null);
    assert.equal(entityOf('<html>no script here</html>'), null);
    assert.equal(entityOf('<script id="__NEXT_DATA__" type="application/json">{broken</script>'), null);
  });

  it('keeps no more than a hundred songs, and cleans what it is told about them', () => {
    const many = { trackList: Array.from({ length: 150 }, (_, i) => ({ uri: `spotify:track:${String(i).padStart(22, 'a')}`, title: `T${i}`, subtitle: 'A', duration: 1000 })) };
    assert.equal(tracksOfEntity(many).length, 100);
    const odd = tracksOfEntity({ trackList: [{ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa', title: `a\u0000 \u202e b ${'x'.repeat(500)}`, subtitle: 'A', duration: 'soon' }] });
    assert.ok(odd[0].title.length <= 200 && !/[\u0000\u202e]/.test(odd[0].title));
    assert.equal(odd[0].durationMs, null);
    // an entry that is not a track (an episode, say) is not listed
    assert.equal(tracksOfEntity({ trackList: [{ uri: 'spotify:episode:aaaaaaaaaaaaaaaaaaaaaa', title: 'x' }] }).length, 0);
  });

  it('matches a song to the YouTube result that is about as long as it, remembering the answer', async () => {
    let searches = 0;
    const ytdlp = {
      async search(query) {
        searches += 1;
        assert.equal(query, 'Rick Astley - Never Gonna Give You Up');
        return [
          { source: 'yt:aaaaaaaaaaa', durationMs: 600_000 }, // a ten-hour-ish loop
          { source: 'yt:bbbbbbbbbbb', durationMs: 214_000 }, // the song
          { source: 'yt:ccccccccccc', durationMs: 150_000 },
        ];
      },
    };
    const spotify = new Spotify({ ytdlp });
    const track = { source: 'sp:4uLU6hMCjMI75M1A2tKUQC', title: 'Never Gonna Give You Up', artist: 'Rick Astley', durationMs: 213_573 };
    assert.equal(await spotify.match(track), 'yt:bbbbbbbbbbb');
    assert.equal(await spotify.match(track), 'yt:bbbbbbbbbbb');
    assert.equal(searches, 1, 'asked once');
  });

  it('falls back to the nearest, then to the first, and to nothing when there is nothing', async () => {
    const answer = (results) => new Spotify({ ytdlp: { search: async () => results } });
    const song = { source: 'sp:aaaaaaaaaaaaaaaaaaaaaa', title: 'T', artist: 'A', durationMs: 200_000 };
    assert.equal(await answer([{ source: 'yt:one', durationMs: 10_000 }, { source: 'yt:two', durationMs: 240_000 }]).match(song), 'yt:two', 'within a quarter');
    assert.equal(await answer([{ source: 'yt:one', durationMs: 10_000 }, { source: 'yt:two', durationMs: 900_000 }]).match({ ...song, source: 'sp:bbbbbbbbbbbbbbbbbbbbbb' }), 'yt:one', 'else the first');
    assert.equal(await answer([]).match({ ...song, source: 'sp:cccccccccccccccccccccc' }), null);
  });

  it('refuses a kind or an id that is not Spotify\'s before it asks anybody anything', async () => {
    const spotify = new Spotify({ ytdlp: {} });
    await assert.rejects(() => spotify.tracksOf('show', 'aaaaaaaaaaaaaaaaaaaaaa'), (e) => e.code === 'bad_input');
    await assert.rejects(() => spotify.tracksOf('track', '../../etc'), (e) => e.code === 'bad_input');
  });
});
