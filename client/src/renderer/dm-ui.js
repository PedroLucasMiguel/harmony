// The page of private conversations: the button in the corner, the list it
// opens, the conversation on the stage, and the dialogs for the keys.
//
// Everything the app already has (names, faces, emoji, dialogs, the stage) comes
// in as `deps`, so this file does not reach into app.js and app.js does not
// know how a private message is drawn. What is drawn comes from a DmSession
// (dm-session.js); what the person does goes back to it. Nothing here makes a
// request or opens a message itself.
//
// Drawn as a channel's messages are -- the same classes, so the same look --
// but not by the channel's own code: that is tied to channels (pins, admin
// delete, replies found through the channel's list) and a private message is
// none of those things.

import { PersistentKeyFile } from './dm-keyfile.js';
import { settingsBackend } from './dm-backend.js';
import { DmSession, MAX_BODY, previewOf } from './dm-session.js';
import { fileCard, textCard, previewsAsText, forgetTextHeads, TEXT_PREVIEW_BYTES } from './attachment-card.js';
import { createRecorderBar, voiceNote, isVoiceNote } from './voice-note.js';
import { parkMedia, takeMedia, dropParked, keepable } from './media-keep.js';
import { KeyState } from './dm-vault.js';
import { serverKeyOf } from './server-key.js';
import { createSearchUi } from './search-ui.js';
import { attachmentThumb, createPins, messageCard, toolButton } from './pins-ui.js';
import { StarError } from './stars-store.js';
import { createStarsUi } from './stars-ui.js';
import { keepEnd } from './chat-follow.js';
import { expiring } from './expiring.js';
import { firstLink, linkEmbed } from './link-embed.js';

/** How close together two messages from the same person stay one block. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** How near the end of the log still counts as being at it. */
const BOTTOM_PX = 40;
/** How much of what was already read is left above the line when a conversation opens at its news. */
const NEWS_CONTEXT_PX = 90;
/** Pages of older messages read to get to one a search found: a long way, and not for ever. */
const JUMP_MAX_PAGES = 200;
/** How long the log stays at its end while what is in it (a picture, a link's card) arrives and grows. */
const HOLD_MS = 4000;

/** The message from `session` for a `code` the page can say in its own words. */
function words(t, error) {
  switch (error?.code) {
    case 'no_key': return t('dm.error.no_key');
    case 'peer_has_no_key': return t('dm.error.peer_has_no_key');
    case 'key_not_confirmed': return t('dm.error.key_not_confirmed');
    case 'blocked': return t('dm.error.blocked');
    case 'too_long': return t('dm.error.too_long', { max: MAX_BODY });
    case 'file_too_large': return t('dm.error.file_too_large');
    case 'slow_down': return t('dm.error.slow_down');
    case 'unreachable': return error.message;
    default: return error?.message || t('dm.error.generic');
  }
}

/**
 * @param {object} deps  what the app provides: state, harmony, t and the helpers
 *   named below
 */
