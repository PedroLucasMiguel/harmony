// The pictures for the system tray and the taskbar thumbnail's buttons
// (src/main/voice-tray.js).
//
// Drawn here, in the page, because this is the only side with something that
// can rasterise an SVG: main's nativeImage reads PNG and ICO and nothing
// else, and the UI's icons are Phosphor SVGs. Drawn once, at every scale a
// tray or a taskbar asks for (100% to 200%), and handed to main as PNG data
// URLs; nothing here runs again for the life of the window.
//
// The tray icon is the app's own tile (scripts/make-icons.py: the logo at 68%
// on a square with 22% corners) recoloured for what is happening in a call,
// the way Discord's is: grey while in a channel, green while you talk, and a
// red badge while muted or deafened. Outside a call main shows the real icon.

const SCALES = [1, 1.25, 1.5, 2];
const BASE = 16; // a tray icon and a thumbnail button, at 100%

const COLORS = {
  idle: '#80848e',
  speaking: '#23a55a',
  badge: '#f23f43',
};

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error(`could not load ${src}`));
  img.src = src;
});

/*
 * An icon, given a size of its own first. Phosphor's files have a viewBox
 * and no width or height, and an SVG with no size of its own is drawn onto
 * a canvas at whatever default the browser picks -- or not at all.
 */
async function loadIcon(name) {
  const text = await (await fetch(`icons/${name}.svg`)).text();
  const sized = text.replace('<svg ', '<svg width="256" height="256" ');
  return loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`);
}

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return [c, c.getContext('2d')];
}

/** An image drawn in one flat colour: the SVG's shape, any colour. */
function tinted(img, size, color) {
  const [c, g] = canvas(size);
  g.drawImage(img, 0, 0, size, size);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, size, size);
  return c;
}

function trayPicture(size, { logo, tile, badge }) {
  const [c, g] = canvas(size);
  g.fillStyle = tile;
  g.beginPath();
  g.roundRect(0, 0, size, size, size * 0.22);
  g.fill();

  // The logo is thin lines drawn for 256 px; at 16 they would all but
  // vanish. Drawing it a few times a fraction of a pixel apart thickens it
  // to something that reads, which is what the .ico's small sizes lack.
  const inner = size * 0.68;
  const at = (size - inner) / 2;
  const white = tinted(logo, Math.round(inner), '#fff');
  const spread = Math.max(0.35, size / 64);
  for (const [dx, dy] of [[0, 0], [spread, 0], [0, spread], [spread, spread]]) {
    g.drawImage(white, at + dx - spread / 2, at + dy - spread / 2, inner, inner);
  }

  if (badge) {
    // A round badge in the bottom-right corner, cut out of the tile with a
    // gap around it so it stays a separate shape at 16 px.
    const r = size * 0.3;
    const cx = size - r;
    const cy = size - r;
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.arc(cx, cy, r + size * 0.07, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = COLORS.badge;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    const glyph = r * 1.3;
    g.drawImage(tinted(badge, Math.round(glyph), '#fff'), cx - glyph / 2, cy - glyph / 2, glyph, glyph);
  }
  return c.toDataURL('image/png');
}

function buttonPicture(size, img, color) {
  return tinted(img, size, color).toDataURL('image/png');
}

/** One picture at every scale: [{ scale, size, dataURL }]. */
const atScales = (draw) => SCALES.map((scale) => {
  const size = Math.round(BASE * scale);
  return { scale, size, dataURL: draw(size) };
});

/**
 * Everything main needs, as data URLs.
 *
 * Thumbnail buttons come in two inks, for a dark and a light taskbar; main
 * picks by the system's theme. A button that is "on" -- muted, deafened --
 * is red in both, as the mute button in the app is.
 */
export async function drawTrayIcons() {
  const names = ['microphone', 'microphone-slash', 'headphones', 'speaker-slash', 'phone-x'];
  const [logo, ...glyphs] = await Promise.all([
    loadImage('logo.png'),
    ...names.map(loadIcon),
  ]);
  const icon = Object.fromEntries(names.map((name, i) => [name, glyphs[i]]));

  const buttons = (ink) => ({
    mic: atScales((s) => buttonPicture(s, icon.microphone, ink)),
    micOff: atScales((s) => buttonPicture(s, icon['microphone-slash'], COLORS.badge)),
    deafen: atScales((s) => buttonPicture(s, icon.headphones, ink)),
    deafenOff: atScales((s) => buttonPicture(s, icon['speaker-slash'], COLORS.badge)),
    leave: atScales((s) => buttonPicture(s, icon['phone-x'], ink)),
  });

  return {
    tray: {
      voice: atScales((s) => trayPicture(s, { logo, tile: COLORS.idle })),
      speaking: atScales((s) => trayPicture(s, { logo, tile: COLORS.speaking })),
      muted: atScales((s) => trayPicture(s, { logo, tile: COLORS.idle, badge: icon['microphone-slash'] })),
      deafened: atScales((s) => trayPicture(s, { logo, tile: COLORS.idle, badge: icon['speaker-slash'] })),
    },
    buttons: {
      dark: buttons('#f2f3f5'),
      light: buttons('#313338'),
    },
  };
}
