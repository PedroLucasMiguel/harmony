// The trust model of private conversations, as Ciranda's Vault tests pin it
// (client/src/dm.rs): who can read what, what happens when a key changes, and
// what a server that lies about keys or replays and shuffles messages gets.
// The calls and the legacy-upgrade paths of the Rust are not here: there are
// no private calls in Harmony, and no older Harmony kept keys another way.
//
//   node --test client/test/dm-vault.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Identity, RecoveryKey, aad, b64, pad, pairKey, random } from '../src/renderer/dm-crypto.js';
import { MemoryKeyFile, PersistentKeyFile } from '../src/renderer/dm-keyfile.js';
import { KeyState, SealError, SealFailed, Vault } from '../src/renderer/dm-vault.js';

const encoder = new TextEncoder();

/** Two people with keys published, and the directory each sees. */
async function pairUp() {
  const a = new Vault(new MemoryKeyFile(), 1);
  const b = new Vault(new MemoryKeyFile(), 2);
  assert.equal(a.onKeys({ keys: [], mine: null }), 'create');
  assert.equal(b.onKeys({ keys: [], mine: null }), 'create');
  const [ma, mb] = [Vault.create(), Vault.create()];
  const ka = { id: 10, publicKey: ma.identity.publicB64, wrapped: ma.wrapped };
  const kb = { id: 20, publicKey: mb.identity.publicB64, wrapped: mb.wrapped };
  await a.adopt(ka, ma.identity, ma.recovery, false);
  await b.adopt(kb, mb.identity, mb.recovery, false);
  a.keyChanged({ id: 20, userId: 2, publicKey: kb.publicKey, createdAt: 0 });
  b.keyChanged({ id: 10, userId: 1, publicKey: ka.publicKey, createdAt: 0 });
  return [a, b];
}

/** What `editDm` seals for an edit of `m`. */
const editOf = (m, body) => ({ body, reply: m.reply, mid: m.private.mid, rev: m.private.rev + 1, of: m.id });

const asSent = (sealed, id, from) => ({
  id, conversationId: 5, userId: from, kind: 'text', senderKey: sealed.senderKey, recipientKey: sealed.recipientKey,
  sealed: sealed.text, meta: null, attachmentHash: null, reactions: [], createdAt: 1, editedAt: null,
});
const sentAt = (sealed, id, from, editedAt) => ({ ...asSent(sealed, id, from), editedAt });

const hello = { body: 'oi' };
const thrown = (fn) => { try { fn(); } catch (e) { return e instanceof SealFailed ? e.code : e; } return null; };

/** The server's own key, published as somebody's, and something sealed with it as them to `to`. */
function forged(to, key, owner, aadText, plain) {
  const server = Identity.generate();
  const { id: mine, identity } = to._fileForTests().identity();
  const pk = pairKey(server, 2, identity.public, to.me, 5);
  return {
    info: { id: key, userId: owner, publicKey: server.publicB64, createdAt: 0 },
    sealed: { text: pk.seal(aadText, plain), senderKey: key, recipientKey: mine },
  };
}
const textOf = (body) => encoder.encode(JSON.stringify({ body }));

