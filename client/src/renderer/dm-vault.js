// Private conversations on this computer: whose keys are whose, whether this
// computer can open your messages, and turning sealed messages into ones the
// chat can draw (and back).
//
// Plain logic over dm-crypto and a key file, with no networking and no page, so
// the session drives it and the tests can too. A port of Ciranda's dm.rs
// (`Vault`), with the same rules, because it is these rules and not only the
// bytes that make the two clients trust each other the same way.
//
// The server is not trusted with any of it. It says which key is whose, and it
// may lie: a key is only used for the person it is listed for, and one of theirs
// this computer has not accepted before is marked (and never opens a call, nor
// gets one). It numbers the messages, and it may replay or shuffle them: a
// sealed text, or a message's own sealed id, seen under two message ids is
// refused, and an earlier text of a message put back after a newer one was seen
// is not shown.

import {
  Identity, RecoveryKey, aad, b64, nonceOf, pad, pairKey, publicKey, random, safetyNumber, unwrap, wrap,
} from './dm-crypto.js';

/** Why something could not be sealed for the other person. */
export const SealError = Object.freeze({
  /** This computer can't seal anything yet: no key, or locked. */
  NoKey: 'no_key',
  /** The other person has no key yet. */
  PeerHasNoKey: 'peer_has_no_key',
  /**
   * Their key changed and the change was not accepted here: nothing is sealed
   * to it until it is.
   */
  KeyNotConfirmed: 'key_not_confirmed',
});

/** Whether this computer can take part in private conversations yet. */
export const KeyState = Object.freeze({
  /** Asking the server what keys there are. */
  Loading: 'loading',
  /** This computer has the account's key: everything works. */
  Ready: 'ready',
  /** The account has a key that this computer does not: the recovery key opens it here. */
  Locked: 'locked',
  /** The server could not be asked, or the keychain would not open; tried again on the next connect. */
  Failed: 'failed',
  /** The server is older than private conversations. */
  Unsupported: 'unsupported',
});

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** A sealed thing refused for a reason the caller can name. */
export class SealFailed extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** Where an opened text stands among the texts seen of its message. */
const Placement = Object.freeze({
  /** The one to show. */
  Current: 'current',
  /** An older text than the one shown, arriving late or put back: the newer one stays. */
  Superseded: 'superseded',
  /** Not where it was sealed to be: under another message's id, or an edit of another message. */
  Refused: 'refused',
});

/** Tuples compared as Ciranda compares them: first the left, then the right. */
const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/** What a sealed attachment is drawn as, from the type it was sealed with. */
export function mediaTypeOf(mime) {
  switch (String(mime ?? '').split('/')[0]) {
    case 'image': return 'image';
    case 'video': return 'video';
    case 'audio': return 'audio';
    default: return 'file';
  }
}

export class Vault {
  state = KeyState.Loading;

  /** The reason, when `state` is Failed. */
  failure = '';

  #me;

  /** {id, identity} for the account's key this computer holds. */
  #identity;

  /** The account's key as the server has it, with its wrapped private half. */
  #onServer = null;

  #file;

  /** Every public key seen, by id: history needs keys since replaced. */
  #keys = new Map();

  /** Each person's current key id. */
  #current = new Map();

  /** Agreed keys, by "conversation:mine:theirs": an agreement per message would be wasted work. */
  #pairs = new Map();

  /** By person: ids of keys of theirs that something opened with here, not accepted for them. */
  #unconfirmed = new Map();

  /** The message id each sealed text (by its nonce) and each message's own id was seen at. */
  #nonces = new Map();

  #mids = new Map();

  #texts = new Map();

  constructor(file, me) {
    this.#file = file;
    this.#me = me;
    this.#identity = file.identity();
  }

  get me() {
    return this.#me;
  }

  get ready() {
    return this.state === KeyState.Ready;
  }

  get myKey() {
    return this.#identity?.id ?? null;
  }

