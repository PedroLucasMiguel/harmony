// "Native" for a camera: the best picture it can actually move.
//
// A browser does not list a camera's modes, it only answers a request: a mode that satisfies it, or
// OverconstrainedError. Asking for the biggest picture and the highest rate "ideally" is answered with
// the camera's largest mode whatever its rate -- for a C920 that is 2304x1536 over USB uncompressed, two
// frames a second -- so the question is put the other way round: from the biggest size down, "this size
// or more, at this rate or more", and the first size the camera says yes to is the one that is used.
// The rate is lowered only when no size will do, so the order is: a rate worth having, then the biggest
// picture at it.

/** Sizes asked for, biggest first. A camera of another shape (4:3, 3:2) is matched by the minimums. */
export const SIZES = [
  [4096, 2160],
  [3840, 2160],
  [2560, 1440],
  [1920, 1080],
  [1280, 720],
  [960, 540],
  [640, 360],
];

/** The rates tried, in order: the one wanted (30 when the camera's own is wanted), then lower. */
export function floorsFor(rate) {
  const wanted = rate || 30;
  return [wanted, ...[30, 15].filter((f) => f < wanted)];
}

/** Under this fraction of the rate asked for, a camera that said yes is not believed. */
const BELIEVED = 0.7;

/**
 * @param {(constraints: MediaStreamConstraints) => Promise<MediaStream>} getUserMedia
 * @param {object} options
 * @param {number} options.rate  the frame rate chosen, 0 for the camera's own
 * @param {object} [options.device]  what picks the camera: {deviceId} or {facingMode}
 * @param {(tried: {width: number, height: number, floor: number}) => void} [options.onTry]
 * @returns {Promise<MediaStream>}
 */
export async function openBestCamera(getUserMedia, { rate = 0, device = {}, onTry } = {}) {
  const ideal = rate || 120;
  for (const floor of floorsFor(rate)) {
    for (const [width, height] of SIZES) {
      onTry?.({ width, height, floor });
      let stream;
      try {
        stream = await getUserMedia({
          video: {
            width: { min: width, ideal: width },
            height: { min: height, ideal: height },
            frameRate: { min: floor, ideal },
            ...device,
          },
        });
      } catch (err) {
        // No such mode: the next one. Anything else (refused, busy, gone) will not change by asking smaller,
        // and neither will a camera that is not there.
        if (err?.name === 'OverconstrainedError' && err.constraint !== 'deviceId') continue;
        throw err;
      }
      // Some drivers say yes to a rate they then do not keep.
      const got = stream.getVideoTracks()[0]?.getSettings?.().frameRate;
      if (got && got < floor * BELIEVED) {
        stream.getTracks().forEach((track) => track.stop());
        continue;
      }
      return stream;
    }
  }
  // Nothing reaches a floor: what the camera does, asked for as before.
  return getUserMedia({
    video: { width: { ideal: SIZES[0][0] }, height: { ideal: SIZES[0][1] }, frameRate: { ideal }, ...device },
  });
}
