// Cropping, zooming and rotating a picture to the shape it is shown in -- and writing the result, still or animated.
//
// A profile picture is shown in a circle and a banner behind a strip, and what is saved is what is inside that shape: the
// picture is moved, zoomed and turned under a mask, and the part of it that is under the mask is what is drawn out at the
// size it is kept in. Nothing about the shape is kept besides that, so every place that draws a picture draws the choice
// without knowing there was one.
//
// A GIF is cut the same way frame by frame and written as a GIF again, with its own timing, so that it keeps moving: a
// canvas could only ever give the first frame. It is decoded with ImageDecoder (WebCodecs), which hands out each frame
// already composed, and written with gifenc (see vendor-src/gifenc.js).
//
// The geometry is plain arithmetic and has no page in it, so the tests can drive it; what draws and encodes is below it.
//
// Everything is in the coordinates of the viewport the picture is edited in: a placement says where the picture's
// centre is (cx, cy), how many times its natural size it is drawn at (s) and how far it is turned (deg, clockwise), and
// the mask says what part of the viewport is kept.

import { GIFEncoder, applyPalette, quantize } from './gifenc.js';

/** What can be edited, and how each is kept: the shape of the mask, the shape it is drawn out in, and the size it must come to. */
export const KINDS = Object.freeze({
  avatar: {
    shape: 'circle',
    /** The mask's width over its height. */
    aspect: 1,
    still: { w: 256, h: 256, maxBytes: 256 * 1024 },
    // An animated one is kept smaller, and has more room: it is every frame.
    gif: { w: 160, h: 160, maxBytes: 1024 * 1024 },
  },
  banner: {
    shape: 'rect',
    // The profile card's banner is about three times as wide as it is tall; the member list shows a strip of the middle.
    aspect: 3,
    still: { w: 960, h: 320, maxBytes: 2 * 1024 * 1024 },
    gif: { w: 720, h: 240, maxBytes: 2 * 1024 * 1024 },
  },
});

/** Behind a picture that does not reach all the way (a cut-out), the colour of the pages it is shown on. */
const BACKGROUND = '#202225';

/** The most a picture is enlarged beyond the size that just covers the mask. */
export const MAX_ZOOM = 8;

const rad = (deg) => (deg * Math.PI) / 180;

// ------------------------------------------------------------------------------------------------------ geometry

/**
 * Half the width and half the height of what the mask covers, seen from the picture's own turned frame: the picture has
 * to reach this far from where it is centred on the mask. A circle looks the same from every side; a rectangle looks
 * wider turned.
 */
export function extents(mask, deg) {
  if (mask.shape === 'circle') return { ex: mask.w / 2, ey: mask.w / 2 };
  const c = Math.abs(Math.cos(rad(deg)));
  const s = Math.abs(Math.sin(rad(deg)));
  return { ex: (mask.w * c + mask.h * s) / 2, ey: (mask.w * s + mask.h * c) / 2 };
}

/** The smallest the picture may be drawn (times its size) and still cover the mask, at this turn. */
export function minScale(iw, ih, mask, deg) {
  const { ex, ey } = extents(mask, deg);
  return Math.max((2 * ex) / iw, (2 * ey) / ih);
}

/** The picture centred on the mask, as small as it may be: all of it that fits, and nothing of the mask empty. */
export function startPlacement(iw, ih, mask) {
  return { s: minScale(iw, ih, mask, 0), cx: mask.x + mask.w / 2, cy: mask.y + mask.h / 2, deg: 0 };
}

/**
 * The same placement, brought to the nearest one that leaves no part of the mask empty: not smaller than covers it, and
 * not moved so far that an edge of the picture comes in.
 */
export function clampPlacement(p, iw, ih, mask) {
  const deg = ((((p.deg + 180) % 360) + 360) % 360) - 180;
  const s = Math.min(Math.max(p.s, minScale(iw, ih, mask, deg)), minScale(iw, ih, mask, deg) * MAX_ZOOM);
  const { ex, ey } = extents(mask, deg);
  const room = { x: Math.max(0, (s * iw) / 2 - ex), y: Math.max(0, (s * ih) / 2 - ey) };
  // The mask's centre in the picture's own frame (centred on the picture, turned with it): that is what may not leave `room`.
  const mx = mask.x + mask.w / 2;
  const my = mask.y + mask.h / 2;
  const cos = Math.cos(rad(deg));
  const sin = Math.sin(rad(deg));
  const dx = mx - p.cx;
  const dy = my - p.cy;
  const qx = Math.min(room.x, Math.max(-room.x, dx * cos + dy * sin));
  const qy = Math.min(room.y, Math.max(-room.y, -dx * sin + dy * cos));
  return { s, deg, cx: mx - (qx * cos - qy * sin), cy: my - (qx * sin + qy * cos) };
}

