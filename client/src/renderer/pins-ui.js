// What is pinned in a conversation, shown the way Discord shows it: the one pinned last in a strip under the header, and
// all of them in a panel from the pin in the header.
//
// For a text channel and for a private conversation alike: what differs is where the pins come from and what
// unpinning one does, and that comes in as the config. What a pinned message looks like does not differ -- it is
// drawn by the same function as in the log (config.messageContent), so a pin that carries a picture, a file, a
// link's card or some markdown shows them.

import { iconFor } from './attachment-card.js';

const $ = (id) => document.getElementById(id);

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * A small look at an attachment: its picture where it has one to show, or the icon of its kind of file (a zip, a
 * document, a video). Where the picture is not at hand yet it is the icon, and `showPicture` puts the picture in
 * when it is.
 */
export function attachmentThumb(name, mediaType, url = null) {
  const box = make('span', 'pin-thumb');
  const icon = () => {
    box.replaceChildren();
    const mark = make('span');
    mark.dataset.icon = iconFor(name, mediaType);
    mark.setAttribute('aria-hidden', 'true');
    box.append(mark);
  };
  box.showPicture = (src) => {
    const img = make('img');
    img.alt = '';
    img.addEventListener('error', icon, { once: true });
    img.src = src;
    box.replaceChildren(img);
  };
  if (url && mediaType === 'image') box.showPicture(url);
  else icon();
  return box;
}

/** A small button in a card's corner: an icon, with its words for whoever cannot see it. */
export function toolButton(icon, label, onClick) {
  const button = make('button', 'pin-tool pin-tool-icon');
  button.type = 'button';
  button.dataset.icon = icon;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  return button;
}

/**
 * One message as a card in a list -- who and when, the message as the log draws it, and a click that goes to it. The
 * pins use it, and so do the starred messages: a list of messages should look the same wherever it is.
 *
 * @param {object} card
 *   t            translate
 *   avatar       the author's picture, already made
 *   who          the author's name, already made (and in their font)
 *   createdAt    when it was written
 *   where        optional: where it was written (a channel, a conversation), after the time
 *   content      {text, emojiOnly}: the message, as messageContent makes it
 *   go           () => void: go to it in the log
 *   actions      more buttons for the corner, after Jump
 */
export function messageCard({ t, avatar, who, createdAt, where, content, go, actions = [] }) {
  const card = make('div', 'pin-card');
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.title = t('app.jump_to_this_message');

  const main = make('div', 'pin-main');
  const head = make('div', 'pin-head');
  head.append(who, make('span', 'pin-when', new Date(createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })));
  if (where) head.append(make('span', 'pin-where', where));

  // The message as it is in the log -- markdown, its file or picture, the card for its link -- in a `.chat-msg`
  // so that it is drawn by the same rules; not a row (see .pin-body), only the part of one that is the message.
  const body = make('div', 'chat-msg pin-body');
  if (content.emojiOnly) body.setAttribute('data-emoji-only', '');
  body.append(content.text);
  main.append(head, body);

  const jumpButton = make('button', 'pin-tool', t('app.jump'));
  jumpButton.type = 'button';
  jumpButton.addEventListener('click', go);
  const tools = make('div', 'pin-tools');
  tools.append(jumpButton, ...actions);

  card.append(avatar, main, tools);
  // A click on the card goes to the message, but not one on something in it that does its own thing -- a link,
  // the file, the player, a button -- and not the end of selecting some of its words.
  card.addEventListener('click', (event) => {
    if (event.target.closest('a, button, video, audio, input, .attachment, .link-embed, img.expandable')) return;
    if (String(window.getSelection?.() ?? '')) return;
    go();
  });
  card.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target === card) {
      event.preventDefault();
      go();
    }
  });
  return card;
}

/**
 * @param {object} config
 *   ids          the page's elements: button (the pin in the header), pop (the panel), list (inside it), strip
 *   t            translate
 *   displayOf, faceOf, avatarEl, nameFont   how the app draws a person
 *   whoOf        (message) => the name to show for its author (default: displayOf(userId, nickname))
 *   messageContent  (message) => {text, emojiOnly}: a message's words, file and link card, as the log draws them
 *   items        () => the pinned messages, the one pinned last first
 *   preview      optional (message) => a node to show before the words in the strip: what a pinned file looks like
 *   jump         (message) => Promise: go to it in the log
 *   unpin        (message) => Promise: let it go; whoever calls this is told, through `items`, when it has
 *   canUnpin     () => whether the person may let a pin go (default: yes); the button is only there if so
 *   onError      (error) => void: what to do when unpinning is refused
 */
