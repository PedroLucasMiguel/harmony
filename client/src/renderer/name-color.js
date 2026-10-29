// The colour of a display name, drawn.
//
// A name is a solid colour, a gradient that moves, or the rainbow; the server
// holds the choice (accounts.js cleanNameColor) and this turns it into what
// the page needs. The colours reach the page only as CSS custom properties set
// from script -- the page has no inline styles -- and the rules that use them
// are in styles.css under [data-name-style].
//
// A solid colour is simply the role colour's slot, taken: it overrides the
// colour of the highest role, which is the whole of "overwrite the role colour".

export const NAME_COLOR_STOPS = { min: 2, max: 4 };
export const NAME_COLOR_SPEED = { min: 1, max: 30, step: 0.5, fallback: 6 };

export const DEFAULT_SOLID = '#5865f2';
export const DEFAULT_GRADIENT = ['#8e2de2', '#00c6ff'];

/** What choosing a mode starts from, keeping whatever colours were there. */
export function startingPoint(mode, previous) {
  const colors = previous?.colors?.length >= NAME_COLOR_STOPS.min ? previous.colors : DEFAULT_GRADIENT;
  const speed = previous?.speed ?? NAME_COLOR_SPEED.fallback;
  if (mode === 'solid') return { mode, color: previous?.color ?? previous?.colors?.[0] ?? DEFAULT_SOLID };
  if (mode === 'gradient') return { mode, colors: [...colors], speed };
  if (mode === 'rainbow') return { mode, speed };
  return null;
}

/**
 * Colour a node's text, or clear it.
 *
 * @param {HTMLElement} node
 * @param {object|null} nameColor  the person's own choice, which wins
 * @param {object|string|null} fallback  what applies when there is none: a
 *   role's look (a plain colour as a string or {mode: 'solid'}, or its gradient
 *   or rainbow), or null for the ordinary colour
 */
export function paintName(node, nameColor, fallback) {
  const set = (name, value) => node.style.setProperty(name, value);
  const clear = (...names) => names.forEach((name) => node.style.removeProperty(name));

  const look = nameColor ?? (typeof fallback === 'string' ? { mode: 'solid', color: fallback } : fallback);

  delete node.dataset.nameStyle;
  clear('--name-gradient', '--name-speed');

  if (look?.mode === 'gradient' || look?.mode === 'rainbow') {
    node.dataset.nameStyle = look.mode;
    set('--name-speed', `${look.speed}s`);
    if (look.mode === 'gradient') {
      // The first colour again at the end, so the loop has no seam.
      set('--name-gradient', `linear-gradient(90deg, ${[...look.colors, look.colors[0]].join(', ')})`);
    }
    delete node.dataset.roleColor;
    clear('--role-color');
    return;
  }

  if (look?.mode === 'solid' && look.color) {
    node.dataset.roleColor = '';
    set('--role-color', look.color);
  } else {
    delete node.dataset.roleColor;
    clear('--role-color');
  }
}
