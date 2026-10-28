// The cryptography of private conversations, and nothing else: no networking,
// no storage, no page.
//
// A port, step for step, of Ciranda's core/crypto.rs, and compatible with it to
// the byte: a message sealed here opens there and the other way round, a
// recovery key typed into either opens the same wrapped identity, and both show
// the same safety number. test/dm-crypto.test.mjs holds the answers Ciranda's
// own tests pin (known keys, a known sealed message, a known wrapping), so a
// change that moves any byte of them is a change of format and fails there.
//
//   * Each person has one X25519 identity key. Its private half is made on
//     this computer and leaves it only sealed under a recovery key the server
//     never sees (`wrap`).
//   * Two people agree a key per conversation and per pair of identity keys
//     (`pairKey`): X25519, then HKDF-SHA256 bound to the conversation, both
//     people and both public keys, so a key for one conversation is useless in
//     any other.
//   * Everything is sealed with XChaCha20-Poly1305 under a random 24-byte
//     nonce, with what it is (a message, a reaction, a call key) and where it
//     belongs bound in as associated data: the server can't move a sealed
//     reaction onto another message or replay a message into another
//     conversation without it failing to open.
//   * Files are sealed under a fresh random key each, which travels inside the
//     sealed message.
//
// Sealed text is base64url (no padding) of `version | nonce | ciphertext+tag`.

import { hkdf, sha256, x25519, xchacha20poly1305 } from './noble.js';

/** The format of everything sealed here. Bumped if it ever changes, so old and new can be told apart. */
const VERSION = 1;
const NONCE = 24;
const TAG = 16;

const encoder = new TextEncoder();

