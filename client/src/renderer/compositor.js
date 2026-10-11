// Composite sharing: several sources, arranged, as ONE stream.
//
// Screens, windows and cameras are each captured on their own and drawn,
// every frame, onto one canvas at the place and size the broadcaster chose.
// The canvas's captured track is what gets published -- so to the server and
// to every viewer this is an ordinary stream, and nothing outside this file
// and the picker knows it is a composition.
//
// Every change -- a source moved, resized, cropped, added or removed -- is
// just a change to what is drawn, so it is on viewers' screens on the next
// frame. Nothing is renegotiated, which matters: MediaMTX's WHIP cannot.
//
// Layout is kept in canvas-relative units (0..1), so changing the output
// resolution keeps the arrangement. A crop is a fraction trimmed off each
// side of the source, so it survives the source changing size.

const MIN_VISIBLE = 0.05; // a crop never leaves less than 5% of a side
const SNAP = 0.012;       // how close to an edge counts as "on" it

let nextId = 1;

/**
 * Capture one source as a video track.
 *
 * Screens and windows through getUserMedia's desktop source rather than
 * getDisplayMedia: getDisplayMedia goes through main's one pending source,
 * so it can only open one at a time, and a composition holds several open
 * together.
 */
async function captureSource(source, { maxWidth, maxHeight, fps }) {
  if (source.kind === 'camera') {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: { exact: source.id },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: Math.min(fps, 30) },
      },
    });
    return stream;
  }
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: source.id,
        maxWidth,
        maxHeight,
        maxFrameRate: fps,
      },
    },
  });
}

export class Compositor {
  /**
   * @param {{ width: number, height: number, fps: number }} options
   *   the OUTPUT size and rate -- what viewers receive.
   */
  constructor({ width, height, fps }) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.className = 'composer-canvas';
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.ctx.imageSmoothingQuality = 'high';
    /** Bottom first: drawn in order, so the last is on top. */
    this.layers = [];
    this.listeners = new Set();
    this.destroyed = false;

    /*
     * captureStream(0): no automatic frames. Each tick asks for exactly one
     * (requestFrame), so frames go out at the chosen rate whether or not the
     * window is on screen -- a canvas that only produced frames when it was
     * painted would freeze the stream the moment Harmony was minimized,
     * which is exactly when somebody sharing a game minimizes it.
     */
    this.stream = this.canvas.captureStream(0);
    this.track = this.stream.getVideoTracks()[0];
    this.timer = setInterval(() => this.#tick(), Math.round(1000 / fps));
    this.#tick();
  }