  /**
   * What the server said about everybody's keys and your own.
   *
   * `mine` is the key object, `null` for "this account has none", and
   * `undefined` for an answer that says nothing about it: only a plain null
   * means none, and taking anything else for it would throw away the key this
   * computer has.
   *
   * @returns {'create'|'nothing'}
   */
  onKeys({ keys = [], mine }) {
    this.learn(keys);
    for (const k of keys) {
      if (this.#owner(k.id) === k.userId) this.#current.set(k.userId, k.id);
    }
    if (mine === null) {
      // The server has no key for this account (a new one, or a server that
      // forgot): a new one is made. The one this computer kept is archived, not
      // deleted, so what was sealed to it still opens here.
      if (this.#identity) {
        this.#identity = null;
        this.#file.retireIdentity();
      }
      this.#onServer = null;
      return 'create';
    }
    if (mine && typeof mine === 'object' && mine.id && mine.publicKey && typeof mine.wrapped === 'string') {
      if (this.#identity && this.#identity.id === mine.id && this.#identity.identity.publicB64 === mine.publicKey) {
        this.state = KeyState.Ready;
      } else if (!this.#identity && this.#file.identityLocked()) {
        this.state = KeyState.Failed;
        this.failure = 'keychain';
      } else {
        this.state = KeyState.Locked;
      }
      this.#onServer = mine;
      return 'nothing';
    }
    // An answer that says nothing about your key is not an answer that you have
    // none: keep it, and use it if the directory agrees it is the current one.
    const known = this.#keys.get(this.#current.get(this.#me));
    if (this.#identity && known && this.#identity.id === known.id && this.#identity.identity.publicB64 === known.publicKey) {
      this.state = KeyState.Ready;
    } else {
      this.state = KeyState.Failed;
      this.failure = 'unclear';
    }
    return 'nothing';
  }

  /** Makes a new identity key and its recovery key: the wrapping to publish, and the key to show. */
  static create() {
    const identity = Identity.generate();
    const recovery = RecoveryKey.generate();
    return { identity, recovery, wrapped: wrap(identity, recovery) };
  }

  /**
   * The server took a key this computer made: it is the account's key from now
   * on. Resolves once it is on disk -- the server already has its public half,
   * and lost here it is lost for good.
   */
  async adopt(key, identity, recovery, saved) {
    this.#file.setIdentity(key.id, identity);
    this.#file.setRecovery(recovery, saved);
    this.learn([{ id: key.id, userId: this.#me, publicKey: key.publicKey, createdAt: 0 }]);
    this.#current.set(this.#me, key.id);
    this.#identity = { id: key.id, identity };
    this.#onServer = key;
    this.state = KeyState.Ready;
    await this.#file.flush();
  }

  /** Opens the account's key with the recovery key typed in. False if it is not the right one. */
  async unlock(typed) {
    const recovery = RecoveryKey.parse(typed);
    const mine = this.#onServer;
    if (!recovery || !mine) return false;
    const pub = publicKey(mine.publicKey);
    if (!pub) return false;
    const identity = unwrap(mine.wrapped, pub, recovery);
    if (!identity) return false;
    await this.adopt(mine, identity, recovery, true);
    return true;
  }

  /**
   * The recovery key, as shown, while this computer keeps it: from when it is
   * made until the person says it is somewhere safe.
   */
  recovery() {
    return this.#file.recovery()?.display() ?? null;
  }

  hasRecovery() {
    return this.#file.hasRecovery();
  }

  /** A recovery key was made here and nobody has said it is kept somewhere yet. */
  get needsBackup() {
    return this.ready && !this.#file.recoverySaved();
  }

  /** They kept it: this computer's copy goes, and it can't be shown again. */
  markBackedUp() {
    this.#file.markRecoverySaved();
    return this.#file.flush();
  }

  /** A new recovery key for the key this computer has, and its wrapping to send to the server. */
  newRecovery() {
    if (!this.#identity) return null;
    const recovery = RecoveryKey.generate();
    return { keyId: this.#identity.id, recovery, wrapped: wrap(this.#identity.identity, recovery) };
  }

  setRecovery(recovery, saved) {
    this.#file.setRecovery(recovery, saved);
    return this.#file.flush();
  }

  // The key directory.

  /**
   * Public keys from anywhere the server sends them. A key is a row that never
   * changes, so an id sent again with something else in it is not believed: the
   * first answer stands.
   */
  learn(keys) {
    for (const k of keys) {
      if (!k || this.#keys.has(k.id)) continue;
      this.#keys.set(k.id, k);
      // Key ids only grow: one of theirs newer than the one thought current
      // (met in a message before the push that announces it) is their current
      // one, and is asked about as such.
      const current = this.#current.get(k.userId);
      if (current !== undefined && current < k.id) this.#current.set(k.userId, k.id);
    }
  }

  #owner(key) {
    return this.#keys.get(key)?.userId;
  }

  /** Somebody published a new key (a `keys:changed` push). */
  keyChanged(key) {
    this.learn([key]);
    const current = this.#current.get(key.userId);
    if (this.#owner(key.id) === key.userId && (current === undefined || current < key.id)) {
      this.#current.set(key.userId, key.id);
    }
    // Your own account has a new key, made on another computer: this one's is spent.
    if (key.userId === this.#me && this.myKey !== key.id) this.state = KeyState.Locked;
  }

  /** The key ids among these that are not known yet. */
  unknown(ids) {
    return [...new Set(ids)].filter((id) => !this.#keys.has(id)).sort((a, b) => a - b);
  }

  peerHasKey(peer) {
    return this.#current.has(peer);
  }

  #publicOf(key) {
    const k = this.#keys.get(key);
    return k ? publicKey(k.publicKey) : null;
  }

  #pair(conversation, mine, peer, theirs) {
    // Their half has to be a key listed as theirs. Otherwise any key the server
    // published, under any id, would open as the other person's (or, paired
    // with yours, as your own words).
    if (peer === this.#me || this.#owner(theirs) !== peer) return null;
    const cached = this.#pairs.get(`${conversation}:${mine}:${theirs}`);
    if (cached) return cached;
    const pub = this.#publicOf(theirs);
    if (!pub) return null;
    const identity = this.#identity?.id === mine ? this.#identity.identity : this.#file.archivedIdentity(mine);
    if (!identity) return null;
    const key = pairKey(identity, this.#me, pub, peer, conversation);
    if (key) this.#pairs.set(`${conversation}:${mine}:${theirs}`, key);
    return key;
  }

  /** Seals something to both your current keys, whoever holds theirs. Everything that leaves goes through `#sealConfirmed`. */
  #seal(conversation, peer, aadText, plain) {
    const mine = this.ready ? this.myKey : null;
    if (mine === null) throw new SealFailed(SealError.NoKey);
    const theirs = this.#current.get(peer);
    if (theirs === undefined) throw new SealFailed(SealError.PeerHasNoKey);
    const key = this.#pair(conversation, mine, peer, theirs);
    if (!key) throw new SealFailed(SealError.PeerHasNoKey);
    return { text: key.seal(aadText, plain), senderKey: mine, recipientKey: theirs };
  }

  /**
   * Seals for the other person, but never to a key of theirs not accepted here.
   * The server says which key is theirs, and whoever holds a key it named reads
   * what is sealed to it: so the first one met is pinned and taken (as when the
   * conversation starts), and a change after it waits for the person to accept
   * it.
   */
  #sealConfirmed(conversation, peer, aadText, plain) {
    if (!this.ready || this.myKey === null) throw new SealFailed(SealError.NoKey);
    this.pin(peer);
    const theirs = this.#current.get(peer);
    if (theirs === undefined) throw new SealFailed(SealError.PeerHasNoKey);
    if (!this.#isAccepted(peer, theirs)) throw new SealFailed(SealError.KeyNotConfirmed);
    return this.#seal(conversation, peer, aadText, plain);
  }

  /**
   * Opens something sealed between you and `peer`; `fromMe` says which of the
   * two keys is yours. Also says whether their key is one accepted for them here.
   */
  #open(conversation, peer, [senderKey, recipientKey], fromMe, aadText, sealed) {
    const [mine, theirs] = fromMe ? [senderKey, recipientKey] : [recipientKey, senderKey];
    const plain = this.#pair(conversation, mine, peer, theirs)?.open(aadText, sealed);
    return plain ? { plain, confirmed: this.#confirm(peer, theirs) } : null;
  }

  /**
   * Whether `theirs` is a key accepted for `peer` here, first pinning their
   * current one if none was yet. One that isn't is remembered, so the
   * conversation can say their key changed. Either of the two people holding
   * the halves of a pair can seal anything in it, so a key nobody accepted is as
   * good as a stranger's.
   */
  #confirm(peer, theirs) {
    if (this.#file.pin(peer) === null) this.#acceptUpTo(peer, this.#current.get(peer) ?? theirs);
    if (this.#isAccepted(peer, theirs)) return true;
    if (!this.#unconfirmed.has(peer)) this.#unconfirmed.set(peer, new Set());
    this.#unconfirmed.get(peer).add(theirs);
    return false;
  }

  /**
   * Seals a message. `payload` is {body, file?, reply?, rev?, of?, mid?}; a new
   * message gets an id of its own, an edit keeps the one its message has.
   *
   * @returns {{text: string, senderKey: number, recipientKey: number}}
   * @throws {SealFailed}
   */
  sealMessage(conversation, peer, payload) {
    const out = { body: payload.body ?? '' };
    if (payload.file) out.file = payload.file;
    if (payload.reply) out.reply = payload.reply;
    out.mid = payload.mid ?? b64(random(16));
    if (payload.rev) out.rev = payload.rev;
    if (payload.of !== undefined && payload.of !== null) out.of = payload.of;
    const json = pad(encoder.encode(JSON.stringify(out)));
    return this.#sealConfirmed(conversation, peer, aad.message(conversation, this.#me), json);
  }

  /** @throws {SealFailed} */
  sealReactions(conversation, peer, message, emoji) {
    const json = pad(encoder.encode(JSON.stringify(emoji)));
    return this.#sealConfirmed(conversation, peer, aad.reaction(conversation, message, this.#me), json);
  }

  /**
   * A sealed message as the chat draws it. One that doesn't open here still
   * shows, saying so.
   */
  openMessage(m, peer) {
    const fromMe = m.userId === this.#me;
    const view = { file: null, call: null, unreadable: false, outOfPlace: false, unconfirmed: false, mid: null, rev: 0 };
    let body = '';
    let reply = null;
    let current = false;
    if (m.kind === 'call') {
      view.call = m.meta ?? null;
    } else {
      let opened = null;
      if (m.senderKey != null && m.recipientKey != null && m.sealed) {
        const got = this.#open(
          m.conversationId, peer, [m.senderKey, m.recipientKey], fromMe, aad.message(m.conversationId, m.userId), m.sealed,
        );
        const payload = got && parsePayload(got.plain);
        if (payload) opened = { payload, confirmed: got.confirmed, sealed: m.sealed };
      }
      if (opened) {
        const { payload: p, confirmed, sealed } = opened;
        const placed = this.#place(m, sealed, p);
        const shown = this.#texts.get(m.id)?.shown;
        if (placed === Placement.Superseded && shown) {
          return { ...shown, reactions: this.openReactions(m.conversationId, peer, m.id, m.reactions ?? []) };
        }
        if (placed === Placement.Refused) {
          view.unreadable = true;
          view.outOfPlace = true;
        } else {
          current = true;
          view.unconfirmed = !confirmed;
          view.mid = p.mid ?? null;
          view.rev = p.rev ?? 0;
          body = p.body;
          view.file = p.file ?? null;
          reply = p.reply ?? null;
        }
      } else {
        view.unreadable = true;
      }
    }
    const message = {
      id: m.id,
      conversationId: m.conversationId,
      userId: m.userId,
      body,
      attachmentHash: view.file ? (m.attachmentHash ?? null) : null,
      attachmentName: view.file?.name ?? null,
      attachmentBytes: view.file?.size ?? null,
      mediaType: view.file ? mediaTypeOf(view.file.mime) : null,
      editedAt: m.editedAt ?? null,
      reply,
      reactions: this.openReactions(m.conversationId, peer, m.id, m.reactions ?? []),
      createdAt: m.createdAt,
      private: view,
    };
    if (current) {
      const texts = this.#texts.get(m.id);
      if (texts) texts.shown = message;
    }
    return message;
  }

  /**
   * Where an opened text of `m` stands. Refused when its sealed text or its own
   * id was seen under another message id (sent again, or two swapped), or when
   * it is an edit of another message. Nothing is remembered of a text that is
   * refused, so it can't spoil the real one.
   *
   * A text of this message already seen and since replaced is superseded, not
   * refused: the newer one stays shown. Only the sender can make a new text, so
   * that is the server putting an old one back, or a page fetched before an
   * edit arriving after it; either way the old words are not shown, and the real
   * current ones are not covered by a refusal. A new text older than the one
   * shown, by the server's edit time and then its edit count, is late, and
   * superseded too.
   *
   * What was seen lives as long as the message is kept here (`forgetAllBut`): a
   * computer that never saw the newer text can't tell it was withheld, which is
   * as far as anything the server keeps can be checked.
   */
  #place(m, sealed, p) {
    const id = m.id;
    const nonce = nonceOf(sealed);
    if (!nonce) return Placement.Refused;
    const elsewhere = (this.#nonces.has(nonce) && this.#nonces.get(nonce) !== id)
      || (p.mid != null && this.#mids.has(p.mid) && this.#mids.get(p.mid) !== id)
      || (p.of != null && p.of !== id);
    if (!this.#texts.has(id)) this.#texts.set(id, { seen: [], current: null, edited: 0, rev: 0, shown: null });
    const t = this.#texts.get(id);
    if (t.current === nonce) return Placement.Current;
    if (elsewhere) return Placement.Refused;
    if (t.seen.includes(nonce)) return Placement.Superseded;
    const edited = m.editedAt ?? 0;
    const older = t.current !== null && before([edited, p.rev ?? 0], [t.edited, t.rev]);
    t.seen.push(nonce);
    if (!older) {
      t.current = nonce;
      t.edited = edited;
      t.rev = p.rev ?? 0;
    }
    this.#nonces.set(nonce, id);
    if (p.mid != null) this.#mids.set(p.mid, id);
    return older ? Placement.Superseded : Placement.Current;
  }

  /**
   * Forgets what was seen of every message but these: their texts, nonces and
   * own ids. The session keeps the messages it shows and the last of each
   * conversation, so a replay or a swap is still told among all of those; one
   * involving a message let go is told again once both are loaded together.
   */
  forgetAllBut(keep) {
    for (const map of [this.#texts, this.#nonces, this.#mids]) {
      for (const key of [...map.keys()]) {
        const id = map === this.#texts ? key : map.get(key);
        if (!keep.has(id)) map.delete(key);
      }
    }
  }

  /** An earlier text of `m`: null if it doesn't open here, or is not one of `m`'s. Seen, it can't be put back as the current one later. */
  openVersion(m, peer, v) {
    const conversation = m.conversationId;
    const author = m.userId;
    const got = this.#open(
      conversation, peer, [v.senderKey, v.recipientKey], author === this.#me, aad.message(conversation, author), v.sealed,
    );
    const p = got && parsePayload(got.plain);
    const nonce = nonceOf(v.sealed);
    if (!p || !nonce) return null;
    const now = m.private?.mid ?? null;
    const foreign = (this.#nonces.has(nonce) && this.#nonces.get(nonce) !== m.id)
      || (p.mid != null && this.#mids.has(p.mid) && this.#mids.get(p.mid) !== m.id)
      || (p.of != null && p.of !== m.id)
      || (p.mid != null && now !== null && p.mid !== now);
    if (foreign) return null;
    this.#nonces.set(nonce, m.id);
    if (p.mid != null) this.#mids.set(p.mid, m.id);
    if (!this.#texts.has(m.id)) this.#texts.set(m.id, { seen: [], current: null, edited: 0, rev: 0, shown: null });
    const t = this.#texts.get(m.id);
    if (!t.seen.includes(nonce)) t.seen.push(nonce);
    return p.body;
  }

  /** Everybody's sealed reactions to a message, opened and counted as a channel's are. */
  openReactions(conversation, peer, message, sealed) {
    const out = [];
    for (const r of sealed) {
      const got = this.#open(
        conversation, peer, [r.senderKey, r.recipientKey], r.userId === this.#me,
        aad.reaction(conversation, message, r.userId), r.sealed,
      );
      if (!got) continue;
      let emoji;
      try {
        emoji = JSON.parse(decoder.decode(got.plain));
      } catch {
        continue;
      }
      if (!Array.isArray(emoji) || !emoji.every((e) => typeof e === 'string')) continue;
      for (const e of emoji.slice(0, 20)) {
        const found = out.find((x) => x.emoji === e);
        if (!found) out.push({ emoji: e, count: 1, userIds: [r.userId] });
        else if (!found.userIds.includes(r.userId)) {
          found.count += 1;
          found.userIds.push(r.userId);
        }
      }
    }
    return out;
  }

  // Trust.

  /** The safety number between you and `peer`, with your current keys. */
  safetyNumber(peer) {
    if (!this.#identity) return null;
    const theirs = this.#current.has(peer) ? this.#publicOf(this.#current.get(peer)) : null;
    if (!theirs) return null;
    return safetyNumber({ id: this.#me, key: this.#identity.identity.public }, { id: peer, key: theirs });
  }

  #currentPublic(peer) {
    return this.#keys.get(this.#current.get(peer))?.publicKey ?? null;
  }

  /** Remembers `peer`'s key the first time it is seen, so a later change can be noticed. */
  pin(peer) {
    if (this.#file.pin(peer) === null && this.#current.has(peer)) this.#acceptUpTo(peer, this.#current.get(peer));
  }

  /**
   * `peer`'s key `id` is the one to compare theirs against from now on, and the
   * older keys the directory lists as theirs are accepted with it: what they
   * sealed before a change they made opens without a warning. Keys that turn up
   * later are not.
   */
  #acceptUpTo(peer, id) {
    const older = [...this.#keys.values()].filter((k) => k.userId === peer && k.id < id).map((k) => k.publicKey);
    this.#file.accept(peer, older);
    const k = this.#keys.get(id);
    if (k && k.userId === peer) this.#file.setPin(peer, k.publicKey);
  }

  /** Whether `key` is one of `peer`'s accepted here. */
  #isAccepted(peer, key) {
    const k = this.#keys.get(key);
    return Boolean(k && k.userId === peer && this.#file.accepted(peer, k.publicKey));
  }

  /** The id of the key pinned for `peer`, if the directory has it. */
  #pinId(peer) {
    const pin = this.#file.pin(peer);
    if (pin === null) return null;
    const ids = [...this.#keys.values()].filter((k) => k.userId === peer && k.publicKey === pin).map((k) => k.id);
    return ids.length ? Math.min(...ids) : null;
  }

  /**
   * `peer`'s current key is not one accepted for them, or something of theirs
   * opened with a key between the pinned one and it that isn't. Usually a
   * reinstall without the recovery key; it is also what somebody in the middle
   * would look like, so it is said, not hidden. A key older than the pinned one
   * that turns up now was never part of a change of theirs seen here: it is
   * marked on its messages, and accepting the change does not accept it.
   */
  keyChangedFor(peer) {
    if (this.#file.pin(peer) === null) return false;
    const current = this.#current.get(peer);
    if (current === undefined) return false;
    const since = this.#pinId(peer) ?? 0;
    if (!this.#isAccepted(peer, current)) return true;
    const seen = this.#unconfirmed.get(peer);
    return Boolean(seen && [...seen].some((k) => k > since && k < current && !this.#isAccepted(peer, k)));
  }

  /** The change was seen and accepted: their current key, and the ones between the pinned key and it, which are the change. */
  acceptKey(peer) {
    const current = this.#current.get(peer);
    if (current === undefined) return;
    const since = this.#pinId(peer) ?? 0;
    const between = [...this.#keys.values()].filter((k) => k.userId === peer && k.id > since && k.id < current).map((k) => k.publicKey);
    this.#file.accept(peer, between);
    const k = this.#keys.get(current);
    if (k) {
      this.#file.setPin(peer, k.publicKey);
      const verified = this.#file.verified(peer);
      if (verified !== null && verified !== k.publicKey) this.#file.setVerified(peer, null);
    }
    const seen = this.#unconfirmed.get(peer);
    this.#unconfirmed.delete(peer);
    const still = new Set([...(seen ?? [])].filter((id) => !this.#isAccepted(peer, id)));
    if (still.size) this.#unconfirmed.set(peer, still);
  }

  verified(peer) {
    const v = this.#file.verified(peer);
    const now = this.#currentPublic(peer);
    return v !== null && now !== null && v === now;
  }

  setVerified(peer, on) {
    const key = on ? this.#currentPublic(peer) : null;
    if (key) this.acceptKey(peer);
    this.#file.setVerified(peer, key);
  }

  /** What the tests look at. */
  get _counts() {
    return { texts: this.#texts.size, nonces: this.#nonces.size, mids: this.#mids.size };
  }

  _fileForTests() {
    return this.#file;
  }

  _sealRaw(conversation, peer, aadText, plain) {
    return this.#seal(conversation, peer, aadText, plain);
  }
}

/** The payload inside a sealed message, or null if it is not one. Trailing spaces are the padding. */
function parsePayload(plain) {
  try {
    const p = JSON.parse(decoder.decode(plain));
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    return {
      body: typeof p.body === 'string' ? p.body : '',
      file: validFile(p.file),
      reply: validReply(p.reply),
      mid: typeof p.mid === 'string' ? p.mid : null,
      rev: Number.isInteger(p.rev) && p.rev > 0 ? p.rev : 0,
      of: Number.isSafeInteger(p.of) ? p.of : null,
    };
  } catch {
    return null;
  }
}

/** The attachment's key and details, or null. The key is 32 bytes of base64url. */
function validFile(f) {
  if (!f || typeof f !== 'object') return null;
  const key = typeof f.key === 'string' ? f.key : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return null;
  return {
    key,
    name: typeof f.name === 'string' ? f.name : '',
    mime: typeof f.mime === 'string' ? f.mime : 'application/octet-stream',
    size: Number.isFinite(f.size) && f.size >= 0 ? f.size : 0,
  };
}

/** The message this answers, with a preview of it, or null. */
function validReply(r) {
  if (!r || typeof r !== 'object' || !Number.isSafeInteger(r.id)) return null;
  return {
    id: r.id,
    userId: Number.isSafeInteger(r.userId) ? r.userId : null,
    body: typeof r.body === 'string' ? r.body : '',
    attachmentName: typeof r.attachmentName === 'string' ? r.attachmentName : null,
    deleted: r.deleted === true,
  };
}
