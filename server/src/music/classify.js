// What somebody typed into Music Buddy's box, told apart: a YouTube video or playlist, a Spotify track, album or
// playlist, or words to look for.
//
// This is the one place that decides what may reach yt-dlp, so it is strict. A link is accepted only from the
// handful of hosts below and only if the id in it has the exact shape of one; what goes on to yt-dlp is never the
// text that was typed but an address built here from that id (watchUrl, playlistUrl) or a search, and always after
// `--` so nothing typed can be taken for an option. Anything else that looks like a link is refused, which also
// keeps yt-dlp (it can read hundreds of sites) pointed at the two this feature is about.

const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be',
]);
const SPOTIFY_HOSTS = new Set(['open.spotify.com']);

const VIDEO_ID = /^[\w-]{11}$/;
const PLAYLIST_ID = /^[\w-]{10,64}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_KINDS = new Set(['track', 'album', 'playlist']);

/** The longest search that is passed on. */
export const MAX_QUERY = 120;

/** An address that is certainly YouTube's, from an id that has been checked. */
export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
export const playlistUrl = (id) => `https://www.youtube.com/playlist?list=${id}`;

export const isVideoId = (id) => typeof id === 'string' && VIDEO_ID.test(id);
export const isSpotifyId = (id) => typeof id === 'string' && SPOTIFY_ID.test(id);

const refused = (reason) => ({ kind: 'refused', reason });

/** Whether one word reads as an address, with or without its https://. */
const looksLikeAddress = (word) => /^(https?:\/\/|www\.)/i.test(word) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*/i.test(word);

function fromYoutube(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const list = url.searchParams.get('list');
  const listId = list && PLAYLIST_ID.test(list) ? list : null;

  if (url.hostname.endsWith('youtu.be')) {
    return isVideoId(parts[0]) ? { kind: 'youtube-video', id: parts[0], list: listId } : refused('bad_link');
  }
  if (parts[0] === 'playlist') {
    return listId ? { kind: 'youtube-playlist', id: listId } : refused('bad_link');
  }
  const v = url.searchParams.get('v');
  if (isVideoId(v)) return { kind: 'youtube-video', id: v, list: listId };
  if (['shorts', 'embed', 'live', 'v'].includes(parts[0]) && isVideoId(parts[1])) {
    return { kind: 'youtube-video', id: parts[1], list: listId };
  }
  return refused('bad_link');
}

function fromSpotify(url) {
  const parts = url.pathname.split('/').filter(Boolean);
  // /intl-pt/track/<id> and /embed/track/<id> are the same thing with a prefix.
  while (parts.length && (parts[0] === 'embed' || /^intl-[a-z-]+$/i.test(parts[0]))) parts.shift();
  const [kind, id] = parts;
  if (SPOTIFY_KINDS.has(kind) && isSpotifyId(id)) return { kind: `spotify-${kind}`, id };
  return refused('bad_link');
}

/**
 * @param {unknown} input
 * @returns {{kind: 'youtube-video', id: string, list: string|null}
 *   | {kind: 'youtube-playlist', id: string}
 *   | {kind: 'spotify-track'|'spotify-album'|'spotify-playlist', id: string}
 *   | {kind: 'search', query: string}
 *   | {kind: 'refused', reason: 'empty'|'bad_link'|'unsupported'}}
 */
export function classify(input) {
  const text = String(input ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return refused('empty');

  // spotify:track:<id>, as the app's "copy URI" gives it.
  const uri = /^spotify:(track|album|playlist):([A-Za-z0-9]+)$/i.exec(text);
  if (uri) return isSpotifyId(uri[2]) ? { kind: `spotify-${uri[1].toLowerCase()}`, id: uri[2] } : refused('bad_link');

  // Any other scheme (file:, ftp:, javascript:...) is a link that is not one of ours, not words to look for.
  if (!/\s/.test(text) && /^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return refused('unsupported');

  if (!/\s/.test(text) && looksLikeAddress(text)) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      return refused('bad_link');
    }
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return refused('bad_link');
    const host = url.hostname.toLowerCase();
    if (YOUTUBE_HOSTS.has(host)) return fromYoutube(url);
    if (SPOTIFY_HOSTS.has(host)) return fromSpotify(url);
    return refused('unsupported');
  }

  return { kind: 'search', query: text.slice(0, MAX_QUERY) };
}
