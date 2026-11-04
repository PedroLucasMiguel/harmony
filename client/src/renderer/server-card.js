// The card that opens when the pointer rests on a server in the rail: its picture, its name and, when its owner has
// set one, its banner. It says nothing the bubble does not already know -- it is the server's face, shown larger.
//
// The card never takes the pointer (it is not something to reach), so it is gone the moment the pointer leaves the
// bubble. The rail draws its buttons again whenever anything about a server changes, and the pointer is then over a
// new button: `sync` hands the card the new one, so that it stays up and follows what changed.

const OPEN_DELAY_MS = 450;
/** The gap between the bubble and the card. */
const GAP = 10;

/**
 * @param {object} deps
 * @param {(node: HTMLElement, spec: object) => void} deps.fillBadge  a server's picture, or its initial
 * @param {(hash: string) => string} deps.pictureUrl  where a cached picture is drawn from
 * @param {HTMLElement} deps.root  the rail: it is when this scrolls that the bubble moves from under the card
 * @param {(url: string, person: {userId: number, nickname: string}) => HTMLElement} [deps.faceFor]  somebody's picture on that server
 * @param {(key: string, values?: object) => string} [deps.t]
 */
export function createServerCard({
  fillBadge, pictureUrl, root, faceFor = null, t = (key) => key,
}) {
  /** How many faces the card shows before "and N more". */
  const MAX_FACES = 8;
  /** @type {{url: string, button: HTMLElement, card: HTMLElement}|null} */
  let shown = null;
  let waiting = null;

  function build(info) {
    const card = document.createElement('div');
    card.className = 'server-card';
    card.dataset.testid = 'server-card';
    card.setAttribute('role', 'tooltip');
    if (info.banner) {
      const banner = document.createElement('img');
      banner.className = 'server-card-banner';
      banner.alt = '';
      banner.src = pictureUrl(info.banner);
      // Not cached (yet): the card is as it is without one.
      banner.addEventListener('error', () => {
        banner.remove();
        card.removeAttribute('data-banner');
      });
      card.append(banner);
      card.dataset.banner = '';
    }
    const face = document.createElement('span');
    face.className = 'server-badge large server-card-icon';
    fillBadge(face, { name: info.name, logo: info.logo, dot: false });
    const name = document.createElement('strong');
    name.className = 'server-card-name';
    name.textContent = info.name;
    const row = document.createElement('div');
    row.className = 'server-card-head';
    row.append(face, name);
    card.append(row);
    // Who is in a voice channel there: their pictures, so a look at the server says whether anybody is about.
    if (faceFor && info.voicePeople?.length) {
      const voice = document.createElement('div');
      voice.className = 'server-card-voice';
      const label = document.createElement('span');
      label.className = 'server-card-voice-label';
      label.textContent = t('rail.card_in_voice');
      const faces = document.createElement('div');
      faces.className = 'server-card-faces';
      const seen = new Set();
      const people = info.voicePeople.filter((p) => (seen.has(p.userId) ? false : seen.add(p.userId)));
      for (const person of people.slice(0, MAX_FACES)) {
        const picture = faceFor(info.url, person);
        picture.title = person.nickname ?? '';
        faces.append(picture);
      }
      if (people.length > MAX_FACES) {
        const more = document.createElement('span');
        more.className = 'server-card-more';
        more.textContent = `+${people.length - MAX_FACES}`;
        faces.append(more);
      }
      voice.append(label, faces);
      card.append(voice);
    }
    return card;
  }

  function place(card, anchor) {
    const box = anchor.getBoundingClientRect();
    const own = card.getBoundingClientRect();
    const margin = 8;
    card.style.left = `${Math.round(box.right + GAP)}px`;
    const top = box.top + box.height / 2 - own.height / 2;
    card.style.top = `${Math.round(Math.min(Math.max(margin, top), window.innerHeight - own.height - margin))}px`;
  }

  function close() {
    clearTimeout(waiting);
    waiting = null;
    shown?.card.remove();
    shown = null;
  }

  function open(button, info) {
    close();
    const card = build(info);
    document.body.append(card);
    place(card, button);
    shown = { url: info.url, button, card };
  }

  /** Show the card for `button` when the pointer rests on it (or it is focused from the keyboard). */
  function attach(button, info) {
    button.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'touch') return;
      clearTimeout(waiting);
      // Still up for this server: the bubble was drawn again under the pointer.
      if (shown?.url === info.url) {
        shown.button = button;
        return;
      }
      waiting = setTimeout(() => open(button, info), OPEN_DELAY_MS);
    });
    button.addEventListener('pointerleave', () => {
      clearTimeout(waiting);
      if (shown?.url === info.url) close();
    });
    button.addEventListener('focus', () => {
      if (button.matches(':focus-visible')) open(button, info);
    });
    button.addEventListener('blur', () => {
      if (shown?.url === info.url) close();
    });
    // What the pointer does next is not for the card to be in the way of.
    for (const type of ['pointerdown', 'dragstart', 'contextmenu']) button.addEventListener(type, close);
  }

  /**
   * The rail drew its buttons again: the card follows the server it is for, with what is now known of it, or goes if
   * that server is gone.
   *
   * @param {Map<string, {button: HTMLElement, info: object}>} entries  by server address
   */
  function sync(entries) {
    if (!shown) return;
    const entry = entries.get(shown.url);
    if (!entry || !entry.button.isConnected) {
      close();
      return;
    }
    const card = build(entry.info);
    shown.card.replaceWith(card);
    shown = { url: shown.url, button: entry.button, card };
    place(card, entry.button);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  root.addEventListener('scroll', close);
  window.addEventListener('blur', close);

  return { attach, sync, close };
}
