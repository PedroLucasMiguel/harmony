// Camera background effects: blur, a colour, a gradient, or a picture that may
// be animated (a GIF).
//
// All of it happens in this window, on this machine. The camera's frames are
// segmented into "person" and "not person" by MediaPipe's ImageSegmenter (a
// 250 KB model and a WebAssembly runtime, both shipped with the app), the
// background is replaced in a WebGL2 shader, and the result is a canvas track
// that is published exactly as the raw camera would have been. The server and
// the media relay only ever see the finished picture; nothing is uploaded and
// nothing is looked up, so it works with no network at all.
//
//   camera track ─► MediaStreamTrackProcessor ─► VideoFrame
//                                                  ├─► segmenter (GPU) ─► person mask
//                                                  └─► texture
//   mask + frame + background ─► one shader ─► canvas ─► captureStream ─► WHIP
//
// Nothing here knows about calls or channels: it takes a MediaStream and gives
// one back. Everything it keeps open -- the camera, the segmenter, the frame
// reader -- is released by stopping the stream it returned, which is what the
// call code already does when a camera ends or is switched.

import { FilesetResolver, ImageSegmenter } from './vendor/@mediapipe/tasks-vision/vision_bundle.mjs';

// Relative, so the same code finds them under harmony://app/ on the desktop and
// beside index.html in the web and Android builds.
const WASM_BASE = 'vendor/@mediapipe/tasks-vision/wasm';
const MODEL = 'models/selfie_segmenter.tflite';

/** Past this, a picture is refused: it is kept in the browser's own storage. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export const BACKGROUND_DEFAULTS = {
  // 'off' | 'blur' | 'color' | 'gradient' | 'image'
  mode: 'off',
  // How much the background is blurred, 0-100.
  blur: 60,
  color: '#1f6feb',
  gradient: { from: '#5b8cff', to: '#9a7bff', angle: 135 },
  // What the stored picture is called, for the settings page. The picture
  // itself is in IndexedDB: a GIF can be megabytes, which has no business
  // in a settings file that is rewritten on every slider.
  imageName: '',
  // The two thresholds the model's soft outline is squeezed between: below the
  // first is background, above the second is person. Not in the settings page.
  edge: [0.4, 0.78],
};

/** Whether this build can do it at all: it needs frame access and WebGL2. */
export function backgroundSupported() {
  if (typeof MediaStreamTrackProcessor === 'undefined') return false;
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The picture, kept between runs
// ---------------------------------------------------------------------------

const DB_NAME = 'harmony-camera-background';
const STORE = 'images';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, run) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Keep one picture (or GIF) as the background. Replaces whatever was there. */
export async function saveBackgroundImage(file) {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`That file is ${(file.size / 1048576).toFixed(0)} MB. The limit is ${MAX_IMAGE_BYTES / 1048576} MB.`);
  }
  // Proves it decodes before it replaces a picture that did.
  const probe = await BackgroundImage.open(file);
  probe.close();
  await withStore('readwrite', (store) => store.put({ blob: file, name: file.name, type: file.type }, 'current'));
  return file.name;
}

/** @returns {Promise<{blob: Blob, name: string, type: string}|null>} */
export async function loadBackgroundImage() {
  try {
    return (await withStore('readonly', (store) => store.get('current'))) ?? null;
  } catch {
    return null;
  }
}

export async function clearBackgroundImage() {
  await withStore('readwrite', (store) => store.delete('current')).catch(() => {});
}

