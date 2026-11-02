// How loud tracks are, and the gain that evens them out (src/music/loudness.js), measured against what ffmpeg's EBU R128
// meter says of the same files, and kept next to the file by the library.
//
//   node --test server/test/music-loudness.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Meter, TARGET_LUFS, gainDbFor, measureFile, opusFramesOf } from '../src/music/loudness.js';
import { MusicLibrary } from '../src/music/library.js';
import { YtDlp } from '../src/music/ytdlp.js';
import { Chat } from '../src/chat.js';
import { ensureDataDir, openDatabase } from '../src/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const file = (name) => resolve(here, 'fixtures', `${name}.webm`);
const FAKE = resolve(here, 'fixtures', 'fake-ytdlp.mjs');

// What `ffmpeg -i <file> -af ebur128=peak=sample` reads for the two fixtures (stereo sines, 40 s).
const LOUD = { lufs: -9.6, peakDb: -7.5 };
const QUIET = { lufs: -22.2, peakDb: -20.4 };
const near = (a, b, within = 0.3) => assert.ok(Math.abs(a - b) <= within, `${a} is not within ${within} of ${b}`);

describe('reading the container', () => {
  it('takes the Opus packets out of a WebM file, and says how many channels', () => {
    const found = opusFramesOf(readFileSync(file('tone-loud')));
    assert.equal(found.channels, 2);
    // 40 s of 20 ms packets
    assert.ok(found.frames.length > 1900 && found.frames.length < 2100, String(found.frames.length));
    assert.ok(found.frames.every((f) => f.length > 0));
  });

  it('gives up, rather than guess, at something else', () => {
    assert.equal(opusFramesOf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);
    assert.equal(opusFramesOf(new Uint8Array(0)), null);
    assert.equal(opusFramesOf(readFileSync(resolve(here, 'fixtures', 'spotify-track.html'))), null);
  });
});

describe('measuring', () => {
  it('reads a loud and a quiet track as the broadcast meter does', async () => {
    const loud = await measureFile(file('tone-loud'));
    const quiet = await measureFile(file('tone-quiet'));
    near(loud.lufs, LOUD.lufs);
    near(loud.peakDb, LOUD.peakDb);
    near(quiet.lufs, QUIET.lufs);
    near(quiet.peakDb, QUIET.peakDb);
    assert.ok(loud.lufs - quiet.lufs > 12, 'the two are far apart, which is what evening out is for');
  });

  it('finds nothing to measure in silence, a file that is not audio, or one that is not there', async () => {
    assert.equal(await measureFile(file('silence')), null);
    assert.equal(await measureFile(resolve(here, 'fixtures', 'spotify-track.html')), null);
    assert.equal(await measureFile(resolve(here, 'fixtures', 'nothing.webm')), null);
  });

  it('does not count a quiet passage against a track (the relative gate)', () => {
    const second = (level) => {
      const samples = new Float32Array(48_000);
      for (let i = 0; i < samples.length; i += 1) samples[i] = level * Math.sin((2 * Math.PI * 440 * i) / 48_000);
      return [samples];
    };
    const loudAlone = new Meter(1);
    const withGap = new Meter(1);
    for (let i = 0; i < 20; i += 1) loudAlone.push(second(0.3));
    for (let i = 0; i < 20; i += 1) withGap.push(second(0.3));
    // twenty more seconds, 25 dB down: well under the track's own average, so it is left out
    for (let i = 0; i < 20; i += 1) withGap.push(second(0.3 * 10 ** (-25 / 20)));
    near(withGap.result().lufs, loudAlone.result().lufs, 0.2);
  });
});

describe('the gain that evens tracks out', () => {
  it('turns a loud track down and a quiet one up, to one level', () => {
    const loud = gainDbFor(LOUD);
    const quiet = gainDbFor(QUIET);
    assert.ok(loud < 0 && quiet > 0);
    near(LOUD.lufs + loud, TARGET_LUFS, 0.06);
    near(QUIET.lufs + quiet, TARGET_LUFS, 0.06);
  });

  it('turns a track up only as far as its loudest sample allows, and never past the limits', () => {
    // a quiet track with a sharp peak: only 1.5 dB of room
    assert.equal(gainDbFor({ lufs: -30, peakDb: -3 }), 1.5);
    // and one with no room at all is left alone, not turned down
    assert.equal(gainDbFor({ lufs: -30, peakDb: -0.5 }), 0);
    // the limits
    assert.equal(gainDbFor({ lufs: -2, peakDb: -1 }), -12);
    assert.equal(gainDbFor({ lufs: 6, peakDb: 3 }), -15);
    assert.equal(gainDbFor({ lufs: -40, peakDb: -30 }), 9);
  });

  it('says nothing of a track that was not measured', () => {
    assert.equal(gainDbFor(null), null);
    assert.equal(gainDbFor({ lufs: -Infinity, peakDb: 0 }), null);
  });
});

describe('the library keeps it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harmony-loud-'));
  const ytdlp = new YtDlp({ bin: FAKE, tmpDir: join(dir, 'tmp'), maxSeconds: 900 });
  const dataDir = ensureDataDir(join(dir, 'data'));
  const db = openDatabase({ dataDir });
  const chat = new Chat(db, { dataDir, maxDiskBytes: 64 * 1024 * 1024 });
  const library = new MusicLibrary({ db, chat, ytdlp, thumbnails: false });

  it('measures a track as it is fetched, and gives the gain with the file', async () => {
    const loud = await library.ensure('yt:loud0000001');
    const quiet = await library.ensure('yt:quiet000001');
    near(loud.gainDb, gainDbFor(LOUD), 0.4);
    near(quiet.gainDb, gainDbFor(QUIET), 0.4);
    assert.ok(loud.gainDb < 0 && quiet.gainDb > 0);
  });

  it('has a silent file as unmeasured, and says so once', async () => {
    const silent = await library.ensure('yt:silent00001');
    assert.equal(silent.gainDb, null);
    const row = db.prepare("SELECT loudness_at, loudness_lufs FROM music_tracks WHERE source_key = 'yt:silent00001'").get();
    assert.ok(row.loudness_at > 0, 'it was tried');
    assert.equal(row.loudness_lufs, null);
  });

  it('answers from what it kept, the second time', async () => {
    const again = await library.ensure('yt:loud0000001');
    near(again.gainDb, gainDbFor(LOUD), 0.4);
  });

  it('measures a track from before measuring, the first time it is asked for', async () => {
    db.prepare("UPDATE music_tracks SET loudness_lufs = NULL, peak_db = NULL, loudness_at = NULL WHERE source_key = 'yt:quiet000001'").run();
    const quiet = await library.ensure('yt:quiet000001');
    near(quiet.gainDb, gainDbFor(QUIET), 0.4);
    const row = db.prepare("SELECT loudness_at FROM music_tracks WHERE source_key = 'yt:quiet000001'").get();
    assert.ok(row.loudness_at > 0);
  });
});
