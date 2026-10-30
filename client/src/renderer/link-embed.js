// A link in a message, shown as a card: the site, the title, what the page says
// about itself, and its picture -- the way Discord and WhatsApp show one.
//
// The server reads the page (see server/src/link-preview.js) and keeps the
// picture as a file, so what is drawn here is text and an image from the app's
// own media route: nothing is fetched from the site by this computer. A card is
// asked for when it is on screen, and a link that has been asked about is not
// asked about again.

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

  function draw(preview) {
    if (!preview || !slot.isConnected) return;
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
    card.dataset.layout = imageUrl ? 'large' : 'plain';
    if (/video/.test(preview.kind ?? '')) card.dataset.video = '';

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

    if (imageUrl) {
      const frame = link(preview.url, '');
      const img = document.createElement('img');
      img.className = 'link-embed-image';
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('load', () => {
        card.dataset.layout = isThumbnail(img) ? 'thumb' : 'large';
      });
      // A picture that will not load leaves the card as text, not a hole.
      img.addEventListener('error', () => {
        frame?.remove();
        card.dataset.layout = 'plain';
      });
      img.src = imageUrl;
      if (frame) {
        frame.className = 'link-embed-frame';
        frame.title = preview.url;
        frame.append(img);
        card.append(frame);
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
    const key = `${server}\n${url}`;
    if (!asked.has(key)) {
      asked.set(key, Promise.resolve().then(() => load(url)).then((answer) => answer?.preview ?? null).catch((err) => {
        // A server from before cards answers 404: it is not asked again.
        if (err?.status === 404) unsupported.add(server);
        // Busy: asked again the next time it is drawn.
        asked.delete(key);
        return null;
      }));
    }
    draw(await asked.get(key));
  }

  if (typeof IntersectionObserver === 'function') {
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
