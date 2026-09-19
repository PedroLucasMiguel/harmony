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
  if (cached.encodeAccelerated) return cached;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    cached = snapshot();
    if (cached.encodeAccelerated) break;
  }
  return cached;
}

module.exports = { status, watch, applyEncodingPreference, isAccelerated };
