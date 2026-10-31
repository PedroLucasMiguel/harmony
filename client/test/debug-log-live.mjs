// The debug log describes a live or a screen share while there is one: the encoder, what the capture
// gives, and how the sound gets in -- the three things a laggy, out-of-step stream is explained by.
//
//   node client/test/debug-log-live.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const PORT = 9559;
const { check, summary } = reporter();
const app = launchApp({ port: PORT, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-dll-')) });
process.on('exit', () => { try { app.kill(); } catch { /* gone */ } });

async function run() {
  const page = await attach(await findPage(PORT));
  await sleep(2000);
  const lines = await page.evaluate(`
    const { createDebugLog } = await import('./debug-log.js');
    const got = [];
    const harmony = {
      debug: { start: async () => ({}), stop: async () => ({}), status: async () => ({}), event: async (kind, text) => { got.push(kind + ' ' + text); }, header: async () => ({}) },
      settings: window.harmony?.settings, platform: 'test',
    };
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360; canvas.getContext('2d').fillRect(0, 0, 9, 9);
    const videoTrack = canvas.captureStream(30).getVideoTracks()[0];
    const pc = new RTCPeerConnection();
    pc.addTrack(videoTrack, new MediaStream([videoTrack]));
    const log = createDebugLog({
      harmony, voice: () => null, effectStats: () => null, settings: () => ({}),
      live: () => ({ pc, videoTrack, audioMode: 'native', mix: { ctxState: 'running', baseLatency_ms: 10, pcm: { queued_ms: 80, dropped_ms: 0, underrun_ms: 5 } } }),
    });
    await log.start();
    await new Promise((r) => setTimeout(r, 4500));
    await log.stop();
    pc.close();
    return got;`);
  const live = lines.find((l) => l.startsWith('NET live '));
  const capture = lines.find((l) => l.startsWith('AUDIO liveCapture '));
  check('a live is described like the camera: its connection and what the encoder did', Boolean(live), live?.slice(0, 120) ?? JSON.stringify(lines).slice(0, 200));
  check('and so is what the capture gave, with how the sound gets in', /size=640x360/.test(capture ?? '') && /audioMode=native/.test(capture ?? ''), capture);
  check('with how far behind the audio is playing and what it dropped', /pcm\.queued_ms=80/.test(capture ?? '') && /pcm\.dropped_ms=0/.test(capture ?? '') && /pcm\.underrun_ms=5/.test(capture ?? ''), capture);
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  const failed = summary();
  setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
});
