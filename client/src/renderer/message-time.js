// The time shown beside a message: just the time of day while it is recent, the date as well once it
// is more than a day old, so a message from last week does not read as if it were from this morning.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {number|string|Date} when  when the message was sent
 * @param {number} [now]             the current time (a parameter for the tests)
 */
export function messageTime(when, now = Date.now()) {
  const date = new Date(when);
  const time = { hour: '2-digit', minute: '2-digit' };
  if (now - date.getTime() < DAY_MS) return date.toLocaleTimeString([], time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleString([], {
    day: '2-digit',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    ...time,
  });
}
