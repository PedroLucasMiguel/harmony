// What a link in a message looks like when it is shown as a card: the site, the
// title, a few lines of what the page says about itself, and its picture.
//
// The SERVER reads the page, not the person's computer. A client that fetched
// the link itself would show the site its address, and the page's picture would
// have to be let into the app from anywhere on the internet. Here the server asks
// once, keeps the answer, and keeps the picture as a file of its own: everybody
// is shown the same card, and nobody's address goes anywhere.
//
// Reading a page for a stranger is the kind of thing a server must be careful
// about, so what it will fetch is narrow: http and https, never an address
// inside a network (the check is on the address actually connected to, so a name
// that changes its answer cannot get past it), a few redirects, a few seconds, a
// few hundred kilobytes. See isBlockedAddress and fetchLimited.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

/** How much of a page is read: the head of it is all that holds what a card says. */
const PAGE_BYTES = 512 * 1024;
/** A picture bigger than this is not kept. */
const IMAGE_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 4;
/** How long an answer is kept, and how long a failure is (so a dead link is not asked again at every scroll). */
const KEEP_MS = 12 * 60 * 60 * 1000;
const KEEP_FAILURE_MS = 15 * 60 * 1000;
const CACHE_ENTRIES = 500;

const USER_AGENT = 'Mozilla/5.0 (compatible; HarmonyBot/1.0; link preview)';

// ---------------------------------------------------------------------------
// Which addresses are fair game
// ---------------------------------------------------------------------------

const v4 = (address) => address.split('.').map(Number);

function blockedV4(address) {
  const [a, b, c] = v4(address);
  return a === 0 // "this network"
    || a === 10
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || a === 127
    || (a === 169 && b === 254) // link-local, and the cloud metadata address
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224; // multicast and what is reserved
}

/** Whether an address is one inside somebody's network, which a link preview has no business reading. */
export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return blockedV4(address);
  if (family !== 6) return true;

  const lower = address.toLowerCase();
  // ::ffff:a.b.c.d -- an IPv4 address in an IPv6 coat, in either spelling.
  const mapped = /^(?:0{0,4}:){0,5}ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return blockedV4(mapped[1]);
  const mappedHex = /^(?:0{0,4}:){0,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return blockedV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return lower === '::' || lower === '::1'
    || /^f[cd]/.test(lower) // unique local
    || /^fe[89ab]/.test(lower) // link-local
    || lower.startsWith('ff') // multicast
    || lower.startsWith('64:ff9b:') // NAT64: reaches IPv4 hosts by another door
    || lower.startsWith('2001:db8') // documentation
    || lower.startsWith('100:'); // discard
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/** Resolve a name, and refuse to connect to anything that points into a network. */
function guardedLookup(allowPrivate) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      const allowed = allowPrivate ? addresses : addresses.filter((a) => !isBlockedAddress(a.address));
      if (!allowed.length) return callback(Object.assign(new Error('that address is not allowed'), { code: 'EBLOCKED' }));
      if (options?.all) return callback(null, allowed);
      return callback(null, allowed[0].address, allowed[0].family);
    });
  };
}

/** What one request answered. */
function once(url, { accept, maxBytes, allowPrivate }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return reject(new Error('not a web address'));
    if (target.username || target.password) return reject(new Error('an address with a password'));
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !allowPrivate && isBlockedAddress(host)) {
      return reject(Object.assign(new Error('that address is not allowed'), { code: 'EBLOCKED' }));
    }

    const client = target.protocol === 'https:' ? https : http;
    const request = client.request(target, {
      method: 'GET',
      lookup: guardedLookup(allowPrivate),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
        'Accept-Language': 'en-US,en;q=0.8,pt-BR;q=0.6',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ status, redirect: new URL(res.headers.location, target).href });
        return;
      }

      const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
      let stream = res;
      if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      let have = 0;
      let done = false;
      const finish = (truncated) => {
        if (done) return;
        done = true;
        request.destroy();
        resolve({
          status, url: target.href, headers: res.headers, body: Buffer.concat(chunks), truncated,
        });
      };
      // The size is what is read AFTER it is unpacked: a few kilobytes can be a few gigabytes.
      stream.on('data', (chunk) => {
        if (done) return;
        const room = maxBytes - have;
        chunks.push(room < chunk.length ? chunk.subarray(0, room) : chunk);
        have += Math.min(chunk.length, room);
        if (have >= maxBytes) finish(true);
      });
      stream.on('end', () => finish(false));
      stream.on('error', (err) => {
        if (done) return;
        done = true;
        reject(err);
      });
    });
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error('timed out')));
    request.on('error', reject);
    return request.end();
  });
}

/**
 * Read a URL, following a few redirects, up to a number of bytes.
 *
 * @returns {Promise<{status: number, url: string, headers: object, body: Buffer, truncated: boolean}>}
 */
export async function fetchLimited(url, { accept = '*/*', maxBytes = PAGE_BYTES, allowPrivate = false } = {}) {
  let next = url;
  const deadline = Date.now() + TIMEOUT_MS * 2;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
    if (Date.now() > deadline) throw new Error('timed out');
    // eslint-disable-next-line no-await-in-loop
    const result = await once(next, { accept, maxBytes, allowPrivate });
    if (!result.redirect) return result;
    next = result.redirect;
  }
  throw new Error('too many redirects');
}

