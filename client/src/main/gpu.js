// What the GPU is doing for us, and the switch to stop it.
//
// The short version, measured on this project rather than assumed: WebRTC on
// Windows already encodes H.264 on the GPU. Chromium routes it through Media
// Foundation's VideoEncodeAccelerator, which is a front end for whichever
// vendor encoder is installed -- NVENC on NVIDIA, AMF/VCE on AMD, Quick Sync on
// Intel. There is no flag to turn it on and no vendor SDK to integrate; it is
// the default, and OpenH264 on the CPU is the automatic fallback when no
// hardware encoder can be used.
//
// Measured here, 1920x1080 H.264 with contentHint=detail:
//
//   synthetic canvas   5.3 ms/frame hardware vs  9.9 ms/frame software  (-46%)
//   real screen share  8.1 ms/frame hardware vs  9.9 ms/frame software  (-18%)
//
// The margin depends on the content: a busy frame is where the GPU pulls ahead.
//
// What Chromium does NOT give us is a way to ask, at runtime, which encoder a
// particular stream ended up on. `encoderImplementation` is in the WebRTC stats
// spec but is absent from this Electron build's outbound-rtp -- verified by
// dumping every field the stats object exposes. So the honest thing to report
// is the capability, which is what getGPUFeatureStatus() answers.

const { app } = require('electron');

/**
 * Chromium's own words for each feature, mapped to something a user can act on.
 * 'enabled' and 'enabled_on' mean the GPU is doing the work.
 */
function isAccelerated(value) {
  return typeof value === 'string' && value.startsWith('enabled');
}

/**
 * Turn hardware encoding off for this run.
 *
 * Must be called before the app is ready: these are Chromium command-line
 * switches, read once at startup. That is why the setting needs a restart to
 * take effect rather than applying live.
 *
 * Worth having even though hardware is the better default: a bad driver can
 * produce a stream that looks fine locally and is corrupt for every viewer, and
 * when that happens there has to be something to turn off.
 */
function applyEncodingPreference(preference) {
  if (preference !== 'off') return false;
  app.commandLine.appendSwitch('disable-accelerated-video-encode');
  app.commandLine.appendSwitch('disable-webrtc-hw-encoding');
  return true;
}

/**
 * Which GPU Harmony itself should run on, on a laptop that has two.
 *
 * This exists because of a measurement. On a machine playing a game on the
 * discrete GPU while streaming, Harmony's share of that GPU was:
 *
 *     videoencode 13.0%   3d 2.7%   videodecode 2.7%   copy 1.6%   = ~20%
 *
 * ...on the same adapter the game was using for its 22.8%. Moving Harmony to
 * the integrated GPU hands all of that back. Intel Quick Sync encodes H.264
 * perfectly well, so the stream does not suffer for it -- verified: with this
 * switch the active adapter becomes the iGPU and `video_encode` still reports
 * `enabled`.
 *
 * It is not a free win in every case: capturing a game that renders on the
 * other GPU means the frames have to cross adapters. Which way round is better
 * depends on the machine, so this is an option rather than a default.
 */
function applyAdapterPreference(preference) {
  if (preference === 'integrated') {
    app.commandLine.appendSwitch('force_low_power_gpu');
    return 'integrated';
  }
  if (preference === 'dedicated') {
    app.commandLine.appendSwitch('force_high_performance_gpu');
    return 'dedicated';
  }
  return null;
}

function snapshot() {
  let features = {};
  try {
    features = app.getGPUFeatureStatus() ?? {};
  } catch {
    // Asked before there is a GPU process to ask.
  }
  return {
    videoEncode: features.video_encode ?? 'unknown',
    videoDecode: features.video_decode ?? 'unknown',
    encodeAccelerated: isAccelerated(features.video_encode),
    decodeAccelerated: isAccelerated(features.video_decode),
  };
}

/**
 * How long to keep asking before believing there is no hardware encoder.
 *
 * getGPUFeatureStatus() answers `disabled_software` until the GPU process has
 * reported, which is about 300ms after the window loads -- measured:
 *
 *     17ms  app ready              video_encode=disabled_software
 *     66ms  did-finish-load        video_encode=disabled_software   <- boot()
 *    170ms  +100ms                 video_encode=disabled_software
 *    382ms  +300ms                 video_encode=enabled
 *
 * The renderer asks during boot(), which lands in the middle of that. Reading
 * once and caching the answer therefore reported "no GPU encoder" for the whole
 * session on a machine that was encoding on its GPU the entire time.
 *
 * A machine with genuinely no hardware encoder never flips, so the wait has to
 * be bounded rather than indefinite.
 */
const SETTLE_TIMEOUT_MS = 6000;
const POLL_MS = 150;

/** Kept current so later callers never pay the wait. */
let cached = null;

/** Call once the app is ready. */
function watch() {
  cached = snapshot();
  // Electron re-emits this as the GPU process learns what it can do.
  app.on('gpu-info-update', () => {
    cached = snapshot();
  });
}

/**
 * The GPU's capabilities, waiting for the GPU process if it has not reported.
 *
 * Returns as soon as acceleration is confirmed, so the common case costs one
 * synchronous read.
 */
async function status({ timeoutMs = SETTLE_TIMEOUT_MS } = {}) {
  cached = snapshot();
  if (!cached.encodeAccelerated) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      cached = snapshot();
      if (cached.encodeAccelerated) break;
    }
  }
  return { ...cached, adapters: await adapters() };
}

const VENDORS = { 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x8086: 'Intel', 0x1414: 'Microsoft' };

/**
 * The GPUs present, so the UI can offer to move Harmony between them only when
 * there is somewhere to move it to. Microsoft's Basic Render Driver is filtered
 * out: it is a software fallback, not a second GPU.
 */
let adapterCache = null;

async function adapters() {
  if (adapterCache) return adapterCache;
  try {
    // 'complete' rather than 'basic': only the complete report carries the
    // `active` flag, and without it we cannot tell which GPU Chromium actually
    // chose -- which is the entire question worth asking here.
    const info = await app.getGPUInfo('complete');
    const list = (info.gpuDevice ?? [])
      .filter((g) => g.vendorId !== 0x1414) // Microsoft Basic Render Driver
      .map((g) => ({
        vendor: VENDORS[g.vendorId] ?? `0x${(g.vendorId ?? 0).toString(16)}`,
        active: Boolean(g.active),
      }));
    // Only worth caching once it is actually informative.
    if (list.some((a) => a.active)) adapterCache = list;
    return list;
  } catch {
    return [];
  }
}

module.exports = { status, watch, applyEncodingPreference, applyAdapterPreference, isAccelerated };
