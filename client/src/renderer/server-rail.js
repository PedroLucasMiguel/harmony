// The rail down the left edge: a bubble for private messages, a separator, one
// bubble for every saved server, and a "+" to add another.
//
// Only draws. What the bubbles mean -- which server is open, how many mentions
// wait on another -- is app.js's to say, and clicking one calls back; nothing
// here talks to a server.

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
 * @param {(url: string) => void} deps.onSelect  a server was chosen
 * @param {() => void} deps.onHome  private messages were chosen
 * @param {() => void} deps.onAdd  the "+" was pressed
 * @param {(url: string, event: MouseEvent) => void} [deps.onMenu]  a server was right-clicked
 * @param {(from: string, to: string, after: boolean) => void} [deps.onMove]  a server was dragged to a new place
 */
export function createServerRail({
  root, t, fillBadge, onSelect, onHome, onAdd, onMenu = () => {}, onMove = () => {},
}) {
  /** The server being dragged, by address. */
  let dragging = null;

  /**
   * @param {object} view
   * @param {boolean} view.homeCurrent
   * @param {number} view.homeUnread
   * @param {boolean} view.homeAvailable  private messages can be opened (a server is signed in)
   * @param {{url: string, name: string, logo: string|null, current: boolean,
   *   state: 'up'|'offline'|'locked'|'connecting', unread: number, mentions: number,
   *   inCall: boolean}[]} view.servers
   */
  function render({
    homeCurrent = false, homeUnread = 0, homeAvailable = true, servers = [],
  }) {
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

    const items = servers.map((server) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rail-item';
      button.dataset.server = server.url;
      button.dataset.state = server.state;
      button.title = server.name;
      button.setAttribute('aria-label', server.name);
      if (server.current) button.setAttribute('aria-current', 'true');
      if (server.unread && !server.current) button.dataset.unread = '';
      if (server.inCall) button.dataset.inCall = '';

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
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        onMenu(server.url, event);
      });

      // Dragged to where it should sit: a bar on the side it will land on says which.
      button.draggable = true;
      button.addEventListener('dragstart', (event) => {
        dragging = server.url;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', server.url);
      });
      button.addEventListener('dragend', () => {
        dragging = null;
        for (const other of root.querySelectorAll('[data-drop]')) other.removeAttribute('data-drop');
      });
      button.addEventListener('dragover', (event) => {
        if (dragging === null || dragging === server.url) return;
        event.preventDefault();
        const box = button.getBoundingClientRect();
        button.dataset.drop = event.clientY > box.top + box.height / 2 ? 'after' : 'before';
      });
      button.addEventListener('dragleave', () => button.removeAttribute('data-drop'));
      button.addEventListener('drop', (event) => {
        if (dragging === null || dragging === server.url) return;
        event.preventDefault();
        const after = button.dataset.drop === 'after';
        button.removeAttribute('data-drop');
        const from = dragging;
        dragging = null;
        onMove(from, server.url, after);
      });
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
  }

  return { render };
}
