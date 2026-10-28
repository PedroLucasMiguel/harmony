// Your private-conversation keys on this computer, for one account on one server.
//
// What is kept here, because it is a fact about what this computer has seen
// rather than a setting:
//
//   identity      the private half of your identity key and its id on the server,
//                 sealed with the system's keychain (see `seal`), and the ones
//                 this account had before, so what was sealed to them still opens
//   recovery key  as shown, sealed, until the person says they put it somewhere
//                 safe; then this computer's copy goes and it cannot be shown
//                 again, so a copy of the settings can't open the account's key
//                 elsewhere (the server's wrapped copy opens only with it)
//   pins          the key each person had the first time you talked to them (to
//                 notice when it changes), and the ones accepted since
//   verified      the key whose safety number they compared with you in person
//
// Ciranda's core/keystore.rs, in the same shape and with the same meanings.
// MemoryKeyFile holds them in memory; PersistentKeyFile also writes them where
// `backend` says (the settings file on a desktop, local storage elsewhere).

import { Identity, RecoveryKey } from './dm-crypto.js';

const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const bytesOf = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));

export class MemoryKeyFile {
  /** The id the server gave the current identity key, 0 for none. */
  keyId = 0;

  #identity = null;

  /** Identity keys this account had before, by key id. */
  archive = new Map();

  #recovery = null;

  #recoverySaved = false;

  /** The keychain did not answer: an identity key is here but cannot be opened this run. */
  locked = false;

  pins = new Map();

  /** By user id: every other public key of theirs that was accepted here. */
  acceptedKeys = new Map();

  verifiedKeys = new Map();

  /** Where the data is written on change; memory has nowhere to. */
  changed() {}

  /** Resolves once everything changed so far is where it is kept. */
  async flush() {}

  identityLocked() {
    return this.locked;
  }

  /** The identity key and its id on the server, if this computer has it and it opens. */
  identity() {
    return this.keyId && this.#identity ? { id: this.keyId, identity: this.#identity } : null;
  }

  /** An identity key this account had before, if this computer kept it. */
  archivedIdentity(keyId) {
    return this.archive.get(keyId) ?? null;
  }

  #archiveCurrent() {
    if (this.keyId && this.#identity) this.archive.set(this.keyId, this.#identity);
  }

  /** The account's key from now on. One it replaces is archived, not dropped. */
  setIdentity(keyId, identity) {
    if (this.keyId !== keyId) this.#archiveCurrent();
    this.keyId = keyId;
    this.#identity = identity;
    this.locked = false;
    this.changed();
  }

  /**
   * Stops using the identity key here, as when the server says this account has
   * none. It is archived rather than deleted: the server may have lost it, but
   * what was sealed to it is still somewhere, and only this key opens it.
   */
  retireIdentity() {
    this.#archiveCurrent();
    this.keyId = 0;
    this.#identity = null;
    this.#recovery = null;
    this.#recoverySaved = false;
    this.changed();
  }

  recovery() {
    return this.#recovery;
  }

  /** Whether a recovery key is kept here to show. */
  hasRecovery() {
    return this.#recovery !== null;
  }

  /**
   * A recovery key the server now holds a wrapping for. One already kept
   * somewhere (typed in to unlock this computer) is not written down here at
   * all; a new one is, since it is the only way to the wrapping on the server
   * until it is copied.
   */
  setRecovery(recovery, saved) {
    this.#recovery = saved ? null : recovery;
    this.#recoverySaved = saved;
    this.changed();
  }

  recoverySaved() {
    return this.#recoverySaved || this.#recovery === null;
  }

  /** The person kept it somewhere: this computer's copy goes. */
  markRecoverySaved() {
    this.#recoverySaved = true;
    this.#recovery = null;
    this.changed();
  }

  pin(user) {
    return this.pins.get(user) ?? null;
  }

  /** The key to compare `user`'s against from now on. The one it replaces stays accepted. */
  setPin(user, key) {
    const old = this.pins.get(user);
    this.pins.set(user, key);
    if (old === key) return;
    if (old !== undefined) this.accept(user, [old]);
    this.changed();
  }

  /** `key` is one of `user`'s that was accepted here: the pinned one, or one accepted since. */
  accepted(user, key) {
    return this.pin(user) === key || (this.acceptedKeys.get(user)?.includes(key) ?? false);
  }

  accept(user, keys) {
    const fresh = [...new Set(keys.filter((k) => !this.accepted(user, k)))];
    if (!fresh.length) return;
    this.acceptedKeys.set(user, [...(this.acceptedKeys.get(user) ?? []), ...fresh]);
    this.changed();
  }

