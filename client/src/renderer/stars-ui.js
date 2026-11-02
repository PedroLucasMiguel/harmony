// The starred messages, behind the star in a conversation's header: a panel under it, with a box to search them.
//
// For a text channel and for a private conversation alike. What differs -- where the stars are, how a copy is read
// back, what the click on one does -- comes in as the config; what does not -- the panel, the search, the cards
// (pins-ui's `messageCard`) -- is here.

import { matches } from './stars-store.js';

const $ = (id) => document.getElementById(id);

/** Cards drawn at once. A card can carry a picture or a link's preview, so five hundred of them are not drawn together. */
const PAGE = 50;

/**
 * @param {object} config
 *   ids      the page's elements: button (the star in the header), pop (the panel), list, search (the box), clear,
 *            count (the line under the box)
 *   t        translate
 *   items    () => [{key, searchText, card}]: every star, the one starred last first. `card()` makes its card (and is
 *            only called for what is shown); `searchText` is what the box looks through.
 */
export function createStarsUi(config) {
  const { ids, t, items } = config;
  const button = $(ids.button);
  const pop = $(ids.pop);
  const list = $(ids.list);
  const search = $(ids.search);
  const clear = $(ids.clear);
  const count = $(ids.count);

  let shown = PAGE;

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function draw() {
    const all = items();
    const query = search.value.trim();
    const found = query ? all.filter((i) => matches(query, i.searchText)) : all;
    clear.hidden = !query;
    count.hidden = all.length === 0;
    count.textContent = query
      ? t('stars.found', { count: found.length, total: all.length })
      : t('stars.count', { count: all.length });

    const nodes = found.slice(0, shown).map((i) => i.card());
    if (!found.length) {
      nodes.push(make('p', 'pins-empty muted', all.length ? t('stars.no_match') : t('stars.none')));
    } else if (found.length > shown) {
      const more = make('button', 'ghost small stars-more', t('stars.show_more', { count: found.length - shown }));
      more.type = 'button';
      more.addEventListener('click', () => {
        shown += PAGE;
        const top = list.scrollTop;
        draw();
        list.scrollTop = top;
      });
      nodes.push(more);
    }
    list.replaceChildren(...nodes);
  }

  function open() {
    shown = PAGE;
    draw();
    pop.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.toggleAttribute('data-on', true);
    // Under the star in the header, its right edge to the star's; as wide as the window allows, on a phone.
    const box = button.getBoundingClientRect();
    const top = box.bottom + 6;
    pop.style.top = `${top}px`;
    pop.style.maxHeight = `${Math.max(200, window.innerHeight - top - 12)}px`;
    pop.style.right = `${Math.max(8, window.innerWidth - box.right)}px`;
    list.scrollTop = 0;
    // Where the cursor is wanted: the panel is for finding. Not on a phone, where it would only raise the keyboard.
    if (!window.matchMedia('(pointer: coarse)').matches) search.focus();
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
  search.addEventListener('input', () => {
    shown = PAGE;
    draw();
    list.scrollTop = 0;
  });
  clear.addEventListener('click', () => {
    search.value = '';
    shown = PAGE;
    draw();
    search.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (pop.hidden) return;
    if (pop.contains(event.target) || button.contains(event.target)) return;
    close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || pop.hidden || event.defaultPrevented) return;
    // The first Escape takes back what was typed; the next closes the panel.
    if (search.value && document.activeElement === search) {
      search.value = '';
      draw();
      return;
    }
    close();
  });

  return {
    /** Drawn again from what is starred now, if the panel is open. */
    draw() {
      if (!pop.hidden) draw();
    },
    open,
    close,
    get isOpen() { return !pop.hidden; },
    /** A different conversation: nothing typed in the box carries over. */
    reset() {
      close();
      search.value = '';
    },
  };
}
