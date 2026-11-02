// yt-dlp, run as a child process: searching YouTube, listing a playlist, and fetching one track's audio.
//
// Everything that comes out of a person's hands is made harmless before it gets here (classify.js), and is still never
// put where yt-dlp could read it as an option: the binary is run with an argument ARRAY (no shell), `--ignore-config`
// so nothing on the machine changes what it does, and the only things after `--` are an address built from a checked id
// or a search prefix. It runs two at a time at most and is killed if it takes too long, because a hung download would
// otherwise hold a slot for good.
//
// The audio asked for is WebM/Opus: YouTube serves it for nearly everything, every client Harmony runs on plays it
// natively, and it is stored as it comes -- no ffmpeg, no re-encoding, nothing for a small computer to do but download.

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_QUERY, isVideoId, playlistUrl, watchUrl } from './classify.js';

/** How long a search or a playlist listing may take, and a download. */
const RESOLVE_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** The biggest file taken: the upload store's own cap is 25 MB, and this leaves it room. */
const MAX_FILESIZE = '24M';

/** What is asked for: Opus in WebM, best first. */
const AUDIO_FORMAT = 'bestaudio[ext=webm][acodec=opus]/bestaudio[ext=webm]';

export class MusicError extends Error {
  /** @param {'unavailable'|'timeout'|'too_long'|'no_audio'|'failed'|'bad_input'} code */
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

/** One YouTube result, the way the rest of the feature knows it. */
function itemOf(entry) {
  const id = entry?.id;
  if (!isVideoId(id)) return null;
  const seconds = Number(entry.duration);
  return {
    source: `yt:${id}`,
    title: String(entry.title ?? '').slice(0, 200),
    artist: String(entry.artist ?? entry.uploader ?? entry.channel ?? '').slice(0, 120),
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
  };
}

/** Why a run failed, as one of ours. yt-dlp says a lot; what is worth telling somebody is short. */
function explain(error, stderr = '') {
  if (error.killed || error.signal === 'SIGKILL') return new MusicError('timeout', 'yt-dlp took too long');
  if (error.code === 'ENOENT') return new MusicError('unavailable', 'yt-dlp is not installed');
  const text = String(stderr);
  if (/does not pass filter|duration/i.test(text) && /filter/i.test(text)) return new MusicError('too_long', 'too long');
  if (/requested format is not available|no video formats/i.test(text)) return new MusicError('no_audio', 'no audio');
  return new MusicError('failed', text.split('\n').filter(Boolean).at(-1)?.slice(0, 200) ?? 'yt-dlp failed');
}

export class YtDlp {
  #bin;
  #cookies;
  #maxSeconds;
  #tmpDir;
  #limit;
  #waiting = [];
  #running = 0;
  #jsRuntimes = null;
  #version = undefined;
  #why = '';
  #exec;

  /**
   * @param {object} options
   * @param {string} [options.bin]       the executable (HARMONY_YTDLP_BIN)
   * @param {string|null} [options.cookies]  a cookies file, for when YouTube asks for a sign-in
   * @param {number} [options.maxSeconds]  the longest track fetched
   * @param {string} options.tmpDir      where downloads are made before they are kept
   * @param {number} [options.concurrency]
   * @param {Function} [options.exec]    execFile, replaceable in a test
   */
  constructor({ bin = 'yt-dlp', cookies = null, maxSeconds = 900, tmpDir, concurrency = 2, exec = execFile }) {
    this.#bin = bin;
    this.#cookies = cookies;
    this.#maxSeconds = maxSeconds;
    this.#tmpDir = tmpDir;
    this.#limit = concurrency;
    this.#exec = exec;
    mkdirSync(tmpDir, { recursive: true });
    // Whatever a crash left behind.
    for (const name of readdirSync(tmpDir)) rmSync(join(tmpDir, name), { recursive: true, force: true });
  }

