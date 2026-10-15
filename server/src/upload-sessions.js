// Big uploads, in pieces, straight to disk.
//
// POST /api/uploads takes a file as one request body and holds all of it in
// memory before writing -- fine for a picture, and the reason it stays
// capped at 25 MB. A 2 GB file that way would be 2 GB of a Pi's RAM, and one
// request that has to survive however long a home upload takes.
//
// So a big file is a session instead:
//
//   POST /api/uploads/sessions            { size, contentType } -> { id, chunkBytes }
//   POST /api/uploads/sessions/:id/chunk  ?offset=N, raw body   -> { received }
//   POST /api/uploads/sessions/:id/finish                       -> the upload
//
// Each chunk is at most chunkBytes (8 MB): small enough to hold whole, so a
// chunk is written and hashed only once all of it has arrived, and one that
// breaks halfway can simply be sent again from the same offset. That also
// keeps every request far under the body limits proxies and tunnels impose
// (Cloudflare's is 100 MB).
//
// The file is hashed as it arrives, so finishing is a rename into the
// content-addressed store (Chat.adopt) rather than a second read of 2 GB.
//
// Sessions live in memory: a restart forgets them, and Chat clears the
// directory they wrote to when it starts.

import { createHash, randomBytes } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const CHUNK_BYTES = 8 * 1024 * 1024;
/** A session nothing has been sent to for this long is abandoned. */
const IDLE_MS = 10 * 60 * 1000;
/** Open sessions per account: enough for a few files at once, not a flood. */
const PER_USER = 3;

export class UploadSessions {
  #chat;
  #chunkBytes;
  #idleMs;
  #now;
  /** @type {Map<string, object>} */
  #sessions = new Map();

  /**
   * @param {import('./chat.js').Chat} chat
   */
  constructor(chat, { chunkBytes = CHUNK_BYTES, idleMs = IDLE_MS, now = Date.now } = {}) {
    this.#chat = chat;
    this.#chunkBytes = chunkBytes;
    this.#idleMs = idleMs;
    this.#now = now;
    const sweeper = setInterval(() => this.sweep(), 60 * 1000);
    sweeper.unref();
  }

  /** What open sessions have been promised and not yet written to the store. */
  get reservedBytes() {
    let total = 0;
    for (const s of this.#sessions.values()) total += s.size;
    return total;
  }

  get size() {
    return this.#sessions.size;
  }

  async open({ userId, size, contentType }) {
    if (!Number.isSafeInteger(size) || size <= 0) return { ok: false, error: 'empty_file' };
    if (size > this.#chat.maxFileBytes) return { ok: false, error: 'file_too_large' };
    const mine = [...this.#sessions.values()].filter((s) => s.userId === userId).length;
    if (mine >= PER_USER) return { ok: false, error: 'too_many_uploads' };
    // Room for this one on top of every other upload still arriving.
    if (!this.#chat.makeRoom(size, this.reservedBytes)) return { ok: false, error: 'server_full' };

    const id = randomBytes(16).toString('hex');
    const path = join(this.#chat.incomingDir, id);
    const handle = await open(path, 'w');
    this.#sessions.set(id, {
      id,
      userId,
      size,
      contentType: String(contentType ?? ''),
      path,
      handle,
      hash: createHash('sha256'),
      received: 0,
      busy: false,
      touched: this.#now(),
    });
    return { ok: true, id, chunkBytes: this.#chunkBytes };
  }

  #mine(id, userId) {
    const session = this.#sessions.get(id);
    return session && session.userId === userId ? session : null;
  }

  /**
   * One chunk, at the offset the session has reached.
   *
   * @param {{id: string, userId: number, offset: number,
   *          body: AsyncIterable<Buffer> & {complete?: boolean, destroy?: Function,
   *                headers?: object}}} args
   */
  async append({ id, userId, offset, body }) {
    const session = this.#mine(id, userId);
    if (!session) return { ok: false, error: 'no_such_upload' };
    // A retry of a chunk that did arrive, or a second request racing the
    // first: either way, say where the file really is and let the client
    // carry on from there.
    if (session.busy || offset !== session.received) {
      return { ok: false, error: 'bad_offset', received: session.received };
    }

    const max = Math.min(this.#chunkBytes, session.size - session.received);
    const declared = Number(body.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > max) return { ok: false, error: 'chunk_too_large' };

    session.busy = true;
    try {
      const parts = [];
      let length = 0;
      for await (const part of body) {
        length += part.length;
        if (length > max) {
          body.destroy?.();
          return { ok: false, error: 'chunk_too_large' };
        }
        parts.push(part);
      }
      if (body.complete === false) return { ok: false, error: 'aborted' };
      if (!length) return { ok: false, error: 'empty_file' };

      const chunk = Buffer.concat(parts, length);
      // Positional and asynchronous: 8 MB to an SD card is long enough that
      // a synchronous write would stall every other request on the server.
      await session.handle.write(chunk, 0, length, session.received);
      session.hash.update(chunk);
      session.received += length;
      return { ok: true, received: session.received };
    } catch {
      return { ok: false, error: 'aborted' };
    } finally {
      session.busy = false;
      session.touched = this.#now();
    }
  }

  async finish({ id, userId }) {
    const session = this.#mine(id, userId);
    if (!session) return { ok: false, error: 'no_such_upload' };
    if (session.busy || session.received !== session.size) {
      return { ok: false, error: 'incomplete', received: session.received };
    }
    this.#sessions.delete(id);
    await session.handle.close();
    try {
      return this.#chat.adopt(session.path, {
        hash: session.hash.digest('hex'),
        bytes: session.size,
        claimedType: session.contentType,
      });
    } catch (err) {
      await unlink(session.path).catch(() => {});
      throw err;
    }
  }

  async cancel({ id, userId }) {
    const session = this.#mine(id, userId);
    if (session) await this.#drop(session);
    return { ok: true };
  }

  async #drop(session) {
    this.#sessions.delete(session.id);
    await session.handle.close().catch(() => {});
    await unlink(session.path).catch(() => {});
  }

  /** Forget sessions nobody has sent anything to for a while. */
  async sweep() {
    const cutoff = this.#now() - this.#idleMs;
    for (const session of [...this.#sessions.values()]) {
      if (!session.busy && session.touched < cutoff) await this.#drop(session);
    }
  }
}
