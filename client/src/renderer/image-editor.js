// The window a picture is cropped in before it becomes a profile picture or a banner.
//
// The picture is shown whole, behind a mask that is the shape it will be seen in -- a circle, or the strip of a banner --
// with what is outside the mask dimmed. It is moved by dragging, zoomed by the wheel, a pinch or the slider, and turned
// by the slider and the two quarter-turn buttons; what is left inside the mask is what is kept. An animated GIF is shown
// moving, as it will be. The arithmetic is in image-crop.js; this is only what is on the screen.

import {
  KINDS, MAX_ZOOM, clampPlacement, cropToBlob, cssTransform, inspect, minScale, rotateBy, startPlacement, zoomAt,
} from './image-crop.js';

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * @param {object} options
 * @param {File} options.file
 * @param {'avatar'|'banner'} options.kind
 * @param {(key: string, params?: object) => string} options.t
 * @returns {Promise<Blob|null>}  the cropped picture, ready to upload; null if it was cancelled. Rejects when the file is
 *   not a picture that can be read.
 */
export async function openImageEditor({ file, kind, t }) {
  const config = KINDS[kind];
  const source = await inspect(file).catch(() => null);
  if (!source) throw new Error(t('app.could_not_read_that_image'));
  const { w: iw, h: ih } = source;

  // The viewport is a little larger than the mask, so that what is just outside it can be seen, dimmed.
  const stageW = Math.min(kind === 'banner' ? 380 : 320, Math.max(220, window.innerWidth - 56));
  const maskW = Math.round(stageW * (kind === 'banner' ? 0.86 : 0.72));
  const maskH = Math.round(maskW / config.aspect);
  const stageH = Math.round(maskH + (kind === 'banner' ? 70 : (stageW - maskW)));
  const mask = { x: Math.round((stageW - maskW) / 2), y: Math.round((stageH - maskH) / 2), w: maskW, h: maskH, shape: config.shape };

  let placement = startPlacement(iw, ih, mask);

  const dialog = make('dialog', 'image-editor');
  dialog.setAttribute('aria-labelledby', 'ie-title');
  const form = make('form', 'image-editor-form');
  form.method = 'dialog';

  const title = make('h3', '', t(kind === 'banner' ? 'image_editor.title_banner' : 'image_editor.title_avatar'));
  title.id = 'ie-title';
  const hint = make('p', 'muted ie-hint', t(kind === 'banner' ? 'image_editor.hint_banner' : 'image_editor.hint'));

  // The stage: the picture, and over it the mask.
  const stage = make('div', 'ie-stage');
  stage.tabIndex = 0;
  stage.style.width = `${stageW}px`;
  stage.style.height = `${stageH}px`;
  const objectUrl = URL.createObjectURL(file);
  const image = make('img', 'ie-image');
  image.alt = '';
  image.draggable = false;
  image.style.width = `${iw}px`;
  image.style.height = `${ih}px`;
  image.src = objectUrl;
  const outline = make('div', 'ie-mask');
  outline.dataset.shape = config.shape;
  outline.style.left = `${mask.x}px`;
  outline.style.top = `${mask.y}px`;
  outline.style.width = `${mask.w}px`;
  outline.style.height = `${mask.h}px`;
  stage.append(image, outline);
  if (kind === 'banner') {
    // What the member list shows of a banner: the middle strip. Dashed, so it is not mistaken for the edge.
    const strip = make('div', 'ie-strip');
    strip.style.left = `${mask.x}px`;
    strip.style.width = `${mask.w}px`;
    strip.style.top = `${mask.y + mask.h / 4}px`;
    strip.style.height = `${mask.h / 2}px`;
    stage.append(strip);
  }

  // The controls: zoom and turn, each a slider, and the quarter turns and the start over beside them.
  const slider = (name, min, max, step) => {
    const input = make('input', `ie-${name}`);
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute('aria-label', t(`image_editor.${name}`));
    return input;
  };
  const zoom = slider('zoom', 0, 100, 0.5);
  const turn = slider('rotate', -180, 180, 1);
  const row = (label, input, ...more) => {
    const line = make('label', 'ie-row');
    line.append(make('span', 'ie-label', label), input, ...more);
    return line;
  };
  const iconButton = (icon, label, run) => {
    const b = make('button', 'ghost small icon-only ie-tool');
    b.type = 'button';
    b.dataset.icon = icon;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', run);
    return b;
  };

  const note = make('p', 'error ie-note');
  note.hidden = true;

  const cancel = make('button', 'ghost ie-cancel', t('image_editor.cancel'));
  cancel.type = 'button';
  const save = make('button', 'primary ie-save', t('image_editor.save'));
  save.type = 'submit';
  const reset = make('button', 'ghost small ie-reset', t('image_editor.reset'));
  reset.type = 'button';
  const foot = make('div', 'ie-foot');
  foot.append(reset, make('span', 'ie-spacer'), cancel, save);

  const turnLeft = iconButton('arrow-counter-clockwise', t('image_editor.rotate_left'), () => place(rotateBy(placement, -90, iw, ih, mask)));
  const turnRight = iconButton('arrow-clockwise', t('image_editor.rotate_right'), () => place(rotateBy(placement, 90, iw, ih, mask)));
  form.append(
    title, hint, stage,
    row(t('image_editor.zoom'), zoom),
    row(t('image_editor.rotate'), turn, turnLeft, turnRight),
    note, foot,
  );
  dialog.append(form);

  /** Draws the picture where the placement says, and the sliders where it is. */
  function place(next) {
    placement = clampPlacement(next, iw, ih, mask);
    image.style.transform = cssTransform(placement, iw, ih);
    const low = minScale(iw, ih, mask, placement.deg);
    zoom.value = String((100 * Math.log(placement.s / low)) / Math.log(MAX_ZOOM));
    turn.value = String(Math.round(placement.deg));
  }
  place(placement);

  // --- the hand: one finger or the mouse moves it, two fingers zoom it, the wheel zooms it
  const pointers = new Map();
  let pinch = null;
  const at = (event) => {
    const box = stage.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  stage.addEventListener('pointerdown', (event) => {
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, at(event));
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), placement };
    }
    stage.focus();
  });
  stage.addEventListener('pointermove', (event) => {
    const before = pointers.get(event.pointerId);
    if (!before) return;
    const now = at(event);
    pointers.set(event.pointerId, now);
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.distance > 0) {
        place(zoomAt(pinch.placement, distance / pinch.distance, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, iw, ih, mask));
      }
    } else if (pointers.size === 1) {
      place({ ...placement, cx: placement.cx + now.x - before.x, cy: placement.cy + now.y - before.y });
    }
  });
  const lift = (event) => {
    pointers.delete(event.pointerId);
    pinch = null;
  };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);
  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    place(zoomAt(placement, Math.exp(-event.deltaY * 0.0015), at(event), iw, ih, mask));
  }, { passive: false });
  // The keys: arrows move it, plus and minus zoom it.
  stage.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 24 : 6;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[event.key]) {
      event.preventDefault();
      place({ ...placement, cx: placement.cx + moves[event.key][0], cy: placement.cy + moves[event.key][1] });
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      place(zoomAt(placement, 1.1, { x: mask.x + mask.w / 2, y: mask.y + mask.h / 2 }, iw, ih, mask));
    } else if (event.key === '-') {
      event.preventDefault();
      place(zoomAt(placement, 1 / 1.1, { x: mask.x + mask.w / 2, y: mask.y + mask.h / 2 }, iw, ih, mask));
    }
  });

  // --- the sliders
  zoom.addEventListener('input', () => {
    const low = minScale(iw, ih, mask, placement.deg);
    const s = low * MAX_ZOOM ** (Number(zoom.value) / 100);
    place(zoomAt(placement, s / placement.s, { x: mask.x + mask.w / 2, y: mask.y + mask.h / 2 }, iw, ih, mask));
  });
  turn.addEventListener('input', () => place(rotateBy(placement, Number(turn.value) - placement.deg, iw, ih, mask)));
  reset.addEventListener('click', () => place(startPlacement(iw, ih, mask)));

  // --- done
  return new Promise((resolve) => {
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      URL.revokeObjectURL(objectUrl);
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      note.hidden = true;
      save.disabled = true;
      cancel.disabled = true;
      save.textContent = t('image_editor.saving');
      try {
        const blob = await cropToBlob(file, placement, mask, kind, source);
        finish(blob);
      } catch (err) {
        // Stays open: it can be zoomed in on a smaller part and tried again.
        note.textContent = err.code === 'too_detailed' ? t('app.that_picture_is_too_detailed') : t('app.could_not_read_that_image');
        note.hidden = false;
        save.disabled = false;
        cancel.disabled = false;
        save.textContent = t('image_editor.save');
      }
    });
    document.body.append(dialog);
    dialog.showModal();
    stage.focus();
  });
}