describe('opening and sealing', () => {
  it('a message opens on both sides', async () => {
    const [a, b] = await pairUp();
    const m = asSent(a.sealMessage(5, 2, { body: 'oi, tudo bem?' }), 1, 1);
    assert.equal(b.openMessage(m, 1).body, 'oi, tudo bem?');
    assert.equal(a.openMessage(m, 2).body, 'oi, tudo bem?', 'your own message opens too, on any of your computers');
  });

  it('a message moved to another conversation or sender does not open', async () => {
    const [a, b] = await pairUp();
    const m = asSent(a.sealMessage(5, 2, { body: 'x' }), 1, 1);
    assert.equal(b.openMessage({ ...m, userId: 2 }, 1).private.unreadable, true);
    assert.equal(b.openMessage({ ...m, conversationId: 6 }, 1).private.unreadable, true);
  });

  it('a reply and an earlier version open on the other side', async () => {
    const [a, b] = await pairUp();
    const reply = { id: 7, userId: 2, body: 'bora jogar?', attachmentName: null, deleted: false };
    const first = a.sealMessage(5, 2, { body: 'bora', reply });
    const v = { senderKey: first.senderKey, recipientKey: first.recipientKey, sealed: first.text, at: 1 };
    const sent = a.openMessage(asSent(first, 8, 1), 2);
    const edit = a.sealMessage(5, 2, editOf(sent, 'bora!'));
    const m = b.openMessage(asSent(edit, 8, 1), 1);
    assert.equal(m.body, 'bora!');
    assert.deepEqual(m.reply, reply);
    assert.equal(b.openVersion(m, 1, v), 'bora');
    assert.equal(b.openVersion({ ...m, userId: 2 }, 1, v), null, "passed off as the other person's, it doesn't open");
  });

  it('a file travels as its key and details inside the message', async () => {
    const [a, b] = await pairUp();
    const file = { key: b64(random(32)), name: 'foto.png', mime: 'image/png', size: 1234 };
    const m = b.openMessage({ ...asSent(a.sealMessage(5, 2, { body: '', file }), 1, 1), attachmentHash: 'f'.repeat(64) }, 1);
    assert.deepEqual(m.private.file, file);
    assert.equal(m.attachmentName, 'foto.png');
    assert.equal(m.attachmentBytes, 1234);
    assert.equal(m.mediaType, 'image');
    assert.equal(m.attachmentHash, 'f'.repeat(64));
  });

  it('reactions count up across both people', async () => {
    const [a, b] = await pairUp();
    const ra = a.sealReactions(5, 2, 9, ['👍', '🔥']);
    const rb = b.sealReactions(5, 1, 9, ['👍']);
    const sealed = [
      { userId: 1, senderKey: ra.senderKey, recipientKey: ra.recipientKey, sealed: ra.text },
      { userId: 2, senderKey: rb.senderKey, recipientKey: rb.recipientKey, sealed: rb.text },
    ];
    const counted = b.openReactions(5, 1, 9, sealed);
    assert.deepEqual(counted[0], { emoji: '👍', count: 2, userIds: [1, 2] });
    assert.equal(counted[1].emoji, '🔥');
    assert.deepEqual(b.openReactions(5, 1, 10, sealed), [], 'moved to another message, they open as nothing');
  });

  it('nobody without a key can be written to', async () => {
    const [a] = await pairUp();
    assert.equal(thrown(() => a.sealMessage(5, 99, {})), SealError.PeerHasNoKey);
  });

  it('what this version seals reads as a reader that knows only the body: unknown fields are ignored', async () => {
    const [a, b] = await pairUp();
    const sealed = a.sealMessage(5, 2, { body: 'de agora' });
    const old = JSON.parse(new TextDecoder().decode(b._fileForTests().identity() && pairKey(
      b._fileForTests().identity().identity, 2, a._fileForTests().identity().identity.public, 1, 5,
    ).open(aad.message(5, 1), sealed.text)));
    assert.equal(old.body, 'de agora');
    assert.equal(typeof old.mid, 'string');
  });

  it('seals a payload the way Ciranda writes it: the fields it has and no others, padded', async () => {
    const [a, b] = await pairUp();
    const sealed = a.sealMessage(5, 2, { body: 'oi' });
    const pk = pairKey(b._fileForTests().identity().identity, 2, a._fileForTests().identity().identity.public, 1, 5);
    const plain = pk.open(aad.message(5, 1), sealed.text);
    assert.equal(plain.length, 128, 'padded to 128 at least');
    const json = JSON.parse(new TextDecoder().decode(plain));
    assert.deepEqual(Object.keys(json), ['body', 'mid'], 'no rev, no of, no file, no reply on a new message');
    assert.equal(b64(Uint8Array.from(Buffer.from(json.mid, 'base64url'))), json.mid);
    const edit = JSON.parse(new TextDecoder().decode(pk.open(aad.message(5, 1),
      a.sealMessage(5, 2, { body: 'oi!', mid: json.mid, rev: 1, of: 7 }).text)));
    assert.deepEqual(Object.keys(edit), ['body', 'mid', 'rev', 'of']);
  });
});

