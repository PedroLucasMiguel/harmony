// Tracks, kept: fetched once, and found again by where they came from.
//
// A track is an ordinary upload (audio/webm), so it is served by the route every file is, cached by every client the way
// a soundpad clip is, and counted in the same disk quota. What this adds is the index from a source ("yt:<video id>") to
// the file, so a song somebody asks for twice is downloaded once, and the references that keep a queued track from being
// swept: a queue holds one on each of its files, and lets go when the track leaves it. A file nobody holds is a cache,
// and goes first when the disk needs the room, which is the rule uploads already live by.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { fetchLimited, sniffImage } from '../link-preview.js';
import { gainDbFor, measureFile } from './loudness.js';
import { MusicError } from './ytdlp.js';

const THUMB_BYTES = 256 * 1024;

/** Hash a file as it is read, never all of it in memory. */
function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export class MusicLibrary {
  #db;
  #chat;
  #ytdlp;
  #fetching = new Map();
  #measuring = Promise.resolve();
  #thumbs = new Map();
  #allowPrivate;
  #pictures;
  #q;

  /**
   * @param {object} deps
   * @param {import('node:sqlite').DatabaseSync} deps.db
   * @param {import('../chat.js').Chat} deps.chat
   * @param {import('./ytdlp.js').YtDlp} deps.ytdlp
   * @param {boolean} [deps.allowPrivate]  tests only: thumbnails from a fake internet
   * @param {boolean} [deps.thumbnails]    false: no pictures are fetched (tests, with no internet)
   */
  constructor({ db, chat, ytdlp, allowPrivate = false, thumbnails = true }) {
    this.#db = db;
    this.#chat = chat;
    this.#ytdlp = ytdlp;
    this.#allowPrivate = allowPrivate;
    this.#pictures = thumbnails;
    this.#q = {
      get: db.prepare('SELECT * FROM music_tracks WHERE source_key = ?'),
      put: db.prepare(`
        INSERT INTO music_tracks (source_key, file_hash, title, artist, duration_ms, thumb_hash, fetched_at,
          loudness_lufs, peak_db, loudness_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET file_hash = excluded.file_hash, title = excluded.title,
          artist = excluded.artist, duration_ms = excluded.duration_ms, thumb_hash = excluded.thumb_hash,
          fetched_at = excluded.fetched_at, loudness_lufs = excluded.loudness_lufs, peak_db = excluded.peak_db,
          loudness_at = excluded.loudness_at`),
      touch: db.prepare('UPDATE music_tracks SET fetched_at = ? WHERE source_key = ?'),
      loudness: db.prepare('UPDATE music_tracks SET loudness_lufs = ?, peak_db = ?, loudness_at = ? WHERE source_key = ?'),
    };
  }

  // ------------------------------------------------------------------------------------------------------- tracks

  /**
   * The file for a source, fetching it when it is not here.
   * @param {string} source  "yt:<video id>"
   * @returns {Promise<{hash: string, durationMs: number|null, title: string, artist: string}>}
   * @throws {MusicError}
   */
  ensure(source) {
    const id = /^yt:([\w-]{11})$/.exec(source)?.[1];
    if (!id) return Promise.reject(new MusicError('bad_input', 'not a source'));

    const row = this.#q.get.get(source);
    const file = row ? this.#chat.fileInfo(row.file_hash) : null;
    if (row && file) {
      this.#q.touch.run(Date.now(), source);
      const found = {
        hash: row.file_hash, durationMs: row.duration_ms, title: row.title, artist: row.artist, thumbHash: row.thumb_hash,
        gainDb: gainDbFor(row.loudness_lufs == null ? null : { lufs: row.loudness_lufs, peakDb: row.peak_db ?? -Infinity }),
      };
      if (row.loudness_at) return Promise.resolve(found);
      // A file from before tracks were measured: measured now, once.
      if (!this.#fetching.has(source)) {
        const job = this.#measure(file.path).then((loudness) => {
          this.#q.loudness.run(loudness?.lufs ?? null, Number.isFinite(loudness?.peakDb) ? loudness.peakDb : null, Date.now(), source);
          return { ...found, gainDb: gainDbFor(loudness) };
        }).finally(() => this.#fetching.delete(source));
        this.#fetching.set(source, job);
      }
      return this.#fetching.get(source);
    }
    // Two people queueing the same song at once is one download.
    if (!this.#fetching.has(source)) {
      const job = this.#fetch(source, id).finally(() => this.#fetching.delete(source));
      this.#fetching.set(source, job);
    }
    return this.#fetching.get(source);
  }

  /** One track measured at a time: it is work for the processor, and two at once only make both slower. */
  #measure(path) {
    const run = this.#measuring.then(() => measureFile(path));
    this.#measuring = run.catch(() => {});
    return run;
  }

  async #fetch(source, id) {
    const got = await this.#ytdlp.fetchAudio(id);
    try {
      const hash = await hashFile(got.path);
      const kept = this.#chat.adopt(got.path, { hash, bytes: got.bytes, claimedType: 'audio/webm' });
      if (!kept.ok) throw new MusicError('failed', 'could not keep the file');
      const thumbHash = await this.thumbnail(id);
      const loudness = await this.#measure(this.#chat.fileInfo(hash)?.path ?? got.path);
      this.#q.put.run(
        source, hash, got.title, got.artist, got.durationMs, thumbHash, Date.now(),
        loudness?.lufs ?? null, Number.isFinite(loudness?.peakDb) ? loudness.peakDb : null, Date.now(),
      );
      return { hash, durationMs: got.durationMs, title: got.title, artist: got.artist, thumbHash, gainDb: gainDbFor(loudness) };
    } finally {
      got.done();
    }
  }

  /** Whether a file is still here to be played. */
  has(hash) {
    return Boolean(hash && this.#chat.fileInfo(hash));
  }

  /** A queue takes hold of a file while a track in it points there. */
  hold(hash) {
    if (hash) this.#chat.retain(hash);
  }

  drop(hash) {
    if (hash) this.#chat.release(hash);
  }

  // ----------------------------------------------------------------------------------------------------- pictures

  /**
   * A video's picture, kept as an upload, or null when there is none to be had.
   *
   * The app cannot show a picture from YouTube itself (nothing but its own files may be drawn), so the server fetches
   * it once and hands out the file like any other. Not referenced by anything: it is the first kind of file swept.
   */
  async thumbnail(videoId) {
    if (!this.#pictures) return null;
    const known = this.#thumbs.get(videoId);
    if (known && this.#chat.fileInfo(known)) return known;
    try {
      const page = await fetchLimited(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`, {
        accept: 'image/*', maxBytes: THUMB_BYTES, allowPrivate: this.#allowPrivate,
      });
      if (page.status !== 200 || page.truncated || !sniffImage(page.body)) return null;
      const stored = this.#chat.store(page.body, sniffImage(page.body));
      if (!stored.ok) return null;
      this.#thumbs.set(videoId, stored.upload.hash);
      return stored.upload.hash;
    } catch {
      return null;
    }
  }

  /** Give a list of results their pictures, a few at a time. */
  async withThumbnails(items) {
    const out = [];
    for (let i = 0; i < items.length; i += 5) {
      const group = items.slice(i, i + 5);
      // eslint-disable-next-line no-await-in-loop
      const hashes = await Promise.all(group.map((item) => this.thumbnail(item.source.slice(3))));
      group.forEach((item, k) => out.push({ ...item, thumbHash: hashes[k] }));
    }
    return out;
  }
}