  verified(user) {
    return this.verifiedKeys.get(user) ?? null;
  }

  setVerified(user, key) {
    if (key) this.verifiedKeys.set(user, key);
    else this.verifiedKeys.delete(user);
    this.changed();
  }

  // The identity and recovery keys are private to this class; these are for
  // PersistentKeyFile, which has to write them out and read them back.
  _restore({ keyId, identity, recovery, recoverySaved }) {
    this.keyId = keyId;
    this.#identity = identity;
    this.#recovery = recovery;
    this.#recoverySaved = recoverySaved;
  }

  _snapshot() {
    return { identity: this.#identity, recovery: this.#recovery, recoverySaved: this.#recoverySaved };
  }
}

/**
 * The same, kept between runs.
 *
 * `backend` is {load(): Promise<object|null>, save(record): Promise<void>,
 * seal(text): Promise<string>, unseal(sealed): Promise<string>}: where the
 * record lives, and the system keychain's seal for the two secrets in it.
 * `unseal` answers '' for something it cannot open this run.
 *
 * Written by a queue, one write at a time and the last one wins, so a burst of
 * changes is one write and none passes another. `flush()` is what the caller
 * waits on when the change must be on disk before it goes on: a key the server
 * already has the public half of, lost here, is lost for good.
 */
export class PersistentKeyFile extends MemoryKeyFile {
  #backend;

  #label;

  #queue = Promise.resolve();

  #dirty = false;

  /**
   * What the keychain would not open this run, kept exactly as it was sealed:
   * it is not ours to lose because the keychain did not answer, and rewriting
   * the record without it would be exactly that.
   */
  #unopened = { secret: '', archive: {} };

  constructor(backend, label) {
    super();
    this.#backend = backend;
    this.#label = label;
  }

  static async open(backend, label) {
    const file = new PersistentKeyFile(backend, label);
    await file.#load();
    return file;
  }

  async #load() {
    const record = await this.#backend.load();
    if (!record) return;
    const open = async (sealed) => (sealed ? this.#backend.unseal(sealed) : '');

    const keyId = Number(record.keyId) || 0;
    let identity = null;
    if (keyId && record.secret) {
      const hex = await open(record.secret);
      if (/^[0-9a-f]{64}$/.test(hex)) {
        identity = Identity.fromSecret(bytesOf(hex));
      } else {
        this.locked = true;
        this.#unopened.secret = record.secret;
      }
    }
    let recovery = null;
    if (record.recovery) recovery = RecoveryKey.parse(await open(record.recovery));
    this._restore({ keyId, identity, recovery, recoverySaved: Boolean(record.recoverySaved) });

    for (const [id, sealed] of Object.entries(record.archive ?? {})) {
      const hex = await open(sealed);
      if (/^[0-9a-f]{64}$/.test(hex)) this.archive.set(Number(id), Identity.fromSecret(bytesOf(hex)));
      else this.#unopened.archive[id] = sealed;
    }
    for (const [user, key] of Object.entries(record.pins ?? {})) this.pins.set(Number(user), key);
    for (const [user, keys] of Object.entries(record.accepted ?? {})) this.acceptedKeys.set(Number(user), [...keys]);
    for (const [user, key] of Object.entries(record.verified ?? {})) this.verifiedKeys.set(Number(user), key);
  }

  changed() {
    this.#dirty = true;
    this.#queue = this.#queue.then(() => this.#write()).catch((err) => {
      console.warn('[dm] could not save the keys:', err?.message ?? err);
    });
  }

  flush() {
    return this.#queue;
  }

  async #write() {
    if (!this.#dirty) return;
    this.#dirty = false;
    const { identity, recovery, recoverySaved } = this._snapshot();
    const seal = (text) => this.#backend.seal(text);

    const archive = { ...this.#unopened.archive };
    for (const [id, kept] of this.archive) archive[id] = await seal(hexOf(kept.secret));
    const record = {
      label: this.#label,
      keyId: this.keyId,
      secret: identity ? await seal(hexOf(identity.secret)) : this.#unopened.secret,
      recovery: recovery ? await seal(recovery.display()) : '',
      recoverySaved,
      archive,
      pins: Object.fromEntries(this.pins),
      accepted: Object.fromEntries(this.acceptedKeys),
      verified: Object.fromEntries(this.verifiedKeys),
    };
    await this.#backend.save(record);
  }
}
