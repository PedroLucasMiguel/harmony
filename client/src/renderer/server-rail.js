// The rail down the left edge: a bubble for private messages, a separator, one
// bubble for every saved server, and a "+" to add another.
//
// Only draws. What the bubbles mean -- which server is open, how many mentions
// wait on another -- is app.js's to say, and clicking one calls back; nothing
// here talks to a server.

import { createServerCard } from './server-card.js';

const SVG = 'http://www.w3.org/2000/svg';

/** A speech bubble, for private messages. */
function bubbleIcon() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-4.2 3.4a.6.6 0 0 1-1-.47V18A2 2 0 0 1 2 16V6a2 2 0 0 1 2-2z');
  svg.append(path);
  return svg;
}

const count = (n) => (n > 99 ? '99+' : String(n));

/**
 * @param {object} deps
 * @param {HTMLElement} deps.root
 * @param {(key: string, params?: object) => string} deps.t
 * @param {(node: HTMLElement, spec: object) => void} deps.fillBadge  a server's picture, or its initial
 * @param {(hash: string) => string} [deps.pictureUrl]  where a cached picture (a banner) is drawn from
 * @param {(url: string, person: object) => HTMLElement} [deps.faceFor]  somebody's picture on a server, for its card
 * @param {(url: string) => void} deps.onSelect  a server was chosen
 * @param {() => void} deps.onHome  private messages were chosen
 * @param {() => void} deps.onAdd  the "+" was pressed
 * @param {(url: string, event: MouseEvent) => void} [deps.onMenu]  a server was right-clicked
 * @param {(from: string, to: string, after: boolean) => void} [deps.onMove]  a server was dragged to a new place
 */
