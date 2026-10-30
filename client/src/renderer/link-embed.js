// A link in a message, shown as a card: the site, the title, what the page says
// about itself, and its picture -- the way Discord and WhatsApp show one.
//
// The server reads the page (see server/src/link-preview.js) and keeps the
// picture as a file, so what is drawn here is text and an image from the app's
// own media route: nothing is fetched from the site by this computer. A card is
// asked for when it is on screen, and a link that has been asked about is not
// asked about again.
//
// A YouTube card can also be played where it is: a button over its picture opens
// the player in a frame of the card. The frame is the one thing here that reaches
// the site, and it is made only when the button is pressed. It is kept through a
// redraw of the chat (see media-keep.js).

import { hasParkedFrame } from './media-keep.js';

/** The id of the video a YouTube address is about, or null for any other address. */
export function youtubeId(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const [, kind, rest] = url.pathname.split('/');
      if (['shorts', 'live', 'embed', 'v'].includes(kind)) id = rest;
    }
  }
  return /^[\w-]{11}$/.test(id ?? '') ? id : null;
}

/** Where the player is; the privacy-enhanced address, so nothing is stored for a video that is not played. */
const playerUrl = (id) => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`;

/** The first address in the words of a message, as it would be linked: the one that gets a card. */
export function firstLink(body) {
  // What is in backticks is code, and shown as written.
  const text = String(body ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const found = /https?:\/\/[^\s<>]+/.exec(text);
  if (!found) return null;
  // Not the full stop of the sentence, nor the bracket that closed it.
  const url = found[0].replace(/[.,;:!?)\]}'"*_~]+$/, '');
  return url.length > 'https://x'.length ? url : null;
}

/** What has been asked, by server and address, so scrolling past a message again is free. */
const asked = new Map();
/** What came back, by the same key: a card drawn again is drawn full at once, not empty and then filled. */
const known = new Map();
/** Servers that do not know how (older ones). */
const unsupported = new Set();

const DISMISSED_KEY = 'harmony.dismissedEmbeds';
const DISMISSED_KEPT = 500;

function dismissedSet() {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

function dismiss(key) {
  try {
    const kept = [...dismissedSet(), key].slice(-DISMISSED_KEPT);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(kept));
  } catch { /* the card is gone for this session at least */ }
}

/** A picture this wide and this squarish is a thumbnail beside the text; a wide one goes under it. */
const isThumbnail = (img) => img.naturalWidth < 300 || img.naturalWidth / Math.max(1, img.naturalHeight) < 1.4;

/** Replace the picture with the player. */
function play(frame, card, key, videoId, title) {
  const box = document.createElement('span');
  box.className = 'link-embed-player';
  const player = document.createElement('iframe');
  player.src = playerUrl(videoId);
  player.title = title || 'YouTube';
  player.dataset.keep = key;
  player.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  player.allowFullscreen = true;
  player.referrerPolicy = 'strict-origin-when-cross-origin';
  box.append(player);
  frame.replaceChildren(box);
  card.dataset.playing = '';
}

/** The place a frame that is being kept comes back to. */
function playerSlot(key) {
  const box = document.createElement('span');
  box.className = 'link-embed-player';
  box.dataset.keepSlot = key;
  return box;
}

/** The two buttons over a video's picture: play it here, or open it in the browser. */
function playActions({ videoId, preview, link, t, onPlay }) {
  const actions = document.createElement('span');
  actions.className = 'link-embed-actions';

  const here = document.createElement('button');
  here.type = 'button';
  here.className = 'link-embed-act';
  here.dataset.act = 'play';
  here.dataset.icon = 'play';
  here.title = t('embed.play');
  here.setAttribute('aria-label', t('embed.play'));
  here.addEventListener('click', (event) => {
    event.stopPropagation();
    onPlay();
  });
  actions.append(here);

  const away = link(`https://www.youtube.com/watch?v=${videoId}`, '') ?? link(preview.url, '');
  if (away) {
    away.className = 'link-embed-act';
    away.dataset.act = 'open';
    away.dataset.icon = 'arrow-square-out';
    away.title = t('embed.open');
    away.setAttribute('aria-label', t('embed.open'));
    actions.append(away);
  }
  return actions;
}

/**
 * @param {object} options
 * @param {string} options.server  whose server's cache this is
 * @param {number|string} options.messageId  which message it is under, for dismissing it
 * @param {string} options.url
 * @param {(url: string) => Promise<{preview: object|null}>} options.load
 * @param {(hash: string) => string} options.mediaUrl
 * @param {(href: string, label?: string) => HTMLAnchorElement|null} options.link  makes a link that opens in the browser
 * @param {(key: string) => string} options.t
 * @returns {HTMLElement|null} an empty slot that fills in when the card is known, or null for nothing to ask
 */
