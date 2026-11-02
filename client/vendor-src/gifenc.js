// The GIF encoder a cropped, animated profile picture or banner is written with, and nothing else.
//
// Bundled into src/renderer/gifenc.js by scripts/build-gifenc.js, because the renderer is loaded as plain ES modules
// with no bundler. The bundle is committed, so running the app needs no build step; run `npm run build:gifenc` after
// changing this file or upgrading the package.
//
//   GIFEncoder    writes the frames one after another
//   quantize      the palette for some pixels (at most 256 colours)
//   applyPalette  the pixels of a frame as indexes into it

export { GIFEncoder, quantize, applyPalette } from 'gifenc';
