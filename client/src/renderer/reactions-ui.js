// Who reacted: the card that opens when the pointer rests on a reaction under a message, and the window that lists
// everybody, an emoji at a time.
//
// The card says what the emoji is and who put it there -- the first few by name and, when there are more, a link to
// the rest ("and 12 others"); the link (or "See all reactions" when nobody is left out) opens the window. The window
// is also what a shift-click, or a long press on a touch screen, on a reaction opens: a plain click is still the
// reaction itself, put on or taken back.
//
// Both draw from the reactions as they are at the moment, asked for through a function, because the row a reaction
// sits in is built again by every reaction anybody adds.

import { currentLanguage } from './i18n.js';

/** How long the pointer rests on a reaction before the card opens, and how long it may leave before it closes. */
const OPEN_DELAY_MS = 280;
const CLOSE_DELAY_MS = 160;
/** How many people are named on the card before "and N others". */
const NAMED = 3;
/** A touch held this long on a reaction opens the window, as a shift-click does. */
const LONG_PRESS_MS = 500;
const OTHERS = '\u0000others\u0000';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The card open now, if any, so that a second one never stands beside it. */
let current = null;

/**
 * @param {object} deps
 * @param {Function} deps.t
 * @param {(userId: number, fallback?: string) => string} deps.displayOf
 * @param {(userId: number, fallback?: string) => object} deps.faceOf  what avatarEl draws a person from
 * @param {(face: object, className?: string) => HTMLElement} deps.avatarEl
 * @param {(node: HTMLElement, emoji: string) => void} deps.appendEmoji
 */
