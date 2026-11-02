// The database, and the only place that knows SQL schema.
//
// Harmony stored nothing on disk until this file existed. That was enforced,
// not incidental -- `read_only: true` in compose, `ProtectSystem=strict` in
// systemd -- so introducing a writable directory is a deployment change as much
// as a code change. The boot check below exists because the expected first
// experience of an un-upgraded deployment is EROFS, and an unexplained EROFS at
// 2am is an hour of someone's evening.
//
// `node:sqlite` rather than better-sqlite3: zero npm dependencies and zero
// native compilation. The Docker `deps` stage runs on $BUILDPLATFORM with no
// build toolchain, so a native SQLite module would silently produce binaries
// for the wrong architecture on every cross-build for a Pi.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Schema migrations, applied in order. The array index is the version the
 * migration produces: migrations[0] takes an empty database to user_version 1.
 *
 * Never edit a migration that has shipped -- add a new one. A deployed server
 * has already run the old text, and SQLite has no way to notice it changed.
 */
const MIGRATIONS = [
  // v1 -- identity.
  (db) => {
    db.exec(`
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY,
        nickname      TEXT    NOT NULL UNIQUE,
        password_hash TEXT    NOT NULL,
        role          TEXT    NOT NULL DEFAULT 'member',
        avatar_hash   TEXT,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        token_hash TEXT    PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL
      );
      CREATE INDEX sessions_user ON sessions(user_id);

      CREATE TABLE server_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },

  // v2 -- channels.
  (db) => {
    db.exec(`
      CREATE TABLE channels (
        id            INTEGER PRIMARY KEY,
        kind          TEXT    NOT NULL,
        name          TEXT    NOT NULL,
        position      INTEGER NOT NULL,
        password_hash TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX channels_order ON channels(position, id);

      -- Entering a channel password grants lasting access, so it is asked once
      -- rather than on every join. Revoking is deleting the row.
      CREATE TABLE channel_grants (
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, user_id)
      );
    `);

    // A server with no channels has nowhere to go, and an owner who has to
    // create one before anything works is a worse first run than a lobby that
    // already exists. Both are deletable.
    const now = Date.now();
    const insert = db.prepare(
      'INSERT INTO channels (kind, name, position, created_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('text', 'general', 0, now);
    insert.run('voice', 'voice', 1, now);
  },

  // v3 -- chat, uploads and search.
  (db) => {
    db.exec(`
      CREATE TABLE uploads (
        hash         TEXT    PRIMARY KEY,
        content_type TEXT    NOT NULL,
        bytes        INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        refs         INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE messages (
        id              INTEGER PRIMARY KEY,
        channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id         INTEGER NOT NULL REFERENCES users(id),
        body            TEXT    NOT NULL DEFAULT '',
        attachment_hash TEXT    REFERENCES uploads(hash),
        media_type      TEXT,
        pinned          INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX messages_channel ON messages(channel_id, id DESC);
      CREATE INDEX messages_pinned  ON messages(channel_id) WHERE pinned = 1;
    `);

    /*
     * Search.
     *
     * `trigram` rather than the default tokenizer because "fuzzy" in the
     * request means substring: typing "creen" should find "screenshot", which
     * a word tokenizer will never do. Verified behaviour, both parts of which
     * the query layer has to handle and neither of which is an error:
     *
     *   - a query shorter than 3 characters matches NOTHING, silently. Hence
     *     the mandatory LIKE fallback in chat.js.
     *   - raw user input passed to MATCH throws (a"b(c -> "unterminated
     *     string"), so every query is wrapped as one escaped phrase.
     *
     * columnsize=0 drops per-column length data we never rank on. A trigram
     * index costs roughly 2-3x the indexed text, which for a friends' server
     * is kilobytes.
     *
     * nickname is denormalised in so that "everything by bob" needs no join.
     * Kept in sync by chat.js's single write path rather than by triggers --
     * one place to look, nothing hidden.
     */
    db.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        body, nickname, media_type,
        tokenize = 'trigram',
        columnsize = 0
      );
    `);
  },

  // v4 -- the soundpad.
  (db) => {
    db.exec(`
      CREATE TABLE soundpad_clips (
        id          INTEGER PRIMARY KEY,
        name        TEXT    NOT NULL,
        file_hash   TEXT    NOT NULL REFERENCES uploads(hash),
        uploaded_by INTEGER REFERENCES users(id),
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX soundpad_order ON soundpad_clips(position, id);
    `);
  },

  /*
   * v5 -- a display name.
   *
   * SEPARATE from the nickname, not a relaxing of it. The nickname is an
   * identity: it is folded, it is unique, it is what you log in with, it is
   * what a MediaMTX path is built from and what the auth hook parses. A
   * display name is a label, so it may be anything -- capitals, spaces,
   * accents, emoji -- and two people may pick the same one.
   *
   * NULL means "no preference", which renders as the nickname. Storing the
   * nickname into it instead would mean a later change of nickname quietly
   * failing to show up.
   */
  (db) => {
    db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
  },

  /*
   * v6 -- an emoji on a soundpad clip.
   *
   * A grid of twenty identically-shaped buttons is read by shape before it
   * is read by text, and a name alone gives it nothing to be read by. One
   * character in front of the name is the cheapest thing that makes a clip
   * findable at a glance.
   *
   * NULL means none, and a clip without one is still perfectly usable --
   * which is why this is a nullable column rather than a required field on
   * every existing clip.
   */
  (db) => {
    db.exec('ALTER TABLE soundpad_clips ADD COLUMN emoji TEXT');
  },

  /*
   * v7 -- channel groups.
   *
   * ON DELETE SET NULL, not CASCADE. Deleting a group must not take its
   * channels -- and every message, pin and attachment in them -- with it.
   * A group is a folder for the sidebar, not a container that owns
   * anything, and an admin tidying the list would otherwise destroy a
   * year of chat with one click and no warning that said so.
   *
   * group_id NULL means ungrouped, which is where every channel starts and
   * is why this migration needs no data step.
   *
   * Positions stay on the channels themselves and are read WITHIN a group
   * rather than globally -- see Channels.arrange for why the whole tree is
   * written at once instead of in moves.
   */
  (db) => {
    db.exec(`
      CREATE TABLE channel_groups (
        id         INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL,
        position   INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      ALTER TABLE channels
        ADD COLUMN group_id INTEGER REFERENCES channel_groups(id) ON DELETE SET NULL;
    `);
  },

  /*
   * v8 -- custom emoji, and reactions.
   *
   * PRIMARY KEY (message_id, user_id, emoji) is the whole of "they add up".
   * A second identical reaction from the same person is a key conflict
   * rather than a second row, so a count is a COUNT and cannot drift --
   * there is no tally to keep in step with anything. Reacting again
   * deletes the row, which is why the route is a toggle rather than two.
   *
   * ON DELETE CASCADE on both sides, unlike the groups above. A reaction
   * has no life of its own: it is a fact about a message by a person, and
   * once either is gone there is nothing left for it to mean.
   *
   * emoji is TEXT holding a unicode emoji or ":name:", NOT a foreign key
   * into emojis. A reaction has to outlive the custom emoji behind it --
   * an admin tidying the picker must not silently delete other people's
   * reactions. The count stays and the picture falls back to the text.
   *
   * emojis.name is UNIQUE because it is the trigger: ":shrug:" has to mean
   * exactly one picture, everywhere, or the same message reads differently
   * for two people.
   */
  (db) => {
    db.exec(`
      CREATE TABLE emojis (
        id          INTEGER PRIMARY KEY,
        name        TEXT    NOT NULL UNIQUE,
        file_hash   TEXT    NOT NULL REFERENCES uploads(hash),
        uploaded_by INTEGER REFERENCES users(id),
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE message_reactions (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
        emoji      TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
      );
      CREATE INDEX message_reactions_message ON message_reactions(message_id);
    `);
  },

  /*
   * v9 -- what the attachment was called.
   *
   * Uploads are content-addressed, so the only name a file had on disk was
   * its own hash. That was fine while the only thing anybody did with an
   * attachment was look at it; the moment you can save one, every download
   * is called 9f86d081...  and a folder of them is unreadable.
   *
   * On the MESSAGE, not on the upload: the same bytes posted twice
   * deduplicate to one row in uploads, and the two people who posted them
   * may well have called the file different things. The name belongs to
   * the act of posting, not to the content.
   *
   * Nullable, and every message already here keeps a null -- those fall
   * back to a name derived from the content type, which is the best that
   * can honestly be said about them.
   */
  (db) => {
    db.exec('ALTER TABLE messages ADD COLUMN attachment_name TEXT');
  },

  /*
   * v10 -- when a message was changed.
   *
   * A timestamp rather than a flag, because "edited" and "edited when" are
   * the same column and only one of them can be added later without a
   * second migration.
   *
   * NOT a revision history. Keeping the old text would mean a client could
   * show somebody words they deliberately took back, which is the opposite
   * of what editing is for -- and on a friends' server nobody is auditing
   * anybody. The marker exists so that a message which changed after you
   * read it does not look like the one you read.
   */
  (db) => {
    db.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER');
  },

  /*
   * v-next -- replies.
   *
   * The id of the message this one answers. No foreign key, on purpose: a
   * reply whose original was deleted is still a reply, and says so ("the
   * original was deleted") rather than quietly turning into an ordinary
   * message, which is what ON DELETE SET NULL would make it.
   */
  (db) => {
    db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER');
  },

  /*
   * v-next -- groups and ungrouped channels share one order.
   *
   * A group's position used to count groups (0, 1, 2) and a channel's counted
   * channels, two separate sequences, with every ungrouped channel drawn above
   * every group. That is why a group could never be put above a channel that
   * belongs to none.
   *
   * Now one sequence numbers everything in the order the sidebar draws it: a
   * group's heading, then its channels, and ungrouped channels wherever they
   * sit among the headings. This rewrites what is stored into that sequence
   * without changing what anybody sees today: ungrouped channels first, then
   * each group with its own channels under it.
   */
  (db) => {
    const channels = db.prepare('SELECT id, group_id FROM channels ORDER BY position, id').all();
    const groups = db.prepare('SELECT id FROM channel_groups ORDER BY position, id').all();
    const setChannel = db.prepare('UPDATE channels SET position = ? WHERE id = ?');
    const setGroup = db.prepare('UPDATE channel_groups SET position = ? WHERE id = ?');
    const grouped = new Set(groups.map((g) => g.id));

    let next = 0;
    for (const c of channels) {
      if (c.group_id == null || !grouped.has(c.group_id)) setChannel.run(next++, c.id);
    }
    for (const g of groups) {
      setGroup.run(next++, g.id);
      for (const c of channels) if (c.group_id === g.id) setChannel.run(next++, c.id);
    }
  },

  /*
   * v13 -- profile customisation: a font, a banner and a join sound.
   *
   * All three nullable, and NULL means "none": the default font, no banner
   * and the ordinary join tone, which is what every existing account keeps.
   * The banner and the sound are uploads referenced by hash, exactly like
   * avatar_hash, and are retained and released the same way. The font is the
   * id of one of a fixed list (accounts.js NAME_FONTS), not a font name or a
   * URL: the client ships the fonts, and nobody can point this at a file.
   */
  (db) => {
    db.exec('ALTER TABLE users ADD COLUMN name_font TEXT');
    db.exec('ALTER TABLE users ADD COLUMN banner_hash TEXT');
    db.exec('ALTER TABLE users ADD COLUMN join_sound_hash TEXT');
  },

  /*
   * v14 -- private conversations between two people, end-to-end encrypted.
   *
   * The same tables, with the same columns, as Ciranda's, which is where this
   * feature was made first: a client that speaks one server speaks the other.
   * Ciranda reached them in four steps (its v12, v13, v14 and v17: the
   * conversations, what a message said before an edit, deleting a conversation
   * for yourself, and an index under the file column); they are one here, in
   * the shape they ended up in.
   *
   * The server holds ciphertext and the metadata it cannot avoid knowing
   * (who, when, how big). It never holds a key that opens anything: the
   * private half of every identity key is generated on the client, and what
   * is stored here (`wrapped`) is that key sealed under a recovery key the
   * server never sees. Nothing below is readable by whoever runs the server,
   * the owner included, and that is the feature rather than a side effect.
   *
   * user_keys keeps HISTORY, not just the current key. A message is sealed
   * to the pair of keys that existed when it was sent, and somebody who loses
   * their recovery key and starts over must not make every message the other
   * person ever received from them unreadable to that other person as well.
   * The current key is the newest row.
   *
   * dm_messages.sender_key / recipient_key are plain integers, not foreign
   * keys: a message names the keys it was sealed to, and an account removal
   * that takes the keys with it must not be blocked by -- or cascade through
   * -- the other person's half of the history, which goes with the
   * conversation anyway.
   *
   * user_a < user_b makes "the conversation between these two" exactly one
   * row, so two people opening it at the same moment cannot make two.
   *
   * dm_reads is a high-water mark per person, which is all an unread count
   * needs and is the same on every device that person uses. It is never sent
   * to the other side: "seen" is something to opt into, not a default.
   * cleared_id is the other mark beside it: everything up to it is gone for
   * that person and still there for the other. Something new brings the
   * conversation back, starting from there; once both have cleared past a
   * message nobody can see it any more, and it is deleted for real.
   *
   * dm_message_edits keeps each version that was REPLACED, sealed as it was,
   * with the moment it was written; the current text stays on the message.
   * Deleting the message takes every version along (ON DELETE CASCADE).
   *
   * kind = 'call' rows are written by the server itself -- "missed call",
   * "call, 5 minutes" -- from facts it already has; `meta` holds them as
   * plain JSON and `sealed` is null. Nothing here writes them yet, and a
   * client that meets one draws it.
   */
  (db) => {
    db.exec(`
      CREATE TABLE user_keys (
        id         INTEGER PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key TEXT    NOT NULL,
        wrapped    TEXT    NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX user_keys_user ON user_keys(user_id, id DESC);

      CREATE TABLE dm_conversations (
        id         INTEGER PRIMARY KEY,
        user_a     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_b     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_at    INTEGER NOT NULL,
        CHECK (user_a < user_b),
        UNIQUE (user_a, user_b)
      );
      CREATE INDEX dm_conversations_b ON dm_conversations(user_b);

      CREATE TABLE dm_messages (
        id              INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind            TEXT    NOT NULL DEFAULT 'text',
        sender_key      INTEGER,
        recipient_key   INTEGER,
        sealed          TEXT,
        meta            TEXT,
        attachment_hash TEXT    REFERENCES uploads(hash),
        created_at      INTEGER NOT NULL,
        edited_at       INTEGER
      );
      CREATE INDEX dm_messages_conversation ON dm_messages(conversation_id, id DESC);
      CREATE INDEX dm_messages_attachment ON dm_messages(attachment_hash) WHERE attachment_hash IS NOT NULL;

      CREATE TABLE dm_reactions (
        message_id    INTEGER NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
        user_id       INTEGER NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
        sender_key    INTEGER NOT NULL,
        recipient_key INTEGER NOT NULL,
        sealed        TEXT    NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id)
      );

      CREATE TABLE dm_reads (
        conversation_id INTEGER NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
        user_id         INTEGER NOT NULL REFERENCES users(id)            ON DELETE CASCADE,
        last_read_id    INTEGER NOT NULL,
        cleared_id      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (conversation_id, user_id)
      );

      CREATE TABLE dm_blocks (
        blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (blocker_id, blocked_id)
      );

      CREATE TABLE dm_message_edits (
        id            INTEGER PRIMARY KEY,
        message_id    INTEGER NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
        sender_key    INTEGER NOT NULL,
        recipient_key INTEGER NOT NULL,
        sealed        TEXT    NOT NULL,
        written_at    INTEGER NOT NULL
      );
      CREATE INDEX dm_message_edits_message ON dm_message_edits(message_id, id);
    `);
  },
  /*
   * v15: recovering a password from three questions the person wrote.
   *
   * One row per question, three per account or none. The ANSWER is stored the
   * way a password is -- salted scrypt, of the answer after it has been
   * normalised (see recovery.js) -- because an answer is a password that
   * somebody picked from a much smaller space, and that is worth hiding from
   * anyone who can read the database file. The question is plain text: it has
   * to be shown to somebody who is not signed in.
   */
  (db) => {
    db.exec(`
      CREATE TABLE recovery_answers (
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        slot        INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
        question    TEXT    NOT NULL,
        answer_hash TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (user_id, slot)
      );
    `);
  },
  /*
   * v16: roles.
   *
   * A role is a name, a colour, a set of permissions and a PLACE in one
   * list: `position` 0 is the top of the hierarchy, and that is the whole of
   * how roles rank against each other -- there is no separate "level" to
   * keep in step with the order. permissions and assignable are JSON arrays
   * (permission names, role ids): they are only ever read and written whole,
   * and a table per list would be four joins for nothing.
   *
   * users.role stays what it was -- owner, admin or member. An 'admin' with
   * no roles is the "super admin": the account that can do everything a
   * role can, and rank above all of them. That is why the column is not
   * folded into this table: only the owner can create one, and that is a
   * statement about accounts, not about roles.
   *
   * A role restricts a channel or a group by being listed in channel_roles /
   * group_roles. Deleting a role takes its memberships and its restrictions
   * with it (ON DELETE CASCADE) -- and a channel whose only role was deleted
   * becomes open, not hidden from everyone.
   *
   * A group may hold a password too: it is copied onto the channels inside it
   * (see Channels.setGroupPassword), and kept here so that a channel moved
   * into the group later gets it as well.
   *
   * users.banned_at: a banned account cannot sign in and has no sessions.
   */
  (db) => {
    db.exec(`
      CREATE TABLE roles (
        id          INTEGER PRIMARY KEY,
        name        TEXT    NOT NULL COLLATE NOCASE UNIQUE,
        color       TEXT    NOT NULL DEFAULT '#99aab5',
        position    INTEGER NOT NULL,
        admin       INTEGER NOT NULL DEFAULT 0,
        permissions TEXT    NOT NULL DEFAULT '[]',
        assignable  TEXT    NOT NULL DEFAULT '[]',
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE user_roles (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, role_id)
      );
      CREATE INDEX user_roles_role ON user_roles(role_id);

      CREATE TABLE channel_roles (
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        PRIMARY KEY (channel_id, role_id)
      );

      CREATE TABLE group_roles (
        group_id INTEGER NOT NULL REFERENCES channel_groups(id) ON DELETE CASCADE,
        role_id  INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        PRIMARY KEY (group_id, role_id)
      );

      ALTER TABLE channel_groups ADD COLUMN password_hash TEXT;
      ALTER TABLE users ADD COLUMN banned_at INTEGER;
    `);
  },
  /*
   * v17: the colour of a display name.
   *
   * One JSON text, validated and re-written by accounts.js (cleanNameColor)
   * before it is stored: a solid colour, a gradient that moves, or the
   * rainbow. It overrides the colour of the person's highest role, and null
   * -- the default -- leaves that in charge.
   */
  (db) => {
    db.exec('ALTER TABLE users ADD COLUMN name_color TEXT');
  },
  /*
   * v18: badges.
   *
   * A small decoration with a name, a description and a picture or an emoji,
   * shown on somebody's profile card -- a gimmick, or a reward. Whoever may
   * (the badges.create and badges.edit permissions, or an admin) makes them;
   * handing one out is a different permission, and is limited to the badges a
   * role lists in assignable_badges, as handing out roles is limited to the
   * roles it lists.
   *
   * image_hash is a file already uploaded (and retained by chat, like an
   * avatar). A badge is either that or an emoji, never neither.
   */
  (db) => {
    db.exec(`
      CREATE TABLE badges (
        id          INTEGER PRIMARY KEY,
        name        TEXT    NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT    NOT NULL DEFAULT '',
        emoji       TEXT,
        image_hash  TEXT,
        position    INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE user_badges (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        badge_id   INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
        awarded_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, badge_id)
      );
      CREATE INDEX user_badges_badge ON user_badges(badge_id);

      ALTER TABLE roles ADD COLUMN assignable_badges TEXT NOT NULL DEFAULT '[]';
    `);
  },
  /*
   * v19: people let into a channel by name.
   *
   * A channel or group restricted to roles can also name individual people. The
   * audience is the roles AND these people: somebody who holds one of the
   * roles, or is listed, may see it; nobody else is told it exists. A channel
   * with neither list is open, as before.
   */
  (db) => {
    db.exec(`
      CREATE TABLE channel_users (
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (channel_id, user_id)
      );
      CREATE TABLE group_users (
        group_id INTEGER NOT NULL REFERENCES channel_groups(id) ON DELETE CASCADE,
        user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (group_id, user_id)
      );
    `);
  },
  /*
   * v20: a role's name can be a gradient or the rainbow, as a person's can.
   *
   * `style` is the same JSON a display name's colour is (accounts.js
   * cleanNameColor) or null for a plain colour. `color` stays, and stays a
   * plain #rrggbb: it is the role's colour wherever one colour is wanted -- the
   * dot beside its name -- and the first stop of a gradient.
   */
  (db) => {
    db.exec('ALTER TABLE roles ADD COLUMN style TEXT');
  },
  /*
   * v21: how far each person has read each channel.
   *
   * A high-water mark, the same shape as dm_reads and for the same reason: what
   * "unread" means is "newer than this", and keeping only the mark means there
   * is nothing per message to update. A person with no row has not been counted
   * yet; the first time they are asked, everything already there counts as
   * read (see reads.js).
   */
  (db) => {
    db.exec(`
      CREATE TABLE channel_reads (
        user_id      INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
        channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        last_read_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, channel_id)
      );
    `);
  },
  /*
   * v22: how dim a profile's banner is drawn.
   *
   * 0 (not dimmed at all) to 100 (nearly black), chosen by the person whose
   * banner it is and seen by everybody. NULL is "as it always was": the look the
   * banner had before this could be chosen, which is 50.
   */
  (db) => {
    db.exec('ALTER TABLE users ADD COLUMN banner_dim INTEGER');
  },
  /*
   * v23: when a message was pinned.
   *
   * So that "the last pinned message" is the one pinned most recently and not the newest message among the pins,
   * which is what the order was before and is not what pinning something old, to find it again, means. NULL on
   * every message pinned before this: they keep their old order, below anything pinned from now on.
   */
  (db) => {
    db.exec('ALTER TABLE messages ADD COLUMN pinned_at INTEGER');
  },
  /*
   * v24: the indexes a long history asks for.
   *
   * What a channel does most (its newest page, its pins, what is unread) was already on an index. What was not:
   *
   *   messages_user        everything one person wrote -- `from:` in a search, and the foreign-key check that
   *                        deleting an account makes against every message
   *   messages_time        a message's moment, which a search's dates become an id from
   *   messages_files       only the messages that carry a file, in order, for `has:file` and the kinds of file;
   *                        2% of a typical history, so a scan of it is small where a scan of all of it is not
   *   messages_attachment  the file a message points at, for the check that deleting an upload makes (and a
   *                        partial index, since most messages have none)
   *   channel_reads_channel  the other half of that table's key: deleting a channel removes its marks
   *
   * Then the planner is given statistics, which it has none of on a database that has only ever been written.
   */
  (db) => {
    db.exec(`
      CREATE INDEX messages_user       ON messages(user_id, id DESC);
      CREATE INDEX messages_time       ON messages(created_at);
      CREATE INDEX messages_files      ON messages(id) WHERE attachment_hash IS NOT NULL;
      CREATE INDEX messages_attachment ON messages(attachment_hash) WHERE attachment_hash IS NOT NULL;
      CREATE INDEX channel_reads_channel ON channel_reads(channel_id);
    `);
    db.exec('PRAGMA analysis_limit = 1000');
    db.exec('ANALYZE');
  },
  /*
   * v25: pinned private messages.
   *
   * A flag on the message, as a channel's pin is, and not something sealed: what is pinned is which message, and the
   * server already knows which messages there are, when they were sent and when one was edited. What it says stays
   * sealed. The most a server can do with the flag is pin or unpin a message that is there, which changes what is
   * shown and nothing that was said.
   *
   * pinned_at orders them (the last pinned first, as a channel's are) and pinned_by says who; both are NULL until a
   * message is pinned. The index is partial because almost nothing is.
   */
  (db) => {
    db.exec(`
      ALTER TABLE dm_messages ADD COLUMN pinned    INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE dm_messages ADD COLUMN pinned_at INTEGER;
      ALTER TABLE dm_messages ADD COLUMN pinned_by INTEGER;
      CREATE INDEX dm_messages_pinned ON dm_messages(conversation_id) WHERE pinned = 1;
    `);
  },
  /*
   * v26: Music Buddy's cache of tracks.
   *
   * A track fetched once (by yt-dlp, see music/library.js) is kept as an ordinary upload, and this says which one: the
   * source it came from ("yt:<video id>") to the file's hash, so a song asked for again is not downloaded again. The
   * file is the cache and this is only its index -- a row whose file has been swept to make room is ignored and made
   * again. The title and artist are kept for what was learned while downloading.
   */
  (db) => {
    db.exec(`
      CREATE TABLE music_tracks (
        source_key  TEXT PRIMARY KEY,
        file_hash   TEXT NOT NULL,
        title       TEXT NOT NULL DEFAULT '',
        artist      TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER,
        thumb_hash  TEXT,
        fetched_at  INTEGER NOT NULL
      );
    `);
  },

  // 27: how loud each music track is (see music/loudness.js), so tracks can be played at one level. loudness_at is
  // when it was measured, and set even when the measuring found nothing, so a file that cannot be measured is not
  // tried at every play. A track from before this column has none and is measured the next time it is asked for.
  (db) => {
    db.exec(`
      ALTER TABLE music_tracks ADD COLUMN loudness_lufs REAL;
      ALTER TABLE music_tracks ADD COLUMN peak_db REAL;
      ALTER TABLE music_tracks ADD COLUMN loudness_at INTEGER;
    `);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Create the data directory, or explain exactly what to do and stop.
 *
 * Exiting is deliberate. A server that silently runs without persistence would
 * accept registrations, look healthy, and lose every account on restart -- a
 * far worse failure than refusing to start.
 */
export function ensureDataDir(dataDir) {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o750 });
    // mkdirSync succeeds on a directory that already exists without telling us
    // anything about whether it can be written to, and a read-only bind mount
    // is exactly that case. So actually write something.
    const probe = join(dataDir, '.writable');
    writeFileSync(probe, '');
    unlinkSync(probe);
    return dataDir;
  } catch (err) {
    const why = err.code === 'EROFS'
      ? 'that path is on a read-only filesystem'
      : err.code === 'EACCES'
        ? `this process (uid ${typeof process.getuid === 'function' ? process.getuid() : '?'}) cannot write there`
        : err.message;

    console.error(`
[harmony] FATAL: cannot use the data directory ${dataDir}
[harmony]        ${why}

Harmony now stores accounts and channels in SQLite, so it needs one writable
directory. Nothing else about the hardening has to change.

  docker compose:  add a volume and keep read_only: true

      services:
        harmony:
          volumes:
            - harmony-data:/var/lib/harmony
      volumes:
        harmony-data:

  docker run:      add  -v harmony-data:/var/lib/harmony   (keep --read-only)

  bare metal:      the systemd unit sets StateDirectory=harmony-server, which
                   creates and owns /var/lib/harmony-server for you

A BIND mount keeps the host's ownership rather than the image's, so a bind-
mounted directory must be chown'd to uid 1000 yourself. A NAMED volume inherits
the image's ownership and needs nothing.

Set HARMONY_DATA_DIR to put it somewhere else.
`);
    process.exit(1);
  }
}

/**
 * Open the database and bring it up to the current schema version.
 *
 * @param {{dataDir: string, file?: string}} opts
 * @returns {DatabaseSync}
 */
export function openDatabase({ dataDir, file = 'harmony.db' }) {
  const db = new DatabaseSync(join(dataDir, file));

  // WAL lets the MediaMTX auth hook read while a registration is writing.
  // Without it every write blocks every read, and the auth hook is on the path
  // of every publish and every read in the system.
  db.exec('PRAGMA journal_mode = WAL');

  // NORMAL rather than FULL: a crash can lose the last transaction, which for a
  // chat message on a friends' server is the right trade against an fsync per
  // write on an SD card.
  db.exec('PRAGMA synchronous = NORMAL');

  // Already the default in node:sqlite, unlike stock SQLite. Set anyway, so the
  // schema's ON DELETE CASCADE cannot quietly stop working if that changes.
  db.exec('PRAGMA foreign_keys = ON');

  // A write that finds the database busy (the checkpoint, a second connection) waits a moment instead of failing.
  db.exec('PRAGMA busy_timeout = 5000');

  // Read-heavy, and a server is not short of memory: 64 MB of pages kept (the default is 2 MB), the temporary
  // tables and sorts a search makes held in memory, and the file mapped so that a read is not a copy. All of it
  // is only ever a cache, and costs nothing on disk.
  db.exec('PRAGMA cache_size = -65536');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA mmap_size = 268435456');
  // The write-ahead log does not stay as large as its busiest moment.
  db.exec('PRAGMA journal_size_limit = 67108864');

  migrate(db);

  // Statistics for the planner, kept current: only what has changed a lot is looked at again, and only a sample of
  // it, so this is cheap enough to do at every start. It is what SQLite's own documentation asks long-lived
  // connections to do.
  db.exec('PRAGMA analysis_limit = 1000');
  db.exec('PRAGMA optimize');
  return db;
}

/** Run any migrations this database has not seen yet. */
export function migrate(db) {
  const [{ user_version: current }] = db.prepare('PRAGMA user_version').all();

  if (current > MIGRATIONS.length) {
    throw new Error(
      `database is at schema v${current} but this server only knows v${MIGRATIONS.length}. `
      + 'Downgrading is not supported -- restore a backup or run the newer server.',
    );
  }

  for (let v = current; v < MIGRATIONS.length; v += 1) {
    // Each migration is its own transaction: a failure half way leaves the
    // version untouched, so the next boot retries cleanly rather than starting
    // from a half-applied schema.
    db.exec('BEGIN');
    try {
      MIGRATIONS[v](db);
      // Not a bound parameter: PRAGMA does not accept one. v is a loop index
      // over a literal array, so there is nothing user-controlled here.
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
      console.log(`[db] migrated to schema v${v + 1}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration to v${v + 1} failed: ${err.message}`);
    }
  }
}

/** Small key/value store for things with exactly one row. */
export function meta(db) {
  const get = db.prepare('SELECT value FROM server_meta WHERE key = ?');
  const set = db.prepare(
    'INSERT INTO server_meta (key, value) VALUES (?, ?) '
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const del = db.prepare('DELETE FROM server_meta WHERE key = ?');
  return {
    get: (key) => get.get(key)?.value ?? null,
    set: (key, value) => { set.run(key, String(value)); },
    delete: (key) => { del.run(key); },
  };
}
