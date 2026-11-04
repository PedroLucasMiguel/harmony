// A forum channel's listing: the posts in it, a box to find them or to start one, the card a new post is written
// in, and what is shown of each (its title, who wrote it and the first of what they said, the reactions it has had,
// how many have answered and when it was last written in, and its first picture).
//
// What a post IS -- a message that has a title, whose answers are the messages written under it -- is the server's
// (server/src/chat.js); opening one is the app's: it is the chat pane, showing that post's thread (see openPost in
// app.js). This is only the list on its side, and it knows nothing of how a thread is drawn.

const SORTS = ['activity', 'new', 'replies'];
const SORT_KEY = 'harmony.forum.sort';
/** How long after the last word a typed search is sent, so that every letter is not a request. */
const SEARCH_DELAY_MS = 250;
/** The most files one post is started with: each is a message under it. */
const MAX_FILES = 10;
const SNIPPET = 160;
const DAY = 24 * 60 * 60 * 1000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const $ = (id) => document.getElementById(id);

function savedSort() {
  try {
    const value = localStorage.getItem(SORT_KEY);
    return SORTS.includes(value) ? value : 'new';
  } catch {
    return 'new';
  }
}

/**
 * @param {object} deps
 * @param {Function} deps.t
 * @param {object} deps.harmony  the preload bridge
 * @param {object} deps.state  the app's state: server, auth.user
 * @param {(userId: number, fallback?: string) => string} deps.displayOf
 * @param {(userId: number) => void} deps.nameFont  draws a name in its owner's font: (node, userId)
 * @param {(node: HTMLElement, emoji: string) => void} deps.appendEmoji
 * @param {(anchor: HTMLElement, pick: (value: string) => void) => void} deps.openEmojiPicker
 * @param {() => void} deps.closeEmojiPicker
 * @param {(hash: string) => string} deps.mediaUrl
 * @param {(postId: number) => void} deps.openPost  a post was chosen
 * @param {(input: {title: string, body: string, files: File[]}) => Promise<object>} deps.createPost
 *   sends it, and resolves with the post as a message
 * @param {(text: string) => void} deps.say  an error the list has no room for
 * @param {(message: object) => boolean} deps.mentionsMe  whether a message is addressed to this person
 * @param {() => boolean} deps.canPin  whether this person may pin posts to the top
 * @param {(message: object) => boolean} deps.canDelete  whether this person may delete that post
 * @param {(message: object, on: boolean) => Promise<void>} deps.pinPost
 * @param {(message: object) => Promise<void>} deps.deletePost  asks first, and deletes
 */
