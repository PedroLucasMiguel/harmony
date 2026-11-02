// Spotify links, for what they list: which songs, by whom, and how long.
//
// What a Spotify track IS cannot be played here (it is encrypted and tied to a Spotify account), so a Spotify link is
// only ever read for its list, and each song on it is then looked for on YouTube by artist and title -- when its turn
// comes, not for a whole playlist at once.
//
// The list comes from the page Spotify itself makes for embedding (open.spotify.com/embed/<kind>/<id>), which carries
// what it shows as JSON in a <script id="__NEXT_DATA__"> tag: no account, no key, nothing to set up. It is not an API
// and nothing promises it will stay the way it is: if Spotify changes that page, THIS FILE is the one place that has to
// follow (entityOf and tracksOfEntity), and the test beside it (music.test.js) holds a sample of what it reads. A page
// that does not look as expected is an error that says so, never a guess.
//
// It lists up to 100 songs of a playlist or an album; the page itself shows fewer for a long one.

import { fetchLimited } from '../link-preview.js';
import { isSpotifyId } from './classify.js';
import { MusicError } from './ytdlp.js';

const BASE = 'https://open.spotify.com';
const PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_TRACKS = 100;

/** How close a YouTube result's length has to be to the song's, as a fraction, to be taken for it. */
const CLOSE = 0.1;
const NEAR = 0.25;

const TRACK_URI = /^spotify:track:([A-Za-z0-9]{22})$/;

/** The JSON a page carries, or null. */
export function entityOf(html) {
  const match = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(String(html));
  if (!match) return null;
  try {
    return JSON.parse(match[1])?.props?.pageProps?.state?.data?.entity ?? null;
  } catch {
    return null;
  }
}

const text = (value, max) => String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const length = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? Math.round(Number(ms)) : null);

/** The songs an entity lists: one for a track, its list for a playlist or an album. */
export function tracksOfEntity(entity) {
  if (!entity) return null;
  if (Array.isArray(entity.trackList)) {
    return entity.trackList
      .map((t) => ({
        spotifyId: TRACK_URI.exec(String(t?.uri ?? ''))?.[1] ?? null,
        title: text(t?.title, 200),
        artist: text(t?.subtitle, 120),
        durationMs: length(t?.duration),
      }))
      .filter((t) => t.spotifyId && t.title)
      .slice(0, MAX_TRACKS);
  }
  if (entity.type === 'track' && isSpotifyId(entity.id)) {
    const artists = Array.isArray(entity.artists) ? entity.artists.map((a) => a?.name).filter(Boolean).join(', ') : '';
    const title = text(entity.title ?? entity.name, 200);
    return title ? [{ spotifyId: entity.id, title, artist: text(artists, 120), durationMs: length(entity.duration) }] : [];
  }
  return null;
}

/** A song, the way the queue knows it. */
const itemOf = (t) => ({ source: `sp:${t.spotifyId}`, title: t.title, artist: t.artist, durationMs: t.durationMs, thumbHash: null });

export class Spotify {
  #ytdlp;
  #base;
  #allowPrivate;
  #matches = new Map();

  /**
   * @param {object} options
   * @param {{search: (q: string, n: number) => Promise<object[]>}} options.ytdlp  finds the song on YouTube
   * @param {string} [options.base]          the site to read the pages from (a test points it at a fake)
   * @param {boolean} [options.allowPrivate] tests only: a fake site on this machine
   */
  constructor({ ytdlp, base = BASE, allowPrivate = false }) {
    this.#ytdlp = ytdlp;
    this.#base = base.replace(/\/+$/, '');
    this.#allowPrivate = allowPrivate;
  }

  /**
   * What a Spotify link lists, as queue items.
   * @param {'track'|'album'|'playlist'} kind
   * @param {string} id  22 letters and digits, checked here again
   * @returns {Promise<object[]>}
   * @throws {MusicError}
   */
  async tracksOf(kind, id) {
    if (!['track', 'album', 'playlist'].includes(kind) || !isSpotifyId(id)) throw new MusicError('bad_input', 'not a Spotify link');
    let page;
    try {
      page = await fetchLimited(`${this.#base}/embed/${kind}/${id}`, {
        accept: 'text/html', maxBytes: PAGE_BYTES, allowPrivate: this.#allowPrivate,
      });
    } catch {
      throw new MusicError('timeout', 'could not reach Spotify');
    }
    if (page.status === 404) throw new MusicError('failed', 'there is nothing at that Spotify link');
    if (page.status !== 200) throw new MusicError('failed', 'Spotify did not answer');
    const tracks = tracksOfEntity(entityOf(page.body.toString('utf8')));
    // null: the page is not the shape this reads. An empty list is a real answer (an empty playlist).
    if (tracks === null) throw new MusicError('spotify_changed', 'could not read that Spotify page');
    return tracks.map(itemOf);
  }

  /**
   * The YouTube video for a song: the first result about as long as the song, else the first one that is anywhere near,
   * else the top result. Remembered, so a song that comes round again is not looked for again.
   * @param {{source: string, title: string, artist: string, durationMs: number|null}} track
   * @returns {Promise<string|null>} "yt:<id>"
   */
  async match(track) {
    const known = this.#matches.get(track.source);
    if (known) return known;
    const found = await this.#ytdlp.search(`${track.artist} - ${track.title}`.trim(), 5);
    if (!found.length) return null;
    const near = (limit) => track.durationMs
      && found.find((r) => r.durationMs && Math.abs(r.durationMs - track.durationMs) / track.durationMs <= limit);
    const chosen = near(CLOSE) || near(NEAR) || found[0];
    this.#matches.set(track.source, chosen.source);
    // A small memory: the oldest forgotten first.
    if (this.#matches.size > 500) this.#matches.delete(this.#matches.keys().next().value);
    return chosen.source;
  }
}