/** Zoom by `factor` about a point in the viewport, which stays under whatever it was over. */
export function zoomAt(p, factor, point, iw, ih, mask) {
  const s = p.s * factor;
  const k = Math.min(Math.max(s, minScale(iw, ih, mask, p.deg)), minScale(iw, ih, mask, p.deg) * MAX_ZOOM) / p.s;
  return clampPlacement({ ...p, s: p.s * k, cx: point.x - (point.x - p.cx) * k, cy: point.y - (point.y - p.cy) * k }, iw, ih, mask);
}

/** Turn by `delta` degrees about the middle of the mask. */
export function rotateBy(p, delta, iw, ih, mask) {
  const mx = mask.x + mask.w / 2;
  const my = mask.y + mask.h / 2;
  const a = rad(delta);
  const dx = p.cx - mx;
  const dy = p.cy - my;
  return clampPlacement({
    ...p,
    deg: p.deg + delta,
    cx: mx + dx * Math.cos(a) - dy * Math.sin(a),
    cy: my + dx * Math.sin(a) + dy * Math.cos(a),
  }, iw, ih, mask);
}

/** The CSS transform that puts a picture of natural size iw x ih (its top left at the origin) where the placement says. */
export function cssTransform(p, iw, ih) {
  return `translate(${p.cx}px, ${p.cy}px) rotate(${p.deg}deg) scale(${p.s}) translate(${-iw / 2}px, ${-ih / 2}px)`;
}

// ---------------------------------------------------------------------------------------------------- drawing out

/**
 * Draws what is under the mask onto `ctx`, at `out` pixels, from a source of natural size sw x sh -- the picture, or a
 * frame of it. The same transform as cssTransform, with the mask's corner at the origin and scaled up to the output.
 */
export function drawPlacement(ctx, source, sw, sh, p, mask, out) {
  const k = out.w / mask.w;
  ctx.save();
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, out.w, out.h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(k, k);
  ctx.translate(-mask.x, -mask.y);
  ctx.translate(p.cx, p.cy);
  ctx.rotate(rad(p.deg));
  ctx.scale(p.s, p.s);
  ctx.translate(-sw / 2, -sh / 2);
  ctx.drawImage(source, 0, 0);
  ctx.restore();
}

const isGif = (bytes) => bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;

/** Whether this window can take a GIF apart into its frames. */
export const canAnimate = () => typeof ImageDecoder !== 'undefined';

/** What a picked file is: its size as it is shown (turned upright by what the file says), and how many frames it has. */
export async function inspect(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isGif(bytes) && canAnimate()) {
    const decoder = new ImageDecoder({ data: bytes, type: 'image/gif' });
    try {
      await decoder.tracks.ready;
      await decoder.completed;
      const track = decoder.tracks.selectedTrack;
      const { image } = await decoder.decode({ frameIndex: 0 });
      const size = { w: image.displayWidth, h: image.displayHeight };
      image.close();
      return { ...size, frames: track.frameCount, gif: track.frameCount > 1 };
    } finally {
      decoder.close();
    }
  }
  const bitmap = await createImageBitmap(file);
  const size = { w: bitmap.width, h: bitmap.height };
  bitmap.close();
  return { ...size, frames: 1, gif: false };
}

const canvasOf = (w, h) => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  return canvas;
};

/** A still, as a JPEG that fits: tried at a lower quality until it does. */
async function encodeStill(file, p, mask, kind) {
  const { w, h, maxBytes } = KINDS[kind].still;
  const bitmap = await createImageBitmap(file);
  const canvas = canvasOf(w, h);
  drawPlacement(canvas.getContext('2d'), bitmap, bitmap.width, bitmap.height, p, mask, { w: canvas.width, h: canvas.height });
  bitmap.close();
  let blob = null;
  for (const quality of [0.9, 0.8, 0.65, 0.5, 0.35]) {
    blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', quality));
    if (blob && blob.size <= maxBytes) return blob;
  }
  throw Object.assign(new Error('too_detailed'), { code: 'too_detailed' });
}