export function createServerRail({
  root, t, fillBadge, pictureUrl = () => '', faceFor = null, onSelect, onHome, onAdd, onMenu = () => {}, onMove = () => {},
}) {
  // What is shown when the pointer rests on a server, in place of the browser's own tooltip.
  const card = createServerCard({
    fillBadge, pictureUrl, root, faceFor, t,
  });
  /**
   * The server being moved, while it is: by address, where the press began, and what it is over.
   * @type {{url: string, button: HTMLElement, x: number, y: number, started: boolean, ghost: HTMLElement|null,
   *   over: HTMLElement|null, after: boolean, timer: number|null, pointerId: number, touch: boolean}|null}
   */
  let move = null;
  /** What the app asked to be drawn while a server was in the hand: it is drawn when it is let go. */
  let pending = null;
  /** How far the pointer goes before a press is a drag and not a click. */
  const DRAG_PX = 5;
  /** A finger has to rest this long on a bubble first, or every swipe along the rail would pick one up. */
  const HOLD_MS = 350;

  /**
   * @param {object} view
   * @param {boolean} view.homeCurrent
   * @param {number} view.homeUnread
   * @param {boolean} view.homeAvailable  private messages can be opened (a server is signed in)
   * @param {{url: string, name: string, logo: string|null, banner: string|null, current: boolean,
   *   state: 'up'|'offline'|'locked'|'connecting', unread: number, mentions: number,
   *   inCall: boolean, voice: boolean}[]} view.servers  `voice`: somebody is in one of its voice channels
   */
  function render(view = {}) {
    // The rail is drawn again by every change on any server (a message, somebody joining a call): taking the bubble
    // out from under a hand that is moving it ends the move. What there is to draw waits for it to be put down.
    if (move?.started) {
      pending = view;
      return;
    }
    pending = null;
    const {
      homeCurrent = false, homeUnread = 0, homeAvailable = true, servers = [],
    } = view;
    const home = document.createElement('button');
    home.type = 'button';
    home.className = 'rail-item rail-home';
    home.dataset.role = 'home';
    // The popover closes on a click anywhere but itself and its button; this is its button too.
    home.dataset.dmTrigger = '';
    home.title = homeUnread ? t('dm.open_unread', { count: homeUnread }) : t('rail.private_messages');
    home.setAttribute('aria-label', t('rail.private_messages'));
    if (homeCurrent) home.setAttribute('aria-current', 'true');
    home.disabled = !homeAvailable;
    home.append(bubbleIcon());
    if (homeUnread) {
      const badge = document.createElement('span');
      badge.className = 'rail-badge';
      badge.textContent = count(homeUnread);
      home.append(badge);
    }
    home.addEventListener('click', () => onHome());

    const separator = document.createElement('div');
    separator.className = 'rail-separator';
    separator.setAttribute('role', 'separator');

    /** @type {Map<string, {button: HTMLElement, info: object}>} */
    const cards = new Map();
    const items = servers.map((server) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rail-item';
      button.dataset.server = server.url;
      button.dataset.state = server.state;
      // No `title`: the card says it, and a browser tooltip beside it would say it twice.
      button.setAttribute('aria-label', server.name);
      if (server.current) button.setAttribute('aria-current', 'true');
      if (server.unread && !server.current) button.dataset.unread = '';
      if (server.inCall) button.dataset.inCall = '';
      // Somebody is talking on a server you are neither looking at nor in a call on.
      if (server.voice && !server.current && !server.inCall) {
        const voice = document.createElement('span');
        voice.className = 'rail-voice';
        voice.dataset.icon = 'speaker-high';
        voice.title = t('rail.voice_active');
        voice.setAttribute('aria-hidden', 'true');
        button.append(voice);
      }

      const face = document.createElement('span');
      face.className = 'server-badge';
      fillBadge(face, { name: server.name, logo: server.logo, dot: false });
      button.append(face);

      if (server.mentions && !server.current) {
        const badge = document.createElement('span');
        badge.className = 'rail-badge';
        badge.textContent = count(server.mentions);
        button.append(badge);
      } else if (server.state === 'locked') {
        const lock = document.createElement('span');
        lock.className = 'rail-badge rail-lock';
        lock.textContent = '!';
        lock.title = t('rail.sign_in_needed');
        button.append(lock);
      }
      button.addEventListener('click', () => onSelect(server.url));
      const info = {
        url: server.url, name: server.name, logo: server.logo, banner: server.banner ?? null, voicePeople: server.voicePeople ?? [],
      };
      card.attach(button, info);
      cards.set(server.url, { button, info });
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        onMenu(server.url, event);
      });

      // Moved by pressing and dragging, with a copy of it following the pointer and a bar where it will land. Not the
      // browser's drag-and-drop: that is cancelled by the rail being drawn again, takes the logo's picture for the
      // thing dragged, and shows nothing of where it will go.
      button.addEventListener('pointerdown', (event) => press(event, server.url, button));
      return button;
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'rail-item rail-add';
    add.title = t('rail.add_server');
    add.setAttribute('aria-label', t('rail.add_server'));
    // Drawn, not typed: a text plus sits wherever the font puts it, which is never the middle.
    // In a span of its own (the button's ::before is the mark that says which server is open),
    // and from two bars in CSS: the icon set's plus is a square with a plus cut out of it.
    const plus = document.createElement('span');
    plus.className = 'rail-plus';
    plus.setAttribute('aria-hidden', 'true');
    add.append(plus);
    add.addEventListener('click', () => onAdd());

    root.replaceChildren(home, separator, ...items, add);
    card.sync(cards);
  }

  // ------------------------------------------------------------------------------------------------ moving one

  const bubbles = () => [...root.querySelectorAll('.rail-item[data-server]')];

  function press(event, url, button) {
    if (move || (event.pointerType === 'mouse' && event.button !== 0)) return;
    move = {
      url, button, x: event.clientX, y: event.clientY, started: false, ghost: null, over: null, after: false, timer: null,
      pointerId: event.pointerId, touch: event.pointerType === 'touch',
    };
    // A finger: held a moment first (see HOLD_MS). Anything else: dragged a few pixels.
    if (move.touch) move.timer = window.setTimeout(() => { if (move && !move.started) begin(); }, HOLD_MS);
    document.addEventListener('pointermove', track, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', abandon, true);
    document.addEventListener('keydown', escape, true);
    document.addEventListener('touchmove', holdStill, { capture: true, passive: false });
  }

  /** A finger that has picked a bubble up moves it: the rail does not scroll under it. */
  const holdStill = (event) => {
    if (move?.started && event.cancelable) event.preventDefault();
  };

  function begin() {
    if (!move || move.started) return;
    move.started = true;
    window.clearTimeout(move.timer);
    // The bubble may have been drawn again since the press: the one there now is the one in the hand.
    move.button = bubbles().find((b) => b.dataset.server === move.url) ?? move.button;
    root.dataset.reordering = '';
    move.button.setAttribute('data-dragging', '');
    // A copy of the bubble, in the hand.
    const ghost = move.button.cloneNode(true);
    for (const name of ['data-server', 'data-state', 'data-dragging', 'aria-current', 'data-unread', 'data-in-call']) ghost.removeAttribute(name);
    ghost.removeAttribute('aria-label');
    ghost.classList.add('rail-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    document.body.append(ghost);
    move.ghost = ghost;
    card.close();
    document.body.style.userSelect = 'none';
  }

  function track(event) {
    if (!move || event.pointerId !== move.pointerId) return;
    if (!move.started) {
      if (move.touch) {
        // Moved before the hold was up: it is a swipe, not a pick-up.
        if (Math.hypot(event.clientX - move.x, event.clientY - move.y) > DRAG_PX * 2) stop(false);
        return;
      }
      if (Math.hypot(event.clientX - move.x, event.clientY - move.y) < DRAG_PX) return;
      begin();
    }
    event.preventDefault();
    move.ghost.style.transform = `translate(${event.clientX - 24}px, ${event.clientY - 24}px) scale(1.06)`;
    // The rail scrolls when there are more servers than room: near its edge, it follows the hand.
    const box = root.getBoundingClientRect();
    if (event.clientY < box.top + 28) root.scrollTop -= 8;
    else if (event.clientY > box.bottom - 28) root.scrollTop += 8;

    // The bubble the pointer is on, or the nearest in line with it: and which half of it.
    const others = bubbles().filter((b) => b.dataset.server !== move.url);
    let over = null;
    let best = Infinity;
    for (const b of others) {
      const r = b.getBoundingClientRect();
      const gap = event.clientY < r.top ? r.top - event.clientY : event.clientY > r.bottom ? event.clientY - r.bottom : 0;
      if (gap < best) {
        best = gap;
        over = b;
      }
    }
    const rect = over?.getBoundingClientRect();
    const after = rect ? event.clientY > rect.top + rect.height / 2 : false;
    if (over !== move.over || after !== move.after) {
      move.over?.removeAttribute('data-drop');
      over?.setAttribute('data-drop', after ? 'after' : 'before');
      move.over = over;
      move.after = after;
    }
  }

  function release(event) {
    if (!move || event.pointerId !== move.pointerId) return;
    if (!move.started) {
      stop(false);
      return;
    }
    // The click that ends this press is not a choice of server.
    event.preventDefault();
    stop(true);
  }

  const abandon = () => move && stop(false);
  const escape = (event) => {
    if (event.key === 'Escape' && move?.started) {
      event.stopPropagation();
      stop(false);
    }
  };

  /** Puts it down: where it is over, or back where it was. */
  function stop(drop) {
    const done = move;
    move = null;
    window.clearTimeout(done.timer);
    document.removeEventListener('pointermove', track, true);
    document.removeEventListener('pointerup', release, true);
    document.removeEventListener('pointercancel', abandon, true);
    document.removeEventListener('keydown', escape, true);
    document.removeEventListener('touchmove', holdStill, true);
    if (!done.started) return;
    delete root.dataset.reordering;
    document.body.style.userSelect = '';
    done.ghost?.remove();
    done.button.removeAttribute('data-dragging');
    done.over?.removeAttribute('data-drop');
    // Whatever click follows this release (on the bubble, or on the rail) belongs to the move, not to a server.
    const swallow = (event) => {
      event.stopPropagation();
      event.preventDefault();
    };
    document.addEventListener('click', swallow, { capture: true, once: true });
    window.setTimeout(() => document.removeEventListener('click', swallow, true), 0);
    if (drop && done.over) {
      pending = null;
      onMove(done.url, done.over.dataset.server, done.after);
    } else if (pending) {
      render(pending);
    }
  }

  return { render };
}