/** A small still of the picture, as a data: URL, for the settings page. */
export async function backgroundThumbnail(blob, width = 160, height = 90) {
  const image = await BackgroundImage.open(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    image.draw(canvas.getContext('2d'), width, height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } finally {
    image.close();
  }
}

// ---------------------------------------------------------------------------
// A picture that may move
// ---------------------------------------------------------------------------

/**
 * A still or an animation, drawn "cover" fashion into whatever size is asked.
 *
 * WebCodecs' ImageDecoder does the decoding, and for anything with more than
 * one frame (GIF, animated WebP, APNG) it is stepped by the frame durations
 * the file carries. Frames are decoded one ahead as they come due and never
 * all at once: a 300-frame GIF held as bitmaps would be hundreds of megabytes.
 */
export class BackgroundImage {
  #decoder = null;
  #bitmap = null;
  #frame = null;
  #count = 1;
  #index = 0;
  #until = 0;
  #pending = false;
  #closed = false;

  static async open(blob) {
    const image = new BackgroundImage();
    await image.#load(blob);
    return image;
  }

  async #load(blob) {
    const type = blob.type || 'image/png';
    if (typeof ImageDecoder !== 'undefined' && (await ImageDecoder.isTypeSupported(type))) {
      this.#decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type });
      await this.#decoder.tracks.ready;
      const track = this.#decoder.tracks.selectedTrack;
      // Frame counts for a GIF are only final once it has been read through.
      await this.#decoder.completed;
      this.#count = track.animated ? Math.max(1, track.frameCount) : 1;
      this.#frame = (await this.#decoder.decode({ frameIndex: 0 })).image;
      this.#until = performance.now() + this.#duration(this.#frame);
      return;
    }
    // No decoder: a still is all a browser will give back.
    this.#bitmap = await createImageBitmap(blob);
  }

  /** A GIF's own delays are often 0 or 10 ms, which browsers treat as 100 ms. */
  #duration(frame) {
    const ms = (frame?.duration ?? 0) / 1000;
    return ms < 20 ? 100 : ms;
  }

  get animated() {
    return this.#count > 1;
  }

  /** Start decoding the next frame if the current one has had its time. See takeChange. */
  tick(now) {
    if (!this.animated || this.#closed || this.#pending || now < this.#until) return;
    this.#pending = true;
    const next = (this.#index + 1) % this.#count;
    this.#decoder.decode({ frameIndex: next }).then(({ image }) => {
      if (this.#closed) {
        image.close();
        return;
      }
      this.#frame?.close();
      this.#frame = image;
      this.#index = next;
      this.#until = performance.now() + this.#duration(image);
      this.#changed = true;
    }).catch(() => {
      // A frame that will not decode: hold the last one rather than stop.
      this.#until = performance.now() + 100;
    }).finally(() => {
      this.#pending = false;
    });
  }

  /** Set when a decode has finished since the last call to takeChange(). */
  #changed = false;

  takeChange() {
    const changed = this.#changed;
    this.#changed = false;
    return changed;
  }

  draw(ctx, width, height) {
    const source = this.#frame ?? this.#bitmap;
    if (!source) return;
    const sw = source.displayWidth ?? source.width;
    const sh = source.displayHeight ?? source.height;
    // Cover: scale until both sides are filled, and crop the overflow evenly.
    const scale = Math.max(width / sw, height / sh);
    const w = sw * scale;
    const h = sh * scale;
    ctx.drawImage(source, (width - w) / 2, (height - h) / 2, w, h);
  }

  close() {
    this.#closed = true;
    this.#frame?.close();
    this.#frame = null;
    this.#bitmap?.close();
    this.#bitmap = null;
    this.#decoder?.close();
    this.#decoder = null;
  }
}

// ---------------------------------------------------------------------------
// The segmenter, shared and counted
// ---------------------------------------------------------------------------

let segmenterPromise = null;
let segmenterUsers = 0;
let preferCpu = false;

async function createSegmenter() {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  const make = (delegate) => ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
  if (!preferCpu) {
    try {
      return { segmenter: await make('GPU'), delegate: 'GPU' };
    } catch (err) {
      console.warn('[background] the GPU segmenter would not start; using the CPU:', err?.message ?? err);
      preferCpu = true;
    }
  }
  return { segmenter: await make('CPU'), delegate: 'CPU' };
}

/** One segmenter however many cameras use it; closed with the last of them. */
function acquireSegmenter() {
  segmenterUsers += 1;
  segmenterPromise ??= createSegmenter().catch((err) => {
    segmenterPromise = null;
    throw err;
  });
  return segmenterPromise;
}

function releaseSegmenter() {
  segmenterUsers = Math.max(0, segmenterUsers - 1);
  if (segmenterUsers > 0 || !segmenterPromise) return;
  const finished = segmenterPromise;
  segmenterPromise = null;
  finished.then(({ segmenter }) => segmenter.close()).catch(() => {});
}

// ---------------------------------------------------------------------------
// The shaders
// ---------------------------------------------------------------------------

/*
 * One triangle covering the screen. The texture coordinate is flipped so that
 * v = 0 is the TOP row of every image, which is the order a video frame, a
 * canvas and a mask all store their rows in -- so no texture needs
 * UNPACK_FLIP_Y, and none can be flipped differently from the others.
 */
const VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** A 9-tap Gaussian along one axis. Run twice, once for each. */
const BLUR = `#version 300 es
precision mediump float;
uniform sampler2D uImage;
uniform vec2 uStep;
in vec2 vUv;
out vec4 o;
void main() {
  vec3 c = texture(uImage, vUv).rgb * 0.2270270270;
  c += texture(uImage, vUv + uStep * 1.3846153846).rgb * 0.3162162162;
  c += texture(uImage, vUv - uStep * 1.3846153846).rgb * 0.3162162162;
  c += texture(uImage, vUv + uStep * 3.2307692308).rgb * 0.0702702703;
  c += texture(uImage, vUv - uStep * 3.2307692308).rgb * 0.0702702703;
  o = vec4(c, 1.0);
}`;

