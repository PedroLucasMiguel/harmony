// The slide of a moving name's colour (a gradient, or the rainbow), driven from one timer.
//
// It used to be a CSS animation per name. A background that moves is painted again at every step, and a
// CSS animation also asks the page for a new frame at the refresh rate of the display for as long as it is
// there -- 120 or 240 times a second, for names nobody can see (those scrolled out of the chat count too).
// Measured on 100 names with 5 on screen: 29% of a core, against 6% for this, which moves only the names
// that are on screen, 8 times a second, and not at all while the window is behind another or hidden.
//
// The look is the same one: the text is a window onto a background twice as wide, slid along by one whole
// width per cycle (styles.css, [data-name-style]); only who moves it and how often has changed.

const FPS = 8;
/** The background is twice the text's width: one cycle slides it by this much. */
const CYCLE_PERCENT = 200;
const DEFAULT_SPEED = 6;

/**
 * @param {object} [options]
 * @param {number} [options.fps]
 * @param {Document} [options.document]
 * @returns {{stop: () => void, tick: (now?: number) => void, readonly moving: number}}
 */
export function startNameMotion({ fps = FPS, document: doc = document } = {}) {
  const win = doc.defaultView;
  const root = doc.documentElement;
  if (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return { stop() {}, tick() {}, moving: 0 };

  /** The names that can be seen right now. */
  const visible = new Set();

  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    }
  });

  const watch = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches('[data-name-style]')) seen.observe(node);
    for (const inner of node.querySelectorAll('[data-name-style]')) seen.observe(inner);
  };
  const forget = (node) => {
    if (node.nodeType !== 1) return;
    for (const gone of [node, ...node.querySelectorAll('[data-name-style]')]) {
      seen.unobserve(gone);
      visible.delete(gone);
    }
  };

  const changes = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        // A name that was coloured, or stopped being: observing twice is harmless, unobserving is not.
        if (record.target.hasAttribute('data-name-style')) seen.observe(record.target);
        else forget(record.target);
        continue;
      }
      record.removedNodes.forEach(forget);
      record.addedNodes.forEach(watch);
    }
  });
  changes.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-name-style'] });
  watch(doc.body);

  function tick(now = performance.now()) {
    // Behind another window, or hidden: nobody is looking (app.js marks the page).
    if (root.hasAttribute('data-blurred') || doc.visibilityState === 'hidden') return;
    for (const node of visible) {
      if (!node.isConnected) {
        visible.delete(node);
        continue;
      }
      const speed = parseFloat(node.style.getPropertyValue('--name-speed')) || DEFAULT_SPEED;
      const at = ((now / (speed * 1000)) % 1) * CYCLE_PERCENT;
      node.style.backgroundPositionX = `${at.toFixed(1)}%`;
    }
  }

  const timer = setInterval(tick, Math.round(1000 / fps));

  return {
    stop() {
      clearInterval(timer);
      changes.disconnect();
      seen.disconnect();
      visible.clear();
    },
    tick,
    get moving() {
      return visible.size;
    },
  };
}