/** The frames of a GIF under the mask, at this size: [{rgba, delay}], every `skip`th one (its time added to the one kept). */
async function framesOf(bytes, p, mask, w, h, skip) {
  const decoder = new ImageDecoder({ data: bytes, type: 'image/gif' });
  const frames = [];
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    const count = decoder.tracks.selectedTrack.frameCount;
    const canvas = canvasOf(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    for (let i = 0; i < count; i += 1) {
      const { image } = await decoder.decode({ frameIndex: i });
      // A frame with no time given is shown for a tenth of a second, as the browsers do; and nothing is faster than 20 ms.
      const delay = Math.max(20, Math.round((image.duration ?? 100000) / 1000));
      if (i % skip === 0) {
        drawPlacement(ctx, image, image.displayWidth, image.displayHeight, p, mask, { w: canvas.width, h: canvas.height });
        frames.push({ rgba: ctx.getImageData(0, 0, canvas.width, canvas.height).data, delay });
      } else {
        // A frame left out is still the time it was on screen: the one before it is kept longer.
        frames.at(-1).delay += delay;
      }
      image.close();
    }
    return { frames, width: canvas.width, height: canvas.height };
  } finally {
    decoder.close();
  }
}

/** The most frames kept of a long GIF: each is a picture, and they are all held at once while the palette is chosen. */
const MAX_FRAMES = 120;

/** A GIF, cut: smaller and sparser each time it does not fit, until it does. */
async function encodeGif(file, p, mask, kind, onProgress) {
  const { w, h, maxBytes } = KINDS[kind].gif;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const count = (await inspect(file)).frames;
  const base = Math.ceil(count / MAX_FRAMES);
  // From the best to the barest: the size it is drawn at, the colours it keeps, and how many frames are dropped.
  const plans = [
    { size: 1, colors: 256, skip: base },
    { size: 1, colors: 128, skip: base },
    { size: 0.75, colors: 128, skip: base },
    { size: 0.75, colors: 64, skip: base * 2 },
    { size: 0.5, colors: 64, skip: base * 2 },
    { size: 0.5, colors: 32, skip: base * 3 },
  ];
  for (const [attempt, plan] of plans.entries()) {
    onProgress?.(attempt / plans.length);
    const { frames, width, height } = await framesOf(bytes, p, mask, w * plan.size, h * plan.size, plan.skip);
    // One palette for all of it, from a sample of every frame: a palette per frame flickers.
    const sample = [];
    const every = Math.max(1, Math.floor(frames.length / 12));
    for (let i = 0; i < frames.length; i += every) {
      const { rgba } = frames[i];
      for (let j = 0; j < rgba.length; j += 16) sample.push(rgba[j], rgba[j + 1], rgba[j + 2], rgba[j + 3]);
    }
    const palette = quantize(Uint8Array.from(sample), plan.colors, { format: 'rgb565' });
    const gif = GIFEncoder();
    frames.forEach(({ rgba, delay }, i) => {
      gif.writeFrame(applyPalette(rgba, palette, 'rgb565'), width, height, { palette: i === 0 ? palette : null, delay, repeat: 0 });
    });
    gif.finish();
    const blob = new Blob([gif.bytes()], { type: 'image/gif' });
    if (blob.size <= maxBytes) return blob;
  }
  throw Object.assign(new Error('too_detailed'), { code: 'too_detailed' });
}

/**
 * What is under the mask, as the file it is kept as: a GIF that still moves if the picture does, and a JPEG if it does
 * not. Throws an error with the code `too_detailed` when it cannot be made to fit what a server takes.
 *
 * @param {File|Blob} file
 * @param {{s: number, cx: number, cy: number, deg: number}} placement
 * @param {{x: number, y: number, w: number, h: number, shape: string}} mask
 * @param {'avatar'|'banner'} kind
 * @param {{gif: boolean}} source  what `inspect` said of the file
 */
export function cropToBlob(file, placement, mask, kind, source, onProgress) {
  return source.gif && canAnimate()
    ? encodeGif(file, placement, mask, kind, onProgress)
    : encodeStill(file, placement, mask, kind);
}
