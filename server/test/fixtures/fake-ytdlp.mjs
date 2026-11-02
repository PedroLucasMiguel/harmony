#!/usr/bin/env node
// A stand-in for yt-dlp, for the music tests: it answers the few things Music Buddy asks of the real one, from made-up
// videos, and "downloads" by copying a short real audio file. Nothing here touches the network.
//
//   FAKE_DURATION   seconds a downloaded track lasts (default 30)
//   FAKE_LOG        a file every call's arguments are appended to, one JSON line each
//
// A video id that starts with "bad" cannot be fetched; one that starts with "long" is too long for the filter.

import { appendFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(args)}\n`);

const after = args.indexOf('--');
const target = after >= 0 ? args[after + 1] : null;
const duration = Number(process.env.FAKE_DURATION ?? 30);
const ID = (n) => `${String(n).padStart(2, '0')}abcdefghi`.slice(0, 11);

const video = (id, extra = {}) => ({
  id, title: `Song ${id}`, uploader: `Artist ${id.slice(0, 2)}`, duration, ...extra,
});

if (args.includes('--version')) {
  console.log('2099.01.01');
} else if (args.includes('--help')) {
  console.log('Usage: yt-dlp [OPTIONS] URL [URL...]\n  --js-runtimes RUNTIME');
} else if (target?.startsWith('ytsearch')) {
  const n = Number(/^ytsearch(\d+):/.exec(target)?.[1] ?? 1);
  const q = target.replace(/^ytsearch\d+:/, '');
  console.log(JSON.stringify({ entries: Array.from({ length: Math.min(n, 3) }, (_, i) => video(ID(i + 1), { title: `${q} ${i + 1}` })) }));
} else if (target?.includes('/playlist?list=')) {
  console.log(JSON.stringify({ entries: Array.from({ length: 4 }, (_, i) => video(ID(i + 10))) }));
} else if (target?.includes('/watch?v=')) {
  const id = new URL(target).searchParams.get('v');
  if (args.includes('--print-json')) {
    if (id.startsWith('bad')) {
      console.error('ERROR: [youtube] ' + id + ': Video unavailable');
      process.exit(1);
    }
    if (id.startsWith('long')) {
      // A video the duration filter rules out is skipped without an error: no file, no output.
      process.exit(0);
    }
    const out = args[args.indexOf('-o') + 1].replace('%(id)s', id).replace('%(ext)s', 'webm');
    // Forty seconds of real (silent) Opus, so a client that plays it has something to play. The bytes are the same for
    // every id, so two ids are one file to the upload store -- which is how a real cache behaves with a repeated song.
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'silence.webm'), out);
    console.log(JSON.stringify({ ...video(id), requested_downloads: [{ filepath: out }] }));
  } else {
    console.log(JSON.stringify(video(id)));
  }
} else {
  console.error('ERROR: unsupported');
  process.exit(2);
}
