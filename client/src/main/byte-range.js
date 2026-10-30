// What a request for part of a file asks for.
//
// A <video> or <audio> element does not read a file front to back: it asks for
// the bytes it wants (the index at the end of an mp4, then the part being
// played, then wherever the viewer drags to) and plays nothing from a source
// that cannot answer that. See the media route in index.js.

/**
 * @param {string|null|undefined} header  the Range header
 * @param {number} size  the file's length
 * @returns {{start: number, end: number} | 'unsatisfiable' | null}
 *   null: no range was asked for (or not one this understands), send it all
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;

  let start;
  let end;
  if (match[1] === '') {
    // The last N bytes.
    const last = Number(match[2]);
    if (last === 0) return 'unsatisfiable';
    start = Math.max(0, size - last);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

module.exports = { parseRange };
