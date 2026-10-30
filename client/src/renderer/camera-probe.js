// Is a camera that has just been opened giving us a picture, or only black?
//
// Some webcams, and some drivers, open and deliver black frames: the light is on,
// the track is live and nothing is drawn, and it comes right after the camera is
// turned off and on a few times. What a person does by hand is done here: look at
// what the camera is giving, and when it is only black, say so, so the caller can
// open it again.

/** Mean brightness (0-255) at or under this, and no bright pixel at all, is black. */
const BLACK_MEAN = 3;
const BLACK_PEAK = 24;

/** Whether some RGBA pixels are black: a dark room has noise, a camera that is not working does not. */
export function isBlackFrame(rgba) {
  let sum = 0;
  let peak = 0;
  const pixels = rgba.length / 4;
  if (!pixels) return true;
  for (let i = 0; i < rgba.length; i += 4) {
    const luma = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    sum += luma;
    if (luma > peak) peak = luma;
  }
  return sum / pixels <= BLACK_MEAN && peak <= BLACK_PEAK;
}

/**
 * Watch a stream for a while. Resolves false as soon as a frame has something in
 * it, so a camera that works costs a fraction of a second; true when nothing but
 * black (or no frame at all) arrived in the whole time.
 *
 * @param {MediaStream} stream
 * @param {{ms?: number, every?: number}} [options]
 * @returns {Promise<boolean>} whether it is black
 */
export async function probeBlack(stream, { ms = 2500, every = 250 } = {}) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 18;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  try {
    await video.play().catch(() => {});
    const end = performance.now() + ms;
    while (performance.now() < end) {
      await new Promise((r) => setTimeout(r, every));
      if (!stream.getVideoTracks().some((t) => t.readyState === 'live')) return false; // gone: not a black camera
      if (!video.videoWidth) continue;
      g.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (!isBlackFrame(g.getImageData(0, 0, canvas.width, canvas.height).data)) return false;
    }
    return true;
  } finally {
    video.srcObject = null;
  }
}