const COMPOSITE = `#version 300 es
precision mediump float;
uniform sampler2D uVideo;
uniform sampler2D uMask;
uniform sampler2D uBackground;
uniform sampler2D uBlurred;
uniform int uUseBlur;
uniform vec2 uEdge;
in vec2 vUv;
out vec4 o;
void main() {
  vec3 person = texture(uVideo, vUv).rgb;
  // The model's output is soft at the outline. Squeezing it between two
  // thresholds keeps a short, smooth edge instead of a halo of the old room.
  float m = smoothstep(uEdge.x, uEdge.y, texture(uMask, vUv).r);
  vec3 behind = uUseBlur == 1 ? texture(uBlurred, vUv).rgb : texture(uBackground, vUv).rgb;
  o = vec4(mix(behind, person, m), 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function program(gl, fragment) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
  return p;
}

function texture(gl, { filter = gl.LINEAR } = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

// ---------------------------------------------------------------------------
// The effect
// ---------------------------------------------------------------------------

/** How much of the new mask is let in each frame; the rest is the last one. */
const MASK_SMOOTHING = 0.65;
/** Above this many ms per segmentation, every other frame reuses the last mask. */
const SLOW_SEGMENT_MS = 28;

export class BackgroundEffect {
  #raw;
  #track;
  #canvas = document.createElement('canvas');
  #bg = document.createElement('canvas');
  #bgCtx = this.#bg.getContext('2d');
  #gl = null;
  #programs = {};
  #tex = {};
  #fbo = {};
  #size = { w: 0, h: 0 };
  #segmenter = null;
  #personIndex = 0;
  #options = { ...BACKGROUND_DEFAULTS };
  #image = null;
  #imageBlob = null;
  #bgDirty = true;
  #mask = null;
  #maskSize = { w: 0, h: 0 };
  #stopped = false;
  #out = null;
  #stopOutput = null;
  #frames = 0;
  #skip = false;
  #segMs = 0;
  #reader = null;
  delegate = 'GPU';
  /** Called once when the effect has ended, however that came about. */
  onStop = null;

  /**
   * @param {MediaStream} raw  the camera; this takes it over and stops it with the result
   * @param {object} options   see BACKGROUND_DEFAULTS
   * @param {Blob|null} image  the picture, when options.mode is 'image'
   */
  static async create(raw, options, image = null) {
    const effect = new BackgroundEffect(raw);
    try {
      await effect.#init();
      await effect.update(options, image);
      effect.#run();
    } catch (err) {
      // The camera is still the caller's: it falls back to it, so it must be alive.
      effect.stop({ keepSource: true });
      throw err;
    }
    return effect;
  }

  constructor(raw) {
    this.#raw = raw;
    this.#track = raw.getVideoTracks()[0];
    if (!this.#track) throw new Error('The camera has no video to work on.');
  }

  /** The processed camera: hand it to whatever would have taken the raw one. */
  get stream() {
    return this.#out;
  }

  get canvas() {
    return this.#canvas;
  }

  get options() {
    return this.#options;
  }

  get stats() {
    return { frames: this.#frames, segmentMs: Number(this.#segMs.toFixed(1)), delegate: this.delegate };
  }

  async #init() {
    const gl = this.#canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      // captureStream snapshots the canvas after the draw call returns.
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 is not available.');
    this.#gl = gl;
    this.#programs = {
      blur: program(gl, BLUR),
      composite: program(gl, COMPOSITE),
    };
    this.#tex = {
      video: texture(gl),
      mask: texture(gl),
      background: texture(gl),
      blurA: texture(gl),
      blurB: texture(gl),
    };
    this.#fbo = { a: gl.createFramebuffer(), b: gl.createFramebuffer() };
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.#openMask();

    const { segmenter, delegate } = await acquireSegmenter();
    this.#segmenter = segmenter;
    this.delegate = delegate;
    // "person" is not always the first mask the model reports.
    const labels = segmenter.getLabels?.() ?? [];
    const person = labels.findIndex((label) => /person|foreground|selfie/i.test(label));
    this.#personIndex = person >= 0 ? person : 0;

    const settings = this.#track.getSettings();
    this.#resize(settings.width || 640, settings.height || 360);

    // The processed track. Frames are requested one at a time, as each is
    // finished, so the rate is the camera's and not a timer's.
    const stream = this.#canvas.captureStream(0);
    const out = stream.getVideoTracks()[0];
    this.#stopOutput = out.stop.bind(out);
    // Whoever owns the track stops it to let go of the camera -- the call code
    // does exactly that on a switch or a hang-up -- and the camera here is not
    // theirs to see. So stopping the result stops everything behind it.
    out.stop = () => this.stop();
    // The rest of the app asks the camera track which device it is, and which
    // way it faces, to switch and flip it. A canvas track knows neither, so it
    // answers with the camera's own.
    const ownSettings = out.getSettings.bind(out);
    out.getSettings = () => {
      const camera = this.#track.getSettings();
      return {
        ...ownSettings(),
        ...(camera.deviceId ? { deviceId: camera.deviceId } : {}),
        ...(camera.groupId ? { groupId: camera.groupId } : {}),
        ...(camera.facingMode ? { facingMode: camera.facingMode } : {}),
      };
    };
    this.#out = stream;
  }

  #resize(w, h) {
    const gl = this.#gl;
    this.#size = { w, h };
    this.#canvas.width = w;
    this.#canvas.height = h;
    this.#bg.width = w;
    this.#bg.height = h;
    this.#bgDirty = true;
    // The blur works on a quarter-size copy. It is a sixteenth of the pixels,
    // and small steps between taps at that size reach as far as big ones at
    // full size without the banding that sparse taps leave.
    const hw = Math.max(2, w >> 2);
    const hh = Math.max(2, h >> 2);
    for (const [name, fbo] of [['blurA', this.#fbo.a], ['blurB', this.#fbo.b]]) {
      gl.bindTexture(gl.TEXTURE_2D, this.#tex[name]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, hw, hh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.#tex[name], 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.#half = { w: hw, h: hh };
    this.#openMask();
  }

  /**
   * Until the first mask arrives everything counts as the person, so the first
   * frames are the plain camera rather than a flash of background.
   */
  #openMask() {
    const gl = this.#gl;
    this.#mask = null;
    gl.bindTexture(gl.TEXTURE_2D, this.#tex.mask);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
  }

  #half = { w: 2, h: 2 };

  /**
   * Change what is behind the person, live: no restart, no gap in the video.
   * @param {object} options
   * @param {Blob|null} image  required once when the mode becomes 'image'
   */
  async update(options, image = null) {
    this.#options = { ...BACKGROUND_DEFAULTS, ...options, gradient: { ...BACKGROUND_DEFAULTS.gradient, ...options?.gradient } };
    if (this.#options.mode === 'image' && image && image !== this.#imageBlob) {
      const next = await BackgroundImage.open(image);
      this.#image?.close();
      this.#image = next;
      this.#imageBlob = image;
    }
    this.#bgDirty = true;
  }

  #paintBackground() {
    const { w, h } = this.#size;
    const ctx = this.#bgCtx;
    const { mode, color, gradient } = this.#options;
    if (mode === 'gradient') {
      // CSS's convention: 0deg points up, 90deg to the right.
      const a = (gradient.angle * Math.PI) / 180;
      const dx = Math.sin(a);
      const dy = -Math.cos(a);
      const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
      const fill = ctx.createLinearGradient(w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half);
      fill.addColorStop(0, gradient.from);
      fill.addColorStop(1, gradient.to);
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, w, h);
    } else if (mode === 'image' && this.#image) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      this.#image.draw(ctx, w, h);
    } else {
      ctx.fillStyle = mode === 'color' ? color : '#101319';
      ctx.fillRect(0, 0, w, h);
    }
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, this.#tex.background);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.#bg);
    this.#bgDirty = false;
  }

  /** Read the camera one frame at a time, until it or we are done. */
  async #run() {
    const processor = new MediaStreamTrackProcessor({ track: this.#track });
    this.#reader = processor.readable.getReader();
    for (;;) {
      let result;
      try {
        result = await this.#reader.read();
      } catch {
        break;
      }
      if (result.done || this.#stopped) {
        result.value?.close();
        break;
      }
      const frame = result.value;
      try {
        this.#render(frame);
      } catch (err) {
        console.warn('[background] a frame failed:', err?.message ?? err);
        // A segmenter that dies on the GPU is worth one retry on the CPU, once.
        if (this.delegate === 'GPU' && !preferCpu) await this.#fallBackToCpu();
      } finally {
        frame.close();
      }
    }
  }

  async #fallBackToCpu() {
    preferCpu = true;
    releaseSegmenter();
    const { segmenter, delegate } = await acquireSegmenter();
    this.#segmenter = segmenter;
    this.delegate = delegate;
  }

  #render(frame) {
    const gl = this.#gl;
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (w !== this.#size.w || h !== this.#size.h) this.#resize(w, h);

    gl.bindTexture(gl.TEXTURE_2D, this.#tex.video);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);

    this.#segment(frame);

    const animated = this.#options.mode === 'image' && this.#image;
    if (animated) {
      this.#image.tick(performance.now());
      if (this.#image.takeChange()) this.#bgDirty = true;
    }
    if (this.#bgDirty && this.#options.mode !== 'blur') this.#paintBackground();

    const blur = this.#options.mode === 'blur';
    if (blur) this.#blurPasses();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    const p = this.#programs.composite;
    gl.useProgram(p);
    this.#bind(p, 'uVideo', 0, this.#tex.video);
    this.#bind(p, 'uMask', 1, this.#tex.mask);
    this.#bind(p, 'uBackground', 2, this.#tex.background);
    this.#bind(p, 'uBlurred', 3, this.#tex.blurB);
    gl.uniform1i(gl.getUniformLocation(p, 'uUseBlur'), blur ? 1 : 0);
    gl.uniform2f(gl.getUniformLocation(p, 'uEdge'), this.#options.edge[0], this.#options.edge[1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.#out.getVideoTracks()[0].requestFrame?.();
    this.#frames += 1;
  }

  #bind(p, name, unit, tex) {
    const gl = this.#gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(p, name), unit);
  }

  /** Blur the whole camera frame, at a quarter of its size, twice over. */
  #blurPasses() {
    const gl = this.#gl;
    const { w: hw, h: hh } = this.#half;
    const strength = Math.min(1, Math.max(0, this.#options.blur / 100));
    // Texels between taps, at the small size: gentle at the bottom of the
    // slider and wide at the top, never so wide that the taps show.
    const reach = 0.7 + strength * 2.3;
    const p = this.#programs.blur;
    gl.useProgram(p);
    gl.viewport(0, 0, hw, hh);
    let source = this.#tex.video;
    for (let i = 0; i < 2; i += 1) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo.a);
      this.#bind(p, 'uImage', 0, source);
      gl.uniform2f(gl.getUniformLocation(p, 'uStep'), reach / hw, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo.b);
      this.#bind(p, 'uImage', 0, this.#tex.blurA);
      gl.uniform2f(gl.getUniformLocation(p, 'uStep'), 0, reach / hh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      source = this.#tex.blurB;
    }
  }

  /** Find the person in this frame, and keep the answer steady from one frame to the next. */
  #segment(frame) {
    // Falling behind: segment every other frame and reuse the mask between.
    // A slightly stale outline is better than a slideshow.
    if (this.#segMs > SLOW_SEGMENT_MS) {
      this.#skip = !this.#skip;
      if (this.#skip && this.#mask) return;
    }
    const started = performance.now();
    this.#segmenter.segmentForVideo(frame, started, (result) => {
      const mask = result.confidenceMasks?.[this.#personIndex] ?? result.confidenceMasks?.[0];
      if (!mask) return;
      const w = mask.width;
      const h = mask.height;
      const values = mask.getAsFloat32Array();

      if (!this.#mask || this.#maskSize.w !== w || this.#maskSize.h !== h) {
        this.#mask = new Uint8Array(w * h);
        this.#maskSize = { w, h };
        // The first mask is taken as it is, with nothing before it to blend.
        for (let i = 0; i < values.length; i += 1) this.#mask[i] = Math.round(values[i] * 255);
      } else {
        const keep = 1 - MASK_SMOOTHING;
        for (let i = 0; i < values.length; i += 1) {
          this.#mask[i] = Math.round(this.#mask[i] * keep + values[i] * 255 * MASK_SMOOTHING);
        }
      }
      const gl = this.#gl;
      gl.bindTexture(gl.TEXTURE_2D, this.#tex.mask);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, this.#mask);
    });
    const took = performance.now() - started;
    this.#segMs = this.#segMs ? this.#segMs * 0.9 + took * 0.1 : took;
  }

  /**
   * Release the camera, the frame reader and the segmenter. Safe to call twice.
   * @param {{keepSource?: boolean}} options  leave the camera running
   */
  stop({ keepSource = false } = {}) {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#reader?.cancel().catch(() => {});
    if (!keepSource) this.#raw.getTracks().forEach((track) => track.stop());
    // The original stop, not the override that calls back into here.
    this.#stopOutput?.();
    this.#image?.close();
    this.#image = null;
    if (this.#segmenter) {
      this.#segmenter = null;
      releaseSegmenter();
    }
    const gl = this.#gl;
    if (gl) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      this.#gl = null;
    }
    this.onStop?.();
  }
}