  /** Called with no arguments whenever the layers change. */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #changed() {
    for (const fn of this.listeners) fn();
  }

  #tick() {
    if (this.destroyed) return;
    const { ctx, width, height } = this;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    for (const layer of this.layers) {
      const frame = layer.frame;
      const sw = layer.srcW;
      const sh = layer.srcH;
      if (!frame || !sw || !sh) continue;
      const { l, t, r, b } = layer.crop;
      try {
        ctx.drawImage(
          frame,
          sw * l, sh * t, sw * (1 - l - r), sh * (1 - t - b),
          layer.x * width, layer.y * height, layer.w * width, layer.h * height,
        );
      } catch {
        // A frame closed under us, or a source mid-resize. Next tick.
      }
    }
    this.track.requestFrame?.();
  }

  /** The source's own pixel size, as last seen. */
  #readFrames(layer) {
    // MediaStreamTrackProcessor hands over decoded frames directly, with no
    // <video> element in between to be paused or throttled when the window
    // is hidden. Only the newest frame is kept; the rest are closed at once.
    const processor = new MediaStreamTrackProcessor({ track: layer.track });
    const reader = processor.readable.getReader();
    layer.reader = reader;
    const pump = async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done || this.destroyed || layer.removed) {
          value?.close();
          break;
        }
        const first = !layer.srcW;
        layer.frame?.close();
        layer.frame = value;
        layer.srcW = value.displayWidth;
        layer.srcH = value.displayHeight;
        if (first) {
          this.#place(layer);
          this.#changed();
        }
      }
    };
    pump();
  }

  /** Where a new source goes, once its size is known. */
  #place(layer) {
    const aspect = (layer.srcW / layer.srcH) * (this.height / this.width);
    const others = this.layers.filter((l) => l !== layer && !l.removed);
    let w;
    if (!others.length) {
      // The first one fills the canvas, letterboxed.
      w = Math.min(1, aspect);
    } else if (layer.source.kind === 'camera') {
      w = 0.25;
    } else {
      w = 0.5;
    }
    const h = w / aspect;
    if (!others.length) {
      layer.x = (1 - w) / 2;
      layer.y = (1 - h) / 2;
    } else if (layer.source.kind === 'camera') {
      // A camera goes in the corner, like every stream overlay ever made.
      layer.x = 1 - w - 0.02;
      layer.y = 1 - h - 0.03;
    } else {
      const step = (others.length % 5) * 0.04;
      layer.x = 0.1 + step;
      layer.y = 0.1 + step;
    }
    layer.w = w;
    layer.h = h;
  }

  /** Capture a source and put it on top. Resolves with the new layer. */
  async addLayer(source) {
    const stream = await captureSource(source, {
      maxWidth: Math.max(this.width, 1920),
      maxHeight: Math.max(this.height, 1080),
      fps: this.fps,
    });
    if (this.destroyed) {
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }
    const track = stream.getVideoTracks()[0];
    const layer = {
      id: nextId++,
      source,
      stream,
      track,
      frame: null,
      srcW: 0,
      srcH: 0,
      x: 0, y: 0, w: 0, h: 0,
      crop: { l: 0, t: 0, r: 0, b: 0 },
      removed: false,
    };
    // A window that is closed ends its capture: take it off the canvas
    // rather than leave its last frame frozen there.
    track.addEventListener('ended', () => this.removeLayer(layer.id));
    this.layers.push(layer);
    this.#readFrames(layer);
    this.#changed();
    return layer;
  }

  removeLayer(id) {
    const layer = this.layers.find((l) => l.id === id);
    if (!layer) return;
    layer.removed = true;
    this.layers = this.layers.filter((l) => l !== layer);
    layer.reader?.cancel().catch(() => {});
    layer.frame?.close();
    layer.frame = null;
    layer.stream.getTracks().forEach((t) => t.stop());
    this.#changed();
  }

  layer(id) {
    return this.layers.find((l) => l.id === id) ?? null;
  }

  bringToFront(id) {
    const layer = this.layer(id);
    if (!layer) return;
    this.layers = [...this.layers.filter((l) => l !== layer), layer];
    this.#changed();
  }

  sendToBack(id) {
    const layer = this.layer(id);
    if (!layer) return;
    this.layers = [layer, ...this.layers.filter((l) => l !== layer)];
    this.#changed();
  }

  /** The canvas-relative aspect (w/h) the layer's visible part needs. */
  aspectOf(layer) {
    const { l, t, r, b } = layer.crop;
    const visW = layer.srcW * (1 - l - r);
    const visH = layer.srcH * (1 - t - b);
    return (visW / visH) * (this.height / this.width);
  }

  /** As big as fits, centred, aspect kept. */
  fit(id) {
    const layer = this.layer(id);
    if (!layer || !layer.srcW) return;
    const aspect = this.aspectOf(layer);
    let w = 1;
    let h = w / aspect;
    if (h > 1) {
      h = 1;
      w = aspect;
    }
    Object.assign(layer, { w, h, x: (1 - w) / 2, y: (1 - h) / 2 });
    this.#changed();
  }

  /**
   * Cover the whole canvas, aspect kept: whatever does not fit is cropped
   * off evenly on the two long sides.
   */
  fill(id) {
    const layer = this.layer(id);
    if (!layer || !layer.srcW) return;
    const canvasAspect = this.width / this.height;
    const srcAspect = layer.srcW / layer.srcH;
    const crop = { l: 0, t: 0, r: 0, b: 0 };
    if (srcAspect > canvasAspect) {
      const keep = canvasAspect / srcAspect;
      crop.l = crop.r = (1 - keep) / 2;
    } else {
      const keep = srcAspect / canvasAspect;
      crop.t = crop.b = (1 - keep) / 2;
    }
    Object.assign(layer, { crop, x: 0, y: 0, w: 1, h: 1 });
    this.#changed();
  }

  /** One source pixel per canvas pixel, around the same centre. */
  originalSize(id) {
    const layer = this.layer(id);
    if (!layer || !layer.srcW) return;
    const { l, t, r, b } = layer.crop;
    this.#resizeAround(layer,
      (layer.srcW * (1 - l - r)) / this.width,
      (layer.srcH * (1 - t - b)) / this.height);
  }

  /** A share of the canvas's width, aspect kept, around the same centre. */
  scaleTo(id, widthFraction) {
    const layer = this.layer(id);
    if (!layer || !layer.srcW) return;
    const w = widthFraction;
    this.#resizeAround(layer, w, w / this.aspectOf(layer));
  }

  #resizeAround(layer, w, h) {
    const cx = layer.x + layer.w / 2;
    const cy = layer.y + layer.h / 2;
    Object.assign(layer, { w, h, x: cx - w / 2, y: cy - h / 2 });
    this.#changed();
  }

  resetCrop(id) {
    const layer = this.layer(id);
    if (!layer) return;
    // Keep the width; the height follows the restored aspect.
    layer.crop = { l: 0, t: 0, r: 0, b: 0 };
    layer.h = layer.w / this.aspectOf(layer);
    this.#changed();
  }

  /** Topmost layer under a canvas-relative point. */
  hit(x, y) {
    for (let i = this.layers.length - 1; i >= 0; i -= 1) {
      const l = this.layers[i];
      if (x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) return l;
    }
    return null;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.timer);
    for (const layer of [...this.layers]) this.removeLayer(layer.id);
    this.track.stop();
    this.listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------
