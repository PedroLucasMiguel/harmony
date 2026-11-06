// A share lowering itself when the computer cannot keep up, in the real page: a stream of its own (a canvas, through a
// loopback connection) is handed to the page's share state, the page is told the encoder is starved, and what the sender
// and the capture are then asked for is read back. No screen is shared, and no server is needed.
//
//   node client/test/share-adapt-ui.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const PORT = 9574;
const { check, summary } = reporter();
const app = launchApp({ port: PORT, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-adapt-')), extraArgs: ['--mute-audio'] });
process.on('exit', () => { try { app.kill(); } catch { /* gone */ } });
const page = await attach(await findPage(PORT));
await sleep(2500);

// A 1080p60 "share": a canvas stream, on a sender that is on a real (loopback) connection, handed to the page.
await page.evaluate(`
  const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
  const g = canvas.getContext('2d'); let n = 0;
  setInterval(() => { g.fillStyle = 'hsl(' + (n++ * 7 % 360) + ',70%,50%)'; g.fillRect(0, 0, 1920, 1080); }, 16);
  const stream = canvas.captureStream(60);
  const track = stream.getVideoTracks()[0];
  const a = new RTCPeerConnection(); const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  const sender = a.addTrack(track, stream);
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  const { createShareGovernor } = await import('./share-governor.js');
  window.__share = { sender, track, canvas };
  window.__harmonyShare.adopt({ videoSender: sender, videoTrack: track, governor: createShareGovernor({ fps: 60, width: 1920, height: 1080 }), governed: null });
  return true;`);

const read = () => page.evaluate(`const p = window.__share.sender.getParameters(); return { maxFramerate: p.encodings[0].maxFramerate ?? null, governed: window.__harmonyShare.live().governed && { fps: window.__harmonyShare.live().governed.fps, height: window.__harmonyShare.live().governed.height }, trackFps: window.__share.track.getSettings().frameRate ?? null };`);
// The page is told what the encoder is doing, every second, as getStats() totals: starved, 8 fps at 130 ms a frame.
const feedSeconds = (seconds, { fps, ms, kbps = 3000, link = 20000, from = 0, totals }) => page.evaluate(`
  const t = ${JSON.stringify(totals)};
  for (let i = 1; i <= ${seconds}; i += 1) {
    t.at += 1000; t.frames += ${fps}; t.time += ${fps} * ${ms} / 1000;
    window.__harmonyShare.adapt({ at: t.at, framesEncoded: t.frames, totalEncodeTime: t.time, limitedBy: 'none', kbps: ${kbps}, availableKbps: ${link}, width: 1920, height: 1080 });
    await new Promise((r) => setTimeout(r, 30));
  }
  return t;`);

let totals = { at: 0, frames: 0, time: 0 };
check('at first it asks for what was chosen: nothing lowered', (await read()).governed === null);

totals = await feedSeconds(14, { fps: 8, ms: 130, totals });
await sleep(400);
let now = await read();
check('a computer that cannot keep up is asked for less: 30 fps, on the sender', now.governed?.fps === 30 && now.maxFramerate === 30, JSON.stringify(now));
check('and the capture is held to the same', now.trackFps === null || now.trackFps <= 30.5, JSON.stringify(now));

totals = await feedSeconds(40, { fps: 8, ms: 130, totals });
await sleep(400);
now = await read();
check('and for a smaller picture if that is not enough', now.governed?.height <= 720, JSON.stringify(now));

check('a new capture (another source) opens at what the stream has been lowered to, not at what was first asked', await page.evaluate(`const p = window.__harmonyShare.preset({ width: 1920, height: 1080, fps: 60, bitrate: 12e6 }); return p.fps <= 30 && p.height <= 720;`));

// The encoder recovers: half a minute of keeping up, and one step back.
totals = await feedSeconds(45, { fps: now.governed.fps, ms: 3, totals });
await sleep(400);
const later = await read();
check('when it keeps up for half a minute it goes back up a step', later.governed === null || later.governed.fps > now.governed.fps || later.governed.height > now.governed.height, JSON.stringify({ now, later }));

// Switched off, from the switch beside the selects: nothing is lowered, and what had been is put back to what was asked.
check('the switch is on to begin with', await page.evaluate("return document.getElementById('live-auto-adapt').checked;"));
await page.evaluate("document.getElementById('live-auto-adapt').click(); return true;");
await sleep(600);
check('it is kept as a setting', await page.evaluate("const s = await harmony.settings.get(); return (s.data ?? s).shareAutoAdapt === false;"));
await page.evaluate(`const { createShareGovernor } = await import('./share-governor.js'); window.__harmonyShare.adopt({ governed: null, governor: createShareGovernor({ fps: 60, width: 1920, height: 1080 }) }); return true;`);
totals = { at: 0, frames: 0, time: 0 };
totals = await feedSeconds(30, { fps: 8, ms: 130, totals });
check('and a starved encoder is then left as it is', (await read()).governed === null);

const failed = summary();
process.exit(failed ? 1 : 0);