export function createPins(config) {
  const {
    ids, t, displayOf, faceOf, avatarEl, nameFont, messageContent, items, jump, unpin, onError,
  } = config;
  const whoOf = config.whoOf ?? ((m) => displayOf(m.userId, m.nickname));
  const button = $(ids.button);
  const pop = $(ids.pop);
  const list = $(ids.list);
  const strip = $(ids.strip);

  function renderList() {
    const cards = items().map((m) => {
      const who = make('strong', '', whoOf(m));
      nameFont(who, m.userId);
      const go = () => {
        close();
        jump(m);
      };
      const actions = [];
      if (config.canUnpin?.() ?? true) {
        actions.push(toolButton('x', t('app.unpin'), async () => {
          try {
            // Everyone is told; the list is drawn again from that.
            await unpin(m);
          } catch (err) {
            onError?.(err);
          }
        }));
      }
      return messageCard({
        t, avatar: avatarEl(faceOf(m.userId, m.nickname), 'msg-avatar'), who, createdAt: m.createdAt,
        content: messageContent(m), go, actions,
      });
    });
    if (!cards.length) cards.push(make('p', 'pins-empty muted', t('app.no_pinned_messages')));
    list.replaceChildren(...cards);
  }

  /** Only the one pinned last is held up here; the others are a click away, in the panel. */
  function drawStrip() {
    const pinned = items();
    if (!pinned.length) {
      strip.hidden = true;
      return;
    }
    const [latest, ...others] = pinned;
    strip.hidden = false;
    const line = make('button', 'pinned-line');
    line.type = 'button';
    line.title = t('app.jump_to_this_message');
    const look = latest.attachmentHash || latest.private?.file ? config.preview?.(latest) : null;
    if (look) line.append(look);
    line.append(make('strong', '', whoOf(latest)), make('span', '', latest.body || latest.attachmentName || t('app.attachment_2')));
    line.addEventListener('click', () => jump(latest));
    const nodes = [line];
    if (others.length) {
      const more = make('button', 'ghost small pinned-more', t('app.all_pinned', { count: pinned.length }));
      more.type = 'button';
      more.addEventListener('click', () => open(more));
      nodes.push(more);
    }
    strip.replaceChildren(...nodes);
  }

  function open(anchor = button) {
    renderList();
    pop.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.toggleAttribute('data-on', true);
    // Under the pin in the header, its right edge to the pin's; as wide as the window allows, on a phone.
    const box = button.getBoundingClientRect();
    const from = anchor.getBoundingClientRect();
    const top = Math.max(box.bottom, from.bottom) + 6;
    pop.style.top = `${top}px`;
    pop.style.maxHeight = `${Math.max(160, window.innerHeight - top - 12)}px`;
    pop.style.right = `${Math.max(8, window.innerWidth - box.right)}px`;
    list.scrollTop = 0;
  }

  function close() {
    if (pop.hidden) return;
    pop.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.toggleAttribute('data-on', false);
  }

  button.addEventListener('click', () => (pop.hidden ? open() : close()));
  // The panel is a whole screen on a phone, with no outside to press: this is its way out.
  pop.querySelector('.pins-close')?.addEventListener('click', close);
  document.addEventListener('pointerdown', (event) => {
    if (pop.hidden) return;
    if (pop.contains(event.target) || button.contains(event.target) || strip.contains(event.target)) return;
    close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !pop.hidden && !event.defaultPrevented) close();
  });

  return {
    /** The strip, and the panel if it is open, drawn again from what is pinned now. */
    draw() {
      drawStrip();
      if (!pop.hidden) renderList();
    },
    open,
    close,
    /** Nothing pinned shown: the conversation is none, or has gone. */
    clear() {
      close();
      strip.hidden = true;
    },
  };
}
