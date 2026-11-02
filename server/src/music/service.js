// Music Buddy, as the server runs it: one MusicRoom per voice channel that has music, and what has to happen around it.
//
//   - adding tracks, and starting the music when nothing was playing
//   - fetching a track's file (library.js) before its clock starts, and the next ones before they are wanted
//   - the end of a track: the server decides, with a timer, and starts the next -- listeners never do
//   - telling everyone in the channel what changed, as a whole snapshot each time (a client that missed one is right
//     again with the next, and one that joins gets the current one)
//   - letting go of everything when the last person leaves the voice channel
//
// Like the soundpad, no audio passes through here: every listener plays its own copy of the file. What is shared is the
// state, and the one fact that keeps it together: the server's clock when the track was at 0:00.

import { MusicRoom } from './room.js';

/** How many tracks ahead of the current one are fetched in advance. */
const PREFETCH = 2;

/**
 * How often a playing channel is told where the music is, in a few numbers. Nothing changes for a listener who is
 * already in the right place; one who has drifted (a stalled decode, a throttled background window, a clock that moved)
 * is put right within this long, and every client gets to measure its distance to the server's clock again.
 */
const BEAT_MS = 10_000;

/** A track ends a moment after its length says, so a client that is a hair behind has finished it too. */
const END_GRACE_MS = 150;

const SOURCE = /^(yt:[\w-]{11}|sp:[A-Za-z0-9]{22})$/;

