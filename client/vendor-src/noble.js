// The cryptography private conversations are made of, and nothing else.
//
// Bundled into src/renderer/noble.js by scripts/build-noble.js, because the
// renderer is loaded as plain ES modules with no bundler and no import map,
// and noble's modules import each other by package name. The bundle is
// committed, so running the app needs no build step; run
// `npm run build:noble` after changing this file or upgrading the packages.
//
//   X25519               the key agreement          (RFC 7748)
//   HKDF-SHA256          the key derivation         (RFC 5869)
//   SHA-256              the safety number
//   XChaCha20-Poly1305   sealing                    (draft-irtf-cfrg-xchacha)
//
// The libraries are Paul Miller's noble-curves, noble-ciphers and noble-hashes
// (MIT, audited). Ciranda's client does the same with the Rust crates of the
// same algorithms; the known-answer tests in test/dm-crypto.test.mjs are what
// show the two agree to the byte.

export { x25519 } from '@noble/curves/ed25519.js';
export { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
export { hkdf } from '@noble/hashes/hkdf.js';
export { sha256 } from '@noble/hashes/sha2.js';
