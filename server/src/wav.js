// The length of a WAV file, from its header.
//
// Why only WAV is accepted for a join sound: the server has no audio decoder
// and does not want one, and a length it cannot measure is a length it cannot
// enforce. A WAV states its own, in a few bytes at the front, so the 10-second
// ceiling on a join sound can be checked here instead of trusted from the
// client. The client converts whatever the person picked into one.

import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** Enough to get past any header a real encoder writes (LIST, fact, ...). */
const HEADER_BYTES = 4096;

/**
 * Seconds of audio in a PCM WAV, or null if it is not one or is not readable.
 *
 * The data chunk's declared size is distrusted: a streamed WAV writes 0 or
 * 0xFFFFFFFF there, and a hostile one may claim more than the file holds, so
 * the length is the smaller of what it says and what is actually on disk.
 */
export function wavSeconds(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(HEADER_BYTES);
    const got = readSync(fd, head, 0, HEADER_BYTES, 0);
    const total = statSync(file).size;
    if (got < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      return null;
    }

    let byteRate = 0;
    let at = 12;
    while (at + 8 <= got) {
      const id = head.toString('ascii', at, at + 4);
      const size = head.readUInt32LE(at + 4);
      const body = at + 8;
      if (id === 'fmt ') {
        if (body + 12 > got) return null;
        byteRate = head.readUInt32LE(body + 8);
      } else if (id === 'data') {
        if (!byteRate) return null;
        const onDisk = Math.max(0, total - body);
        const bytes = size === 0 || size === 0xffffffff ? onDisk : Math.min(size, onDisk);
        return bytes / byteRate;
      }
      at = body + size + (size % 2);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
