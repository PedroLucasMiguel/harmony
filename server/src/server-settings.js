// What the server is called, and the key to its front door.
//
// Both live in server_meta rather than only in the environment, so the owner
// can change them from the client instead of editing a file on the host and
// restarting. The environment is still the default: a fresh server behaves
// exactly as it always did, and an override only exists once somebody sets
// one.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { secretsMatch } from './auth.js';

const NAME_KEY = 'server_name';
const DOOR_KEY = 'door_password';
const LOGO_KEY = 'server_logo';

/** What a server with no name of its own is called. */
export const DEFAULT_NAME = 'Harmony';
const MAX_NAME = 32;

/**
 * The stored form of a door password.
 *
 * SHA-256 with a random salt, NOT scrypt -- and that is the opposite of the
 * rule for account passwords, for a reason that is worth writing down. This
 * comparison happens on EVERY request, including the MediaMTX auth hook,
 * which runs on every publish and every read in the system. scrypt is 20 ms
 * here and 150 ms on a Pi; an event-loop stall of that size in the auth hook
 * is a visible stream failure, not a slow login.
 *
 * So this is a trade made with open eyes: the shared door key is protected
 * against a casual read of the database file, not against an offline attack
 * on a weak password. It is the same key that sits in plain text in
 * /etc/harmony/harmony.env today, and a salted digest is strictly better
 * than that -- but it is not an account password and must never be reused
 * as one.
 */
function hashDoor(password, salt) {
  return createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

export class ServerSettings {
  #meta;
  #envPassword;

  /**
   * @param {{get: (k: string) => string|null, set: (k: string, v: string) => void,
   *          delete: (k: string) => void}} meta
   * @param {{envPassword: string}} opts
   */
  constructor(meta, { envPassword = '' } = {}) {
    this.#meta = meta;
    this.#envPassword = envPassword;
  }

  get name() {
    return this.#meta.get(NAME_KEY) || DEFAULT_NAME;
  }

  /**
   * Rename the server. Empty puts it back to the default.
   *
   * Invisible characters are stripped for the same reason they are in a
   * channel name: this ends up in a title bar beside things people trust,
   * and a right-to-left override there reverses whatever is next to it.
   */
  setName(raw) {
    const clean = String(raw ?? '')
      .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_NAME);
    if (clean) this.#meta.set(NAME_KEY, clean);
    else this.#meta.delete(NAME_KEY);
    return this.name;
  }

  /**
   * The server's logo, as the hash of an upload, or null for none.
   *
   * Only the hash lives here. The file is an ordinary upload, reference
   * counted like an avatar -- the route that sets this retains the new one
   * and releases the old, so a logo nobody uses any more can be evicted.
   */
  get logo() {
    return this.#meta.get(LOGO_KEY) || null;
  }

  /** @returns {string|null} the logo it replaced, for its reference to be released */
  setLogo(hash) {
    const previous = this.logo;
    if (hash) this.#meta.set(LOGO_KEY, hash);
    else this.#meta.delete(LOGO_KEY);
    return previous;
  }

  /** The override, or null when the environment is still in charge. */
  #stored() {
    return this.#meta.get(DOOR_KEY);
  }

  /**
   * Is a password wanted at all?
   *
   * An override of the empty string is a real answer -- "the owner turned
   * the door off" -- and is deliberately different from no override, which
   * means "nobody has said, use the environment".
   */
  get passwordRequired() {
    const stored = this.#stored();
    if (stored === null) return Boolean(this.#envPassword);
    return stored !== '';
  }

  /**
   * True when the media relay's stance no longer matches this one.
   *
   * MediaMTX's open-server shortcut is decided at boot from the environment
   * -- `config.mediaToken` is minted then or not at all -- and it governs
   * the legacy flat stream namespace. Voice channels are unaffected: their
   * paths are checked before that shortcut is ever reached, which is the
   * security-critical ordering in the auth hook.
   *
   * So turning the password on or off from the client takes effect
   * immediately for the app and not at all for that one legacy branch until
   * a restart. Saying so is better than hoping nobody notices.
   */
  get restartRequired() {
    return Boolean(this.#envPassword) !== this.passwordRequired;
  }

  /** Does this attempt open the door? */
  matches(offered) {
    const stored = this.#stored();
    if (stored === null) return secretsMatch(offered, this.#envPassword);
    if (stored === '') return true;

    const [salt, expected] = stored.split(':');
    if (!salt || !expected) return false;
    const a = Buffer.from(hashDoor(String(offered ?? ''), salt), 'hex');
    const b = Buffer.from(expected, 'hex');
    // Equal length by construction -- both are a SHA-256 digest -- so there
    // is no length oracle to worry about here.
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Set the door password. An empty string takes the door off its hinges.
   *
   * There is no way back to "use the environment" from here, on purpose: a
   * control that sometimes means "clear this" and sometimes means "fall
   * back to whatever the host is configured with" is a control nobody can
   * predict. Once the owner has decided, the owner decides.
   */
  setPassword(raw) {
    const value = String(raw ?? '');
    if (!value) {
      this.#meta.set(DOOR_KEY, '');
      return { passwordRequired: false, restartRequired: this.restartRequired };
    }
    const salt = randomBytes(16).toString('hex');
    this.#meta.set(DOOR_KEY, `${salt}:${hashDoor(value, salt)}`);
    return { passwordRequired: true, restartRequired: this.restartRequired };
  }

  /** Everything a client is allowed to know. */
  publicView() {
    return {
      name: this.name,
      logo: this.logo,
      passwordRequired: this.passwordRequired,
      restartRequired: this.restartRequired,
    };
  }
}