export function createReactionsUi({
  t, displayOf, faceOf, avatarEl, appendEmoji,
}) {
  const nameOf = (id) => displayOf(id, t('reactions.someone'));

  // -------------------------------------------------------------------- the window

  /**
   * Everybody who reacted, in a window: the emoji down the left with their counts, and who chose the one that is
   * picked on the right.
   *
   * @param {{emoji: string, count: number, userIds: number[]}[]} reactions
   * @param {string} [first]  the emoji to start on
   */
  function openAll(reactions, first) {
    closeCard();
    const list = reactions.filter((r) => (r.userIds?.length ?? 0) > 0);
    if (!list.length) return;
    const dialog = el('dialog', 'ask reactions-dialog');
    dialog.dataset.testid = 'reactions-dialog';
    let picked = list.find((r) => r.emoji === first)?.emoji ?? list[0].emoji;

    const head = el('header', 'reactions-head');
    head.append(el('h2', '', t('reactions.title')));
    const close = el('button', 'composer-btn', t('reactions.close'));
    close.type = 'button';
    close.dataset.icon = 'x';
    close.title = t('reactions.close');
    close.addEventListener('click', () => dialog.close());
    head.append(close);

    const tabs = el('div', 'reactions-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-orientation', 'vertical');
    const people = el('ul', 'reactions-people');
    people.dataset.testid = 'reactions-people';
    const body = el('div', 'reactions-body');
    body.append(tabs, people);

    function paint() {
      tabs.replaceChildren(...list.map((r) => {
        const tab = el('button', 'reactions-tab');
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(r.emoji === picked));
        tab.dataset.emoji = r.emoji;
        const glyph = el('span', 'reactions-glyph');
        appendEmoji(glyph, r.emoji);
        tab.append(glyph, el('span', 'reactions-count', String(r.userIds.length)));
        tab.addEventListener('click', () => {
          picked = r.emoji;
          paint();
          people.scrollTop = 0;
        });
        return tab;
      }));
      const shown = list.find((r) => r.emoji === picked) ?? list[0];
      people.replaceChildren(...shown.userIds.map((id) => {
        const li = el('li', 'reactions-person');
        const names = el('span', 'reactions-names');
        names.append(el('strong', '', nameOf(id)));
        const nick = faceOf(id, '')?.nickname;
        if (nick && nick !== nameOf(id)) names.append(el('small', 'muted', nick));
        li.append(avatarEl(faceOf(id, ''), 'reactions-avatar'), names);
        return li;
      }));
    }
    paint();

    dialog.append(head, body);
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    tabs.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------------- the card

  function closeCard() {
    if (!current) return;
    clearTimeout(current.timer);
    current.card?.remove();
    current = null;
  }

  /** The sentence on the card: "reacted by A, B, C and 12 others", the last a link to the window. */
  function sentence(reaction, open) {
    const ids = reaction.userIds ?? [];
    const named = ids.slice(0, NAMED).map(nameOf);
    const rest = ids.length - named.length;
    const items = rest > 0 ? [...named, OTHERS] : named;
    const parts = new Intl.ListFormat(currentLanguage(), { style: 'long', type: 'conjunction' }).formatToParts(items);
    const who = document.createDocumentFragment();
    for (const part of parts) {
      if (part.type === 'element' && part.value === OTHERS) {
        const link = el('button', 'reactions-others', t('reactions.others', { count: rest }));
        link.type = 'button';
        link.addEventListener('click', open);
        who.append(link);
      } else {
        who.append(part.value);
      }
    }
    const template = t('reactions.reacted_by', { who: OTHERS });
    const [before, after = ''] = template.split(OTHERS);
    const line = el('p', 'reactions-line');
    line.append(before, who, after);
    return line;
  }

  function place(card, anchor) {
    const box = anchor.getBoundingClientRect();
    const own = card.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(Math.max(margin, box.left + box.width / 2 - own.width / 2), window.innerWidth - own.width - margin);
    // Above the reaction, or below it when there is no room above.
    const above = box.top - own.height - 6;
    const top = above >= margin ? above : box.bottom + 6;
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  function openCard(chip, reactionOf, allOf) {
    const reaction = reactionOf();
    if (!reaction || !(reaction.userIds?.length ?? 0)) return;
    closeCard();
    const card = el('div', 'reactions-card');
    card.setAttribute('role', 'tooltip');
    card.dataset.testid = 'reactions-card';
    const glyph = el('span', 'reactions-card-emoji');
    appendEmoji(glyph, reaction.emoji);
    const text = el('div', 'reactions-card-text');
    const open = () => openAll(allOf().length ? allOf() : [reaction], reaction.emoji);
    text.append(sentence(reaction, open));
    // Nobody left out, so there is no "others" to click: the window is still one click away.
    if ((reaction.userIds.length ?? 0) <= NAMED) {
      const all = el('button', 'reactions-others reactions-all', t('reactions.view_all'));
      all.type = 'button';
      all.addEventListener('click', open);
      text.append(all);
    }
    card.append(glyph, text);
    current = { card, chip, timer: null };
    document.body.append(card);
    place(card, chip);
    // Over the card is still over the reaction, so that its link can be reached.
    card.addEventListener('pointerenter', () => clearTimeout(current?.timer));
    card.addEventListener('pointerleave', () => scheduleClose());
  }

  function scheduleClose() {
    if (!current) return;
    clearTimeout(current.timer);
    current.timer = setTimeout(closeCard, CLOSE_DELAY_MS);
  }

  /**
   * Make a reaction's button show the card when the pointer rests on it (or it is focused), and open the window for a
   * shift-click or a long press. A plain click is left to whoever drew the button.
   *
   * @param {HTMLElement} chip
   * @param {() => ({emoji: string, count: number, userIds: number[]}|undefined)} reactionOf  this reaction, now
   * @param {() => object[]} [allOf]  every reaction of the message, for the window
   */
  function attach(chip, reactionOf, allOf = () => []) {
    let waiting = null;
    chip.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'touch') return;
      clearTimeout(waiting);
      if (current?.chip === chip) {
        clearTimeout(current.timer);
        return;
      }
      waiting = setTimeout(() => openCard(chip, reactionOf, allOf), OPEN_DELAY_MS);
    });
    chip.addEventListener('pointerleave', () => {
      clearTimeout(waiting);
      if (current?.chip === chip) scheduleClose();
    });
    chip.addEventListener('focus', () => openCard(chip, reactionOf, allOf));
    chip.addEventListener('blur', () => scheduleClose());

    // Shift-click: the window, not the reaction. In the capture phase, so that the button's own click never runs.
    chip.addEventListener('click', (event) => {
      if (!event.shiftKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const reaction = reactionOf();
      if (reaction) openAll(allOf().length ? allOf() : [reaction], reaction.emoji);
    }, true);

    // A touch screen has no resting pointer: a long press is how it asks, and the click that follows is let go.
    let press = null;
    let longPressed = false;
    chip.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch') return;
      longPressed = false;
      press = setTimeout(() => {
        longPressed = true;
        const reaction = reactionOf();
        if (reaction) openAll(allOf().length ? allOf() : [reaction], reaction.emoji);
      }, LONG_PRESS_MS);
    });
    for (const type of ['pointerup', 'pointercancel', 'pointermove']) chip.addEventListener(type, () => clearTimeout(press));
    chip.addEventListener('click', (event) => {
      if (!longPressed) return;
      longPressed = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    chip.addEventListener('contextmenu', (event) => {
      if (longPressed) event.preventDefault();
    });
  }

  // A card whose reaction has gone (the row was drawn again) is not left hanging.
  document.addEventListener('scroll', () => closeCard(), true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCard();
  });
  document.addEventListener('pointerdown', (event) => {
    if (current && !current.card.contains(event.target)) closeCard();
  });
  new MutationObserver(() => {
    if (current && !current.chip.isConnected) closeCard();
  }).observe(document.body, { childList: true, subtree: true });

  return { attach, openAll, close: closeCard };
}