/** Bytes from the system's generator. Without one there is no safe way on, so it throws. */
export function random(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

const B64URL = /^[A-Za-z0-9_-]*$/;

export function b64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Bytes from base64url without padding, or null if it is anything else. */
export function unb64(text) {
  if (typeof text !== 'string') return null;
  const clean = text.trim();
  // Unpadded base64 is never one character more than a multiple of four.
  if (!B64URL.test(clean) || clean.length % 4 === 1) return null;
  try {
    const binary = atob(clean.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** A public key as the server carries it, or null if it is not 32 bytes of base64url. */
export function publicKey(text) {
  const bytes = unb64(text);
  return bytes?.length === 32 ? bytes : null;
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** A number as a big-endian i64, which is what ids are bound in as. */
function i64(n) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(n), false);
  return out;
}

const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function sealWith(key, aad, plain, nonce = random(NONCE)) {
  const sealed = xchacha20poly1305(key, nonce, aad).encrypt(plain);
  return concat(Uint8Array.of(VERSION), nonce, sealed);
}

function openWith(key, aad, sealed) {
  if (sealed.length < 1 + NONCE + TAG || sealed[0] !== VERSION) return null;
  try {
    return xchacha20poly1305(key, sealed.subarray(1, 1 + NONCE), aad).decrypt(sealed.subarray(1 + NONCE));
  } catch {
    return null;
  }
}

/** `sealWith` under a nonce of the caller's: only the tests pin one. Anything that leaves gets a fresh one. */
export const sealWithNonceForTests = sealWith;

// Identity.

/** Your identity key. */
export class Identity {
  #secret;

  #public;

  constructor(secret) {
    this.#secret = Uint8Array.from(secret);
    this.#public = x25519.getPublicKey(this.#secret);
  }

  static generate() {
    return new Identity(random(32));
  }

  static fromSecret(bytes) {
    return new Identity(bytes);
  }

  get public() {
    return Uint8Array.from(this.#public);
  }

  get publicB64() {
    return b64(this.#public);
  }

  /** The private half, as it is stored and wrapped. Not for anywhere else. */
  get secret() {
    return Uint8Array.from(this.#secret);
  }

  /** The shared secret with another public key, or null for one X25519 must never be used with. */
  agree(theirPublic) {
    let shared;
    try {
      shared = x25519.getSharedSecret(this.#secret, theirPublic);
    } catch {
      return null;
    }
    // A small-order point makes the "shared" secret known to anybody.
    return shared.some((b) => b !== 0) ? shared : null;
  }

  /** Wipes the private half from this object. */
  destroy() {
    this.#secret.fill(0);
  }
}

// Recovery.

/** Crockford's base32: no I, L, O or U, so nothing in it is mistaken for something else when copied. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The recovery key: 160 random bits, shown as 32 characters in eight groups of
 * four. It opens your identity key on a computer that does not have it yet;
 * nothing else can.
 */
export class RecoveryKey {
  #bytes;

  constructor(bytes) {
    this.#bytes = Uint8Array.from(bytes);
  }

  static generate() {
    return new RecoveryKey(random(20));
  }

  /**
   * Reads one back however it was typed: any case, with or without dashes and
   * spaces, and with the letters people confuse (O for 0, I and L for 1) taken
   * as what they meant. Null if it is not one.
   */
  static parse(text) {
    let bits = 0;
    let n = 0;
    const out = new Uint8Array(20);
    let at = 0;
    for (const raw of String(text)) {
      if (/\s/.test(raw) || raw === '-') continue;
      let c = raw.toUpperCase();
      if (c === 'O') c = '0';
      else if (c === 'I' || c === 'L') c = '1';
      const v = CROCKFORD.indexOf(c);
      if (v < 0 || c.length !== 1) return null;
      bits = ((bits << 5) | v) >>> 0;
      n += 5;
      if (n >= 8) {
        n -= 8;
        if (at >= 20) return null;
        out[at] = (bits >>> n) & 0xff;
        at += 1;
        bits &= (1 << n) - 1;
      }
    }
    return at === 20 && n === 0 ? new RecoveryKey(out) : null;
  }

  display() {
    let chars = '';
    let bits = 0;
    let n = 0;
    for (const b of this.#bytes) {
      bits = ((bits << 8) | b) >>> 0;
      n += 8;
      while (n >= 5) {
        n -= 5;
        if (chars.length && (chars.length + 1) % 5 === 0) chars += '-';
        chars += CROCKFORD[(bits >>> n) & 31];
      }
      bits &= (1 << n) - 1;
    }
    return chars;
  }

  /** HKDF-SHA256, salt "harmony-recovery-v1", info "wrap identity". */
  wrappingKey() {
    return hkdf(sha256, this.#bytes, encoder.encode('harmony-recovery-v1'), encoder.encode('wrap identity'), 32);
  }
}

/**
 * Your identity key's private half, sealed under the recovery key: what the
 * server keeps, and all it ever gets of it. The public key is bound in, so a
 * wrapping can't be swapped for another.
 */
export function wrap(identity, recovery) {
  return b64(sealWith(recovery.wrappingKey(), identity.public, identity.secret));
}

/** The identity key back out of a wrapping, if this recovery key is the one it was sealed under. */
export function unwrap(wrapped, publicBytes, recovery) {
  const sealed = unb64(wrapped);
  if (!sealed) return null;
  const plain = openWith(recovery.wrappingKey(), publicBytes, sealed);
  if (plain?.length !== 32) return null;
  const identity = Identity.fromSecret(plain);
  return equal(identity.public, publicBytes) ? identity : null;
}

// Conversations.

/** The key two people share for one conversation and one pair of their identity keys. */
export class PairKey {
  #key;

  constructor(key) {
    this.#key = key;
  }

  seal(aad, plain) {
    return b64(sealWith(this.#key, encoder.encode(aad), plain));
  }

  open(aad, sealed) {
    const bytes = unb64(sealed);
    return bytes ? openWith(this.#key, encoder.encode(aad), bytes) : null;
  }

  /** The key itself, for the tests that pin it against Ciranda's. */
  get bytesForTests() {
    return Uint8Array.from(this.#key);
  }
}

/**
 * Agrees the key for a conversation. Symmetric: each side, with its own private
 * key and the other's public one, arrives at the same key. Null when the other
 * key is one X25519 must never be used with.
 */
export function pairKey(mine, me, theirPublic, them, conversation) {
  const shared = mine.agree(theirPublic);
  if (!shared) return null;
  const ours = [me, mine.public];
  const theirs = [them, theirPublic];
  const [first, second] = me < them ? [ours, theirs] : [theirs, ours];
  const info = concat(i64(conversation), i64(first[0]), first[1], i64(second[0]), second[1]);
  return new PairKey(hkdf(sha256, shared, encoder.encode('harmony-dm-v1'), info, 32));
}

/**
 * The random nonce of something sealed. Fresh for every sealing, so the same
 * one under two message ids is one sealed text sent twice: the client tells a
 * replay by it. A hex string, to be a key in a Map.
 */
export function nonceOf(sealed) {
  const bytes = unb64(sealed);
  if (!bytes || bytes.length < 1 + NONCE + TAG || bytes[0] !== VERSION) return null;
  return Array.from(bytes.subarray(1, 1 + NONCE), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * What a sealed thing is and where it belongs, bound in as associated data.
 *
 * Which message it is can't be: the server numbers a message only after it is
 * sealed. So that goes inside, in the sealed text, which the AEAD authenticates
 * exactly as it does these. A call's key is told from another call's by its
 * nonce. These strings are Ciranda's, character for character.
 */
export const aad = {
  message: (conversation, sender) => `harmony-dm-v1/message/${conversation}/${sender}`,
  reaction: (conversation, message, user) => `harmony-dm-v1/reaction/${conversation}/${message}/${user}`,
  call: (conversation, caller) => `harmony-dm-v1/call/${conversation}/${caller}`,
};

/**
 * Pads a message to a multiple of 64 bytes (at least 128) with trailing spaces,
 * which JSON ignores, so its sealed size says roughly how long it is and not
 * exactly.
 */
export function pad(json) {
  const target = Math.ceil(Math.max(json.length, 128) / 64) * 64;
  const out = new Uint8Array(target).fill(0x20);
  out.set(json);
  return out;
}

// Files.

const FILE_AAD = encoder.encode('harmony-dm-v1/file');

/** Seals a file under a key of its own. The key goes inside the sealed message that sends it. */
export function sealFile(plain) {
  const key = random(32);
  return { sealed: sealWith(key, FILE_AAD, plain), key };
}

export function openFile(key, sealed) {
  return openWith(key, FILE_AAD, sealed);
}

// Verification.

/**
 * The safety number of two people's keys: the same on both screens exactly when
 * each sees the other's real key. Thirty digits in six groups, read out loud in
 * a call to compare.
 *
 * @param {{id: number, key: Uint8Array}} a
 * @param {{id: number, key: Uint8Array}} b
 */
export function safetyNumber(a, b) {
  const [first, second] = a.id < b.id ? [a, b] : [b, a];
  const digest = sha256(concat(encoder.encode('harmony-safety-v1'), i64(first.id), first.key, i64(second.id), second.key));
  const groups = [];
  for (let i = 0; i < 6; i += 1) {
    let n = 0;
    for (const byte of digest.subarray(i * 5, i * 5 + 5)) n = n * 256 + byte;
    groups.push(String(n % 100_000).padStart(5, '0'));
  }
  return groups.join(' ');
}