const clean = (value, max) => String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export class Music {
  #library;
  #push;
  #notifyError;
  #spotify;
  #now;
  #setTimer;
  #clearTimer;
  #maxQueue;
  #random;
  #rooms = new Map();

  /**
   * @param {object} deps
   * @param {import('./library.js').MusicLibrary} deps.library
   * @param {(channelId: number, payload: object) => void} deps.push  to everyone in the voice channel
   * @param {{match: (track: object) => Promise<string|null>}|null} [deps.spotify]  a Spotify track's YouTube source
   */
  constructor({
    library, push, spotify = null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    maxQueue = 200, random = Math.random,
  }) {
    this.#library = library;
    this.#push = push;
    this.#spotify = spotify;
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#maxQueue = maxQueue;
    this.#random = random;
  }

  // ------------------------------------------------------------------------------------------------------ reading

  /** What a channel's music is, for the people in it; null when there is none. */
  snapshot(channelId) {
    const entry = this.#rooms.get(channelId);
    if (!entry || entry.room.isEmpty) return null;
    return { state: entry.room.snapshot(), serverNow: this.#now() };
  }

  #entry(channelId) {
    let entry = this.#rooms.get(channelId);
    if (!entry) {
      entry = { room: new MusicRoom({ random: this.#random }), timer: null, held: new Map() };
      this.#rooms.set(channelId, entry);
    }
    return entry;
  }

  #send(channelId) {
    const entry = this.#rooms.get(channelId);
    if (!entry) return;
    this.#push(channelId, { type: 'music:state', channelId, state: entry.room.snapshot(), serverNow: this.#now() });
  }

  #error(channelId, track, reason) {
    this.#push(channelId, {
      type: 'music:error', channelId, trackId: track.id, title: track.title, reason,
    });
  }

  // ------------------------------------------------------------------------------------------------------ queueing

  /**
   * Put tracks in a channel's queue, and start the music if nothing is playing.
   * @param {object[]} items  `{source, title, artist, durationMs, thumbHash}`, as the resolve route gave them
   * @returns {{ok: true, added: number}|{ok: false, error: string}}
   */
  add(channelId, user, items, { next = false } = {}) {
    if (!Array.isArray(items) || !items.length) return { ok: false, error: 'nothing_to_add' };
    const entry = this.#entry(channelId);
    if (entry.room.size + items.length > this.#maxQueue) {
      if (entry.room.isEmpty) this.#rooms.delete(channelId);
      return { ok: false, error: 'queue_full' };
    }
    const good = [];
    for (const item of items) {
      if (!SOURCE.test(String(item?.source ?? ''))) continue;
      const seconds = Number(item.durationMs);
      good.push({
        source: item.source,
        title: clean(item.title, 200),
        artist: clean(item.artist, 120),
        durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null,
        thumbHash: /^[0-9a-f]{64}$/.test(String(item.thumbHash ?? '')) && this.#library.has(item.thumbHash) ? item.thumbHash : null,
      });
    }
    if (!good.length) {
      if (entry.room.isEmpty) this.#rooms.delete(channelId);
      return { ok: false, error: 'nothing_to_add' };
    }
    const idle = !entry.room.current;
    const made = entry.room.add(good, { next, addedBy: user.nickname });
    if (idle) this.#begin(channelId, made[0].id);
    else {
      this.#send(channelId);
      this.#prefetch(channelId);
    }
    return { ok: true, added: made.length };
  }

  // ------------------------------------------------------------------------------------------------------ control

  /**
   * One of the controls. The caller has already checked that this person may.
   * @returns {{ok: true}|{ok: false, error: string}}
   */
  control(channelId, action, args = {}) {
    const entry = this.#rooms.get(channelId);
    if (!entry || entry.room.isEmpty) return { ok: false, error: 'nothing_playing' };
    const { room } = entry;
    const now = this.#now();

    switch (action) {
      case 'pause':
        if (room.pause(now)) { this.#disarm(entry); this.#send(channelId); }
        return { ok: true };
      case 'resume':
        if (room.status === 'idle' && !room.current) {
          const id = room.upNext();
          if (id) this.#begin(channelId, id);
        } else if (room.resume(now)) {
          this.#arm(channelId);
          this.#send(channelId);
        }
        return { ok: true };
      case 'next':
        this.#advance(channelId, { auto: false });
        return { ok: true };
      case 'prev': {
        const id = room.previous(now);
        if (id) this.#begin(channelId, id);
        return { ok: true };
      }
      case 'seek':
        if (room.seek(Number(args.positionMs), now)) { this.#arm(channelId); this.#send(channelId); }
        return { ok: true };
      case 'shuffle':
        room.setShuffle(Boolean(args.on));
        this.#send(channelId);
        this.#prefetch(channelId);
        return { ok: true };
      case 'reshuffle':
        if (!room.reshuffle()) return { ok: false, error: 'nothing_to_mix' };
        this.#send(channelId);
        this.#prefetch(channelId);
        return { ok: true };
      case 'next-up':
        if (!room.playNext(String(args.id))) return { ok: false, error: 'no_such_track' };
        this.#send(channelId);
        this.#prefetch(channelId);
        return { ok: true };
      case 'repeat':
        if (!room.setRepeat(String(args.mode))) return { ok: false, error: 'bad_mode' };
        this.#send(channelId);
        this.#prefetch(channelId);
        return { ok: true };
      case 'play':
        if (!room.track(String(args.id))) return { ok: false, error: 'no_such_track' };
        this.#begin(channelId, String(args.id));
        return { ok: true };
      case 'remove': {
        const { removed, wasCurrent } = room.remove(String(args.id));
        if (!removed) return { ok: false, error: 'no_such_track' };
        this.#drop(entry, removed.id);
        if (wasCurrent) {
          this.#disarm(entry);
          this.#advance(channelId, { auto: false });
        } else {
          this.#send(channelId);
          this.#prefetch(channelId);
        }
        return { ok: true };
      }
      case 'move':
        if (!room.move(String(args.id), Number(args.index))) return { ok: false, error: 'no_such_track' };
        this.#send(channelId);
        this.#prefetch(channelId);
        return { ok: true };
      case 'clear':
        this.#clear(channelId);
        return { ok: true };
      default:
        return { ok: false, error: 'unknown_action' };
    }
  }

  /** The voice channel's people changed: with nobody left, the music is over and its files are let go of. */
  onRoster(channelId, roster) {
    if (roster.length === 0) this.#end(channelId);
  }

  /** Every channel's music, ended: the server is going down, or the feature was switched off. */
  stopAll() {
    for (const channelId of [...this.#rooms.keys()]) this.#end(channelId);
  }

  // --------------------------------------------------------------------------------------------------------- inside

  /** Start a track from its beginning (harmless to say twice: next() and previous() have already said it). */
  #begin(channelId, id) {
    const entry = this.#rooms.get(channelId);
    if (!entry) return;
    entry.room.play(id);
    this.#disarm(entry);
    this.#send(channelId);
    this.#load(channelId, id);
    this.#prefetch(channelId);
  }

  /** Go on to the next playable track; the music stops when there is none. */
  #advance(channelId, { auto }) {
    const entry = this.#rooms.get(channelId);
    if (!entry) return;
    this.#disarm(entry);
    // A track that could not be fetched is passed over, and so is a lap of nothing but those.
    for (let tries = entry.room.size; tries >= 0; tries -= 1) {
      const id = entry.room.next({ auto });
      if (id === null) {
        this.#send(channelId);
        return;
      }
      if (!entry.room.track(id)?.error) {
        this.#send(channelId);
        this.#load(channelId, id);
        this.#prefetch(channelId);
        return;
      }
    }
    // A whole lap of tracks that could not be fetched: there is nothing to play.
    entry.room.stop();
    this.#send(channelId);
  }

  /** Make the file for a track ready, and start its clock when it is the one being played. */
  async #load(channelId, id) {
    const entry = this.#rooms.get(channelId);
    const track = entry?.room.track(id);
    if (!track) return;
    try {
      const got = track.hash && this.#library.has(track.hash) ? { hash: track.hash } : await this.#fetch(track);
      const live = this.#rooms.get(channelId);
      if (!live || !live.room.track(id)) {
        // Taken out while it was being fetched: nothing holds it now.
        return;
      }
      this.#hold(live, id, got.hash);
      const wasLoading = live.room.current?.id === id && live.room.status === 'loading';
      live.room.ready(id, this.#now(), { hash: got.hash, durationMs: got.durationMs, gainDb: got.gainDb });
      if (got.title && !track.title) track.title = clean(got.title, 200);
      if (got.artist && !track.artist) track.artist = clean(got.artist, 120);
      if (got.thumbHash && !track.thumbHash) track.thumbHash = got.thumbHash;
      if (wasLoading) this.#arm(channelId);
      this.#send(channelId);
    } catch (err) {
      const live = this.#rooms.get(channelId);
      if (!live?.room.track(id)) return;
      live.room.fail(id, err?.code ?? 'failed');
      this.#error(channelId, track, err?.code ?? 'failed');
      if (live.room.current?.id === id) this.#advance(channelId, { auto: true });
      else this.#send(channelId);
    }
  }

  /** The file for a track's source; a Spotify one is looked for on YouTube first. */
  async #fetch(track) {
    let source = track.source;
    if (source.startsWith('sp:')) {
      if (!this.#spotify) throw Object.assign(new Error('no spotify'), { code: 'unsupported' });
      source = await this.#spotify.match(track);
      if (!source) throw Object.assign(new Error('no match'), { code: 'no_match' });
    }
    return this.#library.ensure(source);
  }

  /** Start the next ones fetching, so that a track is already here when its turn comes. */
  #prefetch(channelId) {
    const entry = this.#rooms.get(channelId);
    if (!entry) return;
    const tracks = entry.room.tracks;
    const at = entry.room.current ? tracks.findIndex((t) => t.id === entry.room.current.id) : -1;
    for (const track of tracks.slice(at + 1, at + 1 + PREFETCH)) {
      if (track && !track.hash && !track.error && !entry.loading?.has(track.id)) {
        entry.loading ??= new Set();
        entry.loading.add(track.id);
        this.#load(channelId, track.id).finally(() => entry.loading?.delete(track.id));
      }
    }
  }

  /** Arrange for the current track's end. */
  #arm(channelId) {
    const entry = this.#rooms.get(channelId);
    if (!entry) return;
    this.#disarm(entry);
    const ms = entry.room.remainingMs(this.#now());
    const id = entry.room.current?.id;
    if (entry.room.status === 'playing') this.#beat(entry, channelId);
    if (ms === null || !id) return;
    entry.timer = this.#setTimer(() => {
      entry.timer = null;
      const live = this.#rooms.get(channelId);
      if (live?.room.current?.id === id && live.room.status === 'playing') this.#advance(channelId, { auto: true });
    }, ms + END_GRACE_MS);
    entry.timer?.unref?.();
  }

  /** The heartbeat: while the music plays, now and then, where it is. */
  #beat(entry, channelId) {
    entry.beat = this.#setTimer(() => {
      entry.beat = null;
      if (this.#rooms.get(channelId) !== entry || entry.room.status !== 'playing') return;
      this.#push(channelId, { type: 'music:tick', channelId, ...entry.room.clock(), serverNow: this.#now() });
      this.#beat(entry, channelId);
    }, BEAT_MS);
    entry.beat?.unref?.();
  }

  #disarm(entry) {
    if (entry.timer) this.#clearTimer(entry.timer);
    entry.timer = null;
    if (entry.beat) this.#clearTimer(entry.beat);
    entry.beat = null;
  }

  /** The server's clock, for a client measuring how far away it is. */
  now() {
    return this.#now();
  }

  // ------------------------------------------------------------------------------------------------------ references

  #hold(entry, trackId, hash) {
    if (!hash || entry.held.has(trackId)) return;
    this.#library.hold(hash);
    entry.held.set(trackId, hash);
  }

  #drop(entry, trackId) {
    const hash = entry.held.get(trackId);
    if (!hash) return;
    entry.held.delete(trackId);
    this.#library.drop(hash);
  }

  #clear(channelId) {
    const entry = this.#rooms.get(channelId);
    if (!entry) return;
    this.#disarm(entry);
    for (const track of entry.room.clear()) this.#drop(entry, track.id);
    this.#send(channelId);
    this.#rooms.delete(channelId);
  }

  #end(channelId) {
    const entry = this.#rooms.get(channelId);
    if (!entry) return;
    this.#disarm(entry);
    for (const trackId of [...entry.held.keys()]) this.#drop(entry, trackId);
    this.#rooms.delete(channelId);
  }
}
