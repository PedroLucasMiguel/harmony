// How every slider in the app is moved besides dragging it: with the mouse wheel, and -- for the volumes -- by typing the
// number.
//
//   The wheel     any range input, wherever it is (the settings, a stream's tile, the soundpad, a person's menu), moves one
//                 notch of the wheel at a time while the pointer is over it, and the page does not scroll as it does.
//                 Shift is the fine one: one step.
//   Exact values  a volume's "135%" is pressed to become a box to type in; Enter keeps it, Escape or leaving it empty puts
//                 it back. A number past either end is the end.
//
// Done once for the document, not for each slider: the sliders on a stream's tile and in a person's menu are made and
// thrown away as people come and go, and what is delegated reaches the next one with nothing to wire.

/** The sliders that are volumes, as a selector: the ones whose number can be typed. */
export const VOLUME_SLIDERS = [
  '#volume', '#mosaic-volume', '#soundpad-volume', '#master-volume', '#sound-volume', '#music-volume', '#mic-gain', '#audio-menu-volume', '.peer-volume', '.tile-volume',
].join(', ');

/** What a volume's number is drawn in, by what it can be: the little labels beside the sliders. */
const LABELS = '.volume-value, .peer-volume-label, .tile-volume-label, .value-pill';

/** How many notches of the wheel cross a slider's whole length, at the usual pace. */
const NOTCHES = 40;

/** How long after the last notch the slider is said to have been let go (`change`), as it is when a drag ends. */
const SETTLE_MS = 250;

/** A slider's range as it is, with what a range input has when it says nothing: 0 to 100, a step of 1. */
const rangeOf = (slider) => {
  const num = (text, fallback) => (text !== '' && Number.isFinite(Number(text)) ? Number(text) : fallback);
  const min = num(slider.min, 0);
  const max = num(slider.max, 100);
  const step = Number(slider.step) > 0 ? Number(slider.step) : slider.step === 'any' ? (max - min) / 100 || 1 : 1;
  return { min, max, step };
};
const stepOf = (slider) => rangeOf(slider).step;

/** The notch for a slider: a fortieth of its length, in whole steps (and at least one). */
export function notchOf(slider) {
  const { min, max, step } = rangeOf(slider);
  const length = max - min;
  return Math.max(1, Math.round(length / NOTCHES / step)) * step;
}

/** Sets a slider's value as if it had been moved by hand: `input` at once, `change` when it has settled. */
const settling = new WeakMap();
export function moveSlider(slider, value) {
  const { min, max, step } = rangeOf(slider);
  const snapped = Math.round((Math.min(max, Math.max(min, value)) - min) / step) * step + min;
  const next = Math.min(max, Math.max(min, +snapped.toFixed(6)));
  if (Number(slider.value) === next) return false;
  slider.value = String(next);
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  clearTimeout(settling.get(slider));
  settling.set(slider, setTimeout(() => slider.dispatchEvent(new Event('change', { bubbles: true })), SETTLE_MS));
  return true;
}

/** The slider a label belongs to: the one it is `for`, or the one beside it. */
function sliderOf(label) {
  const named = label.getAttribute('for') ? document.getElementById(label.getAttribute('for')) : null;
  if (named?.matches?.('input[type="range"]')) return named;
  for (let node = label.previousElementSibling; node; node = node.previousElementSibling) {
    if (node.matches?.('input[type="range"]')) return node;
  }
  return label.parentElement?.querySelector?.('input[type="range"]') ?? null;
}

/**
 * @param {object} options
 * @param {(key: string) => string} options.t  translate
 */
export function installSliderInput({ t }) {
  // --- the wheel
  /** What a trackpad has turned that is not yet a whole step: it is kept, so a slow slide adds up. */
  const carried = new WeakMap();
  /** Kept only while the wheel is still turning, and the same way: a turn long ago, or the other way, is not owed. */
  const CARRY_MS = 300;
  document.addEventListener('wheel', (event) => {
    const slider = event.target?.closest?.('input[type="range"]');
    if (!slider || slider.disabled || event.defaultPrevented || event.ctrlKey) return;
    // Shift turns a wheel sideways in most places: either way it is the turn that counts.
    const turn = event.deltaY || event.deltaX;
    if (!turn) return;
    event.preventDefault();
    // A line is a notch; a pixel is a fraction of one; a page is several.
    const notches = event.deltaMode === 1 ? turn : event.deltaMode === 2 ? turn * 10 : turn / 100;
    const unit = event.shiftKey ? stepOf(slider) : notchOf(slider);
    const step = stepOf(slider);
    const before = carried.get(slider);
    const kept = before && event.timeStamp - before.at < CARRY_MS && Math.sign(before.owed) === Math.sign(-notches) ? before.owed : 0;
    const owed = kept - notches * unit;
    const whole = Math.trunc(owed / step);
    carried.set(slider, { owed: owed - whole * step, at: event.timeStamp });
    if (whole) moveSlider(slider, Number(slider.value) + whole * step);
  }, { passive: false });

  // --- the numbers
  document.addEventListener('pointerover', (event) => {
    const label = event.target?.closest?.(LABELS);
    if (!label || label.dataset.exact !== undefined) return;
    const slider = sliderOf(label);
    if (!slider?.matches(VOLUME_SLIDERS)) return;
    label.dataset.exact = '';
  });
  // A label that is a button for typing in, by the keyboard too.
  document.addEventListener('click', (event) => {
    const label = event.target?.closest?.(LABELS);
    if (!label || label.dataset.exact === undefined || label.hidden) return;
    const slider = sliderOf(label);
    if (!slider || slider.disabled) return;
    event.stopPropagation();
    edit(slider, label);
  }, true);

  function edit(slider, label) {
    // A number typed is the number kept, not the nearest one a step of five lands on.
    if (stepOf(slider) !== 1) slider.step = '1';
    const box = document.createElement('span');
    box.className = 'volume-exact-wrap';
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'volume-exact';
    input.min = slider.min;
    input.max = slider.max;
    input.step = '1';
    input.value = slider.value;
    input.setAttribute('aria-label', t('volume.exact'));
    input.title = t('volume.exact_hint', { max: slider.max });
    box.append(input, '%');
    label.hidden = true;
    label.after(box);
    input.focus();
    input.select();

    let done = false;
    const close = (keep) => {
      if (done) return;
      done = true;
      const typed = input.value.trim();
      box.remove();
      label.hidden = false;
      if (keep && typed !== '' && Number.isFinite(Number(typed))) moveSlider(slider, Math.round(Number(typed)));
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        close(true);
      } else if (event.key === 'Escape') {
        // Not the dialog's or the panel's Escape as well.
        event.preventDefault();
        event.stopPropagation();
        close(false);
      }
    });
    input.addEventListener('blur', () => close(true));
    // Its own clicks are its own: a click in the box must not go on to whatever the label is part of (a tile that
    // maximises, a row that opens a menu).
    box.addEventListener('click', (event) => event.stopPropagation());
    box.addEventListener('pointerdown', (event) => event.stopPropagation());
  }
}
