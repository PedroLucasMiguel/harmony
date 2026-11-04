// Private conversations on one server, for the signed-in account: what the
// server says, what the Vault makes of it, and what the page should draw.
//
// Everything here is the plain mechanics -- ask the server, open what came back,
// seal what goes out, keep the lists -- over an injected `api`, so it runs the
// same in the app and in a test against a real server. Nothing here touches the
// page. The page listens to `onChange` and reads `conversations`, `thread()` and
// the key state.
//
// The shapes and the order of things follow Ciranda's session/private.rs: the
// keys are fetched first and say whether this computer can open anything, a
// message that is refused for a changed key is sealed again once, and what the
// server numbers is checked against what was already seen (see dm-vault).

import {
  b64, openFile, sealFile, unb64,
} from './dm-crypto.js';
import { KeyState, SealFailed, SealError, Vault } from './dm-vault.js';

/** The longest message body: what a channel allows, and what the server's size limit is built for. */
export const MAX_BODY = 4000;

/** How much of a message a conversation's row (and a reply's quote) shows. */
const PREVIEW = 80;

/** Types drawn in the page as what they say they are. Anything else is a download. */
const INLINE = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm',
]);

/** A refusal in the page's words: a code the UI can translate, and the server's own sentence if it sent one. */
export class DmError extends Error {
  /** @param {string} code  @param {string} [message]  @param {number} [userId]  in a group: whom a refusal is about */
  constructor(code, message = code, userId = undefined) {
    super(message);
    this.code = code;
    this.userId = userId;
  }
}

/** The line a message shows in a conversation's row, without opening anything the row should not show. */
export function previewOf(message) {
  if (message.private?.call) return { call: message.private.call, text: '' };
  if (message.private?.group) return { group: message.private.group, text: '' };
  if (message.private?.unreadable) return { text: '', unreadable: true };
  const line = (message.body ?? '').split('\n').find((l) => l.trim()) ?? '';
  const text = [...line.trim()].slice(0, PREVIEW).join('');
  return { text: text || message.attachmentName || '' };
}

export class DmSession {
  #api;

  #server;

  #me;

  #onChange;

  #vault = null;

  /** Open files, as blob URLs, by message id and key: a file is fetched and opened once. */
  #files = new Map();

  /** The sealed message as the server sent it, by id: opened again whenever a key says something new. */
  #raw = new Map();

  #started = false;
  /** What is waiting, when this computer cannot read it: the server says how many, in the clear. */
  #lockedUnread = 0;

  /**
   * Conversation id -> {id, kind, peer, userIds, title, ownerId, createdAt, lastAt, unread, lastReadId, last}.
   * `peer` is the other person of a pair and null in a group, which has `userIds`, a `title` and an `ownerId`
   * instead (a pair has them too, as its two people, with no title and nobody running it).
   */
  conversations = new Map();

  /** Conversation id -> {messages: opened[], more: boolean, loaded: boolean}. */
  #threads = new Map();
  /**
   * What is pinned in each conversation, the ids of its messages with the last pinned first: conversation id -> [id].
   * Their texts are in #raw. Not a part of #threads, because a message pinned long ago is not in the page the
   * conversation opens on.
   */
  #pins = new Map();

  /** Who this account has blocked. */
  blocked = new Set();

  /** What `start` found: why private conversations are not available, when they are not. */
  failure = '';

  /**
   * @param {object} options
   * @param {string} options.server   the server's address, as the app keeps it
   * @param {{id: number}} options.me
   * @param {object} options.api      dmRequest/dmUpload/dmDownload, as harmony.api has them
   * @param {import('./dm-keyfile.js').MemoryKeyFile} options.file  this account's key file
   * @param {() => void} [options.onChange]
   */
  constructor({ server, me, api, file, onChange = () => {} }) {
    this.#server = server;
    this.#me = me;
    this.#api = api;
    this.#onChange = onChange;
    this.#vault = new Vault(file, me.id);
  }

  get me() {
    return this.#me.id;
  }

  get vault() {
    return this.#vault;
  }

  /** 'loading', 'ready', 'locked', 'failed' or 'unsupported'. */
  get state() {
    return this.#vault.state;
  }

  get ready() {
    return this.#vault.ready;
  }

