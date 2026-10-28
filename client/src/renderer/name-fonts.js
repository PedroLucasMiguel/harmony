// The fonts a display name may be drawn in.
//
// The ids are the server's (accounts.js NAME_FONTS): the server keeps only the
// id, every client ships the files (fonts/, declared in fonts.css) and draws
// the name with the same font, and an id this build does not know is drawn in
// the ordinary font rather than failing. The font names are proper names and
// are not translated; only "Default" is (see profile.font_default).

export const NAME_FONTS = [
  { id: 'pacifico', label: 'Pacifico' },
  { id: 'press-start', label: 'Press Start 2P' },
  { id: 'orbitron', label: 'Orbitron' },
  { id: 'playfair', label: 'Playfair Display' },
  { id: 'bebas', label: 'Bebas Neue' },
  { id: 'caveat', label: 'Caveat' },
  { id: 'fredoka', label: 'Fredoka' },
  { id: 'cinzel', label: 'Cinzel' },
  { id: 'typewriter', label: 'Special Elite' },
  { id: 'marker', label: 'Permanent Marker' },
];

const KNOWN = new Set(NAME_FONTS.map((f) => f.id));

/** The id to put on an element, or null if this build has no such font. */
export const nameFontOf = (id) => (KNOWN.has(id) ? id : null);
