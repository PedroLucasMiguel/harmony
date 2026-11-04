// Polls in a text channel.
//
// A poll is a message whose `poll` column holds its settings (see cleanPoll) and whose votes are rows of
// `poll_votes`. Nothing here is about a private conversation: those are sealed, the server cannot read
// them, and their polls and votes are made and counted by the clients (client/src/renderer/poll.js).

export const POLL_LIMITS = Object.freeze({
  title: 200,
  description: 1000,
  option: 100,
  footer: 200,
  /** At least two to choose between, and no more than fit on a screen. */
  minOptions: 2,
  maxOptions: 12,
  /** A poll that closes in a century is a poll that does not close. */
  maxDurationMs: 366 * 24 * 60 * 60 * 1000,
});

const clip = (value, max) => String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max).trim();

/**
 * What a client asked for, as what is kept: trimmed, empty options dropped, limits applied.
 *
 * @param {object} raw  {title, description?, footer?, options: string[], multiple?, anonymous?, endsAt?}
 * @param {number} [now]
 * @returns {{ok: true, poll: object} | {ok: false, error: string}}
 */
export function cleanPoll(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'bad_poll' };
  const title = clip(raw.title, POLL_LIMITS.title);
  if (!title) return { ok: false, error: 'poll_needs_title' };
  if (!Array.isArray(raw.options)) return { ok: false, error: 'poll_needs_options' };
  const options = raw.options
    .map((o) => clip(typeof o === 'object' && o !== null ? o.text : o, POLL_LIMITS.option))
    .filter(Boolean);
  if (options.length < POLL_LIMITS.minOptions) return { ok: false, error: 'poll_needs_options' };
  if (options.length > POLL_LIMITS.maxOptions) return { ok: false, error: 'poll_too_many_options' };

  let endsAt = null;
  if (raw.endsAt !== null && raw.endsAt !== undefined && raw.endsAt !== '') {
    endsAt = Number(raw.endsAt);
    if (!Number.isSafeInteger(endsAt) || endsAt <= now) return { ok: false, error: 'poll_bad_end' };
    if (endsAt - now > POLL_LIMITS.maxDurationMs) return { ok: false, error: 'poll_bad_end' };
  }

  return {
    ok: true,
    poll: {
      title,
      description: clip(raw.description, POLL_LIMITS.description),
      footer: clip(raw.footer, POLL_LIMITS.footer),
      options,
      multiple: raw.multiple === true,
      anonymous: raw.anonymous === true,
      endsAt,
    },
  };
}

/**
 * What the message itself says, for everything that reads a message as text: the search, the line a reply
 * quotes, the preview of a pinned one.
 */
export const pollBody = (poll) => poll.title;

/** The settings stored on a message, or null for one that is not a poll (or whose JSON is not to be read). */
export function pollOf(message) {
  if (!message?.poll) return null;
  try {
    const p = JSON.parse(message.poll);
    return p && Array.isArray(p.options) ? p : null;
  } catch {
    return null;
  }
}

export const isClosed = (poll, now = Date.now()) => poll.endsAt !== null && poll.endsAt !== undefined && now >= poll.endsAt;

export class Polls {
  #db;

  #q;

  constructor(db) {
    this.#db = db;
    this.#q = {
      mine: db.prepare('SELECT option FROM poll_votes WHERE message_id = ? AND user_id = ? ORDER BY option'),
      clear: db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?'),
      add: db.prepare('INSERT INTO poll_votes (message_id, user_id, option, created_at) VALUES (?, ?, ?, ?)'),
    };
  }

  /**
   * Put somebody's vote where they say: `options` replaces whatever they had chosen, and an empty list takes
   * the vote back. Choosing nothing new is not an error, so a double click is harmless.
   *
   * @param {{message: object, userId: number, options: unknown, now?: number}} args
   */
  vote({
    message, userId, options, now = Date.now(),
  }) {
    const poll = pollOf(message);
    if (!poll) return { ok: false, error: 'not_a_poll' };
    if (isClosed(poll, now)) return { ok: false, error: 'poll_closed' };
    if (!Array.isArray(options)) return { ok: false, error: 'bad_vote' };
    const chosen = [...new Set(options)];
    if (chosen.some((o) => !Number.isInteger(o) || o < 0 || o >= poll.options.length)) {
      return { ok: false, error: 'bad_vote' };
    }
    if (!poll.multiple && chosen.length > 1) return { ok: false, error: 'bad_vote' };

    this.#db.exec('BEGIN');
    try {
      this.#q.clear.run(message.id, userId);
      for (const option of chosen) this.#q.add.run(message.id, userId, option, now);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { ok: true, mine: chosen.sort((a, b) => a - b) };
  }

  /**
   * The count of each option, how many people voted, who (unless the poll hides them) and, when a viewer is
   * given, what they chose. One query for a page.
   *
   * @param {object[]} messages  rows of `messages`; the ones that are not polls are left out of the result
   * @param {number|null} [viewerId]
   * @returns {Map<number, {counts: number[], total: number, voters: number[][]|null, mine?: number[]}>}
   */
  resultsFor(messages, viewerId = null) {
    const polls = new Map();
    for (const m of messages) {
      const poll = pollOf(m);
      if (poll) polls.set(m.id, poll);
    }
    const out = new Map();
    if (!polls.size) return out;

    const ids = [...polls.keys()];
    const rows = this.#db.prepare(
      'SELECT message_id, user_id, option FROM poll_votes '
      + `WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at, rowid`,
    ).all(...ids);

    for (const [id, poll] of polls) {
      out.set(id, {
        counts: poll.options.map(() => 0),
        total: 0,
        voters: poll.anonymous ? null : poll.options.map(() => []),
        ...(viewerId === null ? {} : { mine: [] }),
        who: new Set(),
      });
    }
    for (const r of rows) {
      const result = out.get(r.message_id);
      if (!result || r.option >= result.counts.length) continue;
      result.counts[r.option] += 1;
      result.who.add(r.user_id);
      result.voters?.[r.option].push(r.user_id);
      if (viewerId !== null && r.user_id === viewerId) result.mine.push(r.option);
    }
    for (const result of out.values()) {
      result.total = result.who.size;
      delete result.who;
    }
    return out;
  }

  /** The same, for one message. */
  resultsOf(message, viewerId = null) {
    return this.resultsFor([message], viewerId).get(message.id) ?? null;
  }
}
