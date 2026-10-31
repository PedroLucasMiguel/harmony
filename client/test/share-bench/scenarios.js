// What the benchmark tries. Every scenario is the baseline -- what the app does for a 1080p 60 fps share at
// the default "sharp" setting -- with the named changes. Run some by name:
//
//   node client/test/share-bench.mjs today-1080p60 now-1080p60
//
// Fields: width, height, fps, maxBitrate, maxFramerate, contentHint, degradationPreference, codec; load
// ('none'|'half'|'full': busy processes) and loadNice; link {kbps, delayMs, lossPct, downLossPct} for the
// publisher's line and viewerLink for the viewer's; startBitrate {start, min} (kbps) and opus {kbps} for what
// the benchmark's own publish says in the answer; useRealPublish to go through the app's publish() with
// realStart (bits a second) and realStereo (kbps); watchStereo: false for a viewer that does not ask for
// stereo; stereoProbe for a left-only beep, which tells stereo from mono; dumpSdp / dumpFb to print what was
// offered and answered; localSync to measure the sender's own audio against its picture; jitterBufferTarget
// and playoutDelayHint for the viewer's buffer; viewerDelayMs for somebody who joins late.

const base = {
  width: 1920,
  height: 1080,
  fps: 60,
  maxBitrate: 12_000_000,
  maxFramerate: 60,
  contentHint: 'detail',
  degradationPreference: 'maintain-resolution',
  codec: 'H264',
  audioPath: 'webaudio',
  load: 'none',
};
const smooth = { contentHint: 'motion', degradationPreference: 'balanced' };
const link = (kbps, extra = {}) => ({ kbps, delayMs: 20, ...extra });
const start = (kbps) => ({ start: kbps, min: 300 });

// the app's own publish and watch: as they were, and as they are now (the start is 40% of the ceiling, in bits)
const today = { useRealPublish: true, watchStereo: false, stereoProbe: true };
const now = (kbps) => ({ useRealPublish: true, stereoProbe: true, realStart: Math.round(kbps * 0.4 * 1000), realStereo: 128 });

export const SCENARIOS = [
  // --- before and after, through the app's own code
  { name: 'today-1080p60', ...base, ...today },
  { name: 'now-1080p60', ...base, ...now(12000) },
  { name: 'today-1440p60', ...base, ...today, width: 2560, height: 1440, maxBitrate: 20_000_000 },
  { name: 'now-1440p60', ...base, ...now(20000), width: 2560, height: 1440, maxBitrate: 20_000_000 },
  { name: 'today-4k60', ...base, ...today, width: 3840, height: 2160, maxBitrate: 28_000_000, movers: 120 },
  { name: 'now-4k60', ...base, ...now(28000), width: 3840, height: 2160, maxBitrate: 28_000_000, movers: 120 },
  { name: 'today-smooth', ...base, ...today, ...smooth },
  { name: 'now-smooth', ...base, ...now(12000), ...smooth },
  { name: 'today-L6', ...base, ...today, link: link(6000) },
  { name: 'now-L6', ...base, ...now(12000), link: link(6000) },
  { name: 'today-L3', ...base, ...today, link: link(3000) },
  { name: 'now-L3', ...base, ...now(12000), link: link(3000) },

  // --- the settings, on the benchmark's own publish
  { name: 'base-sharp', ...base },
  { name: 'smooth', ...base, ...smooth },
  { name: 'detail+balanced', ...base, contentHint: 'detail', degradationPreference: 'balanced' },
  { name: 'motion+maintain-res', ...base, contentHint: 'motion', degradationPreference: 'maintain-resolution' },
  { name: '720p60', ...base, width: 1280, height: 720, maxBitrate: 5_000_000 },
  { name: '1080p30', ...base, fps: 30, maxFramerate: 30, maxBitrate: 8_000_000 },
  { name: 'vp8', ...base, codec: 'VP8' },
  { name: 'vp9', ...base, codec: 'VP9' },
  { name: 'high-only', ...base, h264Only: '64001f', dumpSdp: true },

  // --- the bitrate ramp
  { name: 'start-4000', ...base, startBitrate: start(4000) },
  { name: 'start-8000', ...base, startBitrate: start(8000) },
  { name: '1440p-start-8000', ...base, width: 2560, height: 1440, maxBitrate: 20_000_000, startBitrate: start(8000) },
  { name: '4k-start-10000', ...base, width: 3840, height: 2160, maxBitrate: 28_000_000, movers: 120, startBitrate: start(10000) },

  // --- the viewer's buffer, and joining late
  { name: 'jitter-0', ...base, jitterBufferTarget: 0 },
  { name: 'jitter-100', ...base, jitterBufferTarget: 100 },
  { name: 'hint-0', ...base, playoutDelayHint: 0 },
  { name: 'late-join', ...base, viewerDelayMs: 12000, seconds: 15 },

  // --- the sound
  { name: 'stereo-today', ...base, stereoProbe: true },
  { name: 'stereo-128', ...base, stereoProbe: true, opus: { kbps: 128 }, audioMaxKbps: 128, viewerStereo: true },
  { name: 'sync-calibration', ...base, localSync: true },
  { name: 'audio-element', ...base, audioPath: 'element' },

  // --- lines: a bandwidth, a delay, and loss
  { name: 'L6-base', ...base, link: link(6000) },
  { name: 'L3-base', ...base, link: link(3000) },
  { name: 'loss1-publisher-leg', ...base, link: link(0, { lossPct: 1 }) },
  { name: 'loss03-publisher-leg', ...base, link: link(0, { lossPct: 0.3 }) },
  { name: 'loss1-viewer-leg', ...base, viewerLink: { delayMs: 20, downLossPct: 1 } },
  { name: 'loss3-viewer-leg', ...base, viewerLink: { delayMs: 20, downLossPct: 3 } },

  // --- a busy machine (meaningful on Windows or Linux; macOS keeps the foreground app ahead of the load)
  { name: 'load-sharp', ...base, load: 'full' },
  { name: 'load-smooth', ...base, ...smooth, load: 'full' },

  // --- loss recovery: the sender told the relay has no RTX, so a lost packet is resent as itself
  { name: 'loss1-no-rtx', ...base, noRtx: true, link: link(0, { lossPct: 1 }) },
  { name: 'loss03-no-rtx', ...base, noRtx: true, link: link(0, { lossPct: 0.3 }) },
  { name: 'loss3-no-rtx', ...base, noRtx: true, link: link(0, { lossPct: 3 }) },
  { name: 'loss3-publisher-leg', ...base, link: link(0, { lossPct: 3 }) },

  // --- what the relay negotiates
  { name: 'negotiation', ...base, dumpSdp: true, dumpFb: true, seconds: 8 },
];