  /** The version, or null when there is no yt-dlp to run. Asked once. */
  async version() {
    if (this.#version !== undefined) return this.#version;
    try {
      const { stdout } = await this.#run(['--version'], { timeout: 30_000, queue: false });
      this.#version = stdout.trim() || null;
    } catch (err) {
      this.#version = null;
      this.#why = String(err?.code === 'ENOENT' ? `${this.#bin} was not found` : err?.message ?? err).split('\n')[0].slice(0, 200);
      return null;
    }
    // Recent versions need a JavaScript runtime to read YouTube, and Node is the one that is here. Not knowing is not
    // a reason to call yt-dlp unavailable.
    try {
      const help = await this.#run(['--help'], { timeout: 30_000, queue: false });
      this.#jsRuntimes = /--js-runtimes/.test(help.stdout);
    } catch { /* leave it off */ }
    return this.#version;
  }

  /** Why there is no yt-dlp, in a line, for the log. */
  get why() {
    return this.#why;
  }

  get available() {
    return Boolean(this.#version);
  }

  // ------------------------------------------------------------------------------------------------------- running

  #args(extra) {
    // No cache directory: the service user has no home to keep one in, and nothing here is asked twice from it.
    const args = ['--ignore-config', '--no-warnings', '--no-progress', '--no-cache-dir'];
    if (this.#jsRuntimes) args.push('--js-runtimes', 'node');
    if (this.#cookies) args.push('--cookies', this.#cookies);
    return [...args, ...extra];
  }

  async #slot() {
    if (this.#running < this.#limit) {
      this.#running += 1;
      return;
    }
    await new Promise((resolve) => this.#waiting.push(resolve));
  }

  #release() {
    const waiting = this.#waiting.shift();
    if (waiting) waiting();
    else this.#running -= 1;
  }

  /** @returns {Promise<{stdout: string, stderr: string}>} */
  async #run(args, { timeout = RESOLVE_TIMEOUT_MS, queue = true } = {}) {
    if (queue) await this.#slot();
    try {
      return await new Promise((resolve, reject) => {
        this.#exec(this.#bin, this.#args(args), {
          timeout, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, windowsHide: true,
        }, (error, stdout, stderr) => {
          if (error) reject(explain(error, stderr));
          else resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
      });
    } finally {
      if (queue) this.#release();
    }
  }

  // ------------------------------------------------------------------------------------------------------ asking

  /** Words to look for: the first results, as items. */
  async search(query, count = 10) {
    const text = String(query ?? '').trim().slice(0, MAX_QUERY);
    if (!text) throw new MusicError('bad_input', 'nothing to look for');
    const n = Math.max(1, Math.min(20, Math.trunc(count)));
    const { stdout } = await this.#run(['--flat-playlist', '-J', '--', `ytsearch${n}:${text}`]);
    return this.#entries(stdout);
  }

  /** A playlist's tracks, up to `cap`. */
  async playlist(id, cap = 100) {
    const { stdout } = await this.#run([
      '--flat-playlist', '-J', '--playlist-end', String(Math.max(1, Math.trunc(cap))), '--', playlistUrl(id),
    ]);
    return this.#entries(stdout);
  }

  /** One video, with what is known of it. */
  async video(id) {
    if (!isVideoId(id)) throw new MusicError('bad_input', 'not a video id');
    const { stdout } = await this.#run(['--no-playlist', '-J', '--', watchUrl(id)]);
    let info;
    try {
      info = JSON.parse(stdout);
    } catch {
      throw new MusicError('failed', 'unreadable answer');
    }
    const item = itemOf(info);
    if (!item) throw new MusicError('failed', 'not a video');
    return item;
  }

  #entries(stdout) {
    let doc;
    try {
      doc = JSON.parse(stdout);
    } catch {
      throw new MusicError('failed', 'unreadable answer');
    }
    return (doc.entries ?? []).map(itemOf).filter(Boolean);
  }

  // ---------------------------------------------------------------------------------------------------- fetching

  /**
   * One track's audio, into a file of its own under the temp directory.
   *
   * The caller takes the file (to keep it) and calls `done()` to remove what is left; the directory is made for this
   * call alone, so two downloads never meet.
   *
   * @returns {Promise<{path: string, bytes: number, durationMs: number|null, title: string, artist: string,
   *   done: () => void}>}
   */
  async fetchAudio(id) {
    if (!isVideoId(id)) throw new MusicError('bad_input', 'not a video id');
    const dir = mkdtempSync(join(this.#tmpDir, 'dl-'));
    const done = () => rmSync(dir, { recursive: true, force: true });
    try {
      const { stdout } = await this.#run([
        '--no-playlist', '--no-mtime', '-f', AUDIO_FORMAT,
        '--max-filesize', MAX_FILESIZE,
        '--match-filter', `duration<=${Math.trunc(this.#maxSeconds)}`,
        '-o', join(dir, '%(id)s.%(ext)s'),
        '--print-json', '--',
        watchUrl(id),
      ], { timeout: DOWNLOAD_TIMEOUT_MS });

      // A filter that rules a video out is not an error to yt-dlp: it prints nothing and downloads nothing.
      const line = stdout.trim().split('\n').filter(Boolean).at(-1);
      if (!line) throw new MusicError('too_long', 'too long');
      const info = JSON.parse(line);
      const path = info.requested_downloads?.[0]?.filepath ?? info._filename;
      if (!path || !path.startsWith(dir)) throw new MusicError('failed', 'no file came out');
      const seconds = Number(info.duration);
      return {
        path,
        bytes: statSync(path).size,
        durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
        title: String(info.title ?? '').slice(0, 200),
        artist: String(info.artist ?? info.uploader ?? info.channel ?? '').slice(0, 120),
        done,
      };
    } catch (err) {
      done();
      throw err instanceof MusicError ? err : new MusicError('failed', String(err?.message ?? err));
    }
  }
}
