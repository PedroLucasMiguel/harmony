// What a poll is, for the parts of the app that deal in it without drawing anything: checking one that is about
// to be sent, reading one that arrived, and counting the votes of a private conversation.
//
// A channel's poll lives on the server (server/src/polls.js, the same limits): it counts the votes and says who
// gave them. A private conversation's cannot: the server sees only sealed bytes. There the poll rides in the
// message's own payload, and a vote is a reaction -- one of the sealed list of "emoji" a person leaves on a message
// -- whose text is "poll:<n>", n being the option. Everybody who can open the message can open the votes, and every
// client counts them the same way (resultsFromReactions).

export const POLL_LIMITS = Object.freeze({
  title: 200,
  description: 1000,
  option: 100,
  footer: 200,
  minOptions: 2,
  maxOptions: 12,
  maxDurationMs: 366 * 24 * 60 * 60 * 1000,
});

/** The start of a vote's text among a message's reactions. */
export const VOTE_PREFIX = 'poll:';

const clip = (value, max) => String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max).trim();

/**
 * What was typed into the form, as what is sent: trimmed, the options left empty dropped, the limits applied.
 * The same rules as the server's, so that a refusal there is a surprise rather than a routine.
 *
 * @returns {{ok: true, poll: object} | {ok: false, error: string}}
 */
export function cleanPoll(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'bad_poll' };
  const title = clip(raw.title, POLL_LIMITS.title);
  if (!title) return { ok: false, error: 'poll_needs_title' };
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .map((o) => clip(o, POLL_LIMITS.option))
    .filter(Boolean);
  if (options.length < POLL_LIMITS.minOptions) return { ok: false, error: 'poll_needs_options' };
  if (options.length > POLL_LIMITS.maxOptions) return { ok: false, error: 'poll_too_many_options' };
  let endsAt = null;
  if (raw.endsAt !== null && raw.endsAt !== undefined && raw.endsAt !== '') {
    endsAt = Number(raw.endsAt);
    if (!Number.isSafeInteger(endsAt) || endsAt <= now || endsAt - now > POLL_LIMITS.maxDurationMs) {
      return { ok: false, error: 'poll_bad_end' };
    }
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
 * A poll that arrived inside a private message, or null if it is not one. Read with less trust than cleanPoll
 * writes: whoever sent it may not be this app, and a poll that has closed is still a poll.
 */
export function validPoll(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.title !== 'string' || !raw.title.trim()) return null;
  if (!Array.isArray(raw.options) || raw.options.length < POLL_LIMITS.minOptions) return null;
  if (raw.options.length > POLL_LIMITS.maxOptions || !raw.options.every((o) => typeof o === 'string' && o.trim())) return null;
  const endsAt = Number.isSafeInteger(raw.endsAt) && raw.endsAt > 0 ? raw.endsAt : null;
  return {
    title: raw.title.slice(0, POLL_LIMITS.title),
    description: typeof raw.description === 'string' ? raw.description.slice(0, POLL_LIMITS.description) : '',
    footer: typeof raw.footer === 'string' ? raw.footer.slice(0, POLL_LIMITS.footer) : '',
    options: raw.options.map((o) => o.slice(0, POLL_LIMITS.option)),
    multiple: raw.multiple === true,
    anonymous: raw.anonymous === true,
    endsAt,
  };
}

/**
 * What a private poll says as plain words: the message's body, which is what somebody whose app does not know
 * polls (and a search, and the line a reply quotes) sees instead of the card.
 */
export function pollBody(poll) {
  const lines = [`\u{1F4CA} ${poll.title}`, ...poll.options.map((o, i) => `${i + 1}. ${o}`)];
  return lines.join('\n').slice(0, 4000);
}

export const isClosed = (poll, now = Date.now()) => poll.endsAt !== null && poll.endsAt !== undefined && now >= poll.endsAt;

/** The text of one vote, among a person's reactions. */
export const voteToken = (option) => `${VOTE_PREFIX}${option}`;

/** The option a reaction's text votes for, or null if it is not a vote. */
export function optionOfToken(emoji) {
  if (typeof emoji !== 'string' || !emoji.startsWith(VOTE_PREFIX)) return null;
  const rest = emoji.slice(VOTE_PREFIX.length);
  return /^\d{1,2}$/.test(rest) ? Number(rest) : null;
}

/** Reactions with the votes taken out: the part a message shows under itself. */
export const withoutVotes = (reactions) => (reactions ?? []).filter((r) => optionOfToken(r.emoji) === null);

/**
 * What a person's list of reactions becomes when their vote is `options`: the votes in it replaced, the rest
 * (their emoji) as they were.
 *
 * @param {string[]} mine  everything this person has put on the message, votes included
 * @param {number[]} options
 */
export const withVotes = (mine, options) => [
  ...mine.filter((e) => optionOfToken(e) === null),
  ...[...new Set(options)].sort((a, b) => a - b).map(voteToken),
];

/**
 * The votes of a private poll, from the reactions its message has: the count of each option, how many people
 * voted, who (null when the poll hides them) and what `meId` chose.
 *
 * @param {object} poll
 * @param {{emoji: string, userIds: number[]}[]} reactions
 * @param {number|null} meId
 */
export function resultsFromReactions(poll, reactions, meId) {
  const counts = poll.options.map(() => 0);
  const voters = poll.options.map(() => []);
  const first = new Map();
  for (const r of reactions ?? []) {
    const option = optionOfToken(r.emoji);
    if (option === null || option >= counts.length) continue;
    for (const id of r.userIds) {
      // One option on a poll that takes one: the lowest, so that everybody settles on the same.
      if (!poll.multiple && first.has(id) && first.get(id) < option) continue;
      first.set(id, option);
    }
  }
  const who = new Set();
  const mine = [];
  for (const r of reactions ?? []) {
    const option = optionOfToken(r.emoji);
    if (option === null || option >= counts.length) continue;
    for (const id of r.userIds) {
      if (!poll.multiple && first.get(id) !== option) continue;
      if (voters[option].includes(id)) continue;
      voters[option].push(id);
      counts[option] += 1;
      who.add(id);
      if (id === meId) mine.push(option);
    }
  }
  return {
    counts, total: who.size, voters: poll.anonymous ? null : voters, mine: mine.sort((a, b) => a - b),
  };
}

/**
 * The options a click leaves chosen: on a poll that takes one, that option (or none if it was the one chosen);
 * on one that takes several, that option put in or taken out.
 */
export function afterClick(poll, mine, option) {
  const has = mine.includes(option);
  if (!poll.multiple) return has ? [] : [option];
  return (has ? mine.filter((o) => o !== option) : [...mine, option]).sort((a, b) => a - b);
}

/** How long is left, as the biggest whole unit: [amount, unit], unit one of 'm', 'h', 'd'; or null when it is over. */
export function timeLeft(endsAt, now = Date.now()) {
  const ms = endsAt - now;
  if (ms <= 0) return null;
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return [minutes, 'm'];
  if (minutes < 60 * 24) return [Math.ceil(minutes / 60), 'h'];
  return [Math.ceil(minutes / (60 * 24)), 'd'];
}
