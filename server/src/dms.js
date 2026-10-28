// Private conversations between two people, end-to-end encrypted.
//
// The rule this module exists to keep: the server stores and forwards, and
// never understands. Every message body, every reaction and every attachment
// arrives sealed by the sender's client to a key pair only the two people in
// the conversation hold, and leaves exactly as it came. There is no code path
// here that could show anybody -- an admin, the owner, someone with the
// database file -- what was said, because there is nothing here to show it
// with.
//
// What the server does know, because routing needs it: who talks to whom,
// when, roughly how much (the client pads), and whether a call happened and
// for how long. That is said plainly in the client, too.
//
// The other half of the job is the one that IS the server's: authorization.
// Every read and write goes through forUser(), which answers null for anybody
// who is not one of the two people, and the routes turn that into the same
// 404 as a conversation that does not exist -- so a stranger cannot even
// learn which conversations there are.

/** How many earlier texts of an edited message are kept, oldest dropped first. */
const MAX_VERSIONS = 25;

/** Messages per page, as channels page them. */
const PAGE_SIZE = 50;

/**
 * The longest sealed text accepted, in base64url characters.
 *
 * A body is 4000 characters, which is up to 16 KB of UTF-8, plus the
 * attachment's details, the padding and the framing, then a third again for
 * base64. 64K characters is that with room to spare, and still small enough
 * that nobody uses a message as file storage.
 */
export const MAX_SEALED_CHARS = 64 * 1024;

/** A wrapped private key: a 32-byte key plus framing. Anything longer is not one. */
const MAX_WRAPPED_CHARS = 512;

const B64URL = /^[A-Za-z0-9_-]+$/;

/** Is this a base64url string of at most `max` characters (and at least `min`)? */
export function isSealedText(value, { min = 1, max = MAX_SEALED_CHARS } = {}) {
  return typeof value === 'string' && value.length >= min && value.length <= max && B64URL.test(value);
}

/** An X25519 public key: exactly 32 bytes, base64url without padding. */
export function isPublicKey(value) {
  return typeof value === 'string' && value.length === 43 && B64URL.test(value)
    && Buffer.from(value, 'base64url').length === 32;
}

export class DirectMessages {
  #db;
  #q;