export function createDmUi(deps) {
  const {
    state, harmony, t, stars,
    openEmojiPicker, closeEmojiPicker, askConfirm, formatBytes, playCue, applyStage,
    closeChat, showError,
  } = deps;

  const $ = (id) => document.getElementById(id);
  const el = {
    panel: $('dm-panel'),
    panelClose: $('dm-panel-close'),
    panelNote: $('dm-panel-note'),
    panelActions: $('dm-panel-actions'),
    list: $('dm-list'),
    empty: $('dm-empty'),
    active: $('dm-active'),
    headAvatar: $('dm-head-avatar'),
    name: $('dm-name'),
    verified: $('dm-verified'),
    safety: $('dm-safety'),
    menuButton: $('dm-menu-button'),
    close: $('dm-close'),
    banner: $('dm-banner'),
    log: $('dm-log'),
    toBottom: $('dm-to-bottom'),
    drop: $('dm-drop'),
    dropTitle: $('dm-drop-title'),
    more: $('dm-more'),
    form: $('dm-form'),
    reply: $('dm-reply'),
    replyName: $('dm-reply-name'),
    replyClear: $('dm-reply-clear'),
    editing: $('dm-editing'),
    editingClear: $('dm-editing-clear'),
    pending: $('dm-pending'),
    pendingName: $('dm-pending-name'),
    pendingClear: $('dm-pending-clear'),
    attach: $('dm-attach'),
    input: $('dm-input'),
    emoji: $('dm-emoji'),
    send: $('dm-send'),
    record: $('dm-record'),
    recorder: $('dm-recorder'),
    file: $('dm-file'),
    note: $('dm-note'),
    none: $('dm-none'),
  };

  /** A voice message: recorded in the box, sealed and sent like any file. See voice-note.js. */
  const voiceBar = createRecorderBar({
    bar: el.recorder,
    composer: el.recorder.closest('.composer'),
    t,
    deviceId: () => state.settings?.voiceInputId ?? '',
    onSend: async (file) => {
      setPending({ name: file.name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
      submit();
    },
    onError: (message) => { el.note.textContent = message; },
  });
  el.record.addEventListener('click', () => {
    el.note.textContent = '';
    voiceBar.start();
  });

  /** With nothing to send the microphone is where the send button is. */
  function syncRecord() {
    if (editing) {
      // Saving, not sending or recording; with nothing written it waits, unless a file stays behind.
      el.send.hidden = false;
      el.record.hidden = true;
      el.send.disabled = !el.input.value.trim() && !editing.private?.file;
      return;
    }
    const empty = !el.input.value.trim() && !pendingFile;
    el.send.hidden = empty;
    el.record.hidden = !empty;
  }

  /*
   * Private conversations are kept per server: each saved server the person is
   * signed in to has a "home" -- its own session, with its own keys, and the
   * people it knows -- and the list shows them all together. The conversation on
   * screen belongs to one of them (`home`), which is also what `session` is.
   */
  /** @type {Map<string, {key: string, server: string, meId: number, users: () => Map<number, object>, session: DmSession}>} */
  const homes = new Map();
  let home = null;
  /** While a row of another server's is being drawn: whose people and pictures to use. */
  let scope = null;

  /** @type {DmSession|null} */
  let session = null;
  let currentId = null;
  let replyTo = null;
  /** One of your own messages being rewritten in the box, or null. See setEditing. */
  let editing = null;
  /** What was half-typed when the edit began, put back when it ends. */
  let editDraft = '';
  let pendingFile = null;
  let menu = null;
  let keysDialog = null;
  let busy = false;
  /**
   * Where the news in the open conversation began: the id of the last message that had been read when it was opened,
   * or null if there was nothing new. The line is drawn after it and stays until the conversation is left, as in a
   * channel.
   */
  let newAfter = null;
  /** Until when what is sent is scrolled to (Infinity while it is on its way): see submit. */
  let sendingUntil = 0;
  /** Whether the page of private messages has been put away since the conversation was last opened. */
  let away = false;
  const dmsView = $('view-dms');
  if (dmsView) {
    new MutationObserver(() => { if (!dmsView.hasAttribute('data-active')) away = true; })
      .observe(dmsView, { attributes: true, attributeFilter: ['data-active'] });
  }

  // A box that grows under the log (the message box, the keyboard) does not leave it behind the end.
  keepEnd(el.log);
  // What is said under the box is said for a while, and goes.
  expiring(el.note, () => { el.note.textContent = ''; });

  const me = () => (scope ?? home)?.meId ?? state.auth.user?.id;

  // What names and pictures mean depends on the server: ids are per server, and so are the people.
  const within = (fn) => {
    const h = scope ?? home;
    return h && deps.inServer ? deps.inServer(h, fn) : fn();
  };
  const displayOf = (...args) => within(() => deps.displayOf(...args));
  const faceOf = (...args) => within(() => deps.faceOf(...args));
  const avatarEl = (...args) => within(() => deps.avatarEl(...args));
  const nameFont = (...args) => within(() => deps.nameFont(...args));
  const renderBody = (...args) => within(() => deps.renderBody(...args));
  const appendEmoji = (...args) => within(() => deps.appendEmoji(...args));
  const peerName = (id) => displayOf(id, 'someone');

  const homeOf = (server) => homes.get(serverKeyOf(server)) ?? null;
  /** The home of the server that is open on screen. */
  const openHome = () => (state.auth.user && state.server ? homeOf(state.server) : null);

  /** Point the conversation pane at one server's session. */
  function bind(next) {
    if (home === next) return;
    home = next;
    session = next?.session ?? null;
    currentId = null;
    replyTo = null;
    pendingFile = null;
    voiceBar.cancel();
    syncRecord();
    el.active.hidden = true;
    closeMenu();
  }

  // ---------------------------------------------------------------- lifecycle

  /** Make a server's home: its session, with the keys this computer holds for the account on it. */
  async function makeHome({ server, meId, users }) {
    closeHome(serverKeyOf(server));
    const backend = settingsBackend(harmony, server, meId);
    const file = await PersistentKeyFile.open(backend, `${server}#${meId}`);
    const key = serverKeyOf(server);
    const mine = { key, server, meId, users, session: null };
    mine.session = new DmSession({
      server,
      me: { id: meId },
      api: harmony.api,
      file,
      onChange: () => { if (homes.get(key) === mine) render(); },
    });
    homes.set(key, mine);
    return mine;
  }

  /** Signed in and the accounts are known: find out whether this computer can take part. */
  async function start() {
    const mine = await makeHome({ server: state.server, meId: state.auth.user?.id, users: () => state.users });
    if (!home || currentId === null) bind(mine);
    render();
    await mine.session.start();
    if (homes.get(mine.key) !== mine) return;
    // Nothing is put in front of anybody here: signing in is not asking for
    // private messages. The list says what is waiting (a recovery key to keep,
    // a key to unlock with), and the first time one is opened it is asked.
    render();
  }

  /**
   * A server that is saved but not open: its private conversations are kept up
   * behind it, so the list is every server's and a message that arrives anywhere
   * counts. `users` is what that server's people are looked up in.
   */
  async function startBackground({ server, meId, users }) {
    if (!meId) return;
    const existing = homeOf(server);
    if (existing?.meId === meId) {
      existing.users = users;
      return;
    }
    const mine = await makeHome({ server, meId, users });
    render();
    await mine.session.start();
    if (homes.get(mine.key) === mine) render();
  }

  /** Forget a server's conversations: signed out of it, kicked, or forgotten. */
  function closeHome(key) {
    const mine = homes.get(key);
    if (!mine) return;
    mine.session.closeFiles();
    forgetTextHeads();
    homes.delete(key);
    if (home === mine) {
      bind(null);
      syncPane();
    }
    render();
  }

  /** Signed out of a server, or it is gone: nothing opened stays reachable. */
  function stop(server = state.server) {
    if (!server) return;
    closeHome(serverKeyOf(server));
    keysDialog?.close();
  }

  /**
   * The open server is no longer on screen but still signed in: its
   * conversations carry on behind the list, looked up in the people it had.
   */
  function release(server) {
    const mine = homeOf(server);
    if (!mine) return;
    const people = state.users;
    mine.users = () => people;
  }

  /** Whether any server can take part, for the button that opens the list. */
  const anyAvailable = () => [...homes.values()].some((h) => h.session.state !== KeyState.Unsupported);

  const isOpen = () => currentId !== null;

  /** Closes the conversation on the stage, if there is one. */
  function closeConversation() {
    if (currentId === null) return;
    setEditing(null);
    currentId = null;
    newAfter = null;
    searchUi.reset();
    pins.clear();
    starsUi.close();
    replyTo = null;
    pendingFile = null;
    voiceBar.cancel();
    syncRecord();
    el.active.hidden = true;
    syncPane();
    closeMenu();
    applyStage();
  }

  // ------------------------------------------------------------------ render

  /** The "pick a conversation" text shows exactly when no conversation does. */
  function syncPane() {
    if (el.none) el.none.hidden = !el.active.hidden;
    // A narrow screen shows the list or the conversation, whichever is open.
    el.active.closest('.dms-layout')?.toggleAttribute('data-conversation', !el.active.hidden);
  }

  const totalUnread = () => [...homes.values()].reduce((n, h) => n + h.session.unread, 0);

  function render() {
    renderBadge();
    if (!el.panel.hidden || deps.listDocked?.()) renderPanel();
    if (currentId !== null) renderConversation();
    syncPane();
  }

  function renderBadge() {
    const n = totalUnread();
    // The rail's bubble shows the same count.
    deps.onUnread?.(n);
  }

  const when = (ms) => {
    const d = new Date(ms);
    const today = new Date();
    return d.toDateString() === today.toDateString()
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { day: '2-digit', month: 'short' });
  };

  function button(label, run, className = 'ghost small') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.addEventListener('click', run);
    return b;
  }

  /** What the panel says when there is no list to show, or something to do first. */
  function panelState(h) {
    const note = (text) => ({ text, actions: [] });
    // What the buttons act on is the session they are about.
    const mine = h.session;
    const acting = (run) => () => { bind(h); return run(); };
    switch (mine.state) {
      case undefined:
      case KeyState.Loading:
        return note(t('dm.loading'));
      case KeyState.Unsupported:
        return note(t('dm.unsupported'));
      case KeyState.Failed:
        return {
          text: mine.failure === 'keychain' ? t('dm.keychain') : t('dm.failed', { message: mine.failure || '' }),
          actions: [button(t('dm.retry'), () => mine.start().then(render))],
        };
      case KeyState.Locked:
        return { text: t('dm.locked_note'), actions: [button(t('dm.unlock'), acting(showUnlock), 'primary small')] };
      default: {
        const actions = [];
        let text = '';
        if (mine.vault.needsBackup) {
          text = t('dm.backup_note');
          actions.push(button(t('dm.show_recovery'), acting(() => showRecoveryKey({})), 'primary small'));
        }
        return { text, actions };
      }
    }
  }

  /** The name a server goes by, where there is more than one to tell apart. */
  const serverLabel = (server) => deps.serverName?.(server) ?? server;

  function renderPanel() {
    const all = [...homes.values()];
    const several = all.length > 1;
    // What each server has to say before its conversations can be shown, with a
    // way to deal with it; said with the server's name when there are several.
    const notes = all.map((h) => ({ h, ...panelState(h) })).filter((n) => n.text);
    el.panelNote.hidden = notes.length === 0;
    el.panelNote.textContent = notes.map((n) => (several ? `${serverLabel(n.h.server)}: ${n.text}` : n.text)).join('\n');
    const actions = notes.flatMap((n) => n.actions.map((a) => {
      if (several) a.textContent = `${serverLabel(n.h.server)}: ${a.textContent}`;
      return a;
    }));
    el.panelActions.replaceChildren(...actions);
    el.panelActions.hidden = actions.length === 0;

    const rows = all
      .flatMap((h) => (h.session.ready ? h.session.list().map((c) => ({ h, c })) : []))
      .sort((a, b) => b.c.lastAt - a.c.lastAt);
    el.empty.hidden = rows.length > 0 || !all.some((h) => h.session.ready);
    el.list.replaceChildren(...rows.map(({ h, c }) => {
      scope = h;
      try {
        return conversationRow(c, h, several);
      } finally {
        scope = null;
      }
    }));
  }

  function conversationRow(c, h, tagged = false) {
    const li = document.createElement('li');
    li.className = 'dm-row';
    li.dataset.id = String(c.id);
    li.dataset.server = h.key;
    if (c.unread) li.setAttribute('data-unread', '');
    if (c.id === currentId && h === home) li.setAttribute('data-current', '');

    li.append(avatarEl(faceOf(c.peer, ''), 'tiny'));

    const body = document.createElement('div');
    body.className = 'dm-row-body';
    const top = document.createElement('div');
    top.className = 'dm-row-top';
    const name = document.createElement('span');
    name.className = 'dm-row-name';
    name.textContent = peerName(c.peer);
    nameFont(name, c.peer);
    const time = document.createElement('span');
    time.className = 'dm-row-time';
    time.textContent = c.lastAt ? when(c.lastAt) : '';
    if (tagged) {
      // Which server it is on, when the list is every server's.
      const tag = document.createElement('span');
      tag.className = 'dm-row-server';
      tag.textContent = serverLabel(h.server);
      top.append(name, tag, time);
    } else {
      top.append(name, time);
    }

    const line = document.createElement('div');
    line.className = 'dm-row-line';
    const preview = c.last ? previewOf(c.last) : null;
    const text = document.createElement('span');
    text.className = 'dm-row-text';
    if (preview?.unreadable) text.textContent = t('dm.unreadable_short');
    else if (preview?.call) text.textContent = callLine(preview.call, c.last.userId === me());
    else if (preview) {
      // A voice message is not called by its file name.
      const said = isVoiceNote(preview.text, 'audio') ? t('voice.preview') : preview.text;
      text.textContent = c.last.userId === me() ? t('dm.you_prefix', { text: said }) : said;
    }
    line.append(text);
    if (c.unread) {
      const count = document.createElement('span');
      count.className = 'dm-row-count';
      count.textContent = c.unread > 99 ? '99+' : String(c.unread);
      line.append(count);
    }
    body.append(top, line);
    li.append(body);
    li.addEventListener('click', () => openConversation(c.id, h));
    return li;
  }

  /** A line about a call, as a server that wrote one for us would have it. Harmony has none; Ciranda's servers do. */
  function callLine(meta, mine) {
    switch (meta.outcome) {
      case 'ended': {
        const secs = Math.round((meta.durationMs ?? 0) / 1000);
        return t('dm.call_ended', { length: secs < 60 ? `${Math.max(1, secs)} s` : `${Math.floor(secs / 60)} min` });
      }
      case 'declined': return mine ? t('dm.call_declined_by_them') : t('dm.call_declined');
      default: return mine ? t('dm.call_unanswered') : t('dm.call_missed');
    }
  }

  // ------------------------------------------------------------ conversation

  async function openConversation(id, from = home) {
    if (from && from !== home) bind(from);
    if (!session?.ready) return;
    // The stage holds one thing: leaving the channel's chat, and the call's tiles with it.
    closeChat();
    // A voice message is recorded for the conversation it was started in.
    const switching = currentId !== id;
    // Coming back to the conversation that was open, from somewhere else (a channel, the other server), is entering
    // it again too: what came meanwhile is the news, as it is when a channel is opened again.
    const entering = switching || away;
    away = false;
    if (switching) voiceBar.cancel();
    if (switching) setEditing(null);
    currentId = id;
    if (entering) {
      // Taken now: reading the conversation moves the mark.
      const row = session.conversations.get(id);
      newAfter = row?.unread > 0 ? row.lastReadId : null;
    }
    // What was searched is of the conversation that was left.
    if (switching) searchUi.reset();
    replyTo = null;
    setPending(null);
    // The popover closes behind a choice; a list that is docked stays.
    if (!deps.listDocked?.()) el.panel.hidden = true;
    el.active.hidden = false;
    syncPane();
    el.note.textContent = '';
    applyStage();
    renderConversation();
    deps.showConversation?.();
    try {
      await session.load(id);
    } catch (err) {
      el.note.textContent = words(t, err);
      return;
    }
    if (currentId !== id) return;
    renderConversation({ scrollToBottom: true, toNews: entering && newAfter !== null });
    await session.markRead(id);
    el.input.focus();
  }

  /** Somebody's name was right-clicked: open the conversation with them, making it if there is none. */
  async function openWith(userId) {
    const mine = openHome();
    if (mine) bind(mine);
    if (!session) return;
    if (session.state === KeyState.Locked) return showUnlock();
    if (!session.ready) {
      el.panel.hidden = false;
      deps.showConversation?.();
      return render();
    }
    if (session.vault.needsBackup) showRecoveryKey({ first: true });
    try {
      const id = await session.open(userId);
      await openConversation(id);
    } catch (err) {
      showError(words(t, err));
    }
  }

  function setPending(file) {
    pendingFile = file;
    syncRecord();
    el.pending.hidden = !file;
    el.pendingName.textContent = file ? `${file.name} · ${formatBytes(file.bytes.length)}` : '';
  }

  function setReply(message) {
    // Answering and rewriting are two ways of using the same box.
    if (message && editing) setEditing(null);
    replyTo = message ?? null;
    el.reply.hidden = !message;
    if (!message) return;
    el.replyName.textContent = peerName(message.userId);
    el.input.focus();
  }

  /*
   * Rewriting one of your own messages, in the box -- as a channel does it.
   *
   * The box takes the message's words and the bar above it says it is an edit, so that Enter is plainly "save" and
   * not "send". Whatever was half-typed is put back when it ends. Only your own messages can be reached.
   */
  function setEditing(message) {
    if (!message && !editing) return;
    if (message) {
      if (!editing) editDraft = el.input.value;
      setReply(null);
    }
    editing = message ?? null;
    el.editing.hidden = !message;
    el.form.toggleAttribute('data-editing', Boolean(message));
    el.send.title = message ? t('app.save') : t('chat_form.send');
    el.input.value = message ? message.body : editDraft;
    if (!message) editDraft = '';
    for (const row of el.log.children) {
      row.toggleAttribute('data-editing', Boolean(message) && Number(row.dataset.id) === message.id);
    }
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(el.input.scrollHeight, 160)}px`;
    syncRecord();
    if (!message) return;
    el.input.focus();
    const end = el.input.value.length;
    el.input.setSelectionRange(end, end);
    // The message being edited may be far up the log.
    el.log.querySelector('.chat-msg[data-editing]')?.scrollIntoView({ block: 'nearest' });
  }

  /** Whether a message can be rewritten: yours, and a message and not a call or something that could not be opened. */
  const editable = (m) => m.userId === me() && !m.private?.unreadable && !m.private?.call;

  /** The message Up would edit: your latest in this conversation, as far as it is loaded. */
  function lastOwnMessage() {
    return [...session.thread(currentId)].reverse().find(editable) ?? null;
  }

  async function saveEdit() {
    const message = editing;
    if (!message || busy || !session?.ready) return;
    const body = el.input.value.trim();
    // Words can go only if a file stays behind: the same rule as a channel's.
    if (!body && !message.private?.file) return;
    if (body === message.body) {
      setEditing(null);
      return;
    }
    busy = true;
    el.send.disabled = true;
    const ok = await attempt(() => session.edit(message.id, body));
    busy = false;
    el.send.disabled = false;
    // Stay in the edit when it failed: the words are still in the box.
    if (ok && editing?.id === message.id) setEditing(null);
    else syncRecord();
  }

  function renderConversation({ scrollToBottom = false, toNews = false } = {}) {
    const c = session?.conversations.get(currentId);
    if (!c) {
      // Deleted for you, from here or from another window.
      closeConversation();
      return;
    }
    el.headAvatar.replaceChildren(...avatarEl(faceOf(c.peer, '')).childNodes);
    // The name is drawn in a span: a name font sizes itself against what it sits in
    // (fonts.css), and the heading's own size would otherwise override that.
    const label = document.createElement('span');
    label.textContent = peerName(c.peer);
    nameFont(label, c.peer);
    el.name.replaceChildren(label);
    const verified = session.verified(c.peer);
    el.verified.hidden = !verified;
    el.safety.toggleAttribute('data-verified', Boolean(verified));
    renderBanner(c);
    pins.draw();

    const log = el.log;
    const wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const messages = session.thread(currentId);
    // Rewritten or deleted from somewhere else while it is open here.
    if (editing) {
      const live = messages.find((m) => m.id === editing.id);
      if (live) editing = live;
      else setEditing(null);
    }
    parkMedia(log);
    // The line goes before the first message newer than what was read, and the message under it starts a block of
    // its own.
    let dividerDrawn = false;
    const rows = [];
    messages.forEach((m, i, all) => {
      if (newAfter !== null && !dividerDrawn && m.id > newAfter) {
        dividerDrawn = true;
        rows.push(newMessagesDivider(), messageRow(m, undefined));
        return;
      }
      rows.push(messageRow(m, all[i - 1]));
    });
    log.replaceChildren(...rows);
    dropParked();
    el.more.hidden = !session.hasMore(currentId);
    const line = toNews ? log.querySelector('.new-divider') : null;
    if (line) {
      // Opening it with news: the last of what was read, then the line.
      log.scrollTop += line.getBoundingClientRect().top - log.getBoundingClientRect().top - NEWS_CONTEXT_PX;
    } else if (scrollToBottom || wasAtBottom || Date.now() < sendingUntil) {
      log.scrollTop = log.scrollHeight;
      holdBottom();
    }
    paintToBottom();

    const blocked = session.blocked.has(c.peer);
    const noKey = !session.vault.peerHasKey(c.peer);
    el.input.disabled = blocked || noKey;
    el.send.disabled = blocked || noKey;
    el.record.disabled = blocked || noKey;
    el.attach.disabled = blocked || noKey;
    syncRecord();
  }

  /** What stands over the conversation: a changed key, a block, a person who has not set up yet. */
  function renderBanner(c) {
    const name = peerName(c.peer);
    const rows = [];
    const add = (text, ...actions) => {
      const div = document.createElement('div');
      div.className = 'dm-banner-row';
      const span = document.createElement('span');
      span.textContent = text;
      div.append(span, ...actions);
      rows.push(div);
    };
    if (session.blocked.has(c.peer)) {
      add(t('dm.banner.blocked', { name }), button(t('dm.menu.unblock', { name }), () => block(c, false)));
    }
    if (!session.vault.peerHasKey(c.peer)) {
      add(t('dm.banner.no_key', { name }));
    } else if (session.keyChangedFor(c.peer)) {
      add(
        t('dm.banner.key_changed', { name }),
        button(t('dm.banner.compare'), () => showSafety(c)),
        button(t('dm.banner.accept'), () => session.acceptKey(c.peer), 'primary small'),
      );
    }
    el.banner.hidden = rows.length === 0;
    el.banner.replaceChildren(...rows);
  }

  // ---------------------------------------------------------------- one message

  /**
   * What a message says and carries, as the `.text` of a row: its words, the mark that it was edited, its file or
   * picture -- or, for one that cannot be read, or is a call, the line that says so. One place, because the
   * conversation and the results of a search show a message and must show the same one.
   *
   * @returns {{text: HTMLElement, emojiOnly: boolean}}  emojiOnly: nothing but emoji, drawn larger
   */
  function messageContent(message) {
    const mine = message.userId === me();
    const text = document.createElement('span');
    text.className = 'text';
    const marks = message.private;
    let emojiOnly = false;
    if (marks.unreadable) {
      text.classList.add('dm-unreadable');
      text.dataset.icon = 'lock-simple';
      text.append(document.createTextNode(marks.outOfPlace ? t('dm.out_of_place') : t('dm.unreadable')));
    } else if (marks.call) {
      text.classList.add('dm-call');
      text.append(document.createTextNode(callLine(marks.call, mine)));
    } else {
      emojiOnly = Boolean(renderBody(text, message.body));
      if (message.editedAt) {
        const edited = document.createElement('span');
        edited.className = 'edited-mark';
        edited.textContent = t('dm.edited');
        edited.title = new Date(message.editedAt).toLocaleString();
        text.append(edited);
      }
      if (marks.file) text.append(attachmentNode(message));
      // The card for the first link, as in a channel -- asked of the server that holds this conversation, which is
      // then told the address of the link (see the setting).
      const home_ = scope ?? home;
      if (home_ && state.settings?.linkPreviews !== false && state.settings?.dmLinkPreviews !== false) {
        const address = firstLink(message.body);
        const card = address && linkEmbed({
          server: home_.server,
          // Not a bare number: a channel's messages have ids on this server too.
          messageId: `dm-${message.id}`,
          url: address,
          load: (url) => harmony.api.linkPreview(home_.server, url),
          mediaUrl: (hash) => harmony.mediaUrl(hash, home_.server),
          link: deps.linkNode,
          t,
        });
        if (card) text.append(card);
      }
      if (marks.unconfirmed) {
        const warn = document.createElement('span');
        warn.className = 'dm-unconfirmed';
        warn.textContent = t('dm.unconfirmed');
        text.append(warn);
      }
    }
    return { text, emojiOnly };
  }

  /** One message row: the same parts and classes as a channel's, minus pins and admin powers. */
  function messageRow(message, previous) {
    const mine = message.userId === me();
    const row = document.createElement('div');
    row.className = 'chat-msg';
    row.dataset.id = String(message.id);
    if (message.pinned) row.setAttribute('data-pinned', '');
    if (isStarred(message)) row.setAttribute('data-starred', '');
    if (editing?.id === message.id) row.setAttribute('data-editing', '');

    const grouped = Boolean(previous)
      && previous.userId === message.userId
      // A pin marks a message out: swallowing the one under it into the same block hides which one was pinned.
      && !previous.pinned
      && !message.pinned
      && !message.reply
      && message.createdAt - previous.createdAt < GROUP_WINDOW_MS;
    if (grouped) row.setAttribute('data-grouped', '');

    const { text, emojiOnly } = messageContent(message);
    if (emojiOnly) row.setAttribute('data-emoji-only', '');
    const marks = message.private;

    const time = document.createElement('span');
    time.className = 'when';
    time.textContent = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    time.title = new Date(message.createdAt).toLocaleString();

    const tools = document.createElement('span');
    tools.className = 'msg-tools';
    const tool = (icon, label, run, danger = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `msg-tool${danger ? ' msg-tool-danger' : ''}`;
      b.dataset.icon = icon;
      b.textContent = label;
      b.title = label;
      b.addEventListener('click', run);
      return b;
    };
    const readable = !marks.unreadable && !marks.call;
    if (readable) {
      tools.append(tool('arrow-bend-up-left', t('app.reply'), () => setReply(message)));
      const react = tool('smiley', t('app.react'), () => openEmojiPicker(react, (value) => {
        closeEmojiPicker();
        toggleReaction(message.id, value);
      }));
      react.classList.add('react-btn');
      react.title = t('app.add_a_reaction');
      tools.append(react);
      const starred = isStarred(message);
      const star = tool('star', starred ? t('stars.unstar') : t('stars.star'), () => toggleStar(message));
      star.classList.add('star-tool');
      if (starred) star.setAttribute('data-on', '');
      tools.append(star);
      const pin = tool('push-pin', message.pinned ? t('app.unpin') : t('app.pin'), () => attempt(() => session.pin(message.id, !message.pinned)));
      if (message.pinned) pin.setAttribute('data-on', '');
      tools.append(pin);
      if (message.attachmentHash && marks.file) tools.append(tool('download-simple', t('app.download'), () => saveFile(message)));
      if (mine) tools.append(tool('pencil-simple', t('app.edit_2'), () => setEditing(message)));
    }
    if (mine && !marks.call) tools.append(tool('trash', t('app.delete_2'), () => removeMessage(message), true));

    const gutter = grouped ? time : avatarEl(faceOf(message.userId, ''), 'msg-avatar');
    if (grouped) time.classList.add('when-gutter');

    const main = document.createElement('div');
    main.className = 'msg-main';
    if (!grouped) {
      const head = document.createElement('div');
      head.className = 'msg-head';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = peerName(message.userId);
      nameFont(who, message.userId);
      head.append(who, time);
      main.append(head);
    }
    main.append(text);
    row.append(gutter, main, tools);
    if (message.reply) {
      row.setAttribute('data-reply', '');
      row.prepend(replyLine(message.reply));
    }
    if (message.reactions.length) main.append(reactionRow(message));
    return row;
  }

  function replyLine(reply) {
    const line = document.createElement('div');
    line.className = 'msg-reply';
    const who = document.createElement('span');
    who.className = 'msg-reply-who';
    who.textContent = `@${peerName(reply.userId)}`;
    const text = document.createElement('span');
    text.className = 'msg-reply-text';
    if (reply.deleted) {
      text.classList.add('msg-reply-gone');
      text.textContent = t('app.the_original_message_was_deleted');
    } else if ((reply.body ?? '').trim()) {
      renderBody(text, reply.body.replace(/\s+/g, ' '));
    } else {
      text.classList.add('msg-reply-gone');
      text.textContent = isVoiceNote(reply.attachmentName, 'audio') ? t('voice.preview') : reply.attachmentName ?? '';
    }
    line.append(avatarEl(faceOf(reply.userId, ''), 'reply-avatar'), who, text);
    line.title = t('app.go_to_the_message_this');
    line.addEventListener('click', () => {
      const target = el.log.querySelector(`.chat-msg[data-id="${reply.id}"]`);
      if (!target) return;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.setAttribute('data-jumped', '');
      setTimeout(() => target.removeAttribute('data-jumped'), 1600);
    });
    return line;
  }

  function reactionRow(message) {
    const row = document.createElement('div');
    row.className = 'reactions';
    for (const reaction of message.reactions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'reaction';
      if (reaction.userIds.includes(me())) b.setAttribute('data-mine', '');
      b.title = reaction.userIds.map((id) => peerName(id)).join(', ');
      b.addEventListener('click', () => toggleReaction(message.id, reaction.emoji));
      appendEmoji(b, reaction.emoji);
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(reaction.count);
      b.append(count);
      row.append(b);
    }
    return row;
  }

  /** The file of a message: opened when it is drawn, a placeholder until then. */
  function attachmentNode(message) {
    const f = message.private.file;
    // Drawn once it is open: fetched and opened here, on this computer.
    const media = ['image', 'video', 'audio'].includes(message.mediaType) && f.size <= 25 * 1024 * 1024;

    // What cannot be looked at is a card, as in the channels; what can is the
    // thing itself with a line under it.
    if (!media) {
      const name = f.name || t('app.attachment');
      const size = f.size ? formatBytes(f.size) : '';
      const card = previewsAsText(f.name, f.size)
        ? textCard({
          name,
          bytes: Number(f.size),
          size,
          // Opened here, on this computer, like any other file of the conversation.
          head: async () => {
            const opened = await session.file(message);
            if (!opened) return new Uint8Array();
            return new Uint8Array(await opened.blob.slice(0, TEXT_PREVIEW_BYTES).arrayBuffer());
          },
          onOpen: () => saveFile(message),
          key: `dm:${message.id}:${f.key}`,
          t,
        })
        : fileCard({
          name,
          size,
          mediaType: message.mediaType,
          title: t('app.download'),
          onOpen: () => saveFile(message),
        });
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'msg-tool';
      save.dataset.icon = 'download-simple';
      save.title = t('app.download');
      save.setAttribute('aria-label', t('app.download'));
      save.addEventListener('click', (event) => {
        event.stopPropagation();
        saveFile(message);
      });
      const tools = document.createElement('span');
      tools.className = 'attachment-tools inline';
      tools.append(save);
      card.end.append(tools);
      return card.wrap;
    }

    // A voice message is its own player.
    if (isVoiceNote(f.name, message.mediaType)) {
      return voiceNote({
        key: `${message.id}:${f.key}`,
        load: async () => {
          const opened = await session.file(message);
          if (!opened) throw new Error('unreadable');
          return opened.blob.arrayBuffer();
        },
        sinkId: () => state.settings?.voiceOutputId ?? '',
        volume: () => (state.settings?.masterVolume ?? 100) / 100,
        t,
      });
    }

    const wrap = document.createElement('span');
    wrap.className = 'attachment';
    const bar = document.createElement('span');
    bar.className = 'attachment-bar';
    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = f.name || t('app.attachment');
    name.title = name.textContent;
    bar.append(name);
    if (f.size) {
      const size = document.createElement('span');
      size.className = 'attachment-size';
      size.textContent = formatBytes(f.size);
      bar.append(size);
    }
    wrap.append(bar);

    // One that is playing is kept through a redraw of the conversation: see media-keep.js.
    const key = `${currentId}#${message.id}#${f.key}`;
    const kept = message.mediaType === 'image' ? null : takeMedia(key);
    if (kept) {
      wrap.prepend(kept);
      return wrap;
    }
    session.file(message).then((opened) => {
      if (!opened?.inline) return;
      let node;
      if (message.mediaType === 'image') {
        node = document.createElement('img');
        node.alt = f.name;
      } else {
        node = keepable(document.createElement(message.mediaType), key);
        node.controls = true;
      }
      node.src = opened.url;
      wrap.prepend(node);
    }).catch(() => {});
    return wrap;
  }

  async function saveFile(message) {
    try {
      const opened = await session.file(message);
      if (!opened) {
        el.note.textContent = t('dm.file_unreadable');
        return;
      }
      const a = document.createElement('a');
      a.href = opened.url;
      a.download = opened.name || 'file';
      document.body.append(a);
      a.click();
      a.remove();
    } catch (err) {
      el.note.textContent = words(t, err);
    }
  }

  // ---------------------------------------------------------------- doing things

  async function attempt(run) {
    try {
      await run();
      el.note.textContent = '';
      return true;
    } catch (err) {
      el.note.textContent = words(t, err);
      return false;
    }
  }

  const toggleReaction = (id, emoji) => attempt(() => session.toggleReaction(id, emoji));

  async function removeMessage(message) {
    if (!await askConfirm(t('app.delete_this_message'), { okLabel: t('app.delete_2') })) return;
    await attempt(() => session.remove(message.id));
  }

  async function block(c, on) {
    await attempt(() => session.setBlocked(c.peer, on));
  }

  async function clearConversation(c) {
    const name = peerName(c.peer);
    if (!await askConfirm(t('dm.clear.title'), { okLabel: t('dm.clear.ok'), text: t('dm.clear.text', { name }) })) return;
    if (await attempt(() => session.clear(c.id))) closeConversation();
  }

  async function submit() {
    if (editing) return saveEdit();
    if (busy || !session?.ready || currentId === null) return;
    const body = el.input.value.trim();
    if (!body && !pendingFile) return;
    busy = true;
    el.send.disabled = true;
    // Sending takes you to what you sent, wherever you were reading: until it is drawn, the log follows.
    sendingUntil = Infinity;
    const ok = await attempt(() => session.send(currentId, { body, file: pendingFile, reply: replyTo }));
    sendingUntil = Date.now() + 2000;
    busy = false;
    el.send.disabled = false;
    if (!ok) return;
    el.input.value = '';
    el.input.style.height = '';
    setPending(null);
    setReply(null);
    syncRecord();
    releaseHold();
    el.log.scrollTop = el.log.scrollHeight;
    holdBottom();
    paintToBottom();
    await session.markRead(currentId);
  }

  async function pickFile(file) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      el.note.textContent = t('dm.error.file_too_large');
      return;
    }
    setPending({ name: file.name, mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
  }

  // ------------------------------------------------------------- the small menu

  function closeMenu() {
    menu?.remove();
    menu = null;
  }

  function openMenu() {
    if (menu) return closeMenu();
    const c = session?.conversations.get(currentId);
    if (!c) return undefined;
    const name = peerName(c.peer);
    menu = document.createElement('div');
    menu.className = 'peer-menu dm-menu';
    const item = (label, run, danger = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ghost menu-item${danger ? ' danger' : ''}`;
      b.textContent = label;
      b.addEventListener('click', () => { closeMenu(); run(); });
      return b;
    };
    menu.append(
      item(t('dm.safety.menu'), () => showSafety(c)),
      item(session.blocked.has(c.peer) ? t('dm.menu.unblock', { name }) : t('dm.menu.block', { name }), () => block(c, !session.blocked.has(c.peer))),
      item(t('dm.menu.clear'), () => clearConversation(c), true),
    );
    const box = el.menuButton.getBoundingClientRect();
    menu.style.top = `${box.bottom + 4}px`;
    menu.style.right = `${Math.max(8, window.innerWidth - box.right)}px`;
    document.body.append(menu);
    return undefined;
  }

  // -------------------------------------------------------------------- dialogs

  /** A dialog of its own, made when first needed: the keys are shown once and not otherwise on screen. */
  function dialog() {
    if (!keysDialog) {
      keysDialog = document.createElement('dialog');
      keysDialog.className = 'ask dm-keys';
      document.body.append(keysDialog);
    }
    return keysDialog;
  }

  function section(...children) {
    const d = dialog();
    d.replaceChildren(...children);
    if (!d.open) d.showModal();
    return d;
  }

  const heading = (text) => {
    const h = document.createElement('h2');
    h.textContent = text;
    return h;
  };

  const paragraph = (text, className = 'muted') => {
    const p = document.createElement('p');
    p.className = className;
    p.textContent = text;
    return p;
  };

  /** The recovery key, once: the only way to this account's messages on another computer. */
  async function showRecoveryKey({ first = false }) {
    if (!session?.ready) return;
    let shown = session.vault.recovery();
    if (!shown) {
      // Already kept somewhere: a new one is a new key to keep, and the old one stops opening it.
      try {
        shown = await session.newRecoveryKey();
      } catch (err) {
        showError(words(t, err));
        return;
      }
    }
    const box = document.createElement('div');
    box.className = 'dm-recovery';
    box.textContent = shown;
    box.setAttribute('data-testid', 'recovery-key');

    const copy = button(t('dm.keys.copy'), async () => {
      try {
        await navigator.clipboard.writeText(shown);
        copy.textContent = t('dm.keys.copied');
      } catch { /* the key is on screen to be copied by hand */ }
    });
    copy.dataset.icon = 'copy';

    const saved = button(t('dm.keys.saved'), async () => {
      await session.markBackedUp();
      keysDialog.close();
      render();
    }, 'primary');
    const later = button(t('dm.keys.later'), () => keysDialog.close(), 'ghost');

    section(
      heading(t('dm.keys.setup_title')),
      paragraph(first ? t('dm.keys.setup_text') : t('dm.keys.setup_text_new')),
      box,
      (() => {
        const row = document.createElement('div');
        row.className = 'ask-buttons';
        row.append(copy, later, saved);
        return row;
      })(),
    );
  }

  /** This account has a key made elsewhere: its recovery key opens it here. */
  function showUnlock() {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dm-recovery-input';
    input.placeholder = t('dm.keys.unlock_placeholder');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.id = 'dm-recovery-input';
    const error = paragraph('', 'error');
    error.hidden = true;

    const unlock = button(t('dm.keys.unlock'), async () => {
      error.hidden = true;
      if (!await session.unlock(input.value)) {
        error.textContent = t('dm.keys.wrong');
        error.hidden = false;
        return;
      }
      keysDialog.close();
      render();
    }, 'primary');
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); unlock.click(); }
    });
    const lost = button(t('dm.keys.lost'), async () => {
      if (!await askConfirm(t('dm.keys.start_over_title'), { okLabel: t('dm.keys.start_over'), text: t('dm.keys.start_over_text') })) return;
      await session.startOver();
      keysDialog.close();
      render();
      if (session.ready && session.vault.needsBackup) showRecoveryKey({ first: true });
    }, 'ghost danger');
    const cancel = button(t('dm.keys.later'), () => keysDialog.close(), 'ghost');

    const row = document.createElement('div');
    row.className = 'ask-buttons';
    row.append(lost, cancel, unlock);
    section(heading(t('dm.keys.unlock_title')), paragraph(t('dm.keys.unlock_text')), input, error, row);
    input.focus();
  }

  /** The number to read out loud: the same on both screens exactly when nobody is in between. */
  function showSafety(c) {
    const name = peerName(c.peer);
    const number = session.safetyNumber(c.peer);
    if (!number) return;
    const box = document.createElement('div');
    box.className = 'dm-recovery dm-safety-number';
    box.textContent = number;
    const verified = session.verified(c.peer);
    const toggle = button(
      verified ? t('dm.safety.unverify') : t('dm.safety.verify'),
      () => { session.setVerified(c.peer, !verified); keysDialog.close(); },
      verified ? 'ghost' : 'primary',
    );
    const close = button(t('dm.close'), () => keysDialog.close(), 'ghost');
    const row = document.createElement('div');
    row.className = 'ask-buttons';
    row.append(close, toggle);
    section(heading(t('dm.safety.title', { name })), paragraph(t('dm.safety.text', { name })), box, row);
  }

  // --------------------------------------------------------------------- events

  /**
   * The server's pushes about private conversations. Returns whether this was
   * one: the app's handler passes everything through here first.
   */
  function handleEvent(msg) {
    if (!(msg.type?.startsWith('dm:') || msg.type === 'keys:changed')) return false;
    // Every connection says which server it is; a frame without one is the bound one's.
    const mine = msg.server ? homes.get(msg.server) : home;
    if (!mine) return false;
    mine.session.handle(msg).then(async ({ incoming, conversation }) => {
      if (!incoming) return;
      if (mine === home && conversation.id === currentId && isLookingAtIt()) {
        await mine.session.markRead(currentId);
        return;
      }
      // Its own sound, not the mention's: a private message and somebody writing your name are not the same news.
      if (state.settings?.mentionSound !== false) playCue('dm');
    }).catch(() => {});
    return true;
  }

  // ------------------------------------------------------------------- wiring

  function togglePanel() {
    if (!homes.size) return;
    el.panel.hidden = !el.panel.hidden;
    if (!el.panel.hidden) {
      render();
      refreshAll();
    }
  }

  /**
   * Whether the open conversation is being looked at right now: the window has the focus and the pane is on screen.
   * Not offsetParent for that, which is null for anything positioned fixed (the pane is, on a phone) and would
   * have kept every message unread there.
   */
  function isLookingAtIt() {
    return currentId !== null && document.hasFocus() && !el.active.hidden && el.active.getClientRects().length > 0;
  }

  /*
   * A message that came while the window was elsewhere is read when it comes back. It was only ever read as it
   * arrived, so one that came while the window was not focused stayed counted until you sent something or opened
   * another conversation and returned.
   */
  function readWhatIsOpen() {
    if (!session?.ready || !isLookingAtIt()) return;
    session.markRead(currentId).catch(() => {});
  }
  window.addEventListener('focus', readWhatIsOpen);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) readWhatIsOpen(); });

  /** Every server's list, asked for again. */
  function refreshAll() {
    for (const h of homes.values()) if (h.session.ready) h.session.refresh().catch(() => {});
  }
  el.panelClose.addEventListener('click', () => { el.panel.hidden = true; });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.panel.hidden) el.panel.hidden = true;
  });
  document.addEventListener('click', (event) => {
    if (menu && !menu.contains(event.target) && !el.menuButton.contains(event.target)) closeMenu();
    if (!deps.listDocked?.() && !el.panel.hidden && !el.panel.contains(event.target)
      // The rail's bubble opens it too: its own click is not a click away.
      && !event.target.closest?.('[data-dm-trigger]')) el.panel.hidden = true;
  });
  el.close.addEventListener('click', closeConversation);
  el.menuButton.addEventListener('click', openMenu);
  el.safety.addEventListener('click', () => {
    const c = session?.conversations.get(currentId);
    if (c) showSafety(c);
  });
  el.more.addEventListener('click', () => attempt(async () => {
    const before = el.log.scrollHeight;
    await session.loadOlder(currentId);
    el.log.scrollTop += el.log.scrollHeight - before;
  }));
  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  el.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
    // Esc lets go of an edit, as in a channel.
    if (event.key === 'Escape' && editing && !event.defaultPrevented) {
      setEditing(null);
      return;
    }
    // Up, in an empty box, rewrites your last message -- only when nothing else is in progress, so it can never
    // cost anybody a draft, a reply or a file that was on its way.
    if (event.key === 'ArrowUp' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
      && !event.isComposing && !el.input.value && !editing && !replyTo && !pendingFile && session?.ready) {
      const last = lastOwnMessage();
      if (last) {
        event.preventDefault();
        setEditing(last);
      }
    }
  });
  el.input.addEventListener('input', () => {
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(el.input.scrollHeight, 160)}px`;
    syncRecord();
  });
  /*
   * Paste a file straight into the box -- a screenshot, or a file copied in
   * the file manager -- as the channels' box does. Text is left alone: only a
   * paste that carries a file is taken over. A pasted picture has no name of
   * its own ("image.png", every time), so it gets a dated one.
   */
  el.input.addEventListener('paste', (event) => {
    const file = [...(event.clipboardData?.files ?? [])][0];
    if (!file) return;
    event.preventDefault();
    const generic = file.type.startsWith('image/') && (!file.name || /^image\.[a-z0-9]+$/i.test(file.name));
    if (!generic) {
      pickFile(file);
      return;
    }
    const extension = file.type.split('/')[1]?.split('+')[0] ?? 'png';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    pickFile(new File([file], `pasted-${stamp}.${extension}`, { type: file.type }));
  });
  el.attach.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => {
    pickFile(el.file.files?.[0]);
    el.file.value = '';
  });
  el.pendingClear.addEventListener('click', () => setPending(null));
  el.replyClear.addEventListener('click', () => setReply(null));
  el.editingClear.addEventListener('click', () => {
    setEditing(null);
    el.input.focus();
  });
  el.emoji.addEventListener('click', () => openEmojiPicker(el.emoji, (value) => {
    closeEmojiPicker();
    const start = el.input.selectionStart ?? el.input.value.length;
    const end = el.input.selectionEnd ?? start;
    el.input.setRangeText(value, start, end, 'end');
    el.input.focus();
  }));

  /** Whether a file dropped on the window would go into this conversation. */
  const acceptsFiles = () => currentId !== null && !el.active.hidden && !el.input.disabled;

  /** The "drop it here" cover over the conversation, while a file is dragged over the window. */
  function showDrop(on) {
    if (!on) {
      el.drop.hidden = true;
      return;
    }
    if (!el.drop.hidden) return;
    const c = session?.conversations.get(currentId);
    el.dropTitle.textContent = t('dm.drop_title', { name: c ? peerName(c.peer) : '' });
    el.drop.hidden = false;
  }

  /** Files dropped on it: the first is attached, as the channels' box does. */
  function dropFiles(files) {
    const [file] = files;
    if (!file) return;
    el.note.textContent = files.length > 1 ? t('app.one_file_per_message_is', { name: file.name }) : '';
    pickFile(file);
    el.input.focus();
  }

  // ------------------------------------------------- the line, the button, and finding things

  /** Where the new messages begin, as in a channel's log. */
  function newMessagesDivider() {
    const line = document.createElement('div');
    line.className = 'new-divider';
    line.setAttribute('role', 'separator');
    const label = document.createElement('span');
    label.textContent = t('chat.new_messages');
    line.append(label);
    return line;
  }

  /*
   * Staying at the newest message while the page settles, as a channel's log does.
   *
   * Going to the bottom once, when the rows are drawn, lands somewhere short of it for as long as anything below is
   * still growing: a picture arrives, the card for a link fills in, and the message that holds it gets taller. So for
   * a few seconds after landing at the bottom, any row changing size puts it back there. The reader's own scrolling
   * ends that at once, so somebody who has begun to read up is never taken down again.
   */
  let hold = null;
  function releaseHold() {
    if (!hold) return;
    const { observer, timer, stop } = hold;
    hold = null;
    observer.disconnect();
    clearTimeout(timer);
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) el.log.removeEventListener(name, stop, true);
  }
  function holdBottom() {
    releaseHold();
    const log = el.log;
    const observer = new ResizeObserver(() => {
      log.scrollTop = log.scrollHeight;
      paintToBottom();
    });
    for (const row of log.children) observer.observe(row);
    const stop = () => releaseHold();
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      log.addEventListener(name, stop, { capture: true, passive: true });
    }
    hold = { observer, stop, timer: setTimeout(releaseHold, HOLD_MS) };
  }

  /** The button beside the scroll bar: there while there is more below than a screen's worth of nothing. */
  function paintToBottom() {
    const log = el.log;
    const away = log.scrollHeight - log.scrollTop - log.clientHeight > BOTTOM_PX * 3;
    el.toBottom.hidden = !away || !log.clientHeight;
  }
  el.log.addEventListener('scroll', paintToBottom, { passive: true });
  el.toBottom.addEventListener('click', () => {
    releaseHold();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.log.scrollTo({ top: el.log.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  });

  /**
   * Looks through the conversation for a search. What the server holds of it is sealed, so it is done here: every
   * message is read from the server and opened (see DmSession.scan), and the filters are applied to what was said.
   * The request is the one a channel's search sends, and only the parts a conversation has are looked at.
   */
  async function searchConversation(request, progress) {
    const found = session;
    const id = currentId;
    if (id === null || !found?.ready) return { total: 0, capped: false, results: [] };
    const everything = await found.scan(id, { onPage: progress });

    const words = String(request.q ?? '').trim().toLowerCase();
    const from = new Set(String(request.from ?? '').split(',').filter(Boolean).map(Number));
    const has = String(request.has ?? '').split(',').filter(Boolean);
    const hasLink = (m) => /https?:\/\//i.test(m.body);
    const tests = {
      link: hasLink,
      embed: hasLink,
      file: (m) => Boolean(m.attachmentHash && m.private.file),
      image: (m) => Boolean(m.private.file) && m.mediaType === 'image',
      video: (m) => Boolean(m.private.file) && m.mediaType === 'video',
      audio: (m) => Boolean(m.private.file) && m.mediaType === 'audio',
      sound: (m) => Boolean(m.private.file) && m.mediaType === 'audio',
    };
    const matching = everything.filter((m) => {
      // What could not be opened, and the lines about calls, have no words to look in.
      if (m.private.unreadable || m.private.call) return false;
      if (words && !`${m.body} ${m.attachmentName ?? ''}`.toLowerCase().includes(words)) return false;
      if (from.size && !from.has(m.userId)) return false;
      if (has.some((kind) => !(tests[kind]?.(m) ?? true))) return false;
      if (Number.isFinite(request.after) && !(m.createdAt > request.after)) return false;
      if (Number.isFinite(request.before) && !(m.createdAt < request.before)) return false;
      return true;
    });
    if (request.sort !== 'old') matching.reverse();
    const offset = Math.max(0, Number(request.offset) || 0);
    const limit = Math.max(1, Number(request.limit) || 25);
    return { total: matching.length, capped: false, results: matching.slice(offset, offset + limit) };
  }

  /**
   * Goes to a message of the open conversation, reading older pages until it is there. The conversation opens on
   * its newest fifty, and what a search found may be a long way above.
   */
  async function jumpToMessage(message) {
    // Going somewhere other than the end: staying at it would put the log back there.
    releaseHold();
    const find = () => el.log.querySelector(`.chat-msg[data-id="${message.id}"]`);
    let row = find();
    for (let pages = 0; !row && session?.hasMore(currentId) && pages < JUMP_MAX_PAGES; pages += 1) {
      try {
        await session.loadOlder(currentId);
      } catch {
        break;
      }
      row = find();
    }
    if (!row) {
      el.note.textContent = t('app.that_message_is_no_longer');
      return;
    }
    el.note.textContent = '';
    // Drawing the log again re-arms it (renderConversation does, at the end): once more, just before the scroll.
    releaseHold();
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // A flash rather than a lasting highlight: it answers "which one" and then stops competing with the message.
    row.setAttribute('data-jumped', '');
    setTimeout(() => row.removeAttribute('data-jumped'), 1600);
  }

  /** The pictures of pinned files, opened once and kept: the strip is drawn again at every change. */
  const pinPictures = new Map();

  /** What is pinned in the open conversation: the strip under the header, and the panel from the pin in it. */
  const pins = createPins({
    ids: { button: 'dm-pins', pop: 'dm-pins-pop', list: 'dm-pins-list', strip: 'dm-pinned' },
    t,
    displayOf,
    faceOf,
    avatarEl,
    nameFont,
    whoOf: (m) => peerName(m.userId),
    messageContent,
    items: () => (currentId === null ? [] : session?.pinned(currentId) ?? []),
    // A pinned file shows what it is in the strip: its icon, and its picture once it is opened here (it is sealed).
    preview: (m) => {
      if (!m.private.file) return null;
      const thumb = attachmentThumb(m.attachmentName, m.mediaType);
      if (m.mediaType === 'image' && m.attachmentBytes <= 8 * 1024 * 1024) {
        const key = `${home?.key}:${m.id}`;
        if (pinPictures.has(key)) {
          thumb.showPicture(pinPictures.get(key));
        } else {
          session.file(m).then((opened) => {
            if (!opened) return;
            pinPictures.set(key, URL.createObjectURL(opened.blob));
            pins.draw();
          }).catch(() => {});
        }
      }
      return thumb;
    },
    jump: jumpToMessage,
    unpin: (m) => session.pin(m.id, false),
    onError: (err) => { el.note.textContent = words(t, err); },
  });

  // ---------------------------------------------------------------- starred messages

  /*
   * A star is the person's own and kept on this computer (see stars-store.js). What a private message says is not
   * written to disk in the clear anywhere else, so a starred one is kept SEALED under the account's own key and is
   * read back only where the keys are: on a computer that has not unlocked private messages it is a locked card.
   */
  const starScopeOf = (h) => `${h.key}#${h.meId}`;
  const starWhat = (id) => `star/dm/${id}`;
  const isStarred = (message) => Boolean(home) && stars.has(starScopeOf(home), 'dm', message.id);

  function toggleStar(message) {
    if (!home || !session) return;
    const keep = starScopeOf(home);
    try {
      if (stars.has(keep, 'dm', message.id)) {
        stars.remove(keep, 'dm', message.id);
      } else {
        // What a card needs to be drawn; not the file itself, which stays where it is.
        const snapshot = JSON.stringify({
          id: message.id,
          conversationId: message.conversationId,
          userId: message.userId,
          body: message.body,
          createdAt: message.createdAt,
          editedAt: message.editedAt ?? null,
          attachmentName: message.private.file ? message.attachmentName : null,
          attachmentBytes: message.private.file ? message.attachmentBytes : null,
        });
        const sealed = session.vault.sealLocal(starWhat(message.id), snapshot);
        if (!sealed) {
          el.note.textContent = t('stars.dm_locked');
          return;
        }
        stars.add(keep, {
          kind: 'dm', id: message.id, conversationId: message.conversationId, peer: conversationOpen()?.peer ?? null,
          key: sealed.key, sealed: sealed.sealed,
        });
      }
      el.note.textContent = '';
    } catch (err) {
      el.note.textContent = err instanceof StarError && err.code === 'too_many' ? t('stars.too_many') : words(t, err);
    }
  }

  /** A starred message read back, as the card draws it: null where it can't be opened (keys locked, or lost). */
  function openStar(h, entry) {
    const text = h.session.vault.openLocal(entry.key, starWhat(entry.id), entry.sealed);
    if (text === null) return null;
    try {
      const kept = JSON.parse(text);
      return {
        ...kept,
        reply: null,
        reactions: [],
        pinned: false,
        private: { file: null, call: null, unreadable: false, outOfPlace: false, unconfirmed: false },
      };
    } catch {
      return null;
    }
  }

  /** From a card: to the conversation it was in, on its server, and to the message. */
  async function goToStar(h, entry) {
    starsUi.close();
    if (!h.session.ready) {
      el.note.textContent = t('stars.dm_unreadable');
      return;
    }
    if (!h.session.conversations.has(entry.conversationId)) {
      el.note.textContent = t('stars.dm_gone');
      return;
    }
    await openConversation(entry.conversationId, h);
    await jumpToMessage({ id: entry.id });
  }

  /** Every private message starred, on every server: a card each, the one starred last first. */
  function starItems() {
    const several = homes.size > 1;
    const out = [];
    for (const h of homes.values()) {
      const keep = starScopeOf(h);
      for (const entry of stars.list(keep, 'dm')) {
        scope = h;
        try {
          const message = openStar(h, entry);
          const peer = entry.peer != null ? peerName(entry.peer) : '';
          const where = several ? `${peer} · ${serverLabel(h.server)}` : peer;
          const author = message ? peerName(message.userId) : peer;
          out.push({
            savedAt: entry.savedAt,
            key: `${h.key}:${entry.id}`,
            searchText: [author, message?.body, message?.attachmentName, peer].filter(Boolean).join(' '),
            card: () => {
              scope = h;
              try {
                const who = document.createElement('strong');
                who.textContent = author;
                nameFont(who, message?.userId ?? entry.peer);
                const unstar = toolButton('x', t('stars.unstar'), () => stars.remove(keep, 'dm', entry.id));
                if (!message) {
                  const locked = document.createElement('span');
                  locked.className = 'text dm-unreadable';
                  locked.dataset.icon = 'lock-simple';
                  locked.textContent = t('stars.dm_unreadable');
                  return messageCard({
                    t,
                    avatar: avatarEl(faceOf(entry.peer, ''), 'msg-avatar'),
                    who,
                    createdAt: entry.savedAt,
                    where,
                    content: { text: locked, emojiOnly: false },
                    go: () => { el.note.textContent = t('stars.dm_unreadable'); },
                    actions: [unstar],
                  });
                }
                const content = messageContent(message);
                if (message.attachmentName) {
                  const file = document.createElement('div');
                  file.className = 'dm-star-file muted';
                  file.dataset.icon = 'paperclip';
                  file.textContent = t('stars.attachment', { name: message.attachmentName });
                  content.text.append(file);
                }
                return messageCard({
                  t,
                  avatar: avatarEl(faceOf(message.userId, ''), 'msg-avatar'),
                  who,
                  createdAt: message.createdAt,
                  where,
                  content,
                  go: () => goToStar(h, entry),
                  actions: [unstar],
                });
              } finally {
                scope = null;
              }
            },
          });
        } finally {
          scope = null;
        }
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  const starsUi = createStarsUi({
    ids: { button: 'dm-stars', pop: 'dm-stars-pop', list: 'dm-stars-list', search: 'dm-stars-search', clear: 'dm-stars-clear', count: 'dm-stars-count' },
    t,
    items: starItems,
  });
  // Starred or let go from anywhere -- the log, the panel -- both are drawn from the list.
  stars.onChange(() => {
    starsUi.draw();
    if (!home) return;
    const keep = starScopeOf(home);
    for (const row of el.log.querySelectorAll('.chat-msg[data-id]')) {
      const on = stars.has(keep, 'dm', Number(row.dataset.id));
      if (on === row.hasAttribute('data-starred')) continue;
      row.toggleAttribute('data-starred', on);
      const tool = row.querySelector('.star-tool');
      if (!tool) continue;
      tool.toggleAttribute('data-on', on);
      tool.textContent = on ? t('stars.unstar') : t('stars.star');
      tool.title = tool.textContent;
    }
  });

  const phone = window.matchMedia('(max-width: 720px), (pointer: coarse) and (max-height: 500px)');
  const conversationOpen = () => session?.conversations.get(currentId) ?? null;

  /** The box in the conversation's header: the same as a channel's, with the parts a conversation has. */
  const searchUi = createSearchUi({
    ids: {
      box: 'dm-search-box', input: 'dm-search', chips: 'dm-search-chips', clear: 'dm-search-clear', pop: 'dm-search-pop',
      panel: 'dm-search-results', count: 'dm-sr-count', filters: 'dm-sr-filters', sort: 'dm-sr-sort', close: 'dm-sr-close',
      body: 'dm-sr-body', pager: 'dm-sr-pager', sortMenu: 'dm-sr-sort-menu',
    },
    // Who wrote it, what it holds and when: no channels to be in, nobody else to mention, nothing pinned.
    kinds: ['from', 'has', 'before', 'during', 'after'],
    hasKinds: ['link', 'file', 'image', 'video', 'sound'],
    state,
    harmony,
    t,
    displayOf,
    faceOf,
    avatarEl,
    nameFont,
    // The two of them.
    people: () => {
      const peer = conversationOpen()?.peer;
      return [...new Set([me(), peer].filter((id) => id != null))].map((id) => ({ id, nickname: peerName(id), label: peerName(id) }));
    },
    search: searchConversation,
    messageContent,
    historyKey: () => `${home?.key ?? ''}#dm`,
    placeholder: () => {
      const open = conversationOpen();
      return open ? t('search.placeholder_in', { name: peerName(open.peer) }) : t('search.placeholder');
    },
    host: () => el.active,
    jump: jumpToMessage,
    isNarrow: () => phone.matches,
  });

  /** What a message says, as it was written, for copying. */
  const bodyOf = (id) => session?.messageById(Number(id))?.body ?? null;

  return {
    start, startBackground, stop, release, openWith, handleEvent, closeConversation, isOpen, togglePanel,
    render, refreshAll,
    acceptsFiles, showDrop, dropFiles, bodyOf,
    get session() { return session; },
    /** Messages waiting, over every conversation on every server. */
    get unread() { return totalUnread(); },
    /** Whether somebody can be written to from here: the open server takes part. */
    get available() { const mine = openHome(); return Boolean(mine) && mine.session.state !== KeyState.Unsupported; },
    /** Whether any server can: the list is worth opening. */
    get anyAvailable() { return anyAvailable(); },
  };
}