//
// The live canvas itself, shown over the app, with a selection box drawn in
// DOM ON TOP of it -- never on the canvas, which is what viewers see. Drag a
// source to move it, drag a corner to resize it (aspect kept), and in crop
// mode drag any edge to trim it. Right-click for everything else.

/**
 * @param {Compositor} comp
 * @param {{ listSources: () => Promise<Array<{id,kind,name,thumbnail?}>>,
 *           onError?: (message: string) => void }} options
 * @returns {{ close: () => void }}
 */
export function openCompositionEditor(comp, { listSources, onError = () => {} }) {
  document.querySelector('.composer')?.remove();

  const root = document.createElement('div');
  root.className = 'composer';
  root.innerHTML = `
    <header class="composer-bar">
      <strong>Composition</strong>
      <span class="muted composer-hint">Live as you edit. Drag to move, drag a corner to resize, right-click for more.</span>
      <span class="composer-actions">
        <button type="button" class="ghost small" data-act="add">+ Add source</button>
        <button type="button" class="primary small" data-act="done">Done</button>
      </span>
    </header>
    <div class="composer-stage">
      <div class="composer-frame">
        <div class="composer-empty muted">Right-click to add a screen, window or camera.</div>
        <div class="composer-select" hidden>
          <span class="composer-name"></span>
        </div>
      </div>
    </div>`;
  const frame = root.querySelector('.composer-frame');
  const selectBox = root.querySelector('.composer-select');
  const nameTag = root.querySelector('.composer-name');
  const empty = root.querySelector('.composer-empty');
  frame.style.aspectRatio = `${comp.width} / ${comp.height}`;
  frame.style.setProperty('--ar', String(comp.width / comp.height));
  frame.prepend(comp.canvas);

  for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    const h = document.createElement('span');
    h.className = 'composer-handle';
    h.dataset.handle = handle;
    selectBox.append(h);
  }

  let selected = null;
  let cropping = false;
  /** Free resize: every handle, no aspect lock -- for stretching on purpose. */
  let stretching = false;
  let menu = null;
  let chooser = null;

  function paintSelection() {
    const layer = selected ? comp.layer(selected) : null;
    if (!layer) selected = null;
    empty.hidden = comp.layers.length > 0;
    selectBox.hidden = !layer;
    if (!layer) return;
    Object.assign(selectBox.style, {
      left: `${layer.x * 100}%`,
      top: `${layer.y * 100}%`,
      width: `${layer.w * 100}%`,
      height: `${layer.h * 100}%`,
    });
    selectBox.toggleAttribute('data-crop', cropping);
    selectBox.toggleAttribute('data-stretch', stretching && !cropping);
    nameTag.textContent = cropping
      ? `Cropping ${layer.source.name}`
      : stretching ? `Free resize: ${layer.source.name}` : layer.source.name;
  }

  const offChange = comp.onChange(paintSelection);

  /** Pointer position as canvas-relative units. */
  function point(event) {
    const rect = frame.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  // --- dragging ------------------------------------------------------------

  let drag = null;

  frame.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    closeMenu();
    const p = point(event);
    const handle = event.target.closest?.('.composer-handle')?.dataset.handle;
    let layer = selected ? comp.layer(selected) : null;
    if (!handle) {
      const hit = comp.hit(p.x, p.y);
      if (hit?.id !== selected) { cropping = false; stretching = false; }
      layer = hit;
      selected = hit?.id ?? null;
      paintSelection();
    }
    if (!layer) return;
    drag = {
      mode: handle ? (cropping ? 'crop' : 'resize') : 'move',
      handle,
      start: p,
      orig: { x: layer.x, y: layer.y, w: layer.w, h: layer.h, crop: { ...layer.crop } },
      layer,
    };
    frame.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  frame.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const p = point(event);
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    const { layer, orig } = drag;

    if (drag.mode === 'move') {
      let x = orig.x + dx;
      let y = orig.y + dy;
      // Snap to the canvas edges and centre: putting a camera exactly in the
      // corner is the most common thing anybody does here.
      if (Math.abs(x) < SNAP) x = 0;
      if (Math.abs(x + orig.w - 1) < SNAP) x = 1 - orig.w;
      if (Math.abs(x + orig.w / 2 - 0.5) < SNAP) x = 0.5 - orig.w / 2;
      if (Math.abs(y) < SNAP) y = 0;
      if (Math.abs(y + orig.h - 1) < SNAP) y = 1 - orig.h;
      if (Math.abs(y + orig.h / 2 - 0.5) < SNAP) y = 0.5 - orig.h / 2;
      layer.x = x;
      layer.y = y;
    } else if (drag.mode === 'resize') {
      if (stretching) stretch(layer, orig, drag.handle, dx, dy);
      else resize(layer, orig, drag.handle, dx, dy);
    } else {
      crop(layer, orig, drag.handle, dx, dy);
    }
    paintSelection();
  });

  const endDrag = () => { drag = null; };
  frame.addEventListener('pointerup', endDrag);
  frame.addEventListener('pointercancel', endDrag);

  /** Corners only, aspect kept: a stretched screen helps nobody. */
  function resize(layer, orig, handle, dx, dy) {
    if (!/^(nw|ne|se|sw)$/.test(handle)) return;
    const aspect = orig.w / orig.h;
    const sx = handle.includes('w') ? -1 : 1;
    const sy = handle.includes('n') ? -1 : 1;
    // Follow whichever way the pointer moved further, in width terms.
    const byX = orig.w + sx * dx;
    const byY = (orig.h + sy * dy) * aspect;
    const w = Math.max(0.03, Math.abs(byX - orig.w) > Math.abs(byY - orig.w) ? byX : byY);
    const h = w / aspect;
    layer.w = w;
    layer.h = h;
    layer.x = handle.includes('w') ? orig.x + orig.w - w : orig.x;
    layer.y = handle.includes('n') ? orig.y + orig.h - h : orig.y;
  }

  /** Any handle, any direction: the source is stretched to the box. */
  function stretch(layer, orig, handle, dx, dy) {
    let { x, y, w, h } = orig;
    if (handle.includes('w')) { x = orig.x + dx; w = orig.w - dx; }
    if (handle.includes('e')) w = orig.w + dx;
    if (handle.includes('n')) { y = orig.y + dy; h = orig.h - dy; }
    if (handle.includes('s')) h = orig.h + dy;
    if (w < 0.03 || h < 0.03) return;
    Object.assign(layer, { x, y, w, h });
  }

  /**
   * Trim an edge without rescaling what is left: dragging the left edge in
   * by 10% of the canvas hides exactly that much of the source and moves the
   * edge with it, like cropping a photo in place.
   */
  function crop(layer, orig, handle, dx, dy) {
    const c = { ...orig.crop };
    // Source fraction per canvas unit, from the size at the start.
    const perX = (1 - orig.crop.l - orig.crop.r) / orig.w;
    const perY = (1 - orig.crop.t - orig.crop.b) / orig.h;
    let { x, y, w, h } = orig;
    if (handle.includes('w')) {
      const d = clampCrop(dx * perX, c.l, c.r);
      c.l += d;
      x = orig.x + d / perX;
      w = orig.w - d / perX;
    }
    if (handle.includes('e')) {
      const d = clampCrop(-dx * perX, c.r, c.l);
      c.r += d;
      w = orig.w - d / perX;
    }
    if (handle.includes('n')) {
      const d = clampCrop(dy * perY, c.t, c.b);
      c.t += d;
      y = orig.y + d / perY;
      h = orig.h - d / perY;
    }
    if (handle.includes('s')) {
      const d = clampCrop(-dy * perY, c.b, c.t);
      c.b += d;
      h = orig.h - d / perY;
    }
    Object.assign(layer, { x, y, w, h, crop: c });
  }

  /** How much more of one side may go, keeping MIN_VISIBLE of the source. */
  function clampCrop(delta, side, opposite) {
    const most = 1 - MIN_VISIBLE - opposite - side;
    return Math.min(most, Math.max(-side, delta));
  }

  // --- the right-click menu -----------------------------------------------

  function closeMenu() {
    menu?.remove();
    menu = null;
  }

  function openMenu(event, items) {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'composer-menu';
    for (const item of items) {
      if (item === '-') {
        menu.append(Object.assign(document.createElement('hr'), {}));
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = item.label;
      if (item.danger) b.classList.add('danger-text');
      b.addEventListener('click', () => {
        closeMenu();
        item.run();
      });
      menu.append(b);
    }
    root.append(menu);
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(event.clientX, innerWidth - box.width - 8)}px`;
    menu.style.top = `${Math.min(event.clientY, innerHeight - box.height - 8)}px`;
  }

  frame.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const p = point(event);
    const hit = comp.hit(p.x, p.y);
    if (hit?.id !== selected) { cropping = false; stretching = false; }
    selected = hit?.id ?? null;
    paintSelection();

    const items = [];
    if (hit) {
      const cropped = Object.values(hit.crop).some((v) => v > 0);
      const mode = (crop, stretch) => () => {
        cropping = crop;
        stretching = stretch;
        paintSelection();
      };
      items.push(
        { label: cropping ? 'Finish cropping' : 'Crop', run: mode(!cropping, false) },
        ...(cropped ? [{ label: 'Reset crop', run: () => comp.resetCrop(hit.id) }] : []),
        '-',
        { label: stretching ? 'Finish free resize' : 'Free resize (stretch)', run: mode(false, !stretching) },
        { label: 'Fit to canvas', run: () => comp.fit(hit.id) },
        { label: 'Fill canvas', run: () => comp.fill(hit.id) },
        { label: 'Original size (1:1)', run: () => comp.originalSize(hit.id) },
        { label: 'Size: 75% of the width', run: () => comp.scaleTo(hit.id, 0.75) },
        { label: 'Size: 50% of the width', run: () => comp.scaleTo(hit.id, 0.5) },
        { label: 'Size: 25% of the width', run: () => comp.scaleTo(hit.id, 0.25) },
        '-',
        { label: 'Bring to front', run: () => comp.bringToFront(hit.id) },
        { label: 'Send to back', run: () => comp.sendToBack(hit.id) },
        { label: `Remove ${hit.source.name}`, danger: true, run: () => comp.removeLayer(hit.id) },
        '-',
      );
    }
    items.push({ label: 'Add a screen, window or camera…', run: () => openChooser() });
    openMenu(event, items);
  });

  // --- adding a source ------------------------------------------------------

  async function openChooser() {
    closeChooser();
    chooser = document.createElement('div');
    chooser.className = 'composer-chooser';
    chooser.innerHTML = `
      <header><strong>Add a source</strong>
        <button type="button" class="ghost small" data-act="close">Cancel</button></header>
      <div class="composer-sources"><p class="muted">Looking for sources…</p></div>`;
    root.append(chooser);
    chooser.querySelector('[data-act="close"]').addEventListener('click', closeChooser);
    const grid = chooser.querySelector('.composer-sources');
    let sources = [];
    try {
      sources = await listSources();
    } catch (err) {
      grid.replaceChildren(Object.assign(document.createElement('p'), { textContent: err.message }));
      return;
    }
    if (!chooser) return;
    grid.replaceChildren();
    for (const source of sources) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'source';
      if (source.thumbnail) {
        const img = document.createElement('img');
        img.className = 'thumb';
        img.src = source.thumbnail;
        img.alt = '';
        b.append(img);
      }
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = `${source.kind === 'camera' ? '\u{1F4F7} ' : ''}${source.name}`;
      b.append(label);
      b.addEventListener('click', async () => {
        closeChooser();
        try {
          const layer = await comp.addLayer(source);
          if (layer) {
            selected = layer.id;
            cropping = false;
            paintSelection();
          }
        } catch (err) {
          onError(`Could not add ${source.name}: ${err.message}`);
        }
      });
      grid.append(b);
    }
    if (!sources.length) grid.append(Object.assign(document.createElement('p'), { textContent: 'Nothing to add.' }));
  }

  function closeChooser() {
    chooser?.remove();
    chooser = null;
  }

  // --- keys and closing ------------------------------------------------------

  function onKey(event) {
    if (event.key === 'Escape') {
      if (menu) closeMenu();
      else if (chooser) closeChooser();
      else if (cropping || stretching) { cropping = false; stretching = false; paintSelection(); }
      else close();
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected && !chooser) {
      comp.removeLayer(selected);
    }
  }
  document.addEventListener('keydown', onKey);

  root.addEventListener('pointerdown', (event) => {
    if (menu && !menu.contains(event.target)) closeMenu();
  });
  root.querySelector('[data-act="add"]').addEventListener('click', () => openChooser());
  root.querySelector('[data-act="done"]').addEventListener('click', () => close());

  function close() {
    offChange();
    document.removeEventListener('keydown', onKey);
    // The canvas keeps drawing and streaming detached; only the editor goes.
    comp.canvas.remove();
    root.remove();
  }

  document.body.append(root);
  paintSelection();
  return { close };
}