  constructor(db) {
    this.#db = db;
    this.#q = {
      // --- keys --------------------------------------------------------------
      currentKey: db.prepare(
        'SELECT * FROM user_keys WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      ),
      keyById: db.prepare('SELECT * FROM user_keys WHERE id = ?'),
      currentKeys: db.prepare(`
        SELECT k.* FROM user_keys k
        WHERE k.id = (SELECT MAX(id) FROM user_keys WHERE user_id = k.user_id)
      `),
      insertKey: db.prepare(
        'INSERT INTO user_keys (user_id, public_key, wrapped, created_at) VALUES (?, ?, ?, ?)',
      ),
      rewrap: db.prepare('UPDATE user_keys SET wrapped = ? WHERE id = ?'),

      // --- conversations -----------------------------------------------------
      conversation: db.prepare('SELECT * FROM dm_conversations WHERE id = ?'),
      between: db.prepare('SELECT * FROM dm_conversations WHERE user_a = ? AND user_b = ?'),
      insertConversation: db.prepare(
        'INSERT INTO dm_conversations (user_a, user_b, created_at, last_at) VALUES (?, ?, ?, ?)',
      ),
      touchConversation: db.prepare('UPDATE dm_conversations SET last_at = ? WHERE id = ?'),
      // Only conversations with something in them you have not deleted:
      // opening one and walking away must not put an empty row in the other
      // person's list, and one you deleted stays gone until something new.
      list: db.prepare(`
        SELECT c.*,
          IFNULL(r.last_read_id, 0) AS last_read_id,
          (SELECT MAX(id) FROM dm_messages m
            WHERE m.conversation_id = c.id AND m.id > IFNULL(r.cleared_id, 0)) AS last_id,
          (SELECT COUNT(*) FROM dm_messages m
            WHERE m.conversation_id = c.id AND m.user_id != :me
              AND m.id > MAX(IFNULL(r.last_read_id, 0), IFNULL(r.cleared_id, 0))
              -- A call both people were on is not news to either; a missed one is.
              AND NOT (m.kind = 'call' AND json_extract(m.meta, '$.outcome') = 'ended')) AS unread
        FROM dm_conversations c
        LEFT JOIN dm_reads r ON r.conversation_id = c.id AND r.user_id = :me
        WHERE (c.user_a = :me OR c.user_b = :me)
          AND EXISTS (SELECT 1 FROM dm_messages m
            WHERE m.conversation_id = c.id AND m.id > IFNULL(r.cleared_id, 0))
        ORDER BY c.last_at DESC
      `),
      // Above each conversation's cleared mark, as the list sees it: counting
      // a cleared message would tell a background client there's news forever.
      latest: db.prepare(`
        SELECT MAX(m.id) AS id FROM dm_conversations c
        LEFT JOIN dm_reads r ON r.conversation_id = c.id AND r.user_id = :me
        JOIN dm_messages m ON m.conversation_id = c.id AND m.id > IFNULL(r.cleared_id, 0)
        WHERE c.user_a = :me OR c.user_b = :me
      `),

      // --- messages ----------------------------------------------------------
      // The id is chosen here, not left to SQLite: without AUTOINCREMENT it
      // hands out the newest deleted id again, and a message given an id at
      // or below somebody's cleared mark would be born deleted for them.
      insertMessage: db.prepare(`
        INSERT INTO dm_messages
          (id, conversation_id, user_id, kind, sender_key, recipient_key, sealed, meta,
           attachment_hash, created_at)
        VALUES (
          MAX(IFNULL((SELECT MAX(id) FROM dm_messages), 0),
              IFNULL((SELECT MAX(cleared_id) FROM dm_reads), 0)) + 1,
          ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      message: db.prepare('SELECT * FROM dm_messages WHERE id = ?'),
      editMessage: db.prepare(
        'UPDATE dm_messages SET sealed = ?, sender_key = ?, recipient_key = ?, edited_at = ? '
        + 'WHERE id = ?',
      ),
      deleteMessage: db.prepare('DELETE FROM dm_messages WHERE id = ?'),
      keepVersion: db.prepare(`
        INSERT INTO dm_message_edits (message_id, sender_key, recipient_key, sealed, written_at)
        VALUES (?, ?, ?, ?, ?)
      `),
      trimVersions: db.prepare(`
        DELETE FROM dm_message_edits WHERE message_id = :id AND id NOT IN
          (SELECT id FROM dm_message_edits WHERE message_id = :id ORDER BY id DESC LIMIT :keep)
      `),
      versions: db.prepare('SELECT * FROM dm_message_edits WHERE message_id = ? ORDER BY id'),
      history: db.prepare(`
        SELECT * FROM dm_messages WHERE conversation_id = ? AND id > ? AND id < ?
        ORDER BY id DESC LIMIT ?
      `),
      hasAttachment: db.prepare(
        'SELECT 1 FROM dm_messages WHERE conversation_id = ? AND id > ? AND attachment_hash = ? LIMIT 1',
      ),
      maxId: db.prepare('SELECT MAX(id) AS id FROM dm_messages WHERE conversation_id = ?'),

      // --- reactions, reads, blocks -------------------------------------------
      setReaction: db.prepare(`
        INSERT INTO dm_reactions (message_id, user_id, sender_key, recipient_key, sealed, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id, user_id) DO UPDATE SET
          sender_key = excluded.sender_key, recipient_key = excluded.recipient_key,
          sealed = excluded.sealed, updated_at = excluded.updated_at
      `),
      clearReaction: db.prepare('DELETE FROM dm_reactions WHERE message_id = ? AND user_id = ?'),
      markRead: db.prepare(`
        INSERT INTO dm_reads (conversation_id, user_id, last_read_id) VALUES (?, ?, ?)
        ON CONFLICT(conversation_id, user_id) DO UPDATE SET
          last_read_id = MAX(last_read_id, excluded.last_read_id)
      `),
      lastRead: db.prepare(
        'SELECT last_read_id FROM dm_reads WHERE conversation_id = ? AND user_id = ?',
      ),
      clear: db.prepare(`
        INSERT INTO dm_reads (conversation_id, user_id, last_read_id, cleared_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_id, user_id) DO UPDATE SET
          last_read_id = MAX(last_read_id, excluded.last_read_id),
          cleared_id = MAX(cleared_id, excluded.cleared_id)
      `),
      clearedId: db.prepare(
        'SELECT cleared_id FROM dm_reads WHERE conversation_id = ? AND user_id = ?',
      ),
      purgedFiles: db.prepare(`
        SELECT attachment_hash FROM dm_messages
        WHERE conversation_id = ? AND id <= ? AND attachment_hash IS NOT NULL
      `),
      purge: db.prepare('DELETE FROM dm_messages WHERE conversation_id = ? AND id <= ?'),
      block: db.prepare(
        'INSERT OR IGNORE INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)',
      ),
      unblock: db.prepare('DELETE FROM dm_blocks WHERE blocker_id = ? AND blocked_id = ?'),
      blockedBy: db.prepare('SELECT blocked_id FROM dm_blocks WHERE blocker_id = ? ORDER BY created_at'),
      blockedEither: db.prepare(`
        SELECT 1 FROM dm_blocks
        WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
        LIMIT 1
      `),

      addRef: db.prepare('UPDATE uploads SET refs = refs + 1 WHERE hash = ?'),
      dropRef: db.prepare('UPDATE uploads SET refs = MAX(0, refs - 1) WHERE hash = ?'),
    };
  }

  #transaction(fn) {
    this.#db.exec('BEGIN');
    try {
      const out = fn();
      this.#db.exec('COMMIT');
      return out;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  // ------------------------------------------------------------------- keys

  currentKey(userId) {
    return this.#q.currentKey.get(userId) ?? null;
  }

  /** Every account's current public key, for the client's directory. */
  currentKeys() {
    return this.#q.currentKeys.all();
  }

  /**
   * Public keys by id, for opening history sealed to keys since replaced.
   *
   * Public keys are not secrets -- they are what everybody encrypts TO -- so
   * any signed-in person may look any of them up. Prepared on the spot for
   * the same reason Chat.reactionsFor is: the list varies in length.
   */
  keysByIds(ids) {
    const wanted = [...new Set(ids.map(Number).filter(Number.isSafeInteger))].slice(0, 200);
    if (!wanted.length) return [];
    return this.#db.prepare(
      `SELECT * FROM user_keys WHERE id IN (${wanted.map(() => '?').join(',')})`,
    ).all(...wanted);
  }

  /**
   * Publish a new identity key: the first one, or a fresh start after the
   * old one's recovery key was lost.
   *
   * A new ROW, never an update. The old public key has to stay, because the
   * other side of every conversation still needs it to open what was sealed
   * to it before.
   */
  addKey(userId, publicKey, wrapped) {
    if (!isPublicKey(publicKey)) return { ok: false, error: 'bad_key' };
    if (!isSealedText(wrapped, { min: 40, max: MAX_WRAPPED_CHARS })) return { ok: false, error: 'bad_key' };
    const info = this.#q.insertKey.run(userId, publicKey, wrapped, Date.now());
    return { ok: true, key: this.#q.keyById.get(Number(info.lastInsertRowid)) };
  }

  /**
   * Seal the CURRENT private key under a new recovery key.
   *
   * For somebody who has lost the recovery key but still has a computer that
   * holds the private key: they get a new one and lose nothing. Only the
   * current key, and only your own -- re-wrapping an old key would let a
   * stolen session swap in a wrapping the owner cannot open.
   */
  rewrap(userId, keyId, wrapped) {
    const current = this.currentKey(userId);
    if (!current || current.id !== Number(keyId)) return { ok: false, error: 'stale_key' };
    if (!isSealedText(wrapped, { min: 40, max: MAX_WRAPPED_CHARS })) return { ok: false, error: 'bad_key' };
    this.#q.rewrap.run(wrapped, current.id);
    return { ok: true, key: this.#q.keyById.get(current.id) };
  }

  // ---------------------------------------------------------- conversations

  /**
   * The conversation, if `userId` is one of its two people; otherwise null.
   *
   * THE authorization check. Every route that takes a conversation or a
   * message id comes through here, and "not yours" and "does not exist" are
   * deliberately the same answer.
   */
  forUser(userId, conversationId) {
    const c = this.#q.conversation.get(Number(conversationId));
    if (!c || (c.user_a !== userId && c.user_b !== userId)) return null;
    return c;
  }

  get(conversationId) {
    return this.#q.conversation.get(Number(conversationId)) ?? null;
  }

  static peerOf(conversation, userId) {
    return conversation.user_a === userId ? conversation.user_b : conversation.user_a;
  }

  static members(conversation) {
    return [conversation.user_a, conversation.user_b];
  }

  /**
   * The conversation between two people, made if it does not exist yet.
   * Idempotent: the UNIQUE pair means a second open finds the first.
   */
  open(userId, peerId) {
    const [a, b] = userId < peerId ? [userId, peerId] : [peerId, userId];
    const existing = this.#q.between.get(a, b);
    if (existing) return { conversation: existing, created: false };
    const now = Date.now();
    const info = this.#q.insertConversation.run(a, b, now, now);
    return { conversation: this.#q.conversation.get(Number(info.lastInsertRowid)), created: true };
  }

  /** The newest message id in any of your conversations, 0 with none: what an inbox poll compares. */
  latest(userId) {
    return this.#q.latest.get({ me: userId })?.id ?? 0;
  }

  /** Your conversations, newest activity first, with unread counts and the last message. */
  list(userId) {
    const rows = this.#q.list.all({ me: userId });
    const last = new Map();
    for (const row of rows) {
      if (row.last_id) last.set(row.last_id, this.#q.message.get(row.last_id));
    }
    const reactions = this.reactionsFor([...last.keys()]);
    return rows.map((row) => ({
      conversation: row,
      lastReadId: row.last_read_id,
      unread: row.unread,
      last: row.last_id ? publicDmMessage(last.get(row.last_id), reactions.get(row.last_id)) : null,
    }));
  }

  // ----------------------------------------------------------------- blocks

  /** Either of the two has blocked the other. Checked before anything reaches the other side. */
  isBlocked(a, b) {
    return Boolean(this.#q.blockedEither.get(a, b, b, a));
  }

  blocked(userId) {
    return this.#q.blockedBy.all(userId).map((r) => r.blocked_id);
  }

  setBlocked(blockerId, blockedId, on) {
    if (on) this.#q.block.run(blockerId, blockedId, Date.now());
    else this.#q.unblock.run(blockerId, blockedId);
    return this.blocked(blockerId);
  }

  // --------------------------------------------------------------- messages

  /**
   * The keys a message from `userId` in `conversation` must be sealed to,
   * or why it cannot be sent.
   *
   * Both have to be CURRENT. A client that sealed to a key the other person
   * has since replaced would produce a message the other person can no
   * longer open; refusing it with `stale_key` makes the client fetch the new
   * key and seal again, instead of sending something nobody can read.
   */
  checkKeys(conversation, userId, senderKey, recipientKey) {
    const mine = this.currentKey(userId);
    const theirs = this.currentKey(DirectMessages.peerOf(conversation, userId));
    if (!mine) return { ok: false, error: 'no_key' };
    if (!theirs) return { ok: false, error: 'peer_has_no_key' };
    if (mine.id !== Number(senderKey) || theirs.id !== Number(recipientKey)) {
      return { ok: false, error: 'stale_key', keys: [mine, theirs] };
    }
    return { ok: true };
  }

  post({ conversation, userId, sealed, senderKey, recipientKey, attachmentHash = null }) {
    if (!isSealedText(sealed)) return { ok: false, error: 'bad_message' };
    const keys = this.checkKeys(conversation, userId, senderKey, recipientKey);
    if (!keys.ok) return keys;

    return this.#transaction(() => {
      const now = Date.now();
      const info = this.#q.insertMessage.run(
        conversation.id, userId, 'text', Number(senderKey), Number(recipientKey), sealed, null,
        attachmentHash, now,
      );
      if (attachmentHash) this.#q.addRef.run(attachmentHash);
      this.#q.touchConversation.run(now, conversation.id);
      return { ok: true, message: this.#q.message.get(Number(info.lastInsertRowid)) };
    });
  }

  /**
   * A line the server writes itself: a call that happened, or one that was
   * missed. Plain facts it already had -- who called and for how long -- so
   * nothing is lost by it not being sealed.
   */
  record(conversationId, userId, meta) {
    const now = Date.now();
    return this.#transaction(() => {
      const info = this.#q.insertMessage.run(
        conversationId, userId, 'call', null, null, null, JSON.stringify(meta), null, now,
      );
      this.#q.touchConversation.run(now, conversationId);
      return this.#q.message.get(Number(info.lastInsertRowid));
    });
  }

  message(id) {
    return this.#q.message.get(Number(id)) ?? null;
  }

  /**
   * Replace what a message says. The sender's own, text only; the client
   * seals the new words exactly as it sealed the old ones, to the current keys.
   */
  edit(message, conversation, { sealed, senderKey, recipientKey }) {
    if (message.kind !== 'text') return { ok: false, error: 'no_such_message' };
    if (!isSealedText(sealed)) return { ok: false, error: 'bad_message' };
    const keys = this.checkKeys(conversation, message.user_id, senderKey, recipientKey);
    if (!keys.ok) return keys;
    return this.#transaction(() => {
      // The words being replaced, kept as sealed as they came: still only the two can read them.
      this.#q.keepVersion.run(
        message.id, message.sender_key, message.recipient_key, message.sealed,
        message.edited_at ?? message.created_at,
      );
      this.#q.trimVersions.run({ id: message.id, keep: MAX_VERSIONS });
      this.#q.editMessage.run(sealed, Number(senderKey), Number(recipientKey), Date.now(), message.id);
      return { ok: true, message: this.#q.message.get(message.id) };
    });
  }

  /** A message's earlier versions, sealed, oldest first; the current one is the message itself. */
  versions(message) {
    return this.#q.versions.all(message.id).map((v) => ({
      senderKey: v.sender_key,
      recipientKey: v.recipient_key,
      sealed: v.sealed,
      at: v.written_at,
    }));
  }

  /**
   * Delete a message for both people. The file goes back to being evictable
   * in the same transaction, for the same reason a channel message's does.
   */
  remove(message) {
    return this.#transaction(() => {
      this.#q.deleteMessage.run(message.id);
      if (message.attachment_hash) this.#q.dropRef.run(message.attachment_hash);
      return { ok: true };
    });
  }

  /** A page of what `userId` can still see here: nothing up to their cleared mark. */
  history(conversationId, userId, { before = Number.MAX_SAFE_INTEGER, limit = PAGE_SIZE } = {}) {
    return this.#q.history
      .all(conversationId, this.clearedId(conversationId, userId), before, Math.min(limit, PAGE_SIZE))
      .reverse();
  }

  /** Whether a sealed file was sent in this conversation, and `userId` has not deleted it. */
  hasAttachment(conversationId, userId, hash) {
    return Boolean(this.#q.hasAttachment.get(conversationId, this.clearedId(conversationId, userId), hash));
  }

  // ---------------------------------------------------------- clearing

  /** The newest message `userId` deleted from this conversation for themselves, 0 for none. */
  clearedId(conversationId, userId) {
    return this.#q.clearedId.get(conversationId, userId)?.cleared_id ?? 0;
  }

  /** Whether `userId` still sees this message: it is not behind their cleared mark. */
  visibleTo(message, userId) {
    return message.id > this.clearedId(message.conversation_id, userId);
  }

  /**
   * Delete the conversation for `userId` alone: everything in it now, so it
   * leaves their list and opens empty if it comes back. The other person
   * keeps every word.
   *
   * What NEITHER can see any more -- both have cleared past it -- is deleted
   * for real in the same transaction, files let go as remove() lets them go.
   * Returns the new mark.
   */
  clear(conversation, userId) {
    return this.#transaction(() => {
      const max = this.#q.maxId.get(conversation.id)?.id ?? 0;
      this.#q.clear.run(conversation.id, userId, max, max);
      const marks = DirectMessages.members(conversation).map((id) => this.clearedId(conversation.id, id));
      const gone = Math.min(...marks);
      if (gone > 0) {
        for (const { attachment_hash: hash } of this.#q.purgedFiles.all(conversation.id, gone)) {
          this.#q.dropRef.run(hash);
        }
        this.#q.purge.run(conversation.id, gone);
      }
      return this.clearedId(conversation.id, userId);
    });
  }

  // -------------------------------------------------------------- reactions

  /**
   * Set, or clear, one person's reactions to a message.
   *
   * One sealed blob per person per message, holding every emoji they put on
   * it: sealing them one at a time would tell the server how many there are
   * and when each changed, which is most of what a reaction says.
   */
  setReaction({ message, conversation, userId, sealed, senderKey, recipientKey }) {
    if (sealed == null) {
      this.#q.clearReaction.run(message.id, userId);
      return { ok: true };
    }
    if (!isSealedText(sealed, { max: 4096 })) return { ok: false, error: 'bad_message' };
    const keys = this.checkKeys(conversation, userId, senderKey, recipientKey);
    if (!keys.ok) return keys;
    this.#q.setReaction.run(message.id, userId, Number(senderKey), Number(recipientKey), sealed, Date.now());
    return { ok: true };
  }

  /** Reactions for a page of messages, one query for the page. */
  reactionsFor(ids) {
    const out = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return out;
    const rows = this.#db.prepare(
      'SELECT * FROM dm_reactions '
      + `WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at`,
    ).all(...ids);
    for (const r of rows) {
      out.get(r.message_id)?.push({
        userId: r.user_id,
        senderKey: r.sender_key,
        recipientKey: r.recipient_key,
        sealed: r.sealed,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ reads

  /**
   * Move your read mark forward to `upTo`, never back, and never past the
   * last message there is: a mark ahead of the conversation would swallow the
   * next message's unread badge before it was ever shown.
   */
  markRead(conversationId, userId, upTo) {
    const max = this.#q.maxId.get(conversationId)?.id ?? 0;
    const target = Math.min(Math.max(0, Number(upTo) || 0), max);
    this.#q.markRead.run(conversationId, userId, target);
    return this.#q.lastRead.get(conversationId, userId)?.last_read_id ?? 0;
  }
}

export const publicKey = (k) => (k ? {
  id: k.id,
  userId: k.user_id,
  publicKey: k.public_key,
  createdAt: k.created_at,
} : null);

/** Your own key, with the wrapped private half only you can open. */
export const ownKey = (k) => (k ? { ...publicKey(k), wrapped: k.wrapped } : null);

export const publicConversation = (c) => (c ? {
  id: c.id,
  userIds: [c.user_a, c.user_b],
  createdAt: c.created_at,
  lastAt: c.last_at,
} : null);

export const publicDmMessage = (m, reactions = []) => {
  if (!m) return null;
  let meta = null;
  if (m.meta) {
    try { meta = JSON.parse(m.meta); } catch { meta = null; }
  }
  return {
    id: m.id,
    conversationId: m.conversation_id,
    userId: m.user_id,
    kind: m.kind,
    senderKey: m.sender_key ?? null,
    recipientKey: m.recipient_key ?? null,
    sealed: m.sealed ?? null,
    meta,
    attachmentHash: m.attachment_hash ?? null,
    reactions,
    createdAt: m.created_at,
    editedAt: m.edited_at ?? null,
  };
};
