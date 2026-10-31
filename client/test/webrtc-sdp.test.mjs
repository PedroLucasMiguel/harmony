// What the share's SDP edits do to a real offer and answer, and what they leave alone.
//
//   node client/test/webrtc-sdp.test.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const { check, summary } = reporter();
const app = launchApp({ port: 9566, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-sdp-')) });
process.on('exit', () => { try { app.kill(); } catch { /* gone */ } });
const page = await attach(await findPage(9566));
await sleep(1500);
// The functions run where the app runs them; each call is one round trip to the page.
const run = (fn, ...args) => page.evaluate(`const m = await import('./webrtc.js'); return m.${fn}(...${JSON.stringify(args.filter((a) => a !== undefined))});`);
const tuneOpusStereo = (sdp, options) => run('tuneOpusStereo', sdp, options);
const tuneVideoAnswer = (sdp, options) => run('tuneVideoAnswer', sdp, options);

// An offer and an answer as MediaMTX 1.21 and Chromium write them (trimmed).
const OFFER = [
  'v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111 63', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2', 'a=fmtp:63 111/111',
  'm=video 9 UDP/TLS/RTP/SAVPF 102 103 96', 'a=rtpmap:102 H264/90000',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f', 'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102',
  'a=rtpmap:96 VP8/90000', '',
].join('\r\n');

const stereo = await tuneOpusStereo(OFFER, { kbps: 128 });
check('the Opus line asks for stereo and a bitrate', /a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000/.test(stereo), stereo.split('\r\n')[3]);
check('and only the Opus line: the red, H.264 and rtx lines are as they were', stereo.includes('a=fmtp:63 111/111\r\n') && stereo.includes('profile-level-id=42001f\r\n') && stereo.includes('a=fmtp:103 apt=102\r\n'));
check('saying it twice changes nothing', (await tuneOpusStereo(stereo, { kbps: 128 })) === stereo);
const videoOnly = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n';
check('a description with no audio is left alone', (await tuneOpusStereo(videoOnly)) === videoOnly);

const noFmtp = ['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=sendrecv', ''].join('\r\n');
const added = await tuneOpusStereo(noFmtp);
check('an Opus payload with no line of its own gets one', /a=rtpmap:111 opus\/48000\/2\r\na=fmtp:111 stereo=1;sprop-stereo=1;maxaveragebitrate=128000/.test(added), added.split('\r\n')[2]);

const started = await tuneVideoAnswer(OFFER, { startKbps: 5000 });
check('every H.264 line is told where to start, and the floor that goes with it', /profile-level-id=42001f;x-google-start-bitrate=5000;x-google-min-bitrate=300/.test(started), started.split('\r\n').find((l) => l.startsWith('a=fmtp:102')));
check('and nothing else is: the rtx line, VP8 and the audio are as they were', started.includes('a=fmtp:103 apt=102\r\n') && !/a=fmtp:96/.test(started) && started.includes('a=fmtp:111 minptime=10;useinbandfec=1\r\n'));
check('a start that was already there is kept', (await tuneVideoAnswer(started, { startKbps: 9000 })) === started);
check('no start, no change', (await tuneVideoAnswer(OFFER, { startKbps: 0 })) === OFFER);

const failed = summary();
setTimeout(() => process.exit(failed ? 1 : 0), 200);
