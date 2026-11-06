// A paste too long to be a message becomes a text file, attached, as Discord does it.
//
// Every box a message is written in takes at most 4000 characters, and the browser cuts a longer paste off at that
// without a word: a log, a stack trace or an essay pasted in came out as its first four thousand characters. Here a
// paste that is long is taken out of the paste and made into `message.txt`, which the box's own way of attaching a
// file then carries with the message.
//
// Only the decision and the file are here. What attaching a file means -- a channel's strip of cards, a private
// conversation's one pending file, a post's pictures -- is each box's own, and each one calls this from its paste.

/** A paste longer than this is a file. The same four thousand a message is limited to: past it, it could not be sent as one. */
export const PASTE_AS_FILE_CHARS = 4000;

/** Under this, a paste is never turned into a file for merely not fitting in what is left of the box. */
const NOT_TRIVIAL_CHARS = 1000;

/**
 * Whether this paste, into this box, should be a file.
 *
 * @param {string} text  what is being pasted
 * @param {{value: string, maxLength: number, selectionStart: number|null, selectionEnd: number|null}} [box]
 */
export function isHugePaste(text, box) {
  if (typeof text !== 'string') return false;
  if (text.length > PASTE_AS_FILE_CHARS) return true;
  // Not long on its own, but more than the room left in the box: the browser would cut it, and a part of a paste is
  // worse than a file of it. A line or two is never worth a file, whatever room there is.
  if (!box || text.length < NOT_TRIVIAL_CHARS) return false;
  const limit = box.maxLength > 0 ? box.maxLength : PASTE_AS_FILE_CHARS;
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? start;
  return box.value.length - (end - start) + text.length > limit;
}

/** `message.txt`, or `message (2).txt` where that name is taken by a file that is going with the same message. */
export function pastedName(taken = []) {
  const used = new Set(taken);
  if (!used.has('message.txt')) return 'message.txt';
  for (let n = 2; ; n += 1) {
    const name = `message (${n}).txt`;
    if (!used.has(name)) return name;
  }
}

/**
 * The file for a paste event, or null when the paste is to go in as text (or carries a file of its own, which the
 * box already takes). Does not stop the paste: the caller does that when it takes the file.
 *
 * @param {ClipboardEvent} event
 * @param {HTMLTextAreaElement|HTMLInputElement} [box]
 * @param {string[]} [taken]  the names of the files already going with the message
 * @returns {File|null}
 */
export function fileFromPaste(event, box, taken = []) {
  const data = event.clipboardData;
  if (!data || data.files?.length) return null;
  const text = data.getData('text/plain');
  if (!isHugePaste(text, box)) return null;
  return new File([text], pastedName(taken), { type: 'text/plain' });
}
