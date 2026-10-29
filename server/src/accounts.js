// Accounts: registration, login, session tokens and roles.
//
// The shared HARMONY_PASSWORD is unchanged and still the outer door -- accounts
// sit behind it. A stranger cannot reach these endpoints at all, let alone
// enumerate who has an account.
//
// Passwords are hashed with scrypt rather than encrypted with an AES key from
// the environment. That is both simpler and stronger: there is nothing to
// decrypt, no key to lose or rotate, and a stolen database reveals nothing.

import { randomBytes, createHash, timingSafeEqual, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';

import { isSystemName, normalizeName } from './rooms.js';

const scrypt = promisify(scryptCb);

/**
 * scrypt cost.
 *
 * N=16384 is the ceiling under Node's DEFAULT maxmem: scrypt needs 128*N*r
 * bytes = 16 MiB here, and N=32768 would need 32 MiB and fail outright against
 * the 32 MiB default unless maxmem is passed explicitly. Measured at ~20 ms on
 * a desktop, which is roughly 100-150 ms on a Pi 4 -- about right for a login
 * on the weakest host Harmony targets.
 *
 * Stored self-describing (scrypt$N$r$p$salt$hash) so these can be raised later
 * without a migration: an old hash still carries the parameters it was made
 * with.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const NICKNAME_RE = /^[a-z0-9][a-z0-9_-]{1,19}$/;

/** Roles, most privileged first. */
export /*
 * How long a display name may be, in CODE POINTS rather than UTF-16 units.
 *
 * `.length` counts an emoji as two and a flag as four, so a limit written
 * against it refuses names that are visibly shorter than the ones it
 * accepts -- which is exactly the kind of rule that looks arbitrary and
 * racist from the outside.
 */
const MAX_DISPLAY_NAME = 32;

const ROLES = ['owner', 'admin', 'member'];

/**
 * The ids of the roles an account holds, as one comma-separated column.
 *
 * Carried on every account row so that publicUser can say which roles
 * somebody has without a second query per person. It is only for DRAWING:
 * what somebody is allowed to do is decided by Roles.context, which asks
 * the database again each time rather than trusting a row that may be old.
 */
const BADGE_IDS = '(SELECT group_concat(badge_id) FROM user_badges WHERE user_id = users.id) AS badge_ids';
const ROLE_IDS = '(SELECT group_concat(role_id) FROM user_roles WHERE user_id = users.id) AS role_ids';

/**
 * "Pedro Lucas" is accepted and stored as `pedrolucas` -- the nickname becomes
 * a MediaMTX path and part of a URL, so it cannot keep the capitals or the
 * space, but there is no reason to make someone discover that by being
 * rejected. The 20-character cap applies to the NORMALISED form, and is 20
 * rather than 24 because a nickname has to leave room for the `-cam` suffix its
 * webcam path appends.
 *
 * The system-namespace ban is imported rather than repeated: two copies of this
 * rule is how one of them ends up not being updated, which is exactly the bug
 * the shared validator in rooms.js was split to prevent.
 */
export function normalizeNickname(raw) {
  const value = normalizeName(raw);
  if (!NICKNAME_RE.test(value)) return null;
  return isSystemName(value) ? null : value;
}

/**
 * Hash a password. Always async.
 *
 * NEVER use scryptSync on a request path. This same process serves
 * /mediamtx/auth, which MediaMTX calls on every publish and every read; a
 * 150 ms event-loop stall there is a visible stream failure, not a slow login.
 */
export async function hashPassword(password, params = SCRYPT) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, params.keylen, {
    N: params.N, r: params.r, p: params.p,
  });
  return [
    'scrypt', params.N, params.r, params.p,
    salt.toString('base64url'), key.toString('base64url'),
  ].join('$');
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupted row
 * should lock that one account out, not 500 the login endpoint.
 */
