// Text and media channels: messages, pins, attachments and search.
//
// Uploads are the first thing Harmony stores that grows without bound, and the
// README is explicit that "writing to disk is the one thing that would give the
// server a cost that scales". So the limits here are not defensive padding,
// they are the feature: a per-file cap, a content-type allowlist, and a total
// quota checked before anything is written. The reference host is a Pi with an
// SD card.

import { createHash } from 'node:crypto';
import {
  mkdirSync, writeFileSync, renameSync, unlinkSync, statSync, statfsSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * What may be uploaded, and what it is called in search.
 *
 * An allowlist rather than a blocklist, and the client's claimed type is not
 * trusted for anything but this check -- the file is served back with the type
 * recorded here, so an .html smuggled in as image/png would still be served as
 * an image and never execute.
 */
const ALLOWED_TYPES = new Map([
  ['image/png', 'image'],
  ['image/jpeg', 'image'],
  ['image/gif', 'image'],
  ['image/webp', 'image'],
  ['video/mp4', 'video'],
  ['video/webm', 'video'],
  ['audio/mpeg', 'audio'],
  ['audio/ogg', 'audio'],
  ['audio/wav', 'audio'],
  ['audio/webm', 'audio'],
  ['application/pdf', 'file'],
  ['text/plain', 'file'],
  // Anything else at all: stored and served as a download, never as
  // something a browser would render. See storedType.
  ['application/octet-stream', 'file'],
]);

export const mediaTypeOf = (contentType) => ALLOWED_TYPES.get(String(contentType).toLowerCase()) ?? null;
export const allowedTypes = () => [...ALLOWED_TYPES.keys()];

/**
 * The type a file is kept and served as.
 *
 * Any file may be uploaded, but only the types above are served as what
 * they say they are. Everything else becomes application/octet-stream --
 * served with nosniff and a sandbox, so an .html or an .svg is a file to
 * download and never a page that runs.
 */
export const storedType = (claimed) => {
  const type = String(claimed ?? '').split(';')[0].trim().toLowerCase();
  return ALLOWED_TYPES.has(type) ? type : 'application/octet-stream';
};

/**
 * The most one request may carry: POST /api/uploads buffers the whole body
 * in memory, so this stays small whatever the server allows per file.
 * Anything bigger goes through an upload session (upload-sessions.js), in
 * chunks, straight to disk.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** The largest file the owner may allow, and what a server allows until they do. */
export const MAX_FILE_LIMIT = 2 * 1024 * 1024 * 1024;
export const DEFAULT_FILE_BYTES = MAX_UPLOAD_BYTES;

/**
 * Free disk space never given to uploads, whatever the quota says.
 *
 * The quota is a number the owner typed; this is the floor under it. Once
 * the filesystem is full every SQLite write throws, so the server has to
 * stop accepting files while there is still room to run.
 */
export const DISK_RESERVE_BYTES = 512 * 1024 * 1024;

/**
 * Per-clip ceiling for the soundpad, far below the generic upload cap.
 *
 * Clips are prefetched by every client on sign-in so the first press of a
 * button is not a download, which makes their size a cost paid N times on
 * every join rather than once. Two megabytes is about a minute of 128 kbps
 * audio -- longer than anything anyone actually puts on a soundpad.
 */
export const MAX_CLIP_BYTES = 2 * 1024 * 1024;

/**
 * Per-avatar ceiling.
 *
 * Refused rather than resized: resizing means an image library, and a library
 * is a dependency. The client downscales on a canvas before uploading, which
 * costs nothing and keeps the decision about quality on the machine that can
 * see the picture.
 */
export const MAX_AVATAR_BYTES = 256 * 1024;

/**
 * Per-custom-emoji ceiling, and how many there may be.
 *
 * Both are paid by everyone: an emoji is downloaded by every client that
 * opens the picker and kept out of cache eviction for as long as it exists,
 * the same bargain the soundpad makes. 256 KB is generous for something
 * drawn at 22 pixels, and the client downscales before it uploads anyway.
 *
 * The count cap exists because the name is a shared, server-wide namespace
 * that any member may write to. Without it the backstop is the disk quota,
 * which is the wrong place to discover that somebody scripted a thousand
 * uploads.
 */
export const MAX_EMOJI_BYTES = 256 * 1024;
export const MAX_EMOJIS = 200;

/** Messages returned by one history request. */
const PAGE_SIZE = 50;

/*
 * Every message query brings the message it replies to along with it: who
 * wrote it and the start of what they said, which is all the line above a
 * reply shows. One LEFT JOIN rather than a lookup per message, and a deleted
 * original simply comes back as nulls.
 */
const REPLY_COLUMNS = ', r.id AS r_id, r.user_id AS r_user_id, ru.nickname AS r_nickname, '
  + 'r.body AS r_body, r.media_type AS r_media_type, r.attachment_name AS r_attachment_name, '
  // And the attachment's size, which is how a client decides between showing
  // a file and offering it: nobody wants a 2 GB video to start downloading
  // because it scrolled into view.
  + 'up.bytes AS attachment_bytes';
const REPLY_JOIN = 'LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.user_id '
  + 'LEFT JOIN uploads up ON up.hash = m.attachment_hash';
/** How much of the original a reply carries: one line's worth. */
const REPLY_SNIPPET = 200;

/**
 * Turn arbitrary text into one FTS5 phrase.
 *
 * Verified necessary: `a"b(c` passed to MATCH raw throws "unterminated
 * string", and `*`, `^he` and `NOT bob` are all parsed as query syntax rather
 * than as the text somebody typed. Wrapping in quotes and doubling any
 * internal quote makes every one of them a literal, non-throwing search.
 */
export const ftsPhrase = (query) => `"${String(query).replaceAll('"', '""')}"`;

/**
 * An @mention in message text.
 *
 * The body of the character class is USERNAME_RE from rooms.js, because a
 * mention is a nickname and nothing else -- NOT a display name. Display
 * names may contain spaces and capitals and two people may hold ones that
 * look alike, so there is no answer to "who did they mean"; a nickname is
 * unique, immutable and already folded.
 *
 * The lookbehind refuses a match that follows a word character or another
 * @, so an email address in a message does not quietly notify somebody.
 *
 * THE CLIENT HAS A COPY of this, in app.js, because it has to draw the same
 * thing it sends. If one changes the other has to.
 */
export const MENTION_RE = /(?<![\w@])@([a-z0-9][a-z0-9_-]{0,23})/gi;

/** The one mention that is not a nickname. */
export const EVERYONE = 'everyone';

/**
 * Who a message is addressed to.
 *
 * Computed from the text rather than stored, and that is deliberate. A
 * mentions table would be a second source of truth for something the body
 * already states: edit the text and the table is wrong, and nothing in the
 * UI would show it. Nicknames cannot be changed, so the text cannot start
 * meaning somebody else later.
 *
 * `idOf` takes a folded nickname and returns a user id or null, so this
 * function needs no database of its own.
 */
export function mentionsIn(body, idOf) {
  const text = String(body ?? '');
  const userIds = [];
  let everyone = false;

  MENTION_RE.lastIndex = 0;
  for (let m = MENTION_RE.exec(text); m; m = MENTION_RE.exec(text)) {
    const name = m[1].toLowerCase();
    if (name === EVERYONE) {
      everyone = true;
      continue;
    }
    const id = idOf(name);
    // Deduped: writing somebody's name twice is emphasis, not two pings.
    if (id && !userIds.includes(id)) userIds.push(id);
  }
  return { userIds, everyone };
}

export class Chat {
  #db;
  #dir;
  #maxBytes;
  #maxFileBytes = DEFAULT_FILE_BYTES;
  #q;

  constructor(db, { dataDir, maxDiskBytes }) {
    this.#db = db;
    this.#dir = join(dataDir, 'uploads');
    this.#maxBytes = maxDiskBytes;
    mkdirSync(this.#dir, { recursive: true });
    // Half-finished uploads from before a restart: their sessions died with
    // the process, so nothing will ever finish them.
    rmSync(this.incomingDir, { recursive: true, force: true });
    mkdirSync(this.incomingDir, { recursive: true });

    this.#q = {
      insertMessage: db.prepare(
        'INSERT INTO messages '
        + '(channel_id, user_id, body, attachment_hash, attachment_name, media_type, reply_to, created_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      insertFts: db.prepare(
        'INSERT INTO messages_fts (rowid, body, nickname, media_type) VALUES (?, ?, ?, ?)',
      ),
      deleteFts: db.prepare('DELETE FROM messages_fts WHERE rowid = ?'),
      editMessage: db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?'),
      setAttachment: db.prepare(
        'UPDATE messages SET attachment_hash = ?, attachment_name = ?, media_type = ?, '
        + 'edited_at = ? WHERE id = ?',
      ),
      deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
      messageById: db.prepare(`
        SELECT m.*, u.nickname${REPLY_COLUMNS} FROM messages m JOIN users u ON u.id = m.user_id
        ${REPLY_JOIN}
        WHERE m.id = ?
      `),
      history: db.prepare(`
        SELECT m.*, u.nickname${REPLY_COLUMNS} FROM messages m JOIN users u ON u.id = m.user_id
        ${REPLY_JOIN}
        WHERE m.channel_id = ? AND m.id < ?
        ORDER BY m.id DESC LIMIT ?
      `),
      pinned: db.prepare(`
        SELECT m.*, u.nickname${REPLY_COLUMNS} FROM messages m JOIN users u ON u.id = m.user_id
        ${REPLY_JOIN}
        WHERE m.channel_id = ? AND m.pinned = 1
        ORDER BY m.id DESC
      `),
      setPinned: db.prepare('UPDATE messages SET pinned = ? WHERE id = ?'),

      searchFts: db.prepare(`
        SELECT m.*, u.nickname${REPLY_COLUMNS} FROM messages_fts f
        JOIN messages m ON m.id = f.rowid
        JOIN users u ON u.id = m.user_id
        ${REPLY_JOIN}
        WHERE messages_fts MATCH ? AND m.channel_id = ?
        ORDER BY m.id DESC LIMIT ?
      `),
      searchLike: db.prepare(`
        SELECT m.*, u.nickname${REPLY_COLUMNS} FROM messages m JOIN users u ON u.id = m.user_id
        ${REPLY_JOIN}
        WHERE m.channel_id = ?
          AND (m.body LIKE ? OR u.nickname LIKE ? OR IFNULL(m.media_type, '') LIKE ?)
        ORDER BY m.id DESC LIMIT ?
      `),

      react: db.prepare(
        'INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji, created_at) '
        + 'VALUES (?, ?, ?, ?)',
      ),
      unreact: db.prepare(
        'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
      ),

      upload: db.prepare('SELECT * FROM uploads WHERE hash = ?'),
      insertUpload: db.prepare(
        'INSERT INTO uploads (hash, content_type, bytes, created_at, refs) VALUES (?, ?, ?, ?, 0) '
        + 'ON CONFLICT(hash) DO NOTHING',
      ),
      addRef: db.prepare('UPDATE uploads SET refs = refs + 1 WHERE hash = ?'),
      dropRef: db.prepare('UPDATE uploads SET refs = MAX(0, refs - 1) WHERE hash = ?'),
      totalBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM uploads'),
      orphans: db.prepare('SELECT hash FROM uploads WHERE refs <= 0 ORDER BY created_at LIMIT 200'),
      deleteUpload: db.prepare('DELETE FROM uploads WHERE hash = ?'),
    };
  }

  // ----------------------------------------------------------------- files

  get usedBytes() {
    return this.#q.totalBytes.get().n;
  }

  get quotaBytes() {
    return this.#maxBytes;
  }

  /** The owner's choice of total, from server settings. */
  set quotaBytes(bytes) {
    this.#maxBytes = Math.max(0, Number(bytes) || 0);
  }

  /** The largest file one upload may be. */
  get maxFileBytes() {
    return this.#maxFileBytes;
  }

  set maxFileBytes(bytes) {
    this.#maxFileBytes = Math.min(MAX_FILE_LIMIT, Math.max(1, Number(bytes) || DEFAULT_FILE_BYTES));
  }

  /** Where upload sessions write until a file is complete. Same filesystem, so the move is a rename. */
  get incomingDir() {
    return join(this.#dir, 'incoming');
  }

  /** Free space on the disk the uploads are on, or null where it cannot be asked. */
  diskFreeBytes() {
    try {
      const { bavail, bsize } = statfsSync(this.#dir);
      return Number(bavail) * Number(bsize);
    } catch {
      return null;
    }
  }

  /**
   * Is there room for this many more bytes? Evicts unreferenced files to
   * make it, oldest first, if the quota is what is short.
   *
   * `reserved` is what open upload sessions have already been promised, so
   * three people starting a big file at once cannot each be told there is
   * room for theirs alone.
   */
  makeRoom(bytes, reserved = 0) {
    const needed = bytes + reserved;
    if (this.usedBytes + needed > this.#maxBytes) {
      this.#evictOrphans(needed);
      if (this.usedBytes + needed > this.#maxBytes) return false;
    }
    const free = this.diskFreeBytes();
    return free === null || free - needed >= DISK_RESERVE_BYTES;
  }

  /** Sharded, so one directory never holds tens of thousands of entries. */
  pathFor(hash) {
    return join(this.#dir, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  /**
   * Store a file, keyed by the hash of its contents.
   *
   * Content addressing means uploading the same image twice costs nothing the
   * second time, and that a file's name can never collide with or escape into
   * another's -- the hash is the only thing that reaches the filesystem.
   *
   * @returns {{ok: true, upload: object} | {ok: false, error: string}}
   */
  store(buffer, claimedType) {
    const contentType = storedType(claimedType);
    if (!buffer?.length) return { ok: false, error: 'empty_file' };
    if (buffer.length > Math.min(MAX_UPLOAD_BYTES, this.#maxFileBytes)) {
      return { ok: false, error: 'file_too_large' };
    }

    const hash = createHash('sha256').update(buffer).digest('hex');
    const existing = this.#q.upload.get(hash);
    if (existing) return { ok: true, upload: existing, deduplicated: true };

    // Checked BEFORE writing, and it is not only about uploads: once the
    // filesystem is full every SQLite write throws too, so an unbounded
    // uploads directory does not degrade the server, it stops it.
    if (!this.makeRoom(buffer.length)) return { ok: false, error: 'server_full' };

    const target = this.pathFor(hash);
    mkdirSync(join(target, '..'), { recursive: true });
    // Write then rename, so a crash mid-write cannot leave a truncated file
    // sitting at the name its hash promises.
    const temp = `${target}.part`;
    writeFileSync(temp, buffer);
    renameSync(temp, target);

    this.#q.insertUpload.run(hash, contentType, buffer.length, Date.now());
    return { ok: true, upload: this.#q.upload.get(hash), deduplicated: false };
  }

  /**
   * Take a file an upload session has finished writing (upload-sessions.js).
   *
   * The session hashed it as it arrived, so this is a rename into place --
   * or, when the same file is already here, deleting the copy.
   */
  adopt(tempPath, { hash, bytes, claimedType }) {
    const existing = this.#q.upload.get(hash);
    if (existing) {
      try { unlinkSync(tempPath); } catch { /* already gone */ }
      return { ok: true, upload: existing, deduplicated: true };
    }
    const target = this.pathFor(hash);
    mkdirSync(join(target, '..'), { recursive: true });
    renameSync(tempPath, target);
    this.#q.insertUpload.run(hash, storedType(claimedType), bytes, Date.now());
    return { ok: true, upload: this.#q.upload.get(hash), deduplicated: false };
  }

  /** Delete unreferenced files until there is room, oldest first. */
  #evictOrphans(needed) {
    for (const { hash } of this.#q.orphans.all()) {
      try {
        unlinkSync(this.pathFor(hash));
      } catch { /* already gone; drop the row anyway */ }
      this.#q.deleteUpload.run(hash);
      if (this.usedBytes + needed <= this.#maxBytes) return;
    }
  }

  /**
   * Take a reference on a stored file, so eviction leaves it alone.
   *
   * Public because messages are not the only thing that points at an upload:
   * avatars and soundpad clips do too, and each of those lives in its own
   * module. Reference counting in one place and the owners in another is how a
   * file somebody is still using gets swept.
   */
  retain(hash) {
    this.#q.addRef.run(hash);
  }

  /** Give one back. Dropping to zero makes the file eligible for eviction. */
  release(hash) {
    if (hash) this.#q.dropRef.run(hash);
  }

  fileInfo(hash) {
    const row = this.#q.upload.get(hash);
    if (!row) return null;
    try {
      statSync(this.pathFor(hash));
    } catch {
      return null; // row without a file: treat as missing rather than 500
    }
    return { ...row, path: this.pathFor(hash) };
  }

  // -------------------------------------------------------------- messages

  /**
   * Post a message. The FTS row is written here and nowhere else.
   *
   * One write path rather than triggers: a trigger that silently stops firing
   * produces a search index that is quietly wrong, which is far harder to
   * notice than a function that throws.
   */
  /**
   * A filename that can be written to disk and cannot escape a directory.
   *
   * Only the last segment is kept, so "../../.ssh/authorized_keys" becomes
   * "authorized_keys" -- the client picks where a download goes, but the
   * name must never be able to choose for it. Separators are stripped on
   * BOTH conventions, because the machine that uploads and the machine
   * that downloads need not be the same kind.
   */
  static cleanFilename(raw) {
    const value = String(raw ?? '').split(/[\\/]/).pop() ?? '';
    const safe = value
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 120);
    return safe || null;
  }

  post({ channelId, user, body = '', attachmentHash = null, attachmentName = null, replyTo = null }) {
    const text = String(body ?? '').slice(0, 4000);
    if (!text.trim() && !attachmentHash) return { ok: false, error: 'empty_message' };

    // A reply answers a message in the same channel, and one that exists:
    // anything else would be a quote of something the readers here cannot
    // see.
    let replyId = null;
    if (replyTo !== null && replyTo !== undefined) {
      replyId = Number.parseInt(replyTo, 10);
      const original = Number.isSafeInteger(replyId) ? this.#q.messageById.get(replyId) : null;
      if (!original || original.channel_id !== channelId) return { ok: false, error: 'bad_reply' };
    }

    let mediaType = null;
    if (attachmentHash) {
      const upload = this.#q.upload.get(attachmentHash);
      if (!upload) return { ok: false, error: 'no_such_upload' };
      mediaType = mediaTypeOf(upload.content_type);
    }

    this.#db.exec('BEGIN');
    try {
      const info = this.#q.insertMessage.run(
        channelId,
        user.id,
        text,
        attachmentHash,
        attachmentHash ? Chat.cleanFilename(attachmentName) : null,
        mediaType,
        replyId,
        Date.now(),
      );
      const id = Number(info.lastInsertRowid);
      this.#q.insertFts.run(id, text, user.nickname, mediaType ?? '');
      if (attachmentHash) this.#q.addRef.run(attachmentHash);
      this.#db.exec('COMMIT');
      return { ok: true, message: this.#q.messageById.get(id) };
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  get(id) {
    return this.#q.messageById.get(id) ?? null;
  }

  /**
   * Change what a message says.
   *
   * The FTS row is rewritten here, in the same transaction, for the same
   * reason post() writes it: one write path, nothing hidden in a trigger.
   * Deleting and re-inserting rather than updating, because that is the
   * pair of operations the index is kept in step with everywhere else and
   * an fts5 UPDATE is a different code path for no gain.
   *
   * An attachment cannot be edited -- only the words beside it. So a
   * message with a picture may be edited down to nothing, and one without
   * may not: the rule is the same one post() applies, which is that a
   * message has to be something.
   */
  edit(id, body) {
    const message = this.#q.messageById.get(id);
    if (!message) return { ok: false, error: 'no_such_message' };

    const text = String(body ?? '').slice(0, 4000);
    if (!text.trim() && !message.attachment_hash) {
      return { ok: false, error: 'empty_message' };
    }
    if (text === message.body) return { ok: true, message, unchanged: true };

    this.#db.exec('BEGIN');
    try {
      this.#q.editMessage.run(text, Date.now(), id);
      this.#q.deleteFts.run(id);
      this.#q.insertFts.run(id, text, message.nickname, message.media_type ?? '');
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { ok: true, message: this.#q.messageById.get(id) };
  }

  remove(id) {
    const message = this.#q.messageById.get(id);
    if (!message) return { ok: false, error: 'no_such_message' };

    this.#db.exec('BEGIN');
    try {
      this.#q.deleteFts.run(id);
      this.#q.deleteMessage.run(id);
      if (message.attachment_hash) this.#q.dropRef.run(message.attachment_hash);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { ok: true, message };
  }

  // ------------------------------------------------------------- reactions

  /**
   * Reactions for a page of messages, grouped and counted.
   *
   * One query for the whole page rather than one per message: a fifty-row
   * history would otherwise be fifty-one trips into SQLite for something
   * most messages do not have at all.
   *
   * Prepared on the spot because the id list varies in length and
   * node:sqlite has no array binding. The tempting alternative -- a BETWEEN
   * over the page's first and last id -- is wrong the moment somebody
   * deletes a message, because a page stops being a contiguous id range.
   *
   * Grouped in insertion order (rowid), so the first reaction anybody chose
   * stays leftmost as others pile onto it.
   */
  reactionsFor(ids) {
    const out = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return out;

    const rows = this.#db.prepare(
      'SELECT message_id, emoji, user_id FROM message_reactions '
      + `WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY rowid`,
    ).all(...ids);

    const groups = new Map();
    for (const row of rows) {
      const key = `${row.message_id}\u0000${row.emoji}`;
      let group = groups.get(key);
      if (!group) {
        group = { emoji: row.emoji, count: 0, userIds: [] };
        groups.set(key, group);
        out.get(row.message_id)?.push(group);
      }
      group.count += 1;
      group.userIds.push(row.user_id);
    }
    return out;
  }

  reactions(messageId) {
    return this.reactionsFor([messageId]).get(messageId) ?? [];
  }

  /**
   * Add or remove one person's reaction. Idempotent in both directions.
   *
   * INSERT OR IGNORE rather than a read-then-write: two clicks racing each
   * other cannot produce two rows, because the primary key refuses the
   * second regardless of what either one read first.
   */
  react({ messageId, userId, emoji, on = true }) {
    const message = this.#q.messageById.get(messageId);
    if (!message) return { ok: false, error: 'no_such_message' };

    const key = Chat.reactionKey(emoji);
    if (!key) return { ok: false, error: 'bad_emoji' };

    if (on) this.#q.react.run(messageId, userId, key, Date.now());
    else this.#q.unreact.run(messageId, userId, key);

    return { ok: true, message, reactions: this.reactions(messageId) };
  }

  /**
   * What counts as something to react with.
   *
   * ":name:" for a custom one, or a short run of emoji. The cap matters:
   * the column is TEXT and without it a "reaction" can be a second message
   * body, rendering as a button the width of the pane.
   *
   * The control-character rule has one deliberate hole. \p{C} would be the
   * obvious test and it is WRONG here -- U+200D ZERO WIDTH JOINER is
   * Cf, and it is what holds together every family, every profession and
   * most of the people emoji anyone would actually use. It is allowed by
   * name; the other format characters, which is where a right-to-left
   * override would come in and reverse the row around it, are not.
   */
  static reactionKey(raw) {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    if (/^:[a-z0-9_]{2,32}:$/.test(value)) return value;

    if (/[\p{Cc}\p{Cs}]/u.test(value)) return null;
    if (/\p{Cf}/u.test(value.replaceAll('\u200d', ''))) return null;
    if ([...value].length > 16) return null;
    return value;
  }

  /**
   * Swap the file on a message, or take it off.
   *
   * The reference counting is the whole of this. An upload is shared by
   * everything that points at it, so putting a new file on a message means
   * taking a reference AND giving the old one back -- miss the second half
   * and the old file is never evictable, miss the first and it can be swept
   * out from under the message that is now showing it.
   *
   * The FTS row carries media_type, so it is rewritten too: searching for
   * "image" has to stop finding a message whose image has become a video.
   *
   * Removing is allowed only when there are words left, which is the same
   * rule post() and edit() apply -- a message has to be something.
   */
  setAttachment(id, { hash = null, name = null } = {}) {
    const message = this.#q.messageById.get(id);
    if (!message) return { ok: false, error: 'no_such_message' };

    let mediaType = null;
    if (hash) {
      const upload = this.#q.upload.get(hash);
      if (!upload) return { ok: false, error: 'no_such_upload' };
      mediaType = mediaTypeOf(upload.content_type);
    } else if (!message.body.trim()) {
      return { ok: false, error: 'empty_message' };
    }

    const previous = message.attachment_hash ?? null;
    if (previous === hash) return { ok: true, message, unchanged: true };

    this.#db.exec('BEGIN');
    try {
      this.#q.setAttachment.run(
        hash,
        hash ? Chat.cleanFilename(name) : null,
        mediaType,
        Date.now(),
        id,
      );
      if (hash) this.#q.addRef.run(hash);
      if (previous) this.#q.dropRef.run(previous);
      this.#q.deleteFts.run(id);
      this.#q.insertFts.run(id, message.body, message.nickname, mediaType ?? '');
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { ok: true, message: this.#q.messageById.get(id) };
  }

  history(channelId, { before = Number.MAX_SAFE_INTEGER, limit = PAGE_SIZE } = {}) {
    return this.#q.history
      .all(channelId, before, Math.min(limit, PAGE_SIZE))
      .reverse(); // oldest first, which is the order a chat pane renders
  }

  pinned(channelId) {
    return this.#q.pinned.all(channelId);
  }

  setPinned(id, pinned) {
    const message = this.#q.messageById.get(id);
    if (!message) return { ok: false, error: 'no_such_message' };
    this.#q.setPinned.run(pinned ? 1 : 0, id);
    return { ok: true, message: this.#q.messageById.get(id) };
  }

  /**
   * Search one channel by text, author or media type.
   *
   * Returns the mode it used, because the two differ in a way a user can
   * notice: trigram cannot match fewer than 3 characters at all, so short
   * queries silently fall back to LIKE. Surfacing it makes that testable
   * rather than mysterious.
   */
  search(channelId, query, { limit = PAGE_SIZE } = {}) {
    const text = String(query ?? '').trim();
    if (!text) return { mode: 'none', results: [] };

    if (text.length < 3) {
      const like = `%${text.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      return {
        mode: 'like',
        results: this.#q.searchLike.all(channelId, like, like, like, Math.min(limit, PAGE_SIZE)),
      };
    }

    return {
      mode: 'fts',
      results: this.#q.searchFts.all(ftsPhrase(text), channelId, Math.min(limit, PAGE_SIZE)),
    };
  }
}

/**
 * Soundpad clips.
 *
 * Only the registry lives here -- the audio itself is an ordinary upload, so
 * it inherits the allowlist, the per-file cap and the disk quota for free.
 *
 * Playback is NOT mixed into anyone's microphone. The server broadcasts "play
 * clip X" and every client plays its own cached copy, for four reasons: the
 * mixed alternative re-encodes music through a 32 kbps speech codec, the
 * clicker's echo cancellation ducks it, only people subscribed to that one
 * person would hear it, and a force-muted user's soundpad would go silent too.
 */
export class Soundpad {
  #db;
  #q;

  constructor(db) {
    this.#db = db;
    this.#q = {
      all: db.prepare(`
        SELECT c.*, u.nickname AS uploader FROM soundpad_clips c
        LEFT JOIN users u ON u.id = c.uploaded_by
        ORDER BY c.position, c.id
      `),
      // Joined, so a freshly created clip has the same shape as a listed one.
      // Without the join the 201 response says uploader: null and the list
      // says the nickname, which is the kind of inconsistency a client ends up
      // working around rather than reporting.
      byId: db.prepare(`
        SELECT c.*, u.nickname AS uploader FROM soundpad_clips c
        LEFT JOIN users u ON u.id = c.uploaded_by
        WHERE c.id = ?
      `),
      insert: db.prepare(
        'INSERT INTO soundpad_clips '
        + '(name, emoji, file_hash, uploaded_by, position, created_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?)',
      ),
      rename: db.prepare('UPDATE soundpad_clips SET name = ?, emoji = ? WHERE id = ?'),
      nextPosition: db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM soundpad_clips'),
      setPosition: db.prepare('UPDATE soundpad_clips SET position = ? WHERE id = ?'),
      remove: db.prepare('DELETE FROM soundpad_clips WHERE id = ?'),
      addRef: db.prepare('UPDATE uploads SET refs = refs + 1 WHERE hash = ?'),
      dropRef: db.prepare('UPDATE uploads SET refs = MAX(0, refs - 1) WHERE hash = ?'),
      upload: db.prepare('SELECT * FROM uploads WHERE hash = ?'),
    };
  }

  list() {
    return this.#q.all.all();
  }

  /** Change a clip's label. The audio behind it is not touched. */
  rename(id, name, emoji) {
    const clip = this.#q.byId.get(Number(id));
    if (!clip) return { ok: false, error: 'no_such_clip' };
    const clean = String(name ?? '').trim().slice(0, 32);
    if (!clean) return { ok: false, error: 'invalid_name' };
    this.#q.rename.run(clean, Soundpad.emojiOf(emoji), clip.id);
    return { ok: true, clip: this.#q.byId.get(clip.id) };
  }

  /**
   * One emoji, or nothing.
   *
   * Taken as the FIRST grapheme rather than validated as "an emoji": there
   * is no cheap, correct test for that, every approximation refuses
   * something somebody wanted, and the worst case here is a clip labelled
   * with a letter -- which is fine, and is what several of them will be
   * anyway.
   *
   * \p{C} is refused for the same reason it is on a display name: a
   * right-to-left override in a grid of buttons reverses the labels around
   * it.
   */
  static emojiOf(raw) {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    if (/\p{C}/u.test(value)) return null;
    return [...value][0] ?? null;
  }

  add({ name, emoji, fileHash, userId }) {
    const clean = String(name ?? '').trim().slice(0, 32);
    if (!clean) return { ok: false, error: 'invalid_name' };

    const upload = this.#q.upload.get(fileHash);
    if (!upload) return { ok: false, error: 'no_such_upload' };
    if (mediaTypeOf(upload.content_type) !== 'audio') {
      return { ok: false, error: 'not_audio' };
    }
    // Checked against the stored row rather than the request: the upload may
    // have been made by somebody else, or reused from an old message, and the
    // cap has to hold either way.
    if (upload.bytes > MAX_CLIP_BYTES) return { ok: false, error: 'clip_too_large' };

    this.#db.exec('BEGIN');
    try {
      const info = this.#q.insert.run(
        clean,
        Soundpad.emojiOf(emoji),
        fileHash,
        userId,
        this.#q.nextPosition.get().p,
        Date.now(),
      );
      // Referenced, so cache eviction and orphan cleanup both leave it alone.
      this.#q.addRef.run(fileHash);
      this.#db.exec('COMMIT');
      return { ok: true, clip: this.#q.byId.get(Number(info.lastInsertRowid)) };
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  remove(id) {
    const clip = this.#q.byId.get(id);
    if (!clip) return { ok: false, error: 'no_such_clip' };
    this.#db.exec('BEGIN');
    try {
      this.#q.remove.run(id);
      this.#q.dropRef.run(clip.file_hash);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { ok: true, clip };
  }

  /**
   * Put the clips in exactly this order.
   *
   * The whole list, for the same reason Channels.reorder takes the whole list:
   * two admins dragging at once cannot interleave into an order neither of
   * them chose.
   */
  reorder(ids) {
    const existing = this.list().map((c) => c.id);
    const wanted = [...new Set(ids.map((n) => Number(n)))];
    if (wanted.length !== existing.length || wanted.some((id) => !existing.includes(id))) {
      return { ok: false, error: 'bad_order' };
    }
    this.#db.exec('BEGIN');
    try {
      wanted.forEach((id, index) => this.#q.setPosition.run(index, id));
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { ok: true, clips: this.list() };
  }

  get(id) {
    return this.#q.byId.get(id) ?? null;
  }
}

/**
 * Custom emoji.
 *
 * A registry over ordinary uploads, exactly like the soundpad -- so the
 * allowlist, the per-file cap and the disk quota all apply without this
 * class knowing they exist.
 *
 * Any member may add one. That is a deliberate departure from the soundpad,
 * which is admin-only: the soundpad plays out loud in everybody's ears and
 * an emoji sits in a picker until somebody chooses it. Removal is the
 * uploader's or an admin's, so a bad one can always be taken back without
 * making every addition a request.
 */
export class Emojis {
  #db;
  #q;

  constructor(db) {
    this.#db = db;
    this.#q = {
      all: db.prepare(`
        SELECT e.*, u.nickname AS uploader FROM emojis e
        LEFT JOIN users u ON u.id = e.uploaded_by
        ORDER BY e.name
      `),
      byId: db.prepare(`
        SELECT e.*, u.nickname AS uploader FROM emojis e
        LEFT JOIN users u ON u.id = e.uploaded_by
        WHERE e.id = ?
      `),
      byName: db.prepare('SELECT * FROM emojis WHERE name = ?'),
      insert: db.prepare(
        'INSERT INTO emojis (name, file_hash, uploaded_by, created_at) VALUES (?, ?, ?, ?)',
      ),
      remove: db.prepare('DELETE FROM emojis WHERE id = ?'),
      count: db.prepare('SELECT COUNT(*) AS n FROM emojis'),
      addRef: db.prepare('UPDATE uploads SET refs = refs + 1 WHERE hash = ?'),
      dropRef: db.prepare('UPDATE uploads SET refs = MAX(0, refs - 1) WHERE hash = ?'),
      upload: db.prepare('SELECT * FROM uploads WHERE hash = ?'),
    };
  }

  list() {
    return this.#q.all.all();
  }

  /**
   * Fold what somebody typed into a name that can be a trigger.
   *
   * Lowercased, spaces and dashes to underscores, surrounding colons
   * dropped so pasting ":shrug:" does what it looks like it does. The
   * result has to match exactly, because the trigger is a literal match in
   * message text -- there is no second chance to be lenient at render time.
   */
  static normalizeName(raw) {
    const value = String(raw ?? '').trim().toLowerCase()
      .replace(/^:+|:+$/g, '')
      .replace(/[\s-]+/g, '_');
    return /^[a-z0-9_]{2,32}$/.test(value) ? value : null;
  }

  add({ name, fileHash, userId }) {
    const clean = Emojis.normalizeName(name);
    if (!clean) return { ok: false, error: 'invalid_name' };
    if (this.#q.byName.get(clean)) return { ok: false, error: 'name_taken' };
    if (this.#q.count.get().n >= MAX_EMOJIS) return { ok: false, error: 'too_many_emojis' };

    const upload = this.#q.upload.get(fileHash);
    if (!upload) return { ok: false, error: 'no_such_upload' };
    if (mediaTypeOf(upload.content_type) !== 'image') return { ok: false, error: 'not_an_image' };
    // Against the stored row, not the request: the upload may be one
    // somebody else made, and the cap has to hold either way.
    if (upload.bytes > MAX_EMOJI_BYTES) return { ok: false, error: 'emoji_too_large' };

    this.#db.exec('BEGIN');
    try {
      const info = this.#q.insert.run(clean, fileHash, userId, Date.now());
      this.#q.addRef.run(fileHash);
      this.#db.exec('COMMIT');
      return { ok: true, emoji: this.#q.byId.get(Number(info.lastInsertRowid)) };
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  get(id) {
    return this.#q.byId.get(id) ?? null;
  }

  remove(id) {
    const emoji = this.#q.byId.get(id);
    if (!emoji) return { ok: false, error: 'no_such_emoji' };
    this.#db.exec('BEGIN');
    try {
      this.#q.remove.run(id);
      this.#q.dropRef.run(emoji.file_hash);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { ok: true, emoji };
  }
}

export const publicEmoji = (e) => (e ? {
  id: e.id,
  name: e.name,
  hash: e.file_hash,
  uploadedBy: e.uploaded_by ?? null,
  uploader: e.uploader ?? null,
  createdAt: e.created_at,
} : null);

export const publicClip = (c) => (c ? {
  id: c.id,
  name: c.name,
  emoji: c.emoji ?? null,
  hash: c.file_hash,
  uploader: c.uploader ?? null,
  createdAt: c.created_at,
} : null);

/**
 * A message as the client sees it.
 *
 * Reactions are passed in rather than looked up here, because they are a
 * second query and this is called in a loop over a page. Defaulting to []
 * means a caller that has not got them yet renders an empty strip rather
 * than throwing -- which is also exactly right for a message created one
 * line ago.
 */
export const publicMessage = (m, reactions = [], mentions = null) => (m ? {
  id: m.id,
  channelId: m.channel_id,
  userId: m.user_id,
  nickname: m.nickname,
  body: m.body,
  attachmentHash: m.attachment_hash ?? null,
  attachmentName: m.attachment_name ?? null,
  attachmentBytes: m.attachment_bytes ?? null,
  mediaType: m.media_type ?? null,
  pinned: Boolean(m.pinned),
  editedAt: m.edited_at ?? null,
  /*
   * What this answers: who, and the start of what they said -- or, when the
   * original has since been deleted, just that it was.
   */
  replyTo: m.reply_to ?? null,
  reply: m.reply_to
    ? (m.r_id
      ? {
        id: m.r_id,
        userId: m.r_user_id,
        nickname: m.r_nickname,
        body: String(m.r_body ?? '').slice(0, REPLY_SNIPPET),
        mediaType: m.r_media_type ?? null,
        attachmentName: m.r_attachment_name ?? null,
      }
      : { id: m.reply_to, deleted: true })
    : null,
  reactions,
  // Ids, not names: the client already has the roster and would otherwise
  // have to fold and match nicknames a second time to know whether one of
  // them is you.
  mentions: mentions?.userIds ?? [],
  mentionsEveryone: Boolean(mentions?.everyone),
  createdAt: m.created_at,
} : null);