export function createForumUi(deps) {
  const {
    t, harmony, state, displayOf, nameFont, appendEmoji, openEmojiPicker, closeEmojiPicker, mediaUrl, openPost, createPost, say,
    mentionsMe, canPin, canDelete, pinPost, deletePost,
  } = deps;

  const root = $('forum-active');
  const nameEl = $('forum-name');
  const searchInput = $('forum-search');
  const newButton = $('forum-new');
  const sortButton = $('forum-sort');
  const mentionsButton = $('forum-mentions');
  const sortMenu = $('forum-sort-menu');
  const composeSlot = $('forum-compose-slot');
  const listEl = $('forum-posts');
  const emptyEl = $('forum-empty');
  const moreButton = $('forum-more');

  /** @type {number|null} */
  let channelId = null;
  /** @type {{message: object, replyCount: number, lastActivityAt: number}[]} */
  let items = [];
  let query = '';
  let sort = savedSort();
  /** Only the posts that mention this person. */
  let mentionsOnly = false;
  let more = false;
  let loading = false;
  /** The latest request, so that an answer that comes late is not drawn over a newer one. */
  let ticket = 0;
  let activeId = null;
  let compose = null;
  let searchTimer = null;

  const me = () => state.auth.user?.id ?? null;

  // ------------------------------------------------------------------ words

  /** How long ago, in the units of a list: "now", "5m ago", "3h ago", "12d ago", ">30d ago". */
  function ago(when, now = Date.now()) {
    const ms = Math.max(0, now - when);
    if (ms < 60_000) return t('forum.ago_now');
    if (ms < 3_600_000) return t('forum.ago_m', { count: Math.floor(ms / 60_000) });
    if (ms < DAY) return t('forum.ago_h', { count: Math.floor(ms / 3_600_000) });
    if (ms <= 30 * DAY) return t('forum.ago_d', { count: Math.floor(ms / DAY) });
    return t('forum.ago_old');
  }

  const snippetOf = (message) => {
    const text = String(message.body ?? '').replace(/\s+/g, ' ').trim();
    if (text) return text.length > SNIPPET ? `${text.slice(0, SNIPPET - 1)}…` : text;
    return message.attachmentName ?? '';
  };

  // ------------------------------------------------------------------- the list

  const order = {
    activity: (a, b) => b.lastActivityAt - a.lastActivityAt || b.message.id - a.message.id,
    new: (a, b) => b.message.id - a.message.id,
    replies: (a, b) => b.replyCount - a.replyCount || b.lastActivityAt - a.lastActivityAt || b.message.id - a.message.id,
  };

  /** The pinned posts first, the one pinned last on top; the rest as the sort says. */
  const byPin = (a, b) => (b.message.postPinnedAt ?? 0) - (a.message.postPinnedAt ?? 0);
  const arrange = () => items.sort((a, b) => byPin(a, b) || order[sort](a, b));

  function reactionsOf(message) {
    const strip = el('span', 'forum-post-reactions');
    for (const reaction of message.reactions ?? []) {
      const chip = el('span', 'reaction');
      chip.setAttribute('role', 'img');
      if (reaction.userIds?.includes(me())) chip.setAttribute('data-mine', '');
      chip.title = (reaction.userIds ?? []).map((id) => displayOf(id, t('forum.someone'))).join(', ');
      appendEmoji(chip, reaction.emoji);
      chip.append(el('span', 'count', String(reaction.count)));
      strip.append(chip);
    }
    return strip;
  }

  function rowOf(item) {
    const { message } = item;
    const li = el('li', 'forum-post');
    li.dataset.id = String(message.id);
    li.setAttribute('role', 'button');
    li.tabIndex = 0;
    if (message.id === activeId) li.setAttribute('data-active', '');
    if (message.postPinnedAt) li.setAttribute('data-post-pinned', '');
    if (item.mentionCount > 0) li.setAttribute('data-mention', '');

    const main = el('div', 'forum-post-main');
    const heading = el('div', 'forum-post-heading');
    if (message.postPinnedAt) {
      const pin = el('span', 'forum-post-pin');
      pin.dataset.icon = 'push-pin';
      pin.title = t('forum.pinned');
      heading.append(pin);
    }
    heading.append(el('h3', 'forum-post-title', message.title));
    main.append(heading);

    const line = el('p', 'forum-post-snippet');
    const who = el('strong', 'who', `${displayOf(message.userId, message.nickname)}:`);
    nameFont(who, message.userId);
    line.append(who, ' ', snippetOf(message));
    main.append(line);

    const meta = el('div', 'forum-post-meta');
    if (message.reactions?.length) meta.append(reactionsOf(message));
    if (item.mentionCount > 0) {
      const badge = el('span', 'forum-post-mention', `@${item.mentionCount}`);
      badge.title = t('forum.mention_badge', { count: item.mentionCount });
      meta.append(badge);
    }
    const replies = el('span', 'forum-post-replies', String(item.replyCount));
    replies.dataset.icon = 'chat-teardrop';
    replies.title = t('forum.replies', { count: item.replyCount });
    const when = el('span', 'forum-post-ago', ago(item.lastActivityAt));
    when.title = new Date(item.lastActivityAt).toLocaleString();
    meta.append(replies, when);
    main.append(meta);
    li.append(main);

    if (message.attachmentHash && message.mediaType === 'image') {
      const thumb = el('img', 'forum-post-thumb');
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.draggable = false;
      thumb.src = mediaUrl(message.attachmentHash);
      li.append(thumb);
    }

    // What the row offers to those who may: pin it to the top, delete it.
    const tools = el('span', 'forum-post-tools');
    const tool = (icon, label, run, danger = false) => {
      const b = el('button', `msg-tool${danger ? ' msg-tool-danger' : ''}`, label);
      b.type = 'button';
      b.dataset.icon = icon;
      b.title = label;
      b.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await run();
        } catch (err) {
          say(err.message);
        }
      });
      return b;
    };
    if (canPin()) {
      const on = Boolean(message.postPinnedAt);
      const pinTool = tool('push-pin', on ? t('forum.unpin_post') : t('forum.pin_post'), () => pinPost(message, !on));
      if (on) pinTool.setAttribute('data-on', '');
      pinTool.dataset.testid = 'forum-pin';
      tools.append(pinTool);
    }
    if (canDelete(message)) {
      const del = tool('trash', t('forum.delete_post'), () => deletePost(message), true);
      del.dataset.testid = 'forum-delete';
      tools.append(del);
    }
    if (tools.children.length) li.append(tools);

    const choose = () => openPost(message.id);
    li.addEventListener('click', choose);
    li.addEventListener('keydown', (event) => {
      if (event.target !== li) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        choose();
      }
    });
    return li;
  }

  function draw() {
    listEl.replaceChildren(...items.map(rowOf));
    moreButton.hidden = !more;
    moreButton.disabled = loading;
    emptyEl.hidden = items.length > 0 || loading;
    if (!items.length && !loading) {
      emptyEl.replaceChildren();
      if (mentionsOnly && !query) {
        emptyEl.append(el('p', 'muted', t('forum.no_mentions')));
      } else if (query) {
        emptyEl.append(el('p', 'muted', t('forum.no_match')));
        const create = el('button', 'ghost small', t('forum.create_titled', { title: query }));
        create.type = 'button';
        create.addEventListener('click', () => openCompose(query));
        emptyEl.append(create);
      } else {
        emptyEl.append(el('p', 'muted', t('forum.empty')));
      }
    }
  }

  async function load({ reset }) {
    if (channelId === null) return;
    const mine = ++ticket;
    const forum = channelId;
    const server = state.server;
    loading = true;
    if (reset) {
      items = [];
      more = false;
    }
    draw();
    try {
      const page = await harmony.api.forumPosts(server, forum, { q: query, sort, offset: reset ? 0 : items.length, mentions: mentionsOnly ? 1 : undefined });
      if (mine !== ticket || channelId !== forum || state.server !== server) return;
      const known = new Set(items.map((i) => i.message.id));
      const fresh = page.posts
        .filter((p) => !known.has(p.message.id))
        .map((p) => ({
          message: p.message, replyCount: p.replyCount, lastActivityAt: p.lastActivityAt, mentionCount: p.mentionCount ?? 0,
        }));
      items = [...items, ...fresh];
      more = Boolean(page.more);
    } catch (err) {
      if (mine === ticket) say(err.message);
    } finally {
      if (mine === ticket) {
        loading = false;
        draw();
      }
    }
  }

  // ---------------------------------------------------------------- the toolbar

  function paintSort() {
    sortButton.setAttribute('aria-expanded', String(!sortMenu.hidden));
    for (const option of sortMenu.querySelectorAll('[data-sort]')) {
      option.setAttribute('aria-checked', String(option.dataset.sort === sort));
    }
  }

  function setSort(next) {
    sortMenu.hidden = true;
    if (!SORTS.includes(next) || next === sort) {
      paintSort();
      return;
    }
    sort = next;
    try { localStorage.setItem(SORT_KEY, sort); } catch { /* not kept */ }
    paintSort();
    load({ reset: true });
  }

  for (const name of SORTS) {
    const option = el('button', 'search-menu-item forum-sort-option', t(`forum.sort_${name}`));
    option.type = 'button';
    option.setAttribute('role', 'menuitemradio');
    option.dataset.sort = name;
    option.addEventListener('click', () => setSort(name));
    sortMenu.append(option);
  }
  sortButton.addEventListener('click', (event) => {
    event.stopPropagation();
    sortMenu.hidden = !sortMenu.hidden;
    paintSort();
  });
  document.addEventListener('click', (event) => {
    if (!sortMenu.hidden && !sortMenu.contains(event.target) && event.target !== sortButton) {
      sortMenu.hidden = true;
      paintSort();
    }
  });
  paintSort();

  mentionsButton.addEventListener('click', () => {
    mentionsOnly = !mentionsOnly;
    mentionsButton.setAttribute('aria-pressed', String(mentionsOnly));
    load({ reset: true });
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const next = searchInput.value.trim();
      if (next === query) return;
      query = next;
      load({ reset: true });
    }, SEARCH_DELAY_MS);
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !searchInput.value) return;
    event.stopPropagation();
    searchInput.value = '';
    clearTimeout(searchTimer);
    if (query) {
      query = '';
      load({ reset: true });
    }
  });
  newButton.addEventListener('click', () => openCompose());
  moreButton.addEventListener('click', () => load({ reset: false }));

  // ---------------------------------------------------------- writing a new post

  function closeCompose() {
    if (!compose) return;
    for (const url of compose.urls) URL.revokeObjectURL(url);
    compose.card.remove();
    compose = null;
    newButton.setAttribute('aria-expanded', 'false');
  }

  /** The card a post is started in: a title, the words, pictures and files, and Post. */
  function openCompose(title = '') {
    if (compose) {
      compose.title.focus();
      return compose;
    }
    const card = el('div', 'forum-compose');
    card.dataset.testid = 'forum-compose';
    const state_ = { card, files: [], urls: [], busy: false };

    const close = el('button', 'composer-btn forum-compose-close', t('forum.cancel'));
    close.type = 'button';
    close.dataset.icon = 'x';
    close.title = t('forum.cancel');
    const titleInput = el('input', 'forum-compose-title');
    titleInput.type = 'text';
    titleInput.maxLength = 200;
    titleInput.placeholder = t('forum.title_placeholder');
    titleInput.setAttribute('aria-label', t('forum.title_placeholder'));
    titleInput.autocomplete = 'off';
    titleInput.value = title;
    titleInput.dataset.testid = 'forum-title';
    const head = el('div', 'forum-compose-head');
    head.append(close, titleInput);

    const body = el('textarea', 'forum-compose-body');
    body.placeholder = t('forum.message_placeholder');
    body.setAttribute('aria-label', t('forum.message_placeholder'));
    body.maxLength = 4000;
    body.rows = 2;
    body.dataset.testid = 'forum-body';

    // The pictures and files, and the tile that adds them.
    const tile = el('button', 'forum-compose-media', '');
    tile.type = 'button';
    tile.dataset.icon = 'image-square';
    tile.title = t('forum.add_media');
    tile.setAttribute('aria-label', t('forum.add_media'));
    tile.dataset.testid = 'forum-add-media';
    const picker = el('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.hidden = true;
    picker.dataset.testid = 'forum-file';
    const previews = el('div', 'forum-compose-previews');
    previews.dataset.testid = 'forum-previews';

    const emoji = el('button', 'composer-btn', t('chat_emoji.emoji'));
    emoji.type = 'button';
    emoji.dataset.icon = 'smiley';
    emoji.title = t('chat_emoji.emoji');
    const problem = el('span', 'forum-compose-problem');
    problem.setAttribute('role', 'status');
    const post = el('button', 'primary forum-compose-post', t('forum.post'));
    post.type = 'button';
    post.dataset.icon = 'chat-teardrop';
    post.dataset.testid = 'forum-post';
    const foot = el('div', 'forum-compose-foot');
    foot.append(emoji, problem, post);

    const grid = el('div', 'forum-compose-grid');
    const words = el('div', 'forum-compose-words');
    words.append(head, body);
    grid.append(words, tile);
    card.append(grid, previews, foot, picker);

    function valid() {
      return Boolean(titleInput.value.trim()) && Boolean(body.value.trim() || state_.files.length);
    }
    function refresh() {
      post.disabled = state_.busy || !valid();
      body.style.height = 'auto';
      body.style.height = `${Math.min(body.scrollHeight, 220)}px`;
    }

    function drawPreviews() {
      for (const url of state_.urls) URL.revokeObjectURL(url);
      state_.urls = [];
      previews.replaceChildren(...state_.files.map((file, index) => {
        const item = el('div', 'forum-compose-preview');
        if (file.type.startsWith('image/')) {
          const img = el('img');
          img.alt = '';
          const url = URL.createObjectURL(file);
          state_.urls.push(url);
          img.src = url;
          item.append(img);
        } else {
          item.append(el('span', 'forum-compose-file', file.name));
        }
        const drop = el('button', 'forum-compose-remove', t('forum.remove_media'));
        drop.type = 'button';
        drop.dataset.icon = 'x';
        drop.title = t('forum.remove_media');
        drop.addEventListener('click', () => {
          state_.files.splice(index, 1);
          drawPreviews();
          refresh();
        });
        item.append(drop);
        return item;
      }));
      previews.hidden = !state_.files.length;
      refresh();
    }

    function add(files) {
      const room = MAX_FILES - state_.files.length;
      const taken = [...files].filter((f) => f.size > 0 || f.type).slice(0, Math.max(0, room));
      if (files.length > taken.length) problem.textContent = t('forum.too_many_files', { count: MAX_FILES });
      else problem.textContent = '';
      state_.files.push(...taken);
      drawPreviews();
    }
    state_.add = add;

    tile.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
      add(picker.files ?? []);
      picker.value = '';
    });

    // A file dropped on the card, or pasted into it, goes with the post.
    for (const type of ['dragenter', 'dragover']) {
      card.addEventListener(type, (event) => {
        if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return;
        event.preventDefault();
        event.stopPropagation();
        card.setAttribute('data-drop', '');
      });
    }
    card.addEventListener('dragleave', (event) => {
      if (!card.contains(event.relatedTarget)) card.removeAttribute('data-drop');
    });
    card.addEventListener('drop', (event) => {
      if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return;
      event.preventDefault();
      event.stopPropagation();
      card.removeAttribute('data-drop');
      add(event.dataTransfer.files);
    });
    body.addEventListener('paste', (event) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (!files.length) return;
      event.preventDefault();
      add(files);
    });

    emoji.addEventListener('click', () => openEmojiPicker(emoji, (value) => {
      closeEmojiPicker();
      const start = body.selectionStart ?? body.value.length;
      const end = body.selectionEnd ?? start;
      body.setRangeText(value, start, end, 'end');
      body.focus();
      refresh();
    }));

    async function send() {
      if (state_.busy || !valid()) return;
      state_.busy = true;
      refresh();
      problem.textContent = '';
      post.textContent = t('forum.posting');
      try {
        const message = await createPost({ title: titleInput.value, body: body.value, files: state_.files });
        closeCompose();
        if (message) {
          upsert(message);
          openPost(message.id);
        }
      } catch (err) {
        state_.busy = false;
        post.textContent = t('forum.post');
        problem.textContent = err.message;
        refresh();
      }
    }
    post.addEventListener('click', send);
    close.addEventListener('click', closeCompose);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeCompose();
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        send();
      }
    });
    titleInput.addEventListener('input', refresh);
    body.addEventListener('input', refresh);

    state_.title = titleInput;
    compose = state_;
    composeSlot.replaceChildren(card);
    newButton.setAttribute('aria-expanded', 'true');
    previews.hidden = true;
    refresh();
    (title ? body : titleInput).focus();
    return state_;
  }

  // ------------------------------------------------------------- what happens live

  /** Put a post into the list (or bring its line up to date), in its place. */
  function upsert(message, extra = {}) {
    const at = items.findIndex((i) => i.message.id === message.id);
    if (at >= 0) {
      items[at] = { ...items[at], message, ...extra };
    } else {
      const text = `${message.title} ${message.body}`.toLowerCase();
      if (query && !text.includes(query.toLowerCase())) return;
      if (mentionsOnly && !(extra.mentionCount > 0)) return;
      items.push({
        message,
        replyCount: extra.replyCount ?? 0,
        lastActivityAt: extra.lastActivityAt ?? message.createdAt,
        mentionCount: extra.mentionCount ?? 0,
      });
    }
    arrange();
    draw();
  }

  return {
    /** The forum is on screen: its name, and its posts from the top. */
    open(channel) {
      channelId = channel.id;
      nameEl.textContent = channel.name;
      query = '';
      searchInput.value = '';
      mentionsOnly = false;
      mentionsButton.setAttribute('aria-pressed', 'false');
      closeCompose();
      sortMenu.hidden = true;
      paintSort();
      activeId = null;
      load({ reset: true });
    },
    /** Left for another channel: nothing in it is kept. */
    close() {
      channelId = null;
      ticket += 1;
      items = [];
      activeId = null;
      closeCompose();
      listEl.replaceChildren();
    },
    /** Which post is open beside the list, lit in it. */
    highlight(postId) {
      activeId = postId;
      for (const row of listEl.children) row.toggleAttribute('data-active', Number(row.dataset.id) === postId);
    },
    /** A message arrived: a post makes a line, an answer counts under its post. */
    onMessage(message) {
      if (message.channelId !== channelId) return;
      const mentions = message.userId !== me() && mentionsMe(message);
      if (message.title !== null && message.title !== undefined) {
        upsert(message, { mentionCount: mentions ? 1 : 0 });
        return;
      }
      const item = items.find((i) => i.message.id === message.threadId);
      if (!item) {
        // Asked for the mentions alone, and a post not in the list was just answered with one: it belongs there now.
        if (mentionsOnly && mentions) load({ reset: true });
        return;
      }
      item.replyCount += 1;
      if (mentions) item.mentionCount += 1;
      item.lastActivityAt = Math.max(item.lastActivityAt, message.createdAt);
      arrange();
      draw();
    },
    /** A post was changed (its words, or pinned): the line follows. */
    onUpdated(message) {
      if (message.channelId !== channelId || message.title === null || message.title === undefined) return;
      const item = items.find((i) => i.message.id === message.id);
      if (item) upsert(message);
    },
    onDeleted({ id, post, threadId }) {
      if (post) {
        items = items.filter((i) => i.message.id !== id);
        draw();
        return;
      }
      const item = items.find((i) => i.message.id === threadId);
      if (item) {
        item.replyCount = Math.max(0, item.replyCount - 1);
        draw();
      }
    },
    onReactions(id, reactions) {
      const item = items.find((i) => i.message.id === id);
      if (!item) return;
      item.message = { ...item.message, reactions };
      draw();
    },
    /** Files dropped on the list: they open a new post with them attached. */
    dropFiles(files) {
      openCompose().add(files);
    },
    /** Whether a dropped file has somewhere to go here. */
    acceptsFiles: () => channelId !== null && !root.hidden,
    isOpen: () => channelId !== null,
    /** The newest answer count and last-written time of a post, as a thread that is open knows them. */
    ago,
  };
}
