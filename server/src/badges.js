// Badges: a small decoration with a name, a description and a picture or an
// emoji, shown on somebody's profile card. A gimmick, or a reward.
//
// Storage and shape only. Who may make one, change one, or hand one out is
// decided in the routes from Roles.context (permissions badges.create and
// badges.edit, and the badges a role lists as assignable); nothing here knows
// about people.

export const MAX_BADGE_NAME = 32;
export const MAX_BADGE_DESCRIPTION = 200;
export const MAX_BADGES = 100;

/** Single line, nothing invisible, at most `max` characters. */
const clean = (raw, max) => String(raw ?? '')
  .replace(/[\p{Cc}\p{Cs}]/gu, ' ')
  .replace(/[\p{Cf}]/gu, (c) => (c === '‍' || c === '️' ? c : ''))
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

/**
 * An emoji, as typed: whatever holds one, up to a short length. The test is
 * "contains a pictograph or a flag", not "is exactly one", because a flag and
 * a family are several code points and a stricter rule refuses real emoji.
 */
function cleanEmoji(raw) {
  const value = clean(raw, 16);
  if (!value) return null;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value) ? value : undefined;
}

export const publicBadge = (b) => (b ? {
  id: b.id,
  name: b.name,
  description: b.description,
  emoji: b.emoji ?? null,
  imageHash: b.image_hash ?? null,
  position: b.position,
} : null);

export class Badges {
  #db;
  #q;

  constructor(db) {
    this.#db = db;
    this.#q = {
      all: db.prepare('SELECT * FROM badges ORDER BY position, id'),
      byId: db.prepare('SELECT * FROM badges WHERE id = ?'),
      nextPosition: db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM badges'),
      insert: db.prepare(
        'INSERT INTO badges (name, description, emoji, image_hash, position, created_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?)',
      ),
      update: db.prepare(
        'UPDATE badges SET name = ?, description = ?, emoji = ?, image_hash = ? WHERE id = ?',
      ),
      remove: db.prepare('DELETE FROM badges WHERE id = ?'),
      heldBy: db.prepare('SELECT badge_id FROM user_badges WHERE user_id = ?'),
      clearUser: db.prepare('DELETE FROM user_badges WHERE user_id = ?'),
      award: db.prepare(
        'INSERT OR IGNORE INTO user_badges (user_id, badge_id, awarded_at) VALUES (?, ?, ?)',
      ),
    };
  }

  list() {
    return this.#q.all.all();
  }

  get(id) {
    return this.#q.byId.get(Number(id)) ?? null;
  }

  /**
   * Validate what a request says into what to store, or an error.
   * `previous` fills in what an update leaves out.
   */
  #sanitize(input, previous) {
    const name = input.name === undefined ? previous?.name : clean(input.name, MAX_BADGE_NAME);
    if (!name) return { error: 'invalid_name' };

    const description = input.description === undefined
      ? (previous?.description ?? '') : clean(input.description, MAX_BADGE_DESCRIPTION);

    let emoji = previous?.emoji ?? null;
    if (input.emoji !== undefined) {
      emoji = cleanEmoji(input.emoji);
      if (emoji === undefined) return { error: 'invalid_emoji' };
    }
    let imageHash = previous?.image_hash ?? null;
    if (input.imageHash !== undefined) {
      imageHash = input.imageHash === null || input.imageHash === '' ? null : String(input.imageHash);
      if (imageHash !== null && !/^[0-9a-f]{64}$/.test(imageHash)) return { error: 'bad_hash' };
    }
    if (!emoji && !imageHash) return { error: 'needs_picture' };
    return { value: { name, description, emoji, imageHash } };
  }

  create(input) {
    if (this.list().length >= MAX_BADGES) return { ok: false, error: 'too_many_badges' };
    const clean_ = this.#sanitize(input ?? {}, null);
    if (clean_.error) return { ok: false, error: clean_.error };
    const v = clean_.value;
    if (this.list().some((b) => b.name.toLowerCase() === v.name.toLowerCase())) {
      return { ok: false, error: 'name_taken' };
    }
    const info = this.#q.insert.run(
      v.name, v.description, v.emoji, v.imageHash, this.#q.nextPosition.get().p, Date.now(),
    );
    return { ok: true, badge: this.get(Number(info.lastInsertRowid)) };
  }

  /** @returns {{ok: true, badge: object, previousHash: string|null}|{ok: false, error: string}} */
  update(id, input) {
    const badge = this.get(id);
    if (!badge) return { ok: false, error: 'no_such_badge' };
    const clean_ = this.#sanitize(input ?? {}, badge);
    if (clean_.error) return { ok: false, error: clean_.error };
    const v = clean_.value;
    if (this.list().some((b) => b.id !== badge.id && b.name.toLowerCase() === v.name.toLowerCase())) {
      return { ok: false, error: 'name_taken' };
    }
    this.#q.update.run(v.name, v.description, v.emoji, v.imageHash, badge.id);
    return { ok: true, badge: this.get(badge.id), previousHash: badge.image_hash ?? null };
  }

  /** Everybody who held it loses it (ON DELETE CASCADE). */
  remove(id) {
    const badge = this.get(id);
    if (!badge) return { ok: false, error: 'no_such_badge' };
    this.#q.remove.run(badge.id);
    return { ok: true, previousHash: badge.image_hash ?? null };
  }

  /** The ids somebody holds. */
  heldBy(userId) {
    return this.#q.heldBy.all(userId).map((r) => r.badge_id);
  }

  /**
   * Replace the badges somebody holds. `allowed(badgeId)` says whether the
   * actor may hand out (or take back) that badge: only the badges that
   * CHANGE are asked about, so a badge somebody holds that the actor cannot
   * award is left alone when the actor adds another beside it.
   */
  setUserBadges(userId, ids, allowed) {
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(Number))];
    if (wanted.some((id) => !Number.isInteger(id) || !this.get(id))) {
      return { ok: false, error: 'no_such_badge' };
    }
    const before = this.heldBy(userId);
    const changed = [
      ...wanted.filter((id) => !before.includes(id)),
      ...before.filter((id) => !wanted.includes(id)),
    ];
    if (changed.some((id) => !allowed(id))) return { ok: false, error: 'forbidden' };
    if (!changed.length) return { ok: true, changed: false };

    this.#db.exec('BEGIN');
    try {
      this.#q.clearUser.run(userId);
      for (const id of wanted) this.#q.award.run(userId, id, Date.now());
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { ok: true, changed: true };
  }
}

export const BADGE_ERRORS = {
  invalid_name: 'Give the badge a name of 1-32 characters.',
  invalid_emoji: 'That is not an emoji.',
  bad_hash: 'That is not an uploaded file.',
  needs_picture: 'A badge needs a picture or an emoji.',
  name_taken: 'There is already a badge with that name.',
  no_such_badge: 'No such badge.',
  no_such_user: 'No such user.',
  too_many_badges: 'That is as many badges as a server can have.',
  forbidden: 'You do not have permission to do that.',
  no_such_upload: 'Upload the picture first.',
  not_an_image: 'A badge picture has to be an image.',
  picture_too_large: 'That picture is too big for a badge.',
};
