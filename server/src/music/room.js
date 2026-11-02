// The music of one voice channel: what is queued, what is playing and how far into it, whether the order is shuffled
// and whether it repeats.
//
// Only state, and only arithmetic on it: no timers, no network, no files. Whatever has to wait for something
// (fetching a track, the end of one) is the service's job (service.js), which calls in here and pushes what comes out.
// That keeps every rule below -- shuffle keeping the current track, repeat wrapping, what Previous does -- testable with
// plain numbers for the clock.
//
// A client never decides anything. It is told where in a track the music is by two numbers, `startedAt` (the server's
// clock when the track was at 0:00) and `positionMs` (where it stopped, while paused), and works its own position out
// from them.

export const REPEAT_MODES = ['off', 'all', 'one'];

/** Pressing Previous later than this into a track starts it again instead of going back one. */
export const RESTART_AFTER_MS = 3000;

/** Fisher-Yates, with the randomness passed in so a test can say what "random" was. */
function shuffled(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class MusicRoom {
  /** Every track that was added, in the order it was added: what turning shuffle off goes back to. */
  #queue = [];
  /** Ids, in the order they will be played. Equal to the queue's order unless shuffled or moved. */
  #order = [];
  #current = null;
  #status = 'idle';
  #startedAt = 0;
  #positionMs = 0;
  #shuffle = false;
  #repeat = 'off';
  #rev = 0;
  #serial = 0;
  /** Where the current track was in the order when it was removed, so that next() starts from that slot. */
  #removedAt = -1;
  #random;

  constructor({ random = Math.random } = {}) {
    this.#random = random;
  }

  // ------------------------------------------------------------------------------------------------------- reading

  get status() { return this.#status; }
  get shuffle() { return this.#shuffle; }
  get repeat() { return this.#repeat; }
  get rev() { return this.#rev; }
  get size() { return this.#queue.length; }
  get current() { return this.#current ? this.track(this.#current) : null; }
  get isEmpty() { return this.#queue.length === 0; }

  track(id) {
    return this.#queue.find((t) => t.id === id) ?? null;
  }

  /** Tracks in the order they will be played. */
  get tracks() {
    return this.#order.map((id) => this.track(id));
  }

  /** How far into the current track the music is, in ms. */
  elapsedMs(now) {
    if (this.#status === 'playing') return Math.max(0, now - this.#startedAt);
    if (this.#status === 'paused') return this.#positionMs;
    return 0;
  }

  /** Milliseconds until the current track ends, or null when nothing is running down. */
  remainingMs(now) {
    const track = this.current;
    if (this.#status !== 'playing' || !track?.durationMs) return null;
    return Math.max(0, track.durationMs - this.elapsedMs(now));
  }

  #cursor() {
    return this.#current ? this.#order.indexOf(this.#current) : -1;
  }

  #changed() {
    this.#rev += 1;
  }

  // ----------------------------------------------------------------------------------------------------- the queue

  /**
   * Put tracks in the queue.
   *
   * `next` puts them right after the current one; otherwise they go to the end -- or, when shuffled, to random places
   * among what has not been played, so adding to a shuffled queue does not leave the new songs for last.
   *
   * @param {object[]} items  `{source, title, artist, durationMs, thumbHash}`
   * @returns {object[]} the tracks as they are kept, with an id each
   */
  add(items, { next = false, addedBy = null } = {}) {
    const made = items.map((item) => ({
      id: `t${(this.#serial += 1)}`,
      source: item.source,
      title: item.title ?? '',
      artist: item.artist ?? '',
      durationMs: item.durationMs ?? null,
      thumbHash: item.thumbHash ?? null,
      addedBy,
      hash: null,
      gainDb: null,
      error: null,
    }));
    if (!made.length) return made;

    const after = this.#current ? this.#queue.findIndex((t) => t.id === this.#current) : -1;
    if (next && after >= 0) this.#queue.splice(after + 1, 0, ...made);
    else this.#queue.push(...made);

    const cursor = this.#cursor();
    if (next && cursor >= 0) {
      this.#order.splice(cursor + 1, 0, ...made.map((t) => t.id));
    } else if (this.#shuffle && cursor >= 0) {
      for (const track of made) {
        const at = cursor + 1 + Math.floor(this.#random() * (this.#order.length - cursor));
        this.#order.splice(at, 0, track.id);
      }
    } else {
      this.#order.push(...made.map((t) => t.id));
    }
    this.#changed();
    return made;
  }

  /**
   * Take a track out. Returns what the caller has to do about it: nothing, or "the current one went, play the next".
   * @returns {{removed: object|null, wasCurrent: boolean}}
   */
  remove(id) {
    const track = this.track(id);
    if (!track) return { removed: null, wasCurrent: false };
    const wasCurrent = this.#current === id;
    const cursor = this.#order.indexOf(id);
    this.#queue = this.#queue.filter((t) => t.id !== id);
    this.#order = this.#order.filter((x) => x !== id);
    if (wasCurrent) {
      // The slot it held is now the next one's: remembered so next() can pick it up.
      this.#current = null;
      this.#removedAt = cursor;
      this.#status = 'idle';
      this.#positionMs = 0;
    }
    this.#changed();
    return { removed: track, wasCurrent };
  }

  /** Move a track to a place in the order it will be played in. */
  move(id, toIndex) {
    const from = this.#order.indexOf(id);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(this.#order.length - 1, Math.trunc(toIndex)));
    if (to === from) return true;
    this.#order.splice(from, 1);
    this.#order.splice(to, 0, id);
    // Without shuffle the queue and the order are one list, so the queue follows.
    if (!this.#shuffle) this.#queue = this.#order.map((x) => this.track(x));
    this.#changed();
    return true;
  }

  /** Empty it all. Returns the tracks, for their files to be let go of. */
  clear() {
    const gone = this.#queue;
    this.#queue = [];
    this.#order = [];
    this.#current = null;
    this.#status = 'idle';
    this.#positionMs = 0;
    this.#removedAt = -1;
    this.#changed();
    return gone;
  }

  // --------------------------------------------------------------------------------------------------- the playing

  /** Start a track from its beginning. It is `loading` until its file is there (ready()). */
  play(id) {
    if (!this.track(id)) return false;
    this.#current = id;
    this.#status = 'loading';
    this.#positionMs = 0;
    this.#startedAt = 0;
    this.#removedAt = -1;
    this.#changed();
    return true;
  }

  /** The current track's file arrived: the clock starts. */
  ready(id, now, { hash, durationMs, gainDb } = {}) {
    const track = this.track(id);
    if (!track) return false;
    if (hash) track.hash = hash;
    if (typeof gainDb === 'number') track.gainDb = gainDb;
    if (durationMs) track.durationMs = durationMs;
    if (this.#current === id && this.#status === 'loading') {
      this.#status = 'playing';
      this.#startedAt = now;
      this.#positionMs = 0;
    }
    this.#changed();
    return true;
  }

  /** A track that could not be fetched. It stays in the list, marked, and the caller moves on. */
  fail(id, reason) {
    const track = this.track(id);
    if (!track) return false;
    track.error = reason;
    this.#changed();
    return true;
  }

  pause(now) {
    if (this.#status !== 'playing') return false;
    this.#positionMs = this.elapsedMs(now);
    this.#status = 'paused';
    this.#changed();
    return true;
  }

  resume(now) {
    if (this.#status !== 'paused') return false;
    this.#startedAt = now - this.#positionMs;
    this.#status = 'playing';
    this.#changed();
    return true;
  }

  seek(ms, now) {
    const track = this.current;
    if (!track || !['playing', 'paused'].includes(this.#status)) return false;
    const to = Math.max(0, Math.min(track.durationMs ? track.durationMs - 500 : Number.MAX_SAFE_INTEGER, Math.trunc(ms)));
    if (this.#status === 'playing') this.#startedAt = now - to;
    else this.#positionMs = to;
    this.#changed();
    return true;
  }

  /**
   * Which track follows the current one, without moving to it. `auto` is "the track ran out" (repeat-one repeats it),
   * as opposed to somebody pressing Next (which goes on).
   * @returns {string|null} an id, or null when the music ends here
   */
  upNext({ auto = false } = {}) {
    if (!this.#order.length) return null;
    if (this.#current && auto && this.#repeat === 'one') return this.#current;
    // With nothing current, the music starts at the top -- or at the slot of the track that was just taken out.
    const at = this.#current ? this.#cursor() + 1 : Math.max(0, this.#removedAt);
    if (at < this.#order.length) return this.#order[at];
    if (this.#repeat === 'all' || (this.#repeat === 'one' && !auto)) return this.#order[0];
    return null;
  }

  /** Go to the next track (see upNext). With none, the music stops. @returns {string|null} the id now current */
  next({ auto = false } = {}) {
    const id = this.upNext({ auto });
    if (id === null) {
      this.stop();
      return null;
    }
    // Wrapping round with shuffle on starts the new lap in a new order.
    if (this.#shuffle && this.#cursor() === this.#order.length - 1 && id === this.#order[0]) {
      this.#order = shuffled(this.#order, this.#random);
    }
    this.play(id);
    return id;
  }

  /** Nothing is playing any more; the queue is left as it is. */
  stop() {
    this.#current = null;
    this.#status = 'idle';
    this.#positionMs = 0;
    this.#removedAt = -1;
    this.#changed();
  }

  /** Previous: the start of this track if it has gone on a while, else the one before. */
  previous(now) {
    if (!this.#current) return null;
    if (this.elapsedMs(now) > RESTART_AFTER_MS) {
      this.play(this.#current);
      return this.#current;
    }
    const cursor = this.#cursor();
    const id = cursor > 0 ? this.#order[cursor - 1] : (this.#repeat === 'all' ? this.#order.at(-1) : this.#current);
    this.play(id);
    return id;
  }

  /**
   * Shuffle on or off.
   *
   * On: what was already played stays where it is, the current track stays current, and only what is still to come is
   * put in a new order. Off: the order is the one the songs were added in again, the current track keeping its place.
   */
  setShuffle(on) {
    on = Boolean(on);
    if (on === this.#shuffle) return false;
    this.#shuffle = on;
    if (on) {
      const cursor = this.#cursor();
      const head = this.#order.slice(0, cursor + 1);
      this.#order = [...head, ...shuffled(this.#order.slice(cursor + 1), this.#random)];
    } else {
      this.#order = this.#queue.map((t) => t.id);
    }
    this.#changed();
    return true;
  }

  /**
   * Mix what is still to come, again, now.
   *
   * What was played and the current track stay where they are. Unlike the shuffle switch this can be asked for any
   * number of times, and it works with shuffle off too: then the new order is simply the order from now on (there is no
   * "original" to go back to, as there is when shuffle is switched off).
   */
  reshuffle() {
    const cursor = this.#cursor();
    const tail = this.#order.slice(cursor + 1);
    if (tail.length < 2) return false;
    this.#order = [...this.#order.slice(0, cursor + 1), ...shuffled(tail, this.#random)];
    if (!this.#shuffle) this.#queue = this.#order.map((id) => this.track(id));
    this.#changed();
    return true;
  }

  /** Put a track right after the one playing, wherever it was. */
  playNext(id) {
    const from = this.#order.indexOf(id);
    if (from < 0 || id === this.#current) return false;
    this.#order.splice(from, 1);
    const at = this.#order.indexOf(this.#current) + 1;
    this.#order.splice(at, 0, id);
    if (!this.#shuffle) this.#queue = this.#order.map((x) => this.track(x));
    this.#changed();
    return true;
  }

  setRepeat(mode) {
    if (!REPEAT_MODES.includes(mode) || mode === this.#repeat) return false;
    this.#repeat = mode;
    this.#changed();
    return true;
  }

  /** Where the music is, and nothing else: what a heartbeat carries, so listeners can be set right without the queue. */
  clock() {
    return { rev: this.#rev, status: this.#status, startedAt: this.#startedAt, positionMs: this.#positionMs };
  }

  // ------------------------------------------------------------------------------------------------- what clients get

  /** Everything a listener needs, in the order the queue is played. */
  snapshot() {
    const view = (t) => ({
      id: t.id,
      source: t.source,
      title: t.title,
      artist: t.artist,
      durationMs: t.durationMs,
      thumbHash: t.thumbHash,
      addedBy: t.addedBy,
      hash: t.hash,
      gainDb: t.gainDb,
      error: t.error,
    });
    return {
      rev: this.#rev,
      status: this.#status,
      current: this.#current,
      startedAt: this.#startedAt,
      positionMs: this.#positionMs,
      shuffle: this.#shuffle,
      repeat: this.#repeat,
      queue: this.tracks.map(view),
    };
  }
}