describe('your own key', () => {
  it('another computer unlocks with the recovery key and only with it', async () => {
    const identity = Identity.generate();
    const recovery = RecoveryKey.generate();
    const { wrap } = await import('../src/renderer/dm-crypto.js');
    const mine = { id: 3, publicKey: identity.publicB64, wrapped: wrap(identity, recovery) };
    const v = new Vault(new MemoryKeyFile(), 1);
    assert.equal(v.onKeys({ keys: [], mine }), 'nothing');
    assert.equal(v.state, KeyState.Locked);
    assert.equal(await v.unlock('ABCD-EFGH'), false);
    assert.equal(await v.unlock(RecoveryKey.generate().display()), false);
    assert.equal(await v.unlock(recovery.display().toLowerCase()), true);
    assert.equal(v.state, KeyState.Ready);
    assert.equal(v.needsBackup, false, 'they typed it in, so they have it');
  });

  it('a new key made elsewhere locks this computer', async () => {
    const [a] = await pairUp();
    a.keyChanged({ id: 11, userId: 1, publicKey: Identity.generate().publicB64, createdAt: 0 });
    assert.equal(a.state, KeyState.Locked);
    assert.equal(thrown(() => a.sealMessage(5, 2, {})), SealError.NoKey);
  });

  it('a recovery key made here is shown until it is kept somewhere, and then not again', async () => {
    const [a] = await pairUp();
    assert.equal(a.needsBackup, true);
    assert.match(a.recovery(), /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    await a.markBackedUp();
    assert.equal(a.needsBackup, false);
    assert.equal(a.recovery(), null);
    assert.equal(a.hasRecovery(), false);
    assert.ok(a.newRecovery().wrapped, 'a new one can be made while the key is here');
  });

  it('an unclear answer keeps your key and a null one archives it', async () => {
    const [a, b] = await pairUp();
    const before = b.sealMessage(5, 1, { body: 'guardado' });
    const mine = { id: 10, userId: 1, publicKey: a._fileForTests().identity().identity.publicB64, createdAt: 0 };
    assert.equal(a.onKeys({ keys: [mine], mine: undefined }), 'nothing');
    assert.equal(a.myKey, 10);
    assert.equal(a.state, KeyState.Ready);
    assert.equal(a.onKeys({}), 'nothing', 'a reply without the field at all');
    assert.equal(a.myKey, 10);

    assert.equal(a.onKeys({ keys: [], mine: null }), 'create');
    assert.equal(a.myKey, null);
    const made = Vault.create();
    await a.adopt({ id: 11, publicKey: made.identity.publicB64, wrapped: made.wrapped }, made.identity, made.recovery, false);
    assert.equal(a.openMessage(asSent(before, 1, 2), 2).body, 'guardado', 'sealed to the old key, still opens here');
  });
});

describe('when their key changes', () => {
  it('is noticed until it is accepted', async () => {
    const [a] = await pairUp();
    a.pin(2);
    assert.equal(a.keyChangedFor(2), false);
    a.keyChanged({ id: 21, userId: 2, publicKey: Identity.generate().publicB64, createdAt: 0 });
    assert.equal(a.keyChangedFor(2), true);
    a.acceptKey(2);
    assert.equal(a.keyChangedFor(2), false);
  });

  it('nothing is sealed to a changed key until it is accepted', async () => {
    const [a] = await pairUp();
    assert.equal(a.sealMessage(5, 2, hello).recipientKey, 20, 'first contact: their key is taken');

    a.keyChanged({ id: 21, userId: 2, publicKey: Identity.generate().publicB64, createdAt: 0 });
    assert.equal(thrown(() => a.sealMessage(5, 2, hello)), SealError.KeyNotConfirmed);
    assert.equal(thrown(() => a.sealReactions(5, 2, 9, ['👍'])), SealError.KeyNotConfirmed);
    assert.equal(a.keyChangedFor(2), true, 'and the conversation says so');

    a.acceptKey(2);
    assert.equal(a.sealMessage(5, 2, hello).recipientKey, 21, 'accepted: sealed to the new key');
    assert.ok(a.sealReactions(5, 2, 9, ['👍']));

    // Marking the safety number as checked accepts a change too.
    a.keyChanged({ id: 22, userId: 2, publicKey: Identity.generate().publicB64, createdAt: 0 });
    assert.ok(thrown(() => a.sealMessage(5, 2, hello)));
    a.setVerified(2, true);
    assert.equal(a.sealMessage(5, 2, hello).recipientKey, 22);
    assert.equal(a.verified(2), true);
    a.keyChanged({ id: 23, userId: 2, publicKey: Identity.generate().publicB64, createdAt: 0 });
    assert.equal(a.verified(2), false, 'verified is a statement about one key, and it is no longer their current one');
  });

  it('first contact is sealed without asking even after they changed keys', async () => {
    const [a] = await pairUp();
    const file = new MemoryKeyFile();
    const mine = a._fileForTests().identity();
    file.setIdentity(mine.id, mine.identity);
    const fresh = new Vault(file, 1);
    const [older, newer] = [Identity.generate(), Identity.generate()];
    const own = { id: mine.id, publicKey: mine.identity.publicB64, wrapped: 'x' };
    fresh.onKeys({ keys: [{ id: 10, userId: 1, publicKey: own.publicKey }], mine: own });
    fresh.learn([
      { id: 19, userId: 2, publicKey: older.publicB64, createdAt: 0 },
      { id: 23, userId: 2, publicKey: newer.publicB64, createdAt: 0 },
    ]);
    fresh.keyChanged({ id: 23, userId: 2, publicKey: newer.publicB64, createdAt: 0 });
    assert.equal(file.pin(2), null);
    const sealed = fresh.sealMessage(5, 2, { body: 'primeira' });
    assert.equal(sealed.recipientKey, 23);
    assert.equal(file.pin(2), newer.publicB64, 'pinned as it was sealed to');
    assert.equal(fresh.keyChangedFor(2), false);
  });

  it('a key that is not the peer\'s does not open as theirs', async () => {
    const [a] = await pairUp();
    a.pin(2);

    // Listed as somebody else's: refused outright.
    const eve = forged(a, 30, 3, aad.message(5, 2), textOf('pix pra essa conta'));
    a.learn([eve.info]);
    assert.equal(a.openMessage(asSent(eve.sealed, 1, 2), 2).private.unreadable, true);
    assert.equal(a.keyChangedFor(2), false);

    // Listed as theirs, but not one this computer accepted: marked, said.
    const fake = forged(a, 31, 2, aad.message(5, 2), textOf('pix pra essa conta'));
    a.learn([fake.info]);
    const m = a.openMessage(asSent(fake.sealed, 2, 2), 2);
    assert.equal(m.private.unconfirmed, true);
    assert.equal(a.keyChangedFor(2), true);
  });

  it('accepting a change does not accept a key slipped into old history', async () => {
    const [a] = await pairUp();
    a.pin(2);
    const old = forged(a, 5, 2, aad.message(5, 2), textOf('antigo'));
    a.learn([old.info]);
    const slipped = asSent(old.sealed, 1, 2);
    assert.equal(a.openMessage(slipped, 2).private.unconfirmed, true);
    assert.equal(a.keyChangedFor(2), false, 'older than the pinned key: marked on the message, not a change of theirs');

    const fresh = forged(a, 21, 2, aad.message(5, 2), textOf('troquei de pc'));
    a.learn([fresh.info]);
    assert.equal(a.keyChangedFor(2), true);
    a.acceptKey(2);
    assert.equal(a.keyChangedFor(2), false);
    assert.equal(a.openMessage(asSent(fresh.sealed, 2, 2), 2).private.unconfirmed, false);
    assert.equal(a.openMessage(slipped, 2).private.unconfirmed, true, 'still marked');
  });
});

describe('a server that replays, shuffles or withholds', () => {
  it('a replayed or swapped message is refused', async () => {
    const [a, b] = await pairUp();
    const one = a.sealMessage(5, 2, { body: 'um' });
    const two = a.sealMessage(5, 2, { body: 'dois' });
    assert.equal(b.openMessage(asSent(one, 1, 1), 1).body, 'um');
    assert.equal(b.openMessage(asSent(two, 2, 1), 1).body, 'dois');
    assert.equal(b.openMessage(asSent(one, 1, 1), 1).body, 'um', 'the same message again is fine');

    const again = b.openMessage(asSent(one, 3, 1), 1);
    assert.equal(again.private.outOfPlace && again.body === '', true, 'sent again under a new id');
    assert.equal(b.openMessage(asSent(two, 1, 1), 1).private.outOfPlace, true, 'swapped');
    assert.equal(b.openMessage(asSent(one, 2, 1), 1).private.outOfPlace, true, 'swapped');
    const three = a.sealMessage(5, 2, {});
    assert.equal(b.openMessage(asSent(three, 3, 1), 1).private.outOfPlace, false, 'a refused text left id 3 free');

    // One sealed before messages had ids: told by its nonce.
    const old = a._sealRaw(5, 2, aad.message(5, 1), pad(encoder.encode('{"body":"antigo"}')));
    assert.equal(b.openMessage(asSent(old, 7, 1), 1).body, 'antigo');
    assert.equal(b.openMessage(asSent(old, 9, 1), 1).private.outOfPlace, true);
  });

  it('an earlier text put back is not shown and an edit does not move', async () => {
    const [a, b] = await pairUp();
    const first = a.sealMessage(5, 2, { body: '5 reais' });
    const sent = a.openMessage(asSent(first, 4, 1), 2);
    const edit = a.sealMessage(5, 2, editOf(sent, '50 reais'));
    assert.equal(b.openMessage(sentAt(first, 4, 1, null), 1).body, '5 reais');
    assert.equal(b.openMessage(sentAt(edit, 4, 1, 2), 1).body, '50 reais');
    const back = b.openMessage(sentAt(first, 4, 1, 3), 1);
    assert.equal(back.body, '50 reais', 'the earlier text put back: the newer one stays');
    assert.equal(back.private.outOfPlace, false);
    assert.equal(b.openMessage(sentAt(edit, 4, 1, 2), 1).body, '50 reais');

    // On a computer that saw none of it, an edit still can't go on another message.
    const mine = b._fileForTests().identity();
    const file = new MemoryKeyFile();
    file.setIdentity(mine.id, mine.identity);
    const d = new Vault(file, 2);
    d.onKeys({ keys: [{ id: 10, userId: 1, publicKey: a._fileForTests().identity().identity.publicB64 }], mine: { id: 20, publicKey: mine.identity.publicB64, wrapped: 'x' } });
    assert.equal(d.openMessage(sentAt(edit, 6, 1, 2), 1).private.outOfPlace, true);
  });

  it('a late original does not replace its edit', async () => {
    const [a, b] = await pairUp();
    const first = a.sealMessage(5, 2, { body: 'bom dia' });
    const sent = a.openMessage(asSent(first, 4, 1), 2);
    const edit = a.sealMessage(5, 2, editOf(sent, 'boa tarde'));
    assert.equal(b.openMessage(sentAt(edit, 4, 1, 2), 1).body, 'boa tarde');
    const late = b.openMessage(sentAt(first, 4, 1, null), 1);
    assert.equal(late.body, 'boa tarde', 'it waited for its key; the edit stays');
    assert.equal(late.private.outOfPlace, false);
  });

  it('edits from a computer that missed one, and edits without an id or a count, are taken', async () => {
    const [a, b] = await pairUp();
    const first = a.sealMessage(5, 2, { body: 'v1' });
    const sent = a.openMessage(asSent(first, 4, 1), 2);
    const second = a.sealMessage(5, 2, editOf(sent, 'v2'));
    const seen = a.openMessage(sentAt(second, 4, 1, 2), 2);
    const third = a.sealMessage(5, 2, editOf(seen, 'v3'));
    assert.equal(b.openMessage(sentAt(first, 4, 1, null), 1).body, 'v1');
    assert.equal(b.openMessage(sentAt(second, 4, 1, 2), 1).body, 'v2');
    assert.equal(b.openMessage(sentAt(third, 4, 1, 3), 1).body, 'v3');

    // Their other computer only saw v1, so its edit counts 1: newer all the same.
    const stale = a.sealMessage(5, 2, editOf(sent, 'v4'));
    assert.equal(b.openMessage(sentAt(stale, 4, 1, 4), 1).body, 'v4');

    // And an edit sealed without an id or a count.
    const bare = a._sealRaw(5, 2, aad.message(5, 1), pad(encoder.encode('{"body":"v5"}')));
    const m = b.openMessage(sentAt(bare, 4, 1, 5), 1);
    assert.equal(m.body, 'v5');
    assert.equal(m.private.outOfPlace, false);
  });

  it('what the session lets go the vault forgets, and what it keeps stays checked', async () => {
    const [a, b] = await pairUp();
    const one = a.sealMessage(5, 2, { body: 'um' });
    const two = a.sealMessage(5, 2, { body: 'dois' });
    b.openMessage(asSent(one, 1, 1), 1);
    b.openMessage(asSent(two, 2, 1), 1);
    assert.deepEqual(b._counts, { texts: 2, nonces: 2, mids: 2 });

    b.forgetAllBut(new Set([1]));
    assert.deepEqual(b._counts, { texts: 1, nonces: 1, mids: 1 });
    assert.equal(b.openMessage(asSent(one, 3, 1), 1).private.outOfPlace, true, 'a message kept is still told replayed');

    b.forgetAllBut(new Set());
    assert.deepEqual(b._counts, { texts: 0, nonces: 0, mids: 0 });
    assert.equal(b.openMessage(asSent(one, 1, 1), 1).body, 'um', 'loaded again, it opens as before');
  });
});

describe('the keys on this computer, kept between runs', () => {
  /** A backend in memory: the record as written, and a seal that only this "keychain" opens. */
  const backend = (stored = null, { open = true } = {}) => ({
    stored,
    async load() { return this.stored; },
    async save(record) { this.stored = structuredClone(record); },
    async seal(text) { return `sealed:${text}`; },
    async unseal(sealed) { return open && sealed.startsWith('sealed:') ? sealed.slice(7) : ''; },
  });

  it('survive a restart, with the identity sealed and the pins and accepted keys intact', async () => {
    const be = backend();
    const file = await PersistentKeyFile.open(be, 'test');
    const identity = Identity.generate();
    const recovery = RecoveryKey.generate();
    file.setIdentity(7, identity);
    file.setRecovery(recovery, false);
    file.setPin(2, 'pin-one');
    file.setPin(2, 'pin-two');
    file.setVerified(2, 'pin-two');
    await file.flush();
    assert.match(be.stored.secret, /^sealed:[0-9a-f]{64}$/, 'on disk only sealed');
    assert.match(be.stored.recovery, /^sealed:/);

    const back = await PersistentKeyFile.open(backend(be.stored), 'test');
    assert.equal(back.identity().id, 7);
    assert.deepEqual([...back.identity().identity.public], [...identity.public]);
    assert.equal(back.recovery().display(), recovery.display());
    assert.equal(back.pin(2), 'pin-two');
    assert.equal(back.accepted(2, 'pin-one'), true, 'the pin it replaced stays accepted');
    assert.equal(back.verified(2), 'pin-two');
  });

  it('archive the key a new one replaces, so what was sealed to it still opens', async () => {
    const be = backend();
    const file = await PersistentKeyFile.open(be, 'test');
    const [one, two] = [Identity.generate(), Identity.generate()];
    file.setIdentity(1, one);
    file.setIdentity(2, two);
    await file.flush();
    const back = await PersistentKeyFile.open(backend(be.stored), 'test');
    assert.equal(back.identity().id, 2);
    assert.deepEqual([...back.archivedIdentity(1).public], [...one.public]);
  });

  it('keep the recovery key only until it is saved somewhere', async () => {
    const be = backend();
    const file = await PersistentKeyFile.open(be, 'test');
    file.setIdentity(1, Identity.generate());
    file.setRecovery(RecoveryKey.generate(), false);
    await file.flush();
    assert.equal(file.recoverySaved(), false);
    file.markRecoverySaved();
    await file.flush();
    assert.equal(be.stored.recovery, '', 'gone from disk as well');
    assert.equal(file.recoverySaved(), true);
    assert.equal(file.hasRecovery(), false);
  });

  it('a keychain that does not answer is not a reason to lose the key or ask for the recovery key', async () => {
    const be = backend();
    const file = await PersistentKeyFile.open(be, 'test');
    file.setIdentity(1, Identity.generate());
    file.setIdentity(2, Identity.generate());
    await file.flush();
    const sealedBefore = { secret: be.stored.secret, archive: { ...be.stored.archive } };

    const locked = await PersistentKeyFile.open(backend(be.stored, { open: false }), 'test');
    assert.equal(locked.identityLocked(), true);
    assert.equal(locked.identity(), null);
    locked.setPin(2, 'a-pin');
    await locked.flush();
    // What was written back keeps the sealed secrets as they were.
    assert.equal(locked.identityLocked(), true);
    const record = (await locked.flush(), be.stored);
    assert.equal(record.secret, sealedBefore.secret);
    assert.deepEqual(record.archive, sealedBefore.archive);

    const vault = new Vault(locked, 1);
    assert.equal(vault.onKeys({ keys: [], mine: { id: 2, publicKey: 'x', wrapped: 'y' } }), 'nothing');
    assert.equal(vault.state, KeyState.Failed);
  });
});