// ---------------------------------------------------------------------------
// Reading a page
// ---------------------------------------------------------------------------

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', middot: '·',
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      try {
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      } catch {
        return whole;
      }
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const tidy = (text, max) => {
  const flat = decodeEntities(String(text ?? '')).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** The meta tags of a page's head, by their property or name, first one winning. */
function metaOf(html) {
  const head = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '');
  const found = new Map();
  for (const tag of head.matchAll(/<meta\b([^>]*)>/gi)) {
    const attributes = {};
    for (const a of tag[1].matchAll(ATTRIBUTE)) attributes[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    const key = (attributes.property ?? attributes.name ?? attributes.itemprop ?? '').toLowerCase();
    if (key && attributes.content !== undefined && !found.has(key)) found.set(key, attributes.content);
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  return { meta: found, title };
}

/**
 * What a card says, from a page's HTML. Plain strings only: whatever is in the
 * page is text to the client, never markup.
 *
 * @param {string} html
 * @param {string} pageUrl  where it came from, for the picture's address
 * @returns {{site: string, title: string, description: string, image: string|null, color: string|null, kind: string}|null}
 */
export function parseMeta(html, pageUrl) {
  const { meta, title: pageTitle } = metaOf(html.slice(0, PAGE_BYTES));
  const pick = (...keys) => keys.map((k) => meta.get(k)).find((v) => v && v.trim()) ?? '';

  const title = tidy(pick('og:title', 'twitter:title') || pageTitle, 200);
  const description = tidy(pick('og:description', 'twitter:description', 'description'), 400);
  let image = null;
  const rawImage = pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src').trim();
  if (rawImage) {
    try {
      const resolved = new URL(decodeEntities(rawImage), pageUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') image = resolved.href;
    } catch { /* not an address */ }
  }
  if (!title && !description && !image) return null;

  let host = '';
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch { /* none */ }
  const color = pick('theme-color').trim();
  return {
    site: tidy(pick('og:site_name', 'application-name') || host, 80),
    title,
    description,
    image,
    color: /^#[0-9a-f]{3,8}$/i.test(color) ? color.toLowerCase() : null,
    kind: tidy(pick('og:type'), 30).toLowerCase(),
  };
}

/** What kind of picture some bytes are, from their first bytes -- a server's say-so is not enough. */
export function sniffImage(bytes) {
  if (bytes.length > 12 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 6 && bytes.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** The first address in a message's words, the one that is shown as a card. */
export function normalise(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  url.hash = '';
  return url.href.length <= 2048 ? url.href : null;
}

export class LinkPreviews {
  #chat;
  #allowPrivate;
  #now;
  /** @type {Map<string, {at: number, preview: object|null}>} */
  #cache = new Map();
  /** @type {Map<string, Promise<object|null>>} */
  #asking = new Map();

  /**
   * @param {import('./chat.js').Chat} chat  where a card's picture is kept
   * @param {{allowPrivate?: boolean, now?: () => number}} [options]  `allowPrivate` is for tests, which read a page on this computer
   */
  constructor(chat, { allowPrivate = false, now = Date.now } = {}) {
    this.#chat = chat;
    this.#allowPrivate = allowPrivate;
    this.#now = now;
  }

  /**
   * The card for a link, or null if there is nothing to show.
   *
   * @returns {Promise<{url: string, site: string, title: string, description: string, imageHash: string|null, color: string|null, kind: string}|null>}
   */
  async get(raw) {
    const url = normalise(raw);
    if (!url) return null;

    const kept = this.#cache.get(url);
    if (kept) {
      const fresh = this.#now() - kept.at < (kept.preview ? KEEP_MS : KEEP_FAILURE_MS);
      // The picture is a file like any other and can be swept to make room: then the card is made again.
      const pictureGone = kept.preview?.imageHash && !this.#chat.fileInfo(kept.preview.imageHash);
      if (fresh && !pictureGone) {
        this.#cache.delete(url);
        this.#cache.set(url, kept);
        return kept.preview;
      }
    }
    const asking = this.#asking.get(url);
    if (asking) return asking;

    const job = this.#build(url).catch(() => null).then((preview) => {
      this.#cache.set(url, { at: this.#now(), preview });
      while (this.#cache.size > CACHE_ENTRIES) this.#cache.delete(this.#cache.keys().next().value);
      this.#asking.delete(url);
      return preview;
    });
    this.#asking.set(url, job);
    return job;
  }

  async #build(url) {
    const page = await fetchLimited(url, {
      accept: 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5',
      allowPrivate: this.#allowPrivate,
    });
    if (page.status < 200 || page.status >= 300) return null;
    const type = String(page.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

    // A link to a picture is the picture.
    if (type.startsWith('image/')) {
      const hash = page.truncated ? null : this.#keepImage(page.body);
      return hash ? {
        url, site: new URL(page.url).hostname.replace(/^www\./, ''), title: '', description: '', imageHash: hash, color: null, kind: 'image',
      } : null;
    }
    if (type && type !== 'text/html' && type !== 'application/xhtml+xml') return null;

    const meta = parseMeta(page.body.toString('utf8'), page.url);
    if (!meta) return null;
    let imageHash = null;
    if (meta.image) {
      try {
        const picture = await fetchLimited(meta.image, { accept: 'image/*', maxBytes: IMAGE_BYTES, allowPrivate: this.#allowPrivate });
        if (picture.status >= 200 && picture.status < 300 && !picture.truncated) imageHash = this.#keepImage(picture.body);
      } catch { /* a card without its picture is still a card */ }
    }
    return {
      url, site: meta.site, title: meta.title, description: meta.description, imageHash, color: meta.color, kind: meta.kind,
    };
  }

  /** Keep a picture as an upload. Not referenced by anything, so it is the first thing swept when room is needed. */
  #keepImage(bytes) {
    const type = sniffImage(bytes);
    if (!type || !bytes.length || bytes.length > IMAGE_BYTES) return null;
    const result = this.#chat.store(bytes, type);
    return result.ok ? result.upload.hash : null;
  }
}
