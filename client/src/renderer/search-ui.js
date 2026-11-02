// Searching the server, the way Discord's search box does it.
//
// The box in a text channel's header takes words and filters. Focused and empty, it offers the filters
// (from:, in:, has:, mentions:, and "more": dates and pins) and the searches that were made before; typing a
// filter's name offers what it can be (people, channels, kinds of file, dates); a chosen value becomes a chip in the
// box. Enter searches the whole server -- not only this channel -- and the answers go in a panel that covers the
// member list for as long as it is wanted: a count, filters and a sort, the messages by channel, pages. Choosing one
// goes to it.
//
// The server does the work (GET /api/search, see chat.js searchAll). This file is only the page's side of it: what
// is typed, what is shown, and what is remembered.

const FILTER_KEYS = ['from', 'in', 'has', 'mentions', 'before', 'during', 'after', 'pinned'];
/** What `has:` offers; the server also takes `audio` for `sound`. */
const HAS_KINDS = ['link', 'embed', 'file', 'image', 'video', 'sound'];
/** A page of results, which is what the server sends by default. */
const PAGE = 25;
/** Searches kept, newest first, for each server. */
const HISTORY_MAX = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A filter's name and a part of what follows it, at the end of what was typed. */
const TRAILING_TOKEN = /(?:^|\s)(from|in|has|mentions|before|during|after|pinned):(\S*)$/i;
/** Every complete `filter:value` in what was typed. */
const COMPLETE_TOKEN = /(^|\s)(from|in|has|mentions|before|during|after|pinned):(\S+)(?=\s|$)/gi;

const $ = (id) => document.getElementById(id);
const node = (tag, className, text) => {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
};
const icon = (name, className = '') => {
  const span = node('span', className);
  span.dataset.icon = name;
  span.setAttribute('aria-hidden', 'true');
  return span;
};

// ---- dates: written as YYYY-MM-DD, in the person's own day

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** The start of that local day in ms, or null when it is not a date. */
function dayStart(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d);
  // 2026-02-31 is March 3rd to Date, and is not a date.
  return date.getMonth() === m - 1 && date.getDate() === d ? date.getTime() : null;
}

/** "2026-10-30", "today" or "yesterday", as an ISO date; null for anything else. */
function parseDate(raw) {
  const word = String(raw ?? '').trim().toLowerCase();
  if (word === 'today') return isoOf(new Date());
  if (word === 'yesterday') return isoOf(new Date(Date.now() - DAY_MS));
  return dayStart(word) === null ? null : word;
}

/**
 * One search box, with its dropdown, its chips and its panel of results. It is made for a text channel's header (the
 * whole server, asked of the server) and for a private conversation's (that conversation, looked through on this
 * computer, since what the server holds of one is sealed): what differs is in the config, not in the box.
 *
 * @param {object} config
 *   ids          the page's elements: box, input, chips, clear, pop, panel, count, filters, sort, close, body, pager,
 *                sortMenu -- the ids of each
 *   kinds        which filters this search has, of from in has mentions before during after pinned (default: all)
 *   hasKinds     which `has:` it offers (default: link embed file image video sound)
 *   state        the app's state, for the saved settings
 *   harmony      the bridge, to save them
 *   t            translate
 *   displayOf, faceOf, avatarEl, nameFont   how the app draws a person
 *   people       () => [{id, nickname, label}]: who `from:` and `mentions:` can name
 *   channels     () => [{id, name}]: what `in:` can name (default: none)
 *   search       (request, progress) => Promise<{total, capped, results}>: the answer to a request
 *                (see requestFor for its fields); `progress(n)` may be called with how many messages have been read
 *   groupOf      (message) => {key, label} | null: the heading a result goes under (default: none)
 *   messageContent  (message) => {text, emojiOnly}: a message's words, file and link card, as it is drawn there
 *   historyKey   () => the key what was searched is kept under
 *   placeholder  () => what the box says when it is empty
 *   host         () => the element the panel is laid over, which also gets data-searching while it is open
 *   jump         (message) => Promise: go to that message
 *   isNarrow     () => whether this is a phone layout, where the panel takes the whole screen
 */