export function linkEmbed({ server, messageId, url, load, mediaUrl, link, t }) {
  if (unsupported.has(server)) return null;
  const dismissKey = `${server}#${messageId}`;
  if (dismissedSet().has(dismissKey)) return null;

  const slot = document.createElement('span');
  slot.className = 'link-embed-slot';

  const askKey = `${server}\n${url}`;

  function draw(preview) {
    if (!preview) return;
    const imageUrl = preview.imageHash ? mediaUrl(preview.imageHash) : '';

    // A link to a picture is the picture.
    if (preview.kind === 'image') {
      if (!imageUrl) return;
      const img = document.createElement('img');
      img.className = 'link-embed-picture';
      img.alt = '';
      img.loading = 'lazy';
      img.src = imageUrl;
      img.addEventListener('error', () => slot.replaceChildren());
      const a = link(preview.url, '');
      if (!a) return;
      a.className = 'link-embed-picture-link';
      a.title = preview.url;
      a.append(img);
      slot.replaceChildren(a);
      return;
    }

    const card = document.createElement('span');
    card.className = 'link-embed';
    if (preview.color) card.style.setProperty('--embed-color', preview.color);
    card.dataset.layout = imageUrl ? (known.get(askKey)?.layout ?? 'large') : 'plain';
    const videoId = youtubeId(preview.url);
    if (videoId) card.dataset.player = '';
    else if (/video/.test(preview.kind ?? '')) card.dataset.video = '';

    const text = document.createElement('span');
    text.className = 'link-embed-text';
    if (preview.site) {
      const site = document.createElement('span');
      site.className = 'link-embed-site';
      site.textContent = preview.site;
      text.append(site);
    }
    const title = link(preview.url, preview.title || preview.url);
    if (title) {
      title.className = 'link-embed-title';
      text.append(title);
    }
    if (preview.description) {
      const description = document.createElement('span');
      description.className = 'link-embed-description';
      description.textContent = preview.description;
      text.append(description);
    }
    card.append(text);

    if (imageUrl || videoId) {
      const frame = videoId ? document.createElement('span') : link(preview.url, '');
      const img = document.createElement('img');
      img.className = 'link-embed-image';
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('load', () => {
        card.dataset.layout = videoId ? 'large' : isThumbnail(img) ? 'thumb' : 'large';
        const kept = known.get(askKey);
        if (kept) kept.layout = card.dataset.layout;
      });
      // A picture that will not load leaves the card as text, not a hole.
      img.addEventListener('error', () => {
        if (videoId) return;
        frame?.remove();
        card.dataset.layout = 'plain';
      });
      if (imageUrl) img.src = imageUrl;
      if (frame) {
        frame.className = 'link-embed-frame';
        if (!videoId) frame.title = preview.url;
        if (imageUrl) frame.append(img);
        card.append(frame);
        if (videoId) {
          card.dataset.layout = 'large';
          if (hasParkedFrame(dismissKey)) {
            // Playing before the chat was drawn again: media-keep puts the same frame back here.
            frame.replaceChildren(playerSlot(dismissKey));
            card.dataset.playing = '';
          } else {
            frame.append(playActions({ videoId, preview, link, t, onPlay: () => play(frame, card, dismissKey, videoId, preview.title) }));
          }
        }
      }
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'link-embed-close';
    close.dataset.icon = 'x';
    close.title = t('embed.remove');
    close.setAttribute('aria-label', t('embed.remove'));
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      dismiss(dismissKey);
      slot.remove();
    });
    card.append(close);
    slot.replaceChildren(card);
  }

  async function ask() {
    const key = askKey;
    if (!asked.has(key)) {
      asked.set(key, Promise.resolve().then(() => load(url)).then((answer) => {
        const preview = answer?.preview ?? null;
        if (preview) known.set(key, { preview, layout: null });
        return preview;
      }).catch((err) => {
        // A server from before cards answers 404: it is not asked again.
        if (err?.status === 404) unsupported.add(server);
        // Busy: asked again the next time it is drawn.
        asked.delete(key);
        return null;
      }));
    }
    draw(await asked.get(key));
  }

  const already = known.get(askKey);
  if (already) {
    // Asked before: drawn at once, in the same run of script, so a redraw of the chat does not flicker.
    draw(already.preview);
  } else if (typeof IntersectionObserver === 'function') {
    const watcher = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      watcher.disconnect();
      ask();
    }, { rootMargin: '300px' });
    watcher.observe(slot);
  } else {
    queueMicrotask(ask);
  }
  return slot;
}