  #changed() {
    this.#onChange();
  }

  /** A request to the server, answered as {status, body}; a server that cannot be reached throws. */
  #req(method, path, body) {
    return this.#api.dmRequest(this.#server, method, path, body);
  }

  /** An answer that is not a success, as an error the page can read. */
  static #refused(res) {
    return new DmError(res.body?.error ?? `http_${res.status}`, res.body?.message ?? `The server answered ${res.status}.`);
  }

  // ------------------------------------------------------------------- keys

  /**
   * Ask the server what keys there are, and say whether this computer can take
   * part: ready, locked (the account has a key this computer does not), or not
   * available. Makes the account's key when it has none.
   */
  async start() {
    this.#started = true;
    let res;
    try {
      res = await this.#req('GET', '/api/keys');
    } catch (err) {
      this.#vault.state = KeyState.Failed;
      this.failure = err.message;
      this.#changed();
      return this.state;
    }
    if (res.status === 404) {
      this.#vault.state = KeyState.Unsupported;
    } else if (res.status !== 200) {
      this.#vault.state = KeyState.Failed;
      this.failure = res.body?.message ?? `The server answered ${res.status}.`;
    } else {
      const next = this.#vault.onKeys({ keys: res.body?.keys ?? [], mine: res.body?.mine });
      if (next === 'create') await this.#createIdentity();
      if (this.ready) await this.refresh();
      else await this.peekUnread();
    }
    this.#changed();
    return this.state;
  }

  /**
   * How many messages are waiting in a server this computer cannot open (its key
   * is not here yet): the count is not secret, so a badge can say there is
   * something to unlock for. Nothing is read, nothing is kept but the number.
   */
  async peekUnread() {
    try {
      const res = await this.#req('GET', '/api/dms');
      if (res.status !== 200) return 0;
      this.#lockedUnread = (res.body?.conversations ?? []).reduce((n, c) => n + (c.unread ?? 0), 0);
      this.#changed();
    } catch { /* the badge stays as it was */ }
    return this.#lockedUnread;
  }

  /** Makes this account's identity key and publishes it. The recovery key is then the vault's to show. */
  async #createIdentity() {
    const made = Vault.create();
    const res = await this.#req('POST', '/api/keys', { publicKey: made.identity.publicB64, wrapped: made.wrapped });
    if (res.status !== 201 || !res.body?.key) {
      this.#vault.state = KeyState.Failed;
      this.failure = res.body?.message ?? `The server answered ${res.status}.`;
      return;
    }
    await this.#vault.adopt(res.body.key, made.identity, made.recovery, false);
  }

  /** Opens the account's key with the recovery key typed in. */
  async unlock(typed) {
    const opened = await this.#vault.unlock(typed);
    if (opened) {
      await this.refresh();
      this.#changed();
    }
    return opened;
  }

  /**
   * The recovery key is lost and there is no computer that has the key: a new
   * key, and what was sealed to the old one stays unreadable here (and still
   * readable to the people it was sent to).
   */
  async startOver() {
    this.#vault.onKeys({ keys: [], mine: null });
    await this.#createIdentity();
    if (this.ready) await this.refresh();
    this.#changed();
    return this.state;
  }

  /** A new recovery key for the key this computer has, sealed on the server; returns it for showing. */
  async newRecoveryKey() {
    const made = this.#vault.newRecovery();
    if (!made) throw new DmError('no_key', 'This computer does not have your key.');
    const res = await this.#req('POST', '/api/keys/wrap', { keyId: made.keyId, wrapped: made.wrapped });
    if (res.status !== 200) throw DmSession.#refused(res);
    await this.#vault.setRecovery(made.recovery, false);
    this.#changed();
    return made.recovery.display();
  }

  async markBackedUp() {
    await this.#vault.markBackedUp();
    this.#changed();
  }

  // ----------------------------------------------------------- conversations

  /** The other person of a pair; null for a group, which has everybody and so nobody in particular. */
  peerOf(conversation) {
    if (conversation.kind === 'group') return null;
    return conversation.userIds.find((id) => id !== this.#me.id) ?? this.#me.id;
  }

  /** Whether a conversation is a group's. */
  static isGroup(c) {
    return c?.kind === 'group';
  }

  #conversationRow(c, extra = {}) {
    const known = this.conversations.get(c.id);
    return {
      id: c.id,
      kind: c.kind ?? 'pair',
      peer: this.peerOf(c),
      userIds: c.userIds ?? known?.userIds ?? [],
      title: c.title ?? known?.title ?? null,
      ownerId: c.ownerId ?? known?.ownerId ?? null,
      createdAt: c.createdAt ?? known?.createdAt ?? 0,
      lastAt: c.lastAt ?? known?.lastAt ?? 0,
      unread: known?.unread ?? 0,
      lastReadId: known?.lastReadId ?? 0,
      last: known?.last ?? null,
      ...extra,
    };
  }

  /** The list of conversations, with their last message opened for the row. */
  async refresh() {
    if (!this.ready) return;
    const res = await this.#req('GET', '/api/dms');
    if (res.status !== 200) return;
    this.#vault.learn(res.body.keys ?? []);
    this.blocked = new Set(res.body.blocked ?? []);
    const next = new Map();
    for (const c of res.body.conversations ?? []) {
      const row = this.#conversationRow(c, { unread: c.unread ?? 0, lastReadId: c.lastReadId ?? 0, last: null });
      if (c.last) {
        await this.#know([c.last]);
        this.#raw.set(c.last.id, c.last);
        row.last = this.#vault.openMessage(c.last, row.peer);
      }
      next.set(c.id, row);
    }
    this.conversations = next;
    this.#changed();
  }

  /** Conversations, newest activity first. */
  list() {
    return [...this.conversations.values()].sort((a, b) => b.lastAt - a.lastAt);
  }

  get unread() {
    // Not readable here: only the server's own count, until the key is.
    if (!this.ready) return this.#lockedUnread;
    let n = 0;
    for (const c of this.conversations.values()) n += c.unread;
    return n;
  }

  /** Takes what the server now says of a conversation's people, name and who runs it. */
  #adopt(c, view) {
    if (!view) return;
    c.userIds = view.userIds ?? c.userIds;
    c.title = view.title ?? null;
    c.ownerId = view.ownerId ?? null;
    c.lastAt = view.lastAt ?? c.lastAt;
  }

  /** Opens (making it if there is none) the conversation with somebody. */
  async open(peerId) {
    const res = await this.#req('POST', '/api/dms', { userId: peerId });
    if (res.status !== 200 && res.status !== 201) throw DmSession.#refused(res);
    const c = res.body.conversation;
    if (!this.conversations.has(c.id)) this.conversations.set(c.id, this.#conversationRow(c));
    return c.id;
  }

  /** Learns the keys behind sealed messages, asking the server for any this computer has not seen. */
  async #know(messages, keys = []) {
    this.#vault.learn(keys);
    const ids = [];
    for (const m of messages) {
      if (m.senderKey) ids.push(m.senderKey);
      if (m.recipientKey) ids.push(m.recipientKey);
      for (const r of m.reactions ?? []) ids.push(r.senderKey, r.recipientKey);
    }
    const unknown = this.#vault.unknown(ids);
    if (!unknown.length) return;
    // Public keys are asked for in a page of at most what the server answers.
    for (let i = 0; i < unknown.length; i += 100) {
      const res = await this.#req('GET', `/api/keys/lookup?ids=${unknown.slice(i, i + 100).join(',')}`);
      if (res.status === 200) this.#vault.learn(res.body.keys ?? []);
    }
  }

  #open(raw, peer) {
    return this.#vault.openMessage(raw, peer);
  }

  /** Every message id still held here: what the vault keeps its replay checks for. */
  #held() {
    const keep = new Set(this.#raw.keys());
    this.#vault.forgetAllBut(keep);
  }

  // ----------------------------------------------------------------- threads

  /** The conversation's messages as opened, oldest first. Empty until `load`. */
  thread(conversationId) {
    return this.#threads.get(conversationId)?.messages ?? [];
  }

  /** What is pinned in a conversation, the last pinned first, opened. Empty until `load`. */
  pinned(conversationId) {
    const c = this.conversations.get(conversationId);
    if (!c) return [];
    return (this.#pins.get(conversationId) ?? [])
      .map((id) => this.#raw.get(id))
      .filter(Boolean)
      .map((raw) => this.#open(raw, c.peer));
  }

  hasMore(conversationId) {
    return this.#threads.get(conversationId)?.more ?? false;
  }

  async load(conversationId) {
    const c = this.conversations.get(conversationId);
    if (!c) throw new DmError('no_such_conversation', 'No such conversation.');
    const res = await this.#req('GET', `/api/dms/${conversationId}/messages`);
    if (res.status !== 200) throw DmSession.#refused(res);
    const raws = res.body.messages ?? [];
    await this.#know(raws, res.body.keys);
    // Replaced, not added to: what the server says now is what there is.
    for (const old of this.#threads.get(conversationId)?.messages ?? []) this.#raw.delete(old.id);
    for (const m of raws) this.#raw.set(m.id, m);
    this.#threads.set(conversationId, { messages: raws.map((m) => this.#open(m, c.peer)), more: raws.length >= 50, loaded: true });
    // What is pinned, as the server has it now, with the keys that open it.
    const pins = res.body.pinned ?? [];
    await this.#know(pins, res.body.keys);
    for (const m of pins) this.#raw.set(m.id, m);
    this.#pins.set(conversationId, pins.map((m) => m.id));
    this.#held();
    this.#changed();
    return this.thread(conversationId);
  }

  async loadOlder(conversationId) {
    const c = this.conversations.get(conversationId);
    const t = this.#threads.get(conversationId);
    if (!c || !t?.messages.length) return t?.messages ?? [];
    const res = await this.#req('GET', `/api/dms/${conversationId}/messages?before=${t.messages[0].id}`);
    if (res.status !== 200) throw DmSession.#refused(res);
    const raws = res.body.messages ?? [];
    await this.#know(raws, res.body.keys);
    for (const m of raws) this.#raw.set(m.id, m);
    t.messages = [...raws.map((m) => this.#open(m, c.peer)), ...t.messages];
    t.more = raws.length >= 50;
    this.#held();
    this.#changed();
    return t.messages;
  }

  /**
   * Every message of a conversation, oldest first and opened, read from the server a page at a time -- for looking
   * through it, which is the only way to: what the server holds of a private message is sealed, so it cannot be
   * searched there, only here once opened.
   *
   * It is not `load`: what the conversation shows (its thread, where it is scrolled to, what it says it has more of)
   * is left as it is, so that reading the whole history behind a search does not move the page.
   *
   * @param {number} conversationId
   * @param {{onPage?: (read: number) => void, limit?: number}} [options]  onPage: told how many messages have been read
   *   so far; limit: where to stop, newest first (a very long history is searched as far back as this)
   */
  async scan(conversationId, { onPage, limit = 20_000 } = {}) {
    const c = this.conversations.get(conversationId);
    if (!c) throw new DmError('no_such_conversation', 'No such conversation.');
    let opened = [];
    let before = null;
    for (;;) {
      const res = await this.#req('GET', `/api/dms/${conversationId}/messages${before === null ? '' : `?before=${before}`}`);
      if (res.status !== 200) throw DmSession.#refused(res);
      const raws = res.body.messages ?? [];
      if (!raws.length) break;
      await this.#know(raws, res.body.keys);
      for (const m of raws) this.#raw.set(m.id, m);
      opened = [...raws.map((m) => this.#open(m, c.peer)), ...opened];
      onPage?.(opened.length);
      before = raws[0].id;
      if (raws.length < 50 || opened.length >= limit) break;
    }
    return opened;
  }

  /** Opens again everything held, after a key said something new (a change, an acceptance). */
  #reopen() {
    for (const [id, t] of this.#threads) {
      const peer = this.conversations.get(id)?.peer;
      if (peer === undefined) continue;
      t.messages = t.messages.map((m) => this.#open(this.#raw.get(m.id) ?? m, peer));
    }
    for (const c of this.conversations.values()) {
      if (c.last && this.#raw.has(c.last.id)) c.last = this.#open(this.#raw.get(c.last.id), c.peer);
    }
  }

  // ----------------------------------------------------------------- sending

  /**
   * Seals and sends, and once more if the server says a key has changed since:
   * the keys it names come with the refusal, so the second try is to the right ones.
   */
  async #sealAndSend(seal, send, group = null) {
    // A group has two things that can have moved under it -- somebody's key, and who is in it -- so it is tried
    // a third time.
    for (let attempt = 0; attempt < (group ? 3 : 2); attempt += 1) {
      let sealed;
      try {
        sealed = seal();
      } catch (err) {
        if (err instanceof SealFailed) throw new DmError(err.code, DmSession.#sealWords(err.code), err.userId);
        throw err;
      }
      const res = await send(sealed);
      const error = res.status === 409 ? res.body?.error : null;
      if ((error === 'stale_key' || error === 'stale_members') && attempt < (group ? 2 : 1)) {
        for (const k of res.body.keys ?? []) this.#vault.keyChanged(k);
        // Who is in the group now, as the server says: what is sealed next is sealed for them.
        if (group && Array.isArray(res.body.members)) group.userIds = res.body.members;
        continue;
      }
      return res;
    }
    throw new DmError(SealError.PeerHasNoKey, DmSession.#sealWords(SealError.PeerHasNoKey));
  }

  static #sealWords(code) {
    switch (code) {
      case SealError.NoKey: return 'Set up your private messages first.';
      case SealError.PeerHasNoKey: return 'They have not set up private messages yet.';
      case SealError.KeyNotConfirmed:
        return 'Their security key changed, so nothing was sent. Compare your safety number or accept the new key in the conversation first.';
      default: return code;
    }
  }

  /**
   * Sends a message: `body`, and optionally a `file` ({name, mime, bytes}) and
   * the message it answers (`reply`: an opened message). Shows when the server
   * echoes it back, as a channel's does.
   */
  async send(conversationId, { body = '', file = null, reply = null } = {}) {
    const c = this.conversations.get(conversationId);
    if (!c) throw new DmError('no_such_conversation', 'No such conversation.');
    if (body.length > MAX_BODY) throw new DmError('too_long', `Messages are limited to ${MAX_BODY} characters.`);
    if (!body.trim() && !file) throw new DmError('empty_message', 'There is nothing to send.');

    let attachment = null;
    if (file) {
      const { sealed, key } = sealFile(file.bytes);
      const up = await this.#api.dmUpload(this.#server, conversationId, sealed);
      if (up.status !== 201) throw DmSession.#refused(up);
      attachment = {
        hash: up.body.hash,
        file: { key: b64(key), name: file.name, mime: file.mime || 'application/octet-stream', size: file.bytes.length },
      };
    }
    const quote = reply ? {
      id: reply.id,
      userId: reply.userId,
      body: previewOf(reply).text,
      ...(reply.attachmentName ? { attachmentName: reply.attachmentName } : {}),
    } : undefined;

    const payload = { body, file: attachment?.file, reply: quote };
    const group = DmSession.isGroup(c);
    const res = await this.#sealAndSend(
      () => (group
        ? this.#vault.sealGroupMessage(conversationId, c.userIds, payload)
        : this.#vault.sealMessage(conversationId, c.peer, payload)),
      (s) => this.#req('POST', `/api/dms/${conversationId}/messages`, {
        ...(group
          ? { copies: s.copies, senderKey: s.senderKey }
          : { sealed: s.text, senderKey: s.senderKey, recipientKey: s.recipientKey }),
        attachmentHash: attachment?.hash ?? null,
      }),
      group ? c : null,
    );
    if (res.status !== 201) throw DmSession.#refused(res);
    // The message is drawn when the echo arrives; this adds it at once if the
    // socket is slow, and the echo then finds it already there.
    this.#addMessage(res.body.message, c);
    return res.body.message.id;
  }

  /** Changes the words of your own message. The file and the reply stay as they were. */
  async edit(messageId, body) {
    const found = this.#find(messageId);
    if (!found) throw new DmError('no_such_message', 'No such message.');
    const { message, conversation } = found;
    if (body.length > MAX_BODY) throw new DmError('too_long', `Messages are limited to ${MAX_BODY} characters.`);
    const payload = {
      body,
      file: message.private.file ?? undefined,
      reply: message.reply ?? undefined,
      mid: message.private.mid ?? undefined,
      rev: message.private.rev + 1,
      of: message.id,
    };
    const group = DmSession.isGroup(conversation);
    const res = await this.#sealAndSend(
      () => (group
        ? this.#vault.sealGroupMessage(conversation.id, conversation.userIds, payload)
        : this.#vault.sealMessage(conversation.id, conversation.peer, payload)),
      (s) => this.#req('POST', `/api/dm-messages/${messageId}/edit`, group
        ? { copies: s.copies, senderKey: s.senderKey }
        : { sealed: s.text, senderKey: s.senderKey, recipientKey: s.recipientKey }),
      group ? conversation : null,
    );
    if (res.status !== 200) throw DmSession.#refused(res);
    await this.#update(res.body.message);
  }

  async remove(messageId) {
    const res = await this.#req('POST', `/api/dm-messages/${messageId}/delete`, {});
    if (res.status !== 200) throw DmSession.#refused(res);
    this.#drop(messageId);
  }

  /**
   * Your reactions to a message, with `emoji` put on or taken off. One sealed
   * blob per person per message, holding all of them (see the server's setReaction).
   */
  async toggleReaction(messageId, emoji) {
    const found = this.#find(messageId);
    if (!found) throw new DmError('no_such_message', 'No such message.');
    const { message, conversation } = found;
    const mine = message.reactions.filter((r) => r.userIds.includes(this.#me.id)).map((r) => r.emoji);
    const next = mine.includes(emoji) ? mine.filter((e) => e !== emoji) : [...mine, emoji].slice(0, 20);

    let res;
    if (!next.length) {
      res = await this.#req('POST', `/api/dm-messages/${messageId}/react`, { sealed: null });
    } else {
      const group = DmSession.isGroup(conversation);
      res = await this.#sealAndSend(
        () => (group
          ? this.#vault.sealGroupReactions(conversation.id, conversation.userIds, messageId, next)
          : this.#vault.sealReactions(conversation.id, conversation.peer, messageId, next)),
        (s) => this.#req('POST', `/api/dm-messages/${messageId}/react`, group
          ? { copies: s.copies, senderKey: s.senderKey }
          : { sealed: s.text, senderKey: s.senderKey, recipientKey: s.recipientKey }),
        group ? conversation : null,
      );
    }
    if (res.status !== 200) throw DmSession.#refused(res);
    this.#setReactions(messageId, res.body.reactions ?? []);
  }

  // ------------------------------------------------------------------- groups

  /** The server's refusal of a group request, with whom it was about when it says. */
  static #groupRefused(res) {
    return new DmError(res.body?.error ?? 'unreachable', res.body?.message ?? 'Could not reach the server.', res.body?.userId);
  }

  /** Makes a group of these people (you are in it, and run it). Resolves with its conversation id. */
  async createGroup(title, userIds) {
    const res = await this.#req('POST', '/api/dms/groups', { title, userIds });
    if (res.status !== 201) throw DmSession.#groupRefused(res);
    const c = res.body.conversation;
    this.conversations.set(c.id, this.#conversationRow(c));
    this.#changed();
    return c.id;
  }

  async #groupAction(conversationId, path, body, expected = 200) {
    const res = await this.#req('POST', `/api/dms/${conversationId}/${path}`, body);
    if (res.status !== expected) throw DmSession.#groupRefused(res);
    const c = this.conversations.get(conversationId);
    if (c && res.body?.conversation) {
      this.#adopt(c, res.body.conversation);
      this.#changed();
    }
  }

  /** Puts people in a group you run. They see what is said from then on. */
  addMembers(conversationId, userIds) {
    return this.#groupAction(conversationId, 'members', { userIds });
  }

  /** Takes somebody out of a group you run. */
  removeMember(conversationId, userId) {
    return this.#groupAction(conversationId, 'members/remove', { userId });
  }

  /** Renames a group you run. */
  rename(conversationId, title) {
    return this.#groupAction(conversationId, 'rename', { title });
  }

  /** Goes out of a group. It leaves your list at once. */
  async leave(conversationId) {
    const res = await this.#req('POST', `/api/dms/${conversationId}/leave`, {});
    if (res.status !== 200) throw DmSession.#groupRefused(res);
    this.#forget(conversationId);
  }

  // ------------------------------------------------------------ read, clear, block

  /** Moves your read mark to the newest message you have: told to your other windows, to nobody else. */
  async markRead(conversationId) {
    const c = this.conversations.get(conversationId);
    const newest = this.thread(conversationId).at(-1)?.id ?? c?.last?.id ?? 0;
    if (!c || newest <= c.lastReadId) {
      if (c && c.unread) { c.unread = 0; this.#changed(); }
      return;
    }
    c.lastReadId = newest;
    c.unread = 0;
    this.#changed();
    await this.#req('POST', `/api/dms/${conversationId}/read`, { upTo: newest });
  }

  /**
   * Pin a message of the conversation, or unpin it. Either of the two may; both are told. What is pinned is only
   * which message: the server is not told what it says (see the v25 migration).
   */
  async pin(messageId, on = true) {
    const res = await this.#req('POST', `/api/dm-messages/${messageId}/pin`, { pinned: Boolean(on) });
    if (res.status !== 200) throw DmSession.#refused(res);
    await this.#update(res.body.message);
  }

  /** Deletes the conversation for you alone; the other person keeps every word. */
  async clear(conversationId) {
    const res = await this.#req('POST', `/api/dms/${conversationId}/clear`, {});
    if (res.status !== 200) throw DmSession.#refused(res);
    this.#forget(conversationId);
  }

  async setBlocked(userId, on) {
    const res = await this.#req('POST', '/api/dms/blocks', { userId, blocked: on });
    if (res.status !== 200) throw DmSession.#refused(res);
    this.blocked = new Set(res.body.blocked ?? []);
    this.#changed();
  }

  // ------------------------------------------------------------------- files

  /**
   * A message's file, opened: {url, name, mime, inline}. `url` is a blob URL;
   * `inline` says whether the page may draw it as what it says it is. Fetched
   * and opened once. Null if it cannot be opened (a wrong key, a file gone).
   */
  async file(message) {
    const f = message.private?.file;
    if (!f || !message.attachmentHash) return null;
    const cached = this.#files.get(`${message.id}:${f.key}`);
    if (cached) return cached;
    const down = await this.#api.dmDownload(this.#server, message.conversationId, message.attachmentHash);
    const key = unb64(f.key);
    const plain = down.bytes && key?.length === 32 ? openFile(key, down.bytes) : null;
    if (!plain) return null;
    const inline = INLINE.has(f.mime);
    const blob = new Blob([plain], { type: inline ? f.mime : 'application/octet-stream' });
    const opened = { url: URL.createObjectURL(blob), name: f.name, mime: f.mime, inline, size: f.size, blob };
    this.#files.set(`${message.id}:${f.key}`, opened);
    return opened;
  }

  /** Lets go of the blob URLs: on sign-out, so nothing opened stays reachable. */
  closeFiles() {
    for (const f of this.#files.values()) URL.revokeObjectURL(f.url);
    this.#files.clear();
  }

  // ------------------------------------------------------------------- trust

  safetyNumber(peer) {
    return this.#vault.safetyNumber(peer);
  }

  keyChangedFor(peer) {
    return this.#vault.keyChangedFor(peer);
  }

  verified(peer) {
    return this.#vault.verified(peer);
  }

  /** Accepts their new key: what is sealed from now on goes to it. */
  acceptKey(peer) {
    this.#vault.acceptKey(peer);
    this.#reopen();
    this.#changed();
  }

  setVerified(peer, on) {
    this.#vault.setVerified(peer, on);
    this.#reopen();
    this.#changed();
  }

  // ----------------------------------------------------------------- realtime

  /**
   * Everything the server pushes about private conversations. Returns what the
   * page may want to make a noise about: {incoming: message} for a message from
   * somebody else.
   */
  async handle(msg) {
    if (!this.#started || !this.ready && msg.type !== 'keys:changed') return {};
    switch (msg.type) {
      case 'keys:changed': {
        this.#vault.keyChanged(msg.key);
        this.#reopen();
        this.#changed();
        return {};
      }
      case 'dm:message': {
        const c = this.conversations.get(msg.conversation.id) ?? this.#conversationRow(msg.conversation);
        // A group's people, name and who runs it may have changed: the line that says so carries the new ones.
        this.#adopt(c, msg.conversation);
        this.conversations.set(c.id, c);
        const message = await this.#addMessage(msg.message, c);
        const mine = msg.message.userId === this.#me.id;
        const isCall = msg.message.kind === 'call' && msg.message.meta?.outcome === 'ended';
        if (!mine && !isCall) c.unread += 1;
        this.#changed();
        return mine ? {} : { incoming: message, conversation: c };
      }
      case 'dm:updated': {
        await this.#update(msg.message);
        return {};
      }
      case 'dm:deleted':
        this.#drop(msg.id);
        return {};
      case 'dm:reactions':
        this.#setReactions(msg.id, msg.reactions ?? []);
        return {};
      case 'dm:read': {
        const c = this.conversations.get(msg.conversationId);
        if (c) {
          c.lastReadId = Math.max(c.lastReadId, msg.lastReadId);
          if (c.last && c.last.id <= c.lastReadId) c.unread = 0;
          this.#changed();
        }
        return {};
      }
      case 'dm:cleared':
        this.#forget(msg.conversationId);
        return {};
      case 'dm:left':
        // Taken out of a group, or it ended: it is gone from here.
        this.#forget(msg.conversationId);
        return { left: msg.conversationId };
      case 'dm:blocks':
        this.blocked = new Set(msg.blocked ?? []);
        this.#changed();
        return {};
      default:
        return {};
    }
  }

  /** An opened message by id, or null. */
  messageById(messageId) {
    return this.#find(messageId)?.message ?? null;
  }

  #find(messageId) {
    for (const [id, t] of this.#threads) {
      const message = t.messages.find((m) => m.id === messageId);
      if (message) return { message, conversation: this.conversations.get(id) };
    }
    return null;
  }

  async #addMessage(raw, conversation) {
    await this.#know([raw]);
    this.#raw.set(raw.id, raw);
    const t = this.#threads.get(conversation.id);
    const message = this.#open({ ...raw, reactions: raw.reactions ?? [] }, conversation.peer);
    if (t && !t.messages.some((m) => m.id === raw.id)) t.messages.push(message);
    if (!conversation.last || conversation.last.id <= raw.id) conversation.last = message;
    conversation.lastAt = Math.max(conversation.lastAt, raw.createdAt ?? 0);
    this.#held();
    this.#changed();
    return message;
  }

  async #update(raw) {
    await this.#know([raw]);
    const before = this.#raw.get(raw.id);
    this.#raw.set(raw.id, { ...before, ...raw });
    const found = this.#find(raw.id);
    const c = found?.conversation ?? this.conversations.get(raw.conversationId);
    if (!c) return;
    const message = this.#open(this.#raw.get(raw.id), c.peer);
    const t = this.#threads.get(c.id);
    if (t) t.messages = t.messages.map((m) => (m.id === raw.id ? message : m));
    if (c.last?.id === raw.id) c.last = message;
    // Pinned or unpinned: the last pinned goes first; an edit of what is pinned leaves it where it was.
    const pinned = this.#pins.get(c.id) ?? [];
    if (raw.pinned && !pinned.includes(raw.id)) this.#pins.set(c.id, [raw.id, ...pinned]);
    else if (!raw.pinned && pinned.includes(raw.id)) this.#pins.set(c.id, pinned.filter((id) => id !== raw.id));
    this.#held();
    this.#changed();
  }

  #setReactions(messageId, reactions) {
    const raw = this.#raw.get(messageId);
    if (!raw) return;
    raw.reactions = reactions;
    const found = this.#find(messageId);
    if (!found) return;
    const t = this.#threads.get(found.conversation.id);
    const message = this.#open(raw, found.conversation.peer);
    t.messages = t.messages.map((m) => (m.id === messageId ? message : m));
    this.#changed();
  }

  #drop(messageId) {
    this.#raw.delete(messageId);
    for (const [id, pinned] of this.#pins) {
      if (pinned.includes(messageId)) this.#pins.set(id, pinned.filter((x) => x !== messageId));
    }
    for (const [id, t] of this.#threads) {
      const had = t.messages.some((m) => m.id === messageId);
      t.messages = t.messages.filter((m) => m.id !== messageId);
      const c = this.conversations.get(id);
      if (had && c?.last?.id === messageId) c.last = t.messages.at(-1) ?? null;
    }
    this.#changed();
  }

  #forget(conversationId) {
    for (const m of this.#threads.get(conversationId)?.messages ?? []) this.#raw.delete(m.id);
    for (const id of this.#pins.get(conversationId) ?? []) this.#raw.delete(id);
    this.#pins.delete(conversationId);
    this.#threads.delete(conversationId);
    this.conversations.delete(conversationId);
    this.#held();
    this.#changed();
  }
}