export function createSearchUi(config) {
  const {
    state, harmony, t, displayOf, faceOf, avatarEl, nameFont, messageContent, jump, isNarrow,
    ids, people, search,
  } = config;
  const supports = new Set(config.kinds ?? FILTER_KEYS);
  const hasKinds = config.hasKinds ?? HAS_KINDS;
  const textChannels = config.channels ?? (() => []);
  const hostOf = () => config.host?.() ?? panel.closest('.channels-layout');

  const box = $(ids.box);
  const input = $(ids.input);
  const chipsEl = $(ids.chips);
  const clearButton = $(ids.clear);
  const pop = $(ids.pop);
  const panel = $(ids.panel);
  const countEl = $(ids.count);
  const filtersButton = $(ids.filters);
  const sortButton = $(ids.sort);
  const closeButton = $(ids.close);
  const bodyEl = $(ids.body);
  const pagerEl = $(ids.pager);
  const sortMenu = $(ids.sortMenu);

  // On a phone the box fills the row while it is being typed in, and this is its way out (the magnifier's place).
  const backButton = node('button', 'search-back');
  backButton.type = 'button';
  backButton.dataset.icon = 'arrow-left';
  backButton.title = t('search.back');
  backButton.setAttribute('aria-label', t('search.back'));
  box.prepend(backButton);
  // And over the results, what was searched, to go back to it: the box is behind the panel on a phone.
  const queryButton = node('button', 'search-query');
  queryButton.type = 'button';
  queryButton.dataset.icon = 'magnifying-glass';
  queryButton.title = t('search.edit');
  bodyEl.before(queryButton);

  /** What has been chosen: [{key, value, label}] -- value is an id, a kind, an ISO date or a boolean. */
  let chips = [];
  let sort = 'new';
  /** The search on screen: {text, page, total, capped, results} or null. */
  let current = null;
  /** The rows of the open dropdown, in order, for the arrow keys. */
  let rows = [];
  let active = -1;
  /** The latest request, so that an answer that comes late is not drawn over a newer one. */
  let ticket = 0;

  // ---------------------------------------------------------------- who and where

  const matches = (candidate, partial) => !partial || candidate.toLowerCase().includes(partial.toLowerCase());
  /** Names that start with what was typed come before the ones that only contain it. */
  const byStart = (partial, label) => (a, b) => {
    const left = label(a).toLowerCase().startsWith(partial.toLowerCase()) ? 0 : 1;
    const right = label(b).toLowerCase().startsWith(partial.toLowerCase()) ? 0 : 1;
    return left - right || label(a).localeCompare(label(b));
  };

  /** What a typed `key:raw` means, as a chip; null when it names nobody and nothing. */
  function resolve(key, raw) {
    if (!supports.has(key)) return null;
    const word = String(raw).replace(/^"|"$/g, '');
    if (key === 'from' || key === 'mentions') {
      const name = word.replace(/^@/, '').toLowerCase();
      const found = people().find((p) => p.nickname.toLowerCase() === name || p.label.toLowerCase() === name);
      return found ? { key, value: found.id, label: found.label } : null;
    }
    if (key === 'in') {
      const name = word.replace(/^#/, '').toLowerCase();
      const found = textChannels().find((c) => c.name.toLowerCase() === name);
      return found ? { key, value: found.id, label: found.name } : null;
    }
    if (key === 'has') {
      const kind = word.toLowerCase();
      return hasKinds.includes(kind) ? { key, value: kind, label: kind } : null;
    }
    if (key === 'pinned') {
      const flag = word.toLowerCase();
      return flag === 'true' || flag === 'false' ? { key, value: flag === 'true', label: flag } : null;
    }
    const date = parseDate(word);
    return date ? { key, value: date, label: date } : null;
  }

  // ---------------------------------------------------------------- chips

  /** One of each of these at a time; the others can be repeated (from two people). */
  const SINGLE = new Set(['before', 'after', 'during', 'pinned']);

  function addChip(chip) {
    chips = chips.filter((c) => !(c.key === chip.key && (SINGLE.has(chip.key) || c.value === chip.value)));
    chips.push(chip);
    drawChips();
  }

  function removeChip(chip) {
    chips = chips.filter((c) => c !== chip);
    drawChips();
  }

  function drawChips() {
    chipsEl.replaceChildren(...chips.map((chip) => {
      const el = node('span', 'search-chip');
      el.append(node('b', '', `${chip.key}:`), node('span', 'search-chip-value', String(chip.label)));
      const remove = node('button', 'search-chip-remove');
      remove.type = 'button';
      remove.dataset.icon = 'x';
      remove.tabIndex = -1;
      remove.setAttribute('aria-label', t('search.chip_remove', { name: `${chip.key}: ${chip.label}` }));
      remove.addEventListener('click', () => {
        removeChip(chip);
        input.focus();
        refreshPop();
      });
      el.append(remove);
      return el;
    }));
    box.toggleAttribute('data-has-chips', chips.length > 0);
    syncClear();
  }

  const syncClear = () => { clearButton.hidden = !input.value && !chips.length && !current; };

  /** `from:ana` typed out whole, followed by a space or Enter, becomes a chip; what names nobody stays words. */
  function absorbTokens() {
    const rest = input.value.replace(COMPLETE_TOKEN, (whole, space, key, raw) => {
      const chip = resolve(key.toLowerCase(), raw);
      if (!chip) return whole;
      addChip(chip);
      return space;
    });
    if (rest !== input.value) input.value = rest.replace(/\s{2,}/g, ' ').replace(/^\s+/, '');
  }

  // ---------------------------------------------------------------- history

  const historyKey = () => config.historyKey();
  const loadHistory = () => {
    const all = state.settings?.searchHistory;
    const list = all && typeof all === 'object' ? all[historyKey()] : null;
    return Array.isArray(list) ? list : [];
  };

  async function saveHistory(list) {
    const next = { ...(state.settings?.searchHistory ?? {}), [historyKey()]: list };
    if (!list.length) delete next[historyKey()];
    state.settings = { ...state.settings, searchHistory: next };
    try {
      const saved = await harmony.settings.set({ searchHistory: next });
      if (saved && typeof saved === 'object') state.settings = saved;
    } catch {
      // Kept for this session at least.
    }
  }

  function remember(text) {
    const entry = { text, chips: chips.map(({ key, value, label }) => ({ key, value, label })) };
    const same = JSON.stringify(entry);
    const list = [entry, ...loadHistory().filter((e) => JSON.stringify({ text: e.text, chips: e.chips }) !== same)];
    saveHistory(list.slice(0, HISTORY_MAX));
  }

  // ---------------------------------------------------------------- the dropdown

  const popOpen = () => !pop.hidden;

  /**
   * On a phone the list is as wide as the screen and fills it from under the box down: the box stays in sight above
   * the keyboard, and the list is not a small card that has to find room beside it. Where the box is is not known to
   * the stylesheet (the row it is in wraps), so it is told here. Elsewhere the list hangs from the box, as CSS has it.
   */
  function placePop() {
    pop.style.top = !pop.hidden && isNarrow() ? `${Math.round(box.getBoundingClientRect().bottom + 4)}px` : '';
  }
  window.addEventListener('resize', () => { if (!pop.hidden) placePop(); });
  window.visualViewport?.addEventListener('resize', () => { if (!pop.hidden) placePop(); });

  function closePop() {
    pop.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    rows = [];
    active = -1;
  }

  /** @param {{heading?: string, action?: HTMLElement, items: object[]}[]} sections */
  function drawPop(sections) {
    rows = [];
    active = -1;
    const parts = [];
    for (const section of sections) {
      if (!section.items.length) continue;
      if (section.heading) {
        const head = node('div', 'search-pop-heading');
        head.append(node('span', '', section.heading));
        if (section.action) head.append(section.action);
        parts.push(head);
      }
      for (const item of section.items) {
        parts.push(item.el);
        rows.push(item);
        item.el.addEventListener('click', () => item.choose());
        item.el.addEventListener('pointermove', () => setActive(rows.indexOf(item), false));
      }
    }
    pop.replaceChildren(...parts);
    pop.hidden = parts.length === 0;
    placePop();
    input.setAttribute('aria-expanded', String(!pop.hidden));
    // The first value is the one Enter takes, as it is in Discord; the filter list waits for an arrow key.
    if (rows[0]?.preselect) setActive(0, false);
  }

  function setActive(index, scroll = true) {
    if (index === active) return;
    rows[active]?.el.removeAttribute('data-active');
    active = index;
    const item = rows[active];
    if (!item) return;
    item.el.setAttribute('data-active', '');
    if (scroll) item.el.scrollIntoView({ block: 'nearest' });
  }

  function row(className, build) {
    const el = node('div', `search-row ${className}`);
    el.setAttribute('role', 'option');
    build(el);
    return el;
  }

  /** A line with a glyph, a title and what it looks like when typed. */
  function filterRow({ glyph, title, hint, choose }) {
    const el = row('search-filter', (r) => {
      r.append(icon(glyph, 'search-row-icon'));
      const text = node('div', 'search-row-text');
      text.append(node('div', 'search-row-title', title));
      const [key, ...rest] = hint.split(' ');
      const small = node('div', 'search-row-hint');
      small.append(node('b', '', key), document.createTextNode(rest.length ? ` ${rest.join(' ')}` : ''));
      text.append(small);
      r.append(text);
    });
    return { el, choose };
  }

  /** Puts `key:` in the box, after whatever words are already there, and offers its values. */
  function startFilter(key) {
    const before = input.value.replace(TRAILING_TOKEN, '').trimEnd();
    input.value = `${before}${before ? ' ' : ''}${key}:`;
    input.focus();
    refreshPop();
  }

  function filtersSection() {
    const items = [];
    if (supports.has('from')) items.push(filterRow({ glyph: 'user', title: t('search.from'), hint: 'from: user', choose: () => startFilter('from') }));
    if (supports.has('in')) items.push(filterRow({ glyph: 'hash', title: t('search.in'), hint: 'in: channel', choose: () => startFilter('in') }));
    if (supports.has('has')) items.push(filterRow({ glyph: 'paperclip', title: t('search.has'), hint: 'has: link, embed or file', choose: () => startFilter('has') }));
    if (supports.has('mentions')) items.push(filterRow({ glyph: 'at', title: t('search.mentions'), hint: 'mentions: user', choose: () => startFilter('mentions') }));
    const more = filterRow({ glyph: 'sliders-horizontal', title: t('search.more'), hint: 'x', choose: () => { closePop(); openFilters(); } });
    // Not a filter's name followed by an example: its second line is plain words.
    more.el.querySelector('.search-row-hint').replaceChildren(document.createTextNode(t(supports.has('pinned') ? 'search.more_hint' : 'search.more_hint_dates')));
    items.push(more);
    return { heading: t('search.filters'), items };
  }

  function historySection() {
    const list = loadHistory();
    const clear = node('button', 'search-pop-action');
    clear.type = 'button';
    clear.dataset.icon = 'trash';
    clear.title = t('search.history_clear');
    clear.setAttribute('aria-label', t('search.history_clear'));
    clear.addEventListener('click', (event) => {
      event.stopPropagation();
      saveHistory([]);
      refreshPop();
    });
    const items = list.map((entry) => {
      const el = row('search-history', (r) => {
        r.append(icon('magnifying-glass', 'search-row-icon'));
        const line = node('div', 'search-history-line');
        for (const chip of entry.chips ?? []) {
          const c = node('span', 'search-chip static');
          c.append(node('b', '', `${chip.key}:`), node('span', '', String(chip.label)));
          line.append(c);
        }
        if (entry.text) line.append(node('span', 'search-history-text', entry.text));
        r.append(line);
      });
      return {
        el,
        choose: () => {
          chips = (entry.chips ?? []).map((c) => ({ ...c }));
          drawChips();
          input.value = entry.text ?? '';
          closePop();
          run({ text: entry.text ?? '', page: 0, save: true });
        },
      };
    });
    return { heading: t('search.history'), action: list.length ? clear : undefined, items };
  }

  /** What the filter being typed can be, narrowed by what has been typed of it. */
  function valueSection(key, partial) {
    if (!supports.has(key)) return { heading: '', items: [] };
    const word = partial.replace(/^"|"$/g, '');
    const pick = (chip) => {
      // What was typed of it goes; the words before it stay.
      input.value = input.value.replace(TRAILING_TOKEN, '').trimEnd();
      addChip(chip);
      input.focus();
      refreshPop();
    };
    const valueRow = (build, chip) => {
      const el = row('search-value', build);
      return { el, choose: () => pick(chip), preselect: true };
    };

    if (key === 'from' || key === 'mentions') {
      const found = people().filter((p) => matches(p.nickname, word.replace(/^@/, '')) || matches(p.label, word.replace(/^@/, '')))
        .sort(byStart(word.replace(/^@/, ''), (p) => p.label)).slice(0, 8);
      return {
        heading: t('search.people'),
        items: found.map((p) => valueRow((r) => {
          r.append(avatarEl(faceOf(p.id, p.nickname), 'search-avatar'));
          const name = node('span', 'search-row-title', p.label);
          nameFont(name, p.id);
          r.append(name);
          if (p.label.toLowerCase() !== p.nickname.toLowerCase()) r.append(node('span', 'search-row-hint', p.nickname));
        }, { key, value: p.id, label: p.label })),
      };
    }
    if (key === 'in') {
      const found = textChannels().filter((c) => matches(c.name, word.replace(/^#/, '')))
        .sort(byStart(word.replace(/^#/, ''), (c) => c.name)).slice(0, 8);
      return {
        heading: t('search.channels'),
        items: found.map((c) => valueRow((r) => {
          r.append(icon('hash', 'search-row-icon'));
          r.append(node('span', 'search-row-title', c.name));
        }, { key, value: c.id, label: c.name })),
      };
    }
    if (key === 'has') {
      return {
        heading: t('search.kinds'),
        items: hasKinds.filter((kind) => matches(kind, word)).map((kind) => valueRow((r) => {
          r.append(icon(kind === 'link' || kind === 'embed' ? 'link' : 'paperclip', 'search-row-icon'));
          r.append(node('span', 'search-row-title', t(`search.has_${kind}`)));
          r.append(node('span', 'search-row-hint', kind));
        }, { key, value: kind, label: kind })),
      };
    }
    if (key === 'pinned') {
      return {
        heading: t('search.pinned'),
        items: ['true', 'false'].filter((flag) => matches(flag, word)).map((flag) => valueRow((r) => {
          r.append(icon('push-pin', 'search-row-icon'));
          r.append(node('span', 'search-row-title', t(flag === 'true' ? 'search.true' : 'search.false')));
        }, { key, value: flag === 'true', label: flag })),
      };
    }
    // A date: what it parses to, and the two easy ones.
    const wanted = [];
    const parsed = parseDate(word);
    if (parsed) wanted.push(parsed);
    for (const easy of ['today', 'yesterday']) {
      if (easy.startsWith(word.toLowerCase()) && !wanted.includes(parseDate(easy))) wanted.push(parseDate(easy));
    }
    const items = wanted.map((iso) => valueRow((r) => {
      r.append(icon('clock-counter-clockwise', 'search-row-icon'));
      r.append(node('span', 'search-row-title', iso));
    }, { key, value: iso, label: iso }));
    return { heading: t('search.date_hint'), items };
  }

  function refreshPop() {
    const text = input.value;
    const found = TRAILING_TOKEN.exec(text);
    // A filter this search does not have is only words, whatever it looks like.
    const token = found && supports.has(found[1].toLowerCase()) ? found : null;
    if (token) {
      const section = valueSection(token[1].toLowerCase(), token[2]);
      drawPop([section]);
      if (!section.items.length) {
        const none = node('div', 'search-pop-empty', t('search.nothing_to_offer'));
        pop.append(none);
        pop.hidden = false;
        placePop();
      }
    } else if (!text.trim()) {
      drawPop([filtersSection(), historySection()]);
    } else {
      closePop();
    }
    syncClear();
  }

  // ---------------------------------------------------------------- searching

  /** The request for what is typed and chosen, on page `page`. */
  function requestFor(text, page) {
    const request = { limit: PAGE, offset: page * PAGE, sort };
    if (text) request.q = text;
    const ids = (key) => chips.filter((c) => c.key === key).map((c) => c.value).join(',');
    if (ids('from')) request.from = ids('from');
    if (ids('in')) request.in = ids('in');
    if (ids('has')) request.has = ids('has').replace('sound', 'audio');
    if (ids('mentions')) request.mentions = ids('mentions');
    let after = null;
    let before = null;
    const lift = (value) => { after = after === null ? value : Math.max(after, value); };
    const lower = (value) => { before = before === null ? value : Math.min(before, value); };
    for (const chip of chips) {
      const start = dayStart(chip.value);
      if (start === null) continue;
      if (chip.key === 'after') lift(start + DAY_MS - 1);
      if (chip.key === 'before') lower(start);
      if (chip.key === 'during') { lift(start - 1); lower(start + DAY_MS); }
    }
    if (after !== null) request.after = after;
    if (before !== null) request.before = before;
    const pinned = chips.find((c) => c.key === 'pinned');
    if (pinned) request.pinned = pinned.value ? 1 : 0;
    return request;
  }

  async function run({ text = input.value.trim(), page = 0, save = false } = {}) {
    if (!text && !chips.length) return;
    const mine = (ticket += 1);
    current = { text, page, total: current?.total ?? 0, capped: false, results: current?.results ?? [], loading: true };
    openPanel();
    drawPanel();
    try {
      const answer = await search(requestFor(text, page), (read) => {
        if (mine !== ticket || !current) return;
        current.progress = read;
        drawPanel();
      });
      if (mine !== ticket) return;
      current = { text, page, total: answer.total ?? 0, capped: Boolean(answer.capped), results: answer.results ?? [], loading: false };
      if (save) remember(text);
    } catch (err) {
      if (mine !== ticket) return;
      current = { text, page, total: 0, capped: false, results: [], loading: false, error: err.message };
    }
    drawPanel();
  }

  /** Enter in the box. */
  function submit() {
    absorbTokens();
    const text = input.value.trim();
    if (!text && !chips.length) return;
    closePop();
    // On a phone the answers fill the screen: the keyboard has done what it was up for.
    if (isNarrow()) document.activeElement?.blur?.();
    run({ text, page: 0, save: true });
  }

  // ---------------------------------------------------------------- the panel

  /**
   * Under the row the box is in, so that the box -- and its X -- stay in reach: the panel covers the member list, not
   * the thing that is searching. On a phone it is the whole screen and the stylesheet places it.
   */
  function placePanel() {
    const layout = hostOf();
    const header = box.closest('header');
    if (!layout || !header || isNarrow()) {
      panel.style.top = '';
      return;
    }
    panel.style.top = `${Math.max(0, header.getBoundingClientRect().bottom - layout.getBoundingClientRect().top + 8)}px`;
  }

  function openPanel() {
    panel.hidden = false;
    hostOf()?.setAttribute('data-searching', '');
    placePanel();
    syncClear();
  }
  window.addEventListener('resize', () => { if (!panel.hidden) placePanel(); });

  function closeResults() {
    ticket += 1;
    panel.hidden = true;
    sortMenu.hidden = true;
    hostOf()?.removeAttribute('data-searching');
    current = null;
    syncClear();
  }

  /** Back to nothing typed, nothing chosen, nothing shown. */
  function clearAll() {
    chips = [];
    input.value = '';
    drawChips();
    closePop();
    closeResults();
  }

  const timeOf = (m) => {
    const when = new Date(m.createdAt);
    return new Date().toDateString() === when.toDateString()
      ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : when.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  };

  function card(m) {
    const el = node('div', 'search-card');
    el.dataset.id = String(m.id);
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.title = t('app.jump_to_this_message');
    const main = node('div', 'pin-main');
    const head = node('div', 'pin-head');
    const who = node('strong', '', displayOf(m.userId, m.nickname));
    nameFont(who, m.userId);
    head.append(who, node('span', 'pin-when', timeOf(m)));
    // The message as the channel draws it (markdown, its file or picture, the card for its link), in a `.chat-msg`
    // so the same rules apply; see .pin-body for what is and is not kept of a row.
    const body = node('div', 'chat-msg pin-body');
    const { text, emojiOnly } = messageContent(m);
    if (emojiOnly) body.setAttribute('data-emoji-only', '');
    body.append(text);
    main.append(head, body);

    const go = async () => {
      bodyEl.querySelector('.search-card[data-current]')?.removeAttribute('data-current');
      el.setAttribute('data-current', '');
      // On a phone the panel is the whole screen, and the message is behind it.
      if (isNarrow()) closeResults();
      await jump(m);
    };
    const tools = node('div', 'pin-tools');
    const jumpButton = node('button', 'pin-tool', t('app.jump'));
    jumpButton.type = 'button';
    jumpButton.addEventListener('click', go);
    tools.append(jumpButton);

    el.append(avatarEl(faceOf(m.userId, m.nickname), 'msg-avatar'), main, tools);
    el.addEventListener('click', (event) => {
      // Not something in the message that does its own thing (a link, the file, the player), and not the end of
      // selecting some of its words.
      if (event.target.closest('a, button, video, audio, input, .attachment, .link-embed, img.expandable')) return;
      if (String(window.getSelection?.() ?? '')) return;
      go();
    });
    el.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === el) {
        event.preventDefault();
        go();
      }
    });
    return el;
  }

  function drawPanel() {
    if (!current) return;
    const { total, capped, results, loading, error } = current;
    countEl.textContent = loading && !results.length
      ? (current.progress ? t('search.reading', { count: current.progress.toLocaleString() }) : t('search.searching'))
      : capped ? t('search.results_capped', { count: total.toLocaleString() }) : t('search.results', { count: total });
    filtersButton.textContent = chips.length ? t('search.filters_n', { count: chips.length }) : t('search.filters');
    queryButton.textContent = [...chips.map((c) => c.label), current.text].filter(Boolean).join(' ');
    panel.toggleAttribute('data-loading', Boolean(loading));

    if (error) {
      bodyEl.replaceChildren(node('p', 'search-empty', error));
    } else if (!loading && !results.length) {
      const empty = node('div', 'search-empty');
      empty.append(node('strong', '', t('search.no_results')), node('span', '', t('search.no_results_hint')));
      bodyEl.replaceChildren(empty);
    } else {
      // Under the heading each result belongs to (a channel), in the order each first appears: the newest (or
      // oldest) message sets the order. With no headings, the results as they come.
      const parts = [];
      if (config.groupOf) {
        const groups = new Map();
        for (const m of results) {
          const group = config.groupOf(m);
          if (!groups.has(group.key)) groups.set(group.key, { label: group.label, list: [] });
          groups.get(group.key).list.push(m);
        }
        for (const { label, list } of groups.values()) {
          const head = node('h4', 'search-group');
          head.append(icon('hash'), node('span', '', label));
          parts.push(head, ...list.map(card));
        }
      } else {
        parts.push(...results.map(card));
      }
      bodyEl.replaceChildren(...parts);
    }
    bodyEl.scrollTop = 0;
    drawPager();
  }

  function drawPager() {
    const pages = Math.ceil((current?.total ?? 0) / PAGE);
    if (pages <= 1) {
      pagerEl.hidden = true;
      return;
    }
    pagerEl.hidden = false;
    const at = current.page;
    const go = (page) => run({ text: current.text, page, save: false });
    const button = (label, page, { disabled = false, here = false, className = '' } = {}) => {
      const b = node('button', `search-page ${className}`, label);
      b.type = 'button';
      b.disabled = disabled;
      if (here) b.setAttribute('aria-current', 'page');
      b.addEventListener('click', () => go(page));
      return b;
    };
    const shown = new Set([0, pages - 1, at - 1, at, at + 1].filter((p) => p >= 0 && p < pages));
    const parts = [button(t('search.prev'), at - 1, { disabled: at === 0, className: 'search-page-step' })];
    let last = -1;
    for (const page of [...shown].sort((a, b) => a - b)) {
      if (page - last > 1) parts.push(node('span', 'search-page-gap', '…'));
      parts.push(button(String(page + 1), page, { here: page === at }));
      last = page;
    }
    parts.push(button(t('search.next'), at + 1, { disabled: at >= pages - 1, className: 'search-page-step' }));
    pagerEl.replaceChildren(...parts);
  }

  // ---------------------------------------------------------------- sort

  function drawSortMenu() {
    const choose = (value) => {
      sort = value;
      sortMenu.hidden = true;
      if (current) run({ text: current.text, page: 0, save: false });
    };
    sortMenu.replaceChildren(...[['new', 'search.sort_new'], ['old', 'search.sort_old']].map(([value, key]) => {
      const b = node('button', 'search-menu-item', t(key));
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(sort === value));
      b.addEventListener('click', () => choose(value));
      return b;
    }));
  }

  sortButton.addEventListener('click', () => {
    if (sortMenu.hidden) drawSortMenu();
    sortMenu.hidden = !sortMenu.hidden;
  });

  // ---------------------------------------------------------------- the filters dialog

  /** "More filters", and the way to change what has been chosen from the panel: every filter in one place. */
  function openFilters(initial = chips) {
    // A copy: nothing changes until Apply, and Cancel leaves what was chosen as it was.
    const draft = initial.map((c) => ({ ...c }));
    const dialog = node('dialog', 'ask search-filters');
    const form = node('form', 'search-filters-form');
    form.method = 'dialog';
    const head = node('h3', 'search-filters-title', t('search.dialog_title'));
    const body = node('div', 'search-filters-body');

    const field = (label, hint) => {
      const section = node('section', 'search-field-group');
      section.append(node('h4', '', label), node('p', 'muted', hint));
      return section;
    };

    /** People or channels: the chosen ones as removable pills, and a list to add another from. */
    const picker = (key, label, hint, options, addLabel) => {
      const section = field(label, hint);
      const pills = node('div', 'search-pills');
      const select = node('select', 'search-select');
      const draw = () => {
        pills.replaceChildren(...draft.filter((c) => c.key === key).map((chip) => {
          const pill = node('span', 'search-chip');
          pill.append(node('span', 'search-chip-value', String(chip.label)));
          const remove = node('button', 'search-chip-remove');
          remove.type = 'button';
          remove.dataset.icon = 'x';
          remove.setAttribute('aria-label', t('search.chip_remove', { name: String(chip.label) }));
          remove.addEventListener('click', () => {
            draft.splice(draft.indexOf(chip), 1);
            draw();
            sync();
          });
          pill.append(remove);
          return pill;
        }));
        const taken = new Set(draft.filter((c) => c.key === key).map((c) => c.value));
        select.replaceChildren(
          Object.assign(node('option', '', addLabel), { value: '' }),
          ...options.filter((o) => !taken.has(o.value)).map((o) => Object.assign(node('option', '', o.label), { value: String(o.value) })),
        );
      };
      select.addEventListener('change', () => {
        const picked = options.find((o) => String(o.value) === select.value);
        if (picked) draft.push({ key, value: picked.value, label: picked.label });
        draw();
        sync();
      });
      draw();
      section.append(pills, select);
      return section;
    };

    const everyone = () => people().sort((a, b) => a.label.localeCompare(b.label)).map((p) => ({ value: p.id, label: p.label }));
    if (supports.has('from')) body.append(picker('from', t('search.dialog_from'), t('search.dialog_from_hint'), everyone(), t('search.add_person')));
    if (supports.has('in')) body.append(picker('in', t('search.dialog_in'), t('search.dialog_in_hint'), textChannels().map((c) => ({ value: c.id, label: c.name })), t('search.add_channel')));

    // has: the kinds as switches.
    const has = field(t('search.dialog_has'), t('search.dialog_has_hint'));
    const kinds = node('div', 'search-pills');
    for (const kind of hasKinds) {
      const b = node('button', 'search-kind', t(`search.has_${kind}`));
      b.type = 'button';
      const on = () => draft.some((c) => c.key === 'has' && c.value === kind);
      const paint = () => { b.setAttribute('aria-pressed', String(on())); };
      b.addEventListener('click', () => {
        if (on()) draft.splice(draft.findIndex((c) => c.key === 'has' && c.value === kind), 1);
        else draft.push({ key: 'has', value: kind, label: kind });
        paint();
        sync();
      });
      paint();
      kinds.append(b);
    }
    has.append(kinds);
    if (supports.has('has')) body.append(has);

    if (supports.has('mentions')) body.append(picker('mentions', t('search.dialog_mentions'), t('search.dialog_mentions_hint'), everyone(), t('search.add_person')));

    // Date: any number of before / during / after, each with a day.
    const date = field(t('search.dialog_date'), t('search.dialog_date_hint'));
    const dates = node('div', 'search-dates');
    const addDate = node('button', 'search-add-date');
    addDate.type = 'button';
    addDate.append(icon('plus'), document.createTextNode(` ${t('search.add_date')}`));
    const drawDates = () => {
      dates.replaceChildren(...draft.filter((c) => ['before', 'during', 'after'].includes(c.key)).map((chip) => {
        const line = node('div', 'search-date-row');
        const kind = node('select', 'search-select');
        for (const k of ['before', 'during', 'after']) kind.append(Object.assign(node('option', '', t(`search.date_${k}`)), { value: k, selected: k === chip.key }));
        const day = node('input', 'search-date-input');
        day.type = 'date';
        day.value = chip.value;
        const remove = node('button', 'search-chip-remove');
        remove.type = 'button';
        remove.dataset.icon = 'x';
        remove.setAttribute('aria-label', t('search.chip_remove', { name: `${chip.key}: ${chip.value}` }));
        kind.addEventListener('change', () => { chip.key = kind.value; });
        day.addEventListener('change', () => {
          if (dayStart(day.value) !== null) { chip.value = day.value; chip.label = day.value; }
          sync();
        });
        remove.addEventListener('click', () => {
          draft.splice(draft.indexOf(chip), 1);
          drawDates();
          sync();
        });
        line.append(kind, day, remove);
        return line;
      }));
    };
    addDate.addEventListener('click', () => {
      draft.push({ key: 'after', value: isoOf(new Date()), label: isoOf(new Date()) });
      drawDates();
      sync();
    });
    drawDates();
    date.append(dates, addDate);
    if (supports.has('before') || supports.has('after') || supports.has('during')) body.append(date);

    // Pinned: either, or one.
    const pin = field(t('search.dialog_pinned'), t('search.dialog_pinned_hint'));
    const pinSelect = node('select', 'search-select');
    const pinned = draft.find((c) => c.key === 'pinned');
    for (const [value, label] of [['', 'search.any'], ['true', 'search.true'], ['false', 'search.false']]) {
      pinSelect.append(Object.assign(node('option', '', t(label)), { value, selected: String(pinned?.value ?? '') === value }));
    }
    pinSelect.addEventListener('change', () => {
      const at = draft.findIndex((c) => c.key === 'pinned');
      if (at >= 0) draft.splice(at, 1);
      if (pinSelect.value) draft.push({ key: 'pinned', value: pinSelect.value === 'true', label: pinSelect.value });
      sync();
    });
    pin.append(pinSelect);
    if (supports.has('pinned')) body.append(pin);

    // The foot: clear, cancel, apply.
    const foot = node('div', 'search-filters-foot');
    const clear = node('button', 'search-filters-clear');
    clear.type = 'button';
    const cancel = node('button', 'ghost', t('app.cancel'));
    cancel.type = 'button';
    const apply = node('button', 'primary', t('search.apply'));
    apply.type = 'submit';
    foot.append(clear, cancel, apply);

    const sync = () => {
      clear.textContent = t('search.dialog_clear', { count: draft.length });
      clear.disabled = draft.length === 0;
    };
    clear.addEventListener('click', () => {
      // Drawn again from nothing, the simplest way to bring every control back to empty.
      dialog.close();
      openFilters([]);
    });
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', () => {
      chips = draft.filter((c) => c.value !== '' && c.value !== undefined);
      drawChips();
      const text = input.value.trim();
      if (text || chips.length) run({ text, page: 0, save: true });
      else closeResults();
    });
    dialog.addEventListener('close', () => dialog.remove());
    sync();
    form.append(head, body, foot);
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
  }

  filtersButton.addEventListener('click', () => openFilters());
  closeButton.addEventListener('click', closeResults);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeResults();
  });

  // ---------------------------------------------------------------- the box

  input.addEventListener('focus', () => refreshPop());
  input.addEventListener('input', () => {
    if (/\s$/.test(input.value)) absorbTokens();
    refreshPop();
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!popOpen()) refreshPop();
      if (!rows.length) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((active + step + rows.length) % rows.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      // A value on offer, chosen with the arrows or the first of them, is taken; anything else is a search.
      if (popOpen() && active >= 0 && rows[active]) rows[active].choose();
      else submit();
    } else if (event.key === 'Backspace' && !input.value && chips.length) {
      removeChip(chips.at(-1));
      refreshPop();
    } else if (event.key === 'Escape') {
      if (popOpen()) { closePop(); event.stopPropagation(); }
      else if (!panel.hidden) { closeResults(); event.stopPropagation(); }
      else input.blur();
    }
  });
  clearButton.addEventListener('click', () => {
    clearAll();
    input.focus();
  });
  backButton.addEventListener('click', () => {
    closePop();
    backButton.blur();
    input.blur();
  });
  // Back to what was typed, to change it: the answers are put away and the box is where it was left.
  queryButton.addEventListener('click', () => {
    closeResults();
    input.focus();
  });
  box.addEventListener('click', (event) => {
    if (!event.target.closest('button')) input.focus();
  });
  // Pressing on the list must not take the focus from the box, or the list closes before the press lands.
  pop.addEventListener('pointerdown', (event) => event.preventDefault());
  document.addEventListener('pointerdown', (event) => {
    if (popOpen() && !box.contains(event.target) && !pop.contains(event.target)) closePop();
    if (!sortMenu.hidden && !sortMenu.contains(event.target) && !sortButton.contains(event.target)) sortMenu.hidden = true;
  });

  const placeholder = () => { input.placeholder = config.placeholder(); };
  placeholder();

  return {
    /** A different server, or none: nothing typed, chosen or shown carries over. */
    reset() {
      chips = [];
      input.value = '';
      drawChips();
      closePop();
      closeResults();
      placeholder();
    },
    /** The channels' view is on screen: say what it can be asked. */
    refreshPlaceholder: placeholder,
    close: closeResults,
    /** The panel is open, for the page's own logic (a phone's back button). */
    get open() { return !panel.hidden; },
  };
}