export async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored ?? '').split('$');
    if (scheme !== 'scrypt') return false;

    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = await scrypt(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    // Equal length by construction (we asked for expected.length), so
    // timingSafeEqual cannot throw and leak a length.
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Session tokens are hashed with sha256, not scrypt.
 *
 * A 256-bit uniform random value has no guessable structure, so a KDF buys
 * nothing against a stolen database and would cost 20 ms on every
 * authenticated request. Same reasoning as the publish tokens in rooms.js.
 */
const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

/**
 * The fonts a display name may be drawn in, by id.
 *
 * The client ships the font files and knows how to draw each of these
 * (renderer/fonts); the server only keeps the id, so that every client agrees
 * on what a person's name looks like and nobody can name a font that is not
 * there. A client that does not know an id draws the ordinary font.
 */
export const NAME_FONTS = [
  'pacifico', 'press-start', 'orbitron', 'playfair', 'bebas',
  'caveat', 'fredoka', 'cinzel', 'typewriter', 'marker',
];

/**
 * The colour of a display name: null, or one of
 *
 *   {mode: 'solid',    color: '#rrggbb'}
 *   {mode: 'gradient', colors: ['#rrggbb', ...2 to 4], speed: seconds}
 *   {mode: 'rainbow',  speed: seconds}
 *
 * Returns the normalised value to store, `null` for "none", or `undefined`
 * when the input is not one of those -- so a bad value is refused rather than
 * quietly turned into something else. The colours are the six-digit form
 * only, and the speed a number in a fixed range: every client builds its CSS
 * from these, so nothing free-form may reach it.
 */
export const NAME_COLOR_SPEED = { min: 1, max: 30, fallback: 6 };
const NAME_COLOR_RE = /^#[0-9a-f]{6}$/i;

export function cleanNameColor(input) {
  if (input == null || input === '') return null;
  if (typeof input !== 'object') return undefined;
  const speedOf = (raw) => {
    if (raw === undefined || raw === null) return NAME_COLOR_SPEED.fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(NAME_COLOR_SPEED.max, Math.max(NAME_COLOR_SPEED.min, Math.round(n * 10) / 10));
  };
  if (input.mode === 'solid') {
    return NAME_COLOR_RE.test(String(input.color)) ? { mode: 'solid', color: String(input.color).toLowerCase() } : undefined;
  }
  if (input.mode === 'gradient') {
    if (!Array.isArray(input.colors) || input.colors.length < 2 || input.colors.length > 4) return undefined;
    if (!input.colors.every((c) => NAME_COLOR_RE.test(String(c)))) return undefined;
    const speed = speedOf(input.speed);
    if (speed === undefined) return undefined;
    return { mode: 'gradient', colors: input.colors.map((c) => String(c).toLowerCase()), speed };
  }
  if (input.mode === 'rainbow') {
    const speed = speedOf(input.speed);
    return speed === undefined ? undefined : { mode: 'rainbow', speed };
  }
  return undefined;
}

export class Accounts {
  #db;
  #q;

  constructor(db) {
    this.#db = db;
    this.#q = {
      byNickname: db.prepare(`SELECT users.*, ${ROLE_IDS}, ${BADGE_IDS} FROM users WHERE nickname = ?`),
      byId: db.prepare(`SELECT users.*, ${ROLE_IDS}, ${BADGE_IDS} FROM users WHERE id = ?`),
      insert: db.prepare(
        'INSERT INTO users (nickname, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
      ),
      count: db.prepare('SELECT COUNT(*) AS n FROM users'),
      countOwners: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'"),
      setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
      setDisplayName: db.prepare('UPDATE users SET display_name = ? WHERE id = ?'),
      setAvatar: db.prepare('UPDATE users SET avatar_hash = ? WHERE id = ?'),
      setBanner: db.prepare('UPDATE users SET banner_hash = ? WHERE id = ?'),
      setJoinSound: db.prepare('UPDATE users SET join_sound_hash = ? WHERE id = ?'),
      setNameFont: db.prepare('UPDATE users SET name_font = ? WHERE id = ?'),
      setNameColor: db.prepare('UPDATE users SET name_color = ? WHERE id = ?'),
      list: db.prepare(
        'SELECT id, nickname, display_name, role, avatar_hash, name_font, banner_hash, '
        + `join_sound_hash, name_color, created_at, banned_at, ${ROLE_IDS}, ${BADGE_IDS} `
        + 'FROM users ORDER BY nickname',
      ),

      addSession: db.prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)',
      ),
      findSession: db.prepare(
        `SELECT u.*, s.token_hash, ${ROLE_IDS.replace(/users\./g, 'u.')}, ${BADGE_IDS.replace(/users\./g, 'u.')} `
        + 'FROM sessions s JOIN users u ON u.id = s.user_id '
        + 'WHERE s.token_hash = ?',
      ),
      touchSession: db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?'),
      dropSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
      dropUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
      expireSessions: db.prepare('DELETE FROM sessions WHERE last_seen < ?'),

      // --- removing an account, below -------------------------------------
      countMessages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id = ?'),
      dropMessageFts: db.prepare(
        'DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE user_id = ?)',
      ),
      // One decrement per MESSAGE, not per distinct file: somebody who posted
      // the same picture twice holds two references to it.
      releaseAttachments: db.prepare(`
        UPDATE uploads SET refs = MAX(0, refs - (
          SELECT COUNT(*) FROM messages m
          WHERE m.user_id = ? AND m.attachment_hash = uploads.hash
        ))
        WHERE hash IN (
          SELECT attachment_hash FROM messages
          WHERE user_id = ? AND attachment_hash IS NOT NULL
        )
      `),
      dropMessages: db.prepare('DELETE FROM messages WHERE user_id = ?'),
      // Their private conversations go whole, both sides: the other person
      // has nobody left to talk to there, and the sealed history is only
      // ever readable with keys that are going too. The files are released
      // one reference per message, as a channel's are; the rows themselves
      // cascade from the conversation.
      releaseDmAttachments: db.prepare(`
        UPDATE uploads SET refs = MAX(0, refs - (
          SELECT COUNT(*) FROM dm_messages m JOIN dm_conversations c ON c.id = m.conversation_id
          WHERE (c.user_a = :user OR c.user_b = :user) AND m.attachment_hash = uploads.hash
        ))
        WHERE hash IN (
          SELECT m.attachment_hash FROM dm_messages m JOIN dm_conversations c ON c.id = m.conversation_id
          WHERE (c.user_a = :user OR c.user_b = :user) AND m.attachment_hash IS NOT NULL
        )
      `),
      dropConversations: db.prepare('DELETE FROM dm_conversations WHERE user_a = ? OR user_b = ?'),
      releaseAvatar: db.prepare('UPDATE uploads SET refs = MAX(0, refs - 1) WHERE hash = ?'),
      // The clip and the emoji stay. They are server-wide things other
      // people are using; only the credit for them goes.
      disownClips: db.prepare('UPDATE soundpad_clips SET uploaded_by = NULL WHERE uploaded_by = ?'),
      disownEmojis: db.prepare('UPDATE emojis SET uploaded_by = NULL WHERE uploaded_by = ?'),
      dropUser: db.prepare('DELETE FROM users WHERE id = ?'),
    };
  }

  get isEmpty() {
    return this.#q.count.get().n === 0;
  }

  get hasOwner() {
    return this.#q.countOwners.get().n > 0;
  }

  find(nickname) {
    return this.#q.byNickname.get(nickname) ?? null;
  }

  /**
   * One account by id, or null.
   *
   * The raw row, password hash included -- publicUser() is what shapes it
   * for a response, and callers inside the server need the role to decide
   * whether the person asking is allowed to do what they are asking.
   */
  byId(userId) {
    return this.#q.byId.get(Number(userId)) ?? null;
  }

  list() {
    return this.#q.list.all();
  }

  /**
   * Create an account.
   *
   * @returns {Promise<{ok: true, user: object} | {ok: false, error: string}>}
   */
  async register(nickname, password, { role = 'member' } = {}) {
    const name = normalizeNickname(nickname);
    if (!name) return { ok: false, error: 'invalid_nickname' };
    if (password == null || String(password).length < 6) {
      return { ok: false, error: 'weak_password' };
    }
    if (this.find(name)) return { ok: false, error: 'nickname_taken' };

    const hash = await hashPassword(password);
    try {
      this.#q.insert.run(name, hash, role, Date.now());
    } catch (err) {
      // UNIQUE violation: someone registered the same name between the check
      // above and here. The constraint is the real guard; the check is only for
      // a nicer error.
      if (/UNIQUE/i.test(err.message)) return { ok: false, error: 'nickname_taken' };
      throw err;
    }
    return { ok: true, user: this.find(name) };
  }

  /**
   * Check a password. Returns the user row or null.
   *
   * Deliberately does nothing about rate limiting -- the caller owns that, so
   * the same LoginLimiter can be keyed by both nickname and IP.
   */
  async verify(nickname, password) {
    const name = normalizeNickname(nickname);
    if (!name) return null;
    const user = this.find(name);
    if (!user) {
      // Hash anyway, so "no such account" and "wrong password" take the same
      // time. Otherwise this endpoint is a user-enumeration oracle.
      await hashPassword(String(password ?? ''));
      return null;
    }
    return (await verifyPassword(String(password ?? ''), user.password_hash)) ? user : null;
  }

  async changePassword(userId, password) {
    if (password == null || String(password).length < 6) {
      return { ok: false, error: 'weak_password' };
    }
    const hash = await hashPassword(password);
    this.#db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    // Every other device holding a session for this account loses it, which is
    // the point of changing a password.
    this.#q.dropUserSessions.run(userId);
    return { ok: true };
  }

  /** Issue a bearer token. The plaintext is returned once and never stored. */
  startSession(userId) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.#q.addSession.run(tokenHash(token), userId, now, now);
    return token;
  }

  /** Resolve a bearer token to a user, refreshing its last_seen. */
  resolveSession(token) {
    if (!token) return null;
    const row = this.#q.findSession.get(tokenHash(token));
    if (!row) return null;
    // A ban drops the sessions it finds, but a session issued in the instant
    // between the check and the ban would outlive it -- so the ban is also
    // checked here, on every use.
    if (row.banned_at) return null;
    this.#q.touchSession.run(Date.now(), row.token_hash);
    return row;
  }

  endSession(token) {
    if (!token) return false;
    this.#q.dropSession.run(tokenHash(token));
    return true;
  }

  /** Drop sessions nobody has used in a while. Called on a timer. */
  expireSessions(maxIdleMs) {
    this.#q.expireSessions.run(Date.now() - maxIdleMs);
  }

  /** Sign somebody out of every device, without touching the account. */
  dropSessions(userId) {
    this.#q.dropUserSessions.run(userId);
  }

  /**
   * Ban an account, or lift the ban. A banned account keeps everything it
   * wrote -- the ban is about getting in, not about the past -- and loses
   * its sessions at once.
   */
  setBanned(userId, banned) {
    const user = this.#q.byId.get(userId);
    if (!user) return { ok: false, error: 'no_such_user' };
    this.#db.prepare('UPDATE users SET banned_at = ? WHERE id = ?')
      .run(banned ? Date.now() : null, userId);
    if (banned) this.#q.dropUserSessions.run(userId);
    return { ok: true, user: this.#q.byId.get(userId) };
  }

  setRole(userId, role) {
    if (!ROLES.includes(role)) return { ok: false, error: 'invalid_role' };
    const user = this.#q.byId.get(userId);
    if (!user) return { ok: false, error: 'no_such_user' };
    // The last owner cannot demote themselves: a server with no owner has no
    // way back short of editing the database by hand.
    if (user.role === 'owner' && role !== 'owner' && this.#q.countOwners.get().n <= 1) {
      return { ok: false, error: 'last_owner' };
    }
    this.#q.setRole.run(role, userId);
    return { ok: true, user: this.#q.byId.get(userId) };
  }

  /**
   * Point this account at a stored file, or at nothing.
   *
   * Returns the hash it was pointing at before, because the caller owns the
   * reference counting: setting a new picture has to give the old file's
   * reference back or the uploads directory only ever grows.
   */
  /**
   * Set, or clear, somebody's display name.
   *
   * Almost nothing is refused. This is a label rather than an identity --
   * nothing is looked up by it, no path is built from it, no uniqueness is
   * claimed for it -- so capitals, spaces, accents and emoji are all fine,
   * and two people may choose the same one. Only three things are checked:
   *
   *   - a length, so one person cannot push every other name off the
   *     sidebar;
   *   - control characters, which are invisible and would let somebody
   *     plant a right-to-left override or a zero-width join in a name
   *     everybody else has to read;
   *   - all-whitespace, which renders as a person with no name at all.
   *
   * Empty clears it, and the nickname shows again.
   *
   * The client renders every name with textContent, never innerHTML, so
   * markup in a name is text. That is where the XSS answer lives; this is
   * not the place to start a second, weaker one.
   */
  setDisplayName(userId, raw) {
    const user = this.#q.byId.get(Number(userId));
    if (!user) return { ok: false, error: 'no_such_user' };

    const value = String(raw ?? '').trim();
    if (value === '') {
      this.#q.setDisplayName.run(null, user.id);
      return { ok: true, user: this.#q.byId.get(user.id) };
    }
    if ([...value].length > MAX_DISPLAY_NAME) return { ok: false, error: 'too_long' };
    // \p{C} is every control, format and unassigned code point, which
    // covers the bidi overrides and the zero-width characters together.
    if (/\p{C}/u.test(value)) return { ok: false, error: 'bad_characters' };

    this.#q.setDisplayName.run(value, user.id);
    return { ok: true, user: this.#q.byId.get(user.id) };
  }

  /**
   * Delete an account and everything written under it.
   *
   * ONE place that knows a person's whole footprint, because the pieces are
   * spread across five tables and three of them have no foreign key back to
   * users at all:
   *
   *   sessions, channel_grants, message_reactions  -- ON DELETE CASCADE,
   *       so they go on their own and are not mentioned below.
   *   messages                                     -- references users(id)
   *       with NO cascade, so deleting the row would be REFUSED outright
   *       while any message of theirs survives. Deleting them is also what
   *       was asked for, so this is not a workaround.
   *   messages_fts                                 -- not a real foreign
   *       key at all. A search index that still answers with deleted rows
   *       is the quiet half of this bug.
   *   uploads.refs                                 -- a count this module
   *       does not own, so every reference taken has to be given back or
   *       the files never become evictable.
   *   dm_conversations and everything under them   -- would cascade on
   *       their own, but their files hold upload references that a cascade
   *       would never give back, so they are released and dropped here.
   *       user_keys and dm_blocks cascade.
   *   soundpad_clips, emojis                       -- reference users(id)
   *       and would block the delete. The clip and the emoji are shared
   *       things other people use; only the credit is dropped.
   *
   * All in one transaction. Half a deleted account is worse than none.
   */
  remove(userId) {
    const user = this.#q.byId.get(userId);
    if (!user) return { ok: false, error: 'no_such_user' };
    // A server with no owner has no way back short of editing the database
    // by hand -- the same reason the last owner cannot demote themselves.
    if (user.role === 'owner') return { ok: false, error: 'cannot_remove_owner' };

    const messages = this.#q.countMessages.get(userId).n;

    this.#db.exec('BEGIN');
    try {
      this.#q.releaseAttachments.run(userId, userId);
      this.#q.dropMessageFts.run(userId);
      this.#q.dropMessages.run(userId);
      this.#q.releaseDmAttachments.run({ user: userId });
      this.#q.dropConversations.run(userId, userId);
      if (user.avatar_hash) this.#q.releaseAvatar.run(user.avatar_hash);
      if (user.banner_hash) this.#q.releaseAvatar.run(user.banner_hash);
      if (user.join_sound_hash) this.#q.releaseAvatar.run(user.join_sound_hash);
      this.#q.disownClips.run(userId);
      this.#q.disownEmojis.run(userId);
      this.#q.dropUser.run(userId);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { ok: true, user, messages };
  }

  setAvatar(userId, hash) {
    const user = this.#q.byId.get(userId);
    if (!user) return { ok: false, error: 'no_such_user' };
    this.#q.setAvatar.run(hash ?? null, userId);
    return { ok: true, previous: user.avatar_hash ?? null, user: this.#q.byId.get(userId) };
  }

  /** The same as setAvatar, for the profile banner. */
  setBanner(userId, hash) {
    const user = this.#q.byId.get(userId);
    if (!user) return { ok: false, error: 'no_such_user' };
    this.#q.setBanner.run(hash ?? null, userId);
    return { ok: true, previous: user.banner_hash ?? null, user: this.#q.byId.get(userId) };
  }

  /** The same as setAvatar, for the sound played when you join a room. */
  setJoinSound(userId, hash) {
    const user = this.#q.byId.get(userId);
    if (!user) return { ok: false, error: 'no_such_user' };
    this.#q.setJoinSound.run(hash ?? null, userId);
    return { ok: true, previous: user.join_sound_hash ?? null, user: this.#q.byId.get(userId) };
  }

  /** A name colour (see cleanNameColor), or null/'' to go back to the role's. */
  setNameColor(userId, input) {
    const user = this.#q.byId.get(userId);
    if (!user) return { ok: false, error: 'no_such_user' };
    const value = cleanNameColor(input);
    if (value === undefined) return { ok: false, error: 'bad_name_color' };
    this.#q.setNameColor.run(value === null ? null : JSON.stringify(value), userId);
    return { ok: true, user: this.#q.byId.get(userId) };
  }

  /** One of NAME_FONTS, or null/'' for the default. Anything else is refused. */
  setNameFont(userId, font) {
    const user = this.#q.byId.get(userId);
    if (!user) return { ok: false, error: 'no_such_user' };
    const value = font == null || font === '' ? null : String(font);
    if (value !== null && !NAME_FONTS.includes(value)) return { ok: false, error: 'unknown_font' };
    this.#q.setNameFont.run(value, userId);
    return { ok: true, user: this.#q.byId.get(userId) };
  }
}

/** Shape a user row for the wire. Never leaks password_hash. */
export const publicUser = (u) => (u ? {
  id: u.id,
  nickname: u.nickname,
  // What to show. Resolved here rather than in each client, so that every
  // client resolves it the same way and a null stays a null on the wire.
  displayName: u.display_name || u.nickname,
  customName: Boolean(u.display_name),
  role: u.role,
  // The roles they hold, by id. In no particular order: the hierarchy is
  // the roles list's order, and whoever draws this has that list.
  roles: u.role_ids
    ? String(u.role_ids).split(',').map(Number).sort((a, b) => a - b)
    : [],
  banned: Boolean(u.banned_at),
  // The badges they hold, by id; the badges list says what each one is.
  badges: u.badge_ids ? String(u.badge_ids).split(',').map(Number).sort((a, b) => a - b) : [],
  avatarHash: u.avatar_hash ?? null,
  nameFont: u.name_font ?? null,
  // Parsed back out of what cleanNameColor stored; null leaves the role in charge.
  nameColor: (() => {
    try { return u.name_color ? JSON.parse(u.name_color) : null; } catch { return null; }
  })(),
  bannerHash: u.banner_hash ?? null,
  joinSoundHash: u.join_sound_hash ?? null,
  createdAt: u.created_at,
} : null);

/**
 * The owner bootstrap string.
 *
 * On a server with no owner, generate one and print it. stdout is the only
 * place a Docker operator can see it -- there is no console, no email and no
 * config file they are already editing. The first account to present it becomes
 * owner and the string is consumed.
 *
 * Not regenerated once an owner exists, so restarting the server does not spray
 * fresh admin credentials into the logs.
 */
export function ensureOwnerToken(accounts, metaStore) {
  if (accounts.hasOwner) {
    metaStore.delete('owner_token');
    return null;
  }
  let token = metaStore.get('owner_token');
  if (!token) {
    token = randomBytes(16).toString('base64url');
    metaStore.set('owner_token', token);
  }
  console.log(`
  ┌──────────────────────────────────────────────────────────────┐
  │  This server has no owner yet.                               │
  │                                                              │
  │  Register in the client and paste this string into the       │
  │  "owner key" box to claim ownership:                         │
  │                                                              │
  │      ${token.padEnd(56)}│
  │                                                              │
  │  It works once. Anyone who reads this log can use it, so     │
  │  claim it now.                                               │
  └──────────────────────────────────────────────────────────────┘
`);
  return token;
}

/**
 * Consume the owner string. Timing-safe because it is a 128-bit secret sitting
 * behind an endpoint anyone past the door password can reach.
 */
export function claimOwner(accounts, metaStore, userId, offered) {
  const expected = metaStore.get('owner_token');
  if (!expected || !offered) return false;
  const a = createHash('sha256').update(String(offered)).digest();
  const b = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(a, b)) return false;
  accounts.setRole(userId, 'owner');
  metaStore.delete('owner_token');
  console.log('[accounts] owner claimed');
  return true;
}
