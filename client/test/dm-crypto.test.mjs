// The cryptography of private conversations, against the answers Ciranda's own
// tests pin. Everything marked "known answer" was produced once by Ciranda's
// Rust (client/src/core/crypto.rs) and written down there: what is sealed and
// stored (messages on the server, wrapped keys, safety numbers people compared)
// has to keep opening and reading the same, so a result that differs from
// these is two programs that cannot talk to each other.
//
//   node --test client/test/dm-crypto.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  Identity, RecoveryKey, aad, b64, nonceOf, openFile, pad, pairKey, publicKey, random,
  safetyNumber, sealFile, sealWithNonceForTests, unb64, unwrap, wrap,
} from '../src/renderer/dm-crypto.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const fixed = () => [Identity.fromSecret(new Uint8Array(32).fill(0x11)), Identity.fromSecret(new Uint8Array(32).fill(0x22))];
const text = (s) => new TextEncoder().encode(s);
const flip = (sealed, at) => {
  const bytes = unb64(sealed);
  bytes[at < 0 ? bytes.length + at : at] ^= 1;
  return b64(bytes);
};

describe('the pieces agree with Ciranda to the byte (known answers)', () => {
  it('derives the public keys of two fixed identities', () => {
    const [a, b] = fixed();
    assert.equal(a.publicB64, 'e06Qm75__kTEZaIgA31gjuNYl9Me-XLwf3SJLLD3PxM');
    assert.equal(b.publicB64, 'D6poTtKIZ7l_Smot7l34zpdOdrcBjj8iocTPJnhXDyA');
  });

  it('agrees the pair key: HKDF-SHA256, salt "harmony-dm-v1", info conversation | lower id | key | higher id | key', () => {
    const [a, b] = fixed();
    const want = 'b0fc31987202b69061f05d8fb6f5209a170391eba63aaa4e056079cbd7050faf';
    assert.equal(hex(pairKey(a, 1, b.public, 2, 7).bytesForTests), want);
    assert.equal(hex(pairKey(b, 2, a.public, 1, 7).bytesForTests), want, 'the same from either side');
  });

  it('binds what a thing is and where it belongs, as Ciranda writes it', () => {
    assert.equal(aad.message(7, 1), 'harmony-dm-v1/message/7/1');
    assert.equal(aad.reaction(7, 100, 2), 'harmony-dm-v1/reaction/7/100/2');
    assert.equal(aad.call(7, 1), 'harmony-dm-v1/call/7/1');
    assert.equal(aad.message(-3, 9_007_199_254_740_991), 'harmony-dm-v1/message/-3/9007199254740991');
  });

  it('opens a message Ciranda sealed, and seals the very same bytes', () => {
    const [a, b] = fixed();
    const sealed = 'ATMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM4Fkr1GHru_b3hVjLtqVztcZHeCo3hqSFUr3hzlw';
    const k = pairKey(b, 2, a.public, 1, 7);
    assert.equal(new TextDecoder().decode(k.open(aad.message(7, 1), sealed)), '{"body":"oi"}');
    assert.equal(k.open(aad.message(7, 2), sealed), null, 'it belongs to the message of person 1');

    const bytes = unb64(sealed);
    assert.equal(bytes[0], 1);
    assert.deepEqual([...bytes.subarray(1, 25)], new Array(24).fill(0x33));
    assert.equal(bytes.length, 1 + 24 + 13 + 16);
    assert.equal(nonceOf(sealed), '33'.repeat(24));

    const again = b64(sealWithNonceForTests(k.bytesForTests, text(aad.message(7, 1)), text('{"body":"oi"}'), new Uint8Array(24).fill(0x33)));
    assert.equal(again, sealed);

    const later = unb64(sealed);
    later[0] = 2;
    assert.equal(k.open(aad.message(7, 1), b64(later)), null, 'another version is not read as this one');
  });

  it('opens a file Ciranda sealed', () => {
    const sealed = unb64('AXd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3dwAHN4bEUCaTQI39Vu7KX_vFf3RZlBpQO1ta');
    assert.equal(new TextDecoder().decode(openFile(new Uint8Array(32).fill(0x66), sealed)), 'file bytes');
  });

  it('shows a recovery key as Ciranda does and reads it however it was typed', () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, i) => (i * 13) & 0xff);
    const shown = '006H-M9SM-8575-PT3N-GA7S-SADP-RF8D-VTQQ';
    const r = new RecoveryKey(bytes);
    assert.equal(r.display(), shown);
    for (const typed of [
      shown,
      '006h m9sm 8575 pt3n ga7s sadp rf8d vtqq',
      'OO6H-M9SM-8575-PT3N-GA7S-SADP-RF8D-VTQQ',
      '006HM9SM8575PT3NGA7SSADPRF8DVTQQ',
    ]) {
      assert.equal(RecoveryKey.parse(typed).display(), shown, typed);
    }
    assert.equal(
      RecoveryKey.parse('1111-1111-1111-1111-1111-1111-1111-1111').display(),
      RecoveryKey.parse('IiLl-1111-1111-1111-1111-1111-1111-1111').display(),
    );
    // HKDF-SHA256, salt "harmony-recovery-v1", info "wrap identity".
    assert.equal(hex(r.wrappingKey()), '1a1f7e72a5523fe600c53989e36590567655d765c156ff0dc2089825fcdbc1ba');
  });

  it('opens the wrapping Ciranda made of a fixed identity, and makes the same one', () => {
    const [a] = fixed();
    const r = RecoveryKey.parse('006H-M9SM-8575-PT3N-GA7S-SADP-RF8D-VTQQ');
    const wrapped = 'AVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVbWXuqBjNMZkhU8tgZjfsPQ6TJ0qumXZuJddZM4bcF3OtQx0QmCbOScd47xAgzUwvg';
    const back = unwrap(wrapped, a.public, r);
    assert.deepEqual([...back.secret], [...a.secret]);
    const again = b64(sealWithNonceForTests(r.wrappingKey(), a.public, a.secret, new Uint8Array(24).fill(0x55)));
    assert.equal(again, wrapped);
  });

  it('computes the safety number Ciranda shows, from either side', () => {
    const [a, b] = fixed();
    const want = '13418 66612 62703 17296 72420 61925';
    assert.equal(safetyNumber({ id: 1, key: a.public }, { id: 2, key: b.public }), want);
    assert.equal(safetyNumber({ id: 2, key: b.public }, { id: 1, key: a.public }), want);
  });
});

describe('how it behaves', () => {
  it('two people agree on a key and nobody else does', () => {
    const [alice, bob, eve] = [Identity.generate(), Identity.generate(), Identity.generate()];
    const a = pairKey(alice, 1, bob.public, 2, 7);
    const b = pairKey(bob, 2, alice.public, 1, 7);
    const sealed = a.seal(aad.message(7, 1), text('olá, bob'));
    assert.equal(new TextDecoder().decode(b.open(aad.message(7, 1), sealed)), 'olá, bob');

    assert.equal(pairKey(eve, 3, alice.public, 1, 7).open(aad.message(7, 1), sealed), null);
    assert.equal(pairKey(bob, 2, alice.public, 1, 8).open(aad.message(7, 1), sealed), null, 'another conversation, another key');
  });

  it('a sealed thing does not open anywhere it was not sealed for', () => {
    const [alice, bob] = [Identity.generate(), Identity.generate()];
    const k = pairKey(alice, 1, bob.public, 2, 7);
    const sealed = k.seal(aad.reaction(7, 100, 1), text('["x"]'));
    assert.equal(k.open(aad.reaction(7, 101, 1), sealed), null, 'moved to another message');
    assert.equal(k.open(aad.reaction(7, 100, 2), sealed), null, 'claimed by the other person');
    assert.equal(k.open(aad.message(7, 1), sealed), null, 'passed off as a message');
    assert.equal(k.open(aad.reaction(7, 100, 1), flip(sealed, -1)), null, 'tampered with');
    assert.notEqual(k.open(aad.reaction(7, 100, 1), sealed), null);
  });

  it('seals the same text differently every time', () => {
    const [alice, bob] = [Identity.generate(), Identity.generate()];
    const k = pairKey(alice, 1, bob.public, 2, 7);
    const [one, two] = [k.seal('a', text('same')), k.seal('a', text('same'))];
    assert.notEqual(one, two);
    assert.notEqual(nonceOf(one), nonceOf(two));
    assert.equal(nonceOf('not sealed'), null);
  });

  it('refuses a small-order key', () => {
    assert.equal(pairKey(Identity.generate(), 1, new Uint8Array(32), 2, 7), null);
  });

  it('reads public keys only as 32 bytes of base64url', () => {
    const [a] = fixed();
    assert.deepEqual([...publicKey(a.publicB64)], [...a.public]);
    assert.equal(publicKey(b64(random(31))), null);
    assert.equal(publicKey(`${a.publicB64}=`), null, 'no padding');
    assert.equal(publicKey('not base64!'), null);
  });

  it('shows and reads recovery keys of 39 characters, and nothing else', () => {
    const r = RecoveryKey.generate();
    const shown = r.display();
    assert.equal(shown.length, 39);
    assert.equal(shown.split('-').length, 8);
    const typed = shown.toLowerCase().replaceAll('-', ' ').replaceAll('0', 'o').replaceAll('1', 'l');
    assert.equal(RecoveryKey.parse(typed).display(), shown);
    assert.equal(RecoveryKey.parse(shown.slice(0, 30)), null, 'too short');
    assert.equal(RecoveryKey.parse(`${shown}A`), null, 'too long');
    assert.equal(RecoveryKey.parse(shown.replace(/[0-9A-Z]/, 'U')), null, 'not in the alphabet');
  });

  it('opens a wrapped identity only with its recovery key', () => {
    const id = Identity.generate();
    const r = RecoveryKey.generate();
    const w = wrap(id, r);
    const back = unwrap(w, id.public, RecoveryKey.parse(r.display()));
    assert.deepEqual([...back.public], [...id.public]);
    assert.equal(unwrap(w, id.public, RecoveryKey.generate()), null);
    assert.equal(unwrap(w, Identity.generate().public, r), null, 'a wrapping is bound to its public key');
    assert.equal(unwrap('not a wrapping', id.public, r), null);
  });

  it('seals files under a key of their own', () => {
    const data = new Uint8Array(100_000).fill(7);
    const { sealed, key } = sealFile(data);
    assert.equal(sealed.length, data.length + 1 + 24 + 16);
    assert.deepEqual([...openFile(key, sealed)], [...data]);
    assert.equal(openFile(random(32), sealed), null);
  });

  it('pads to a multiple of 64 bytes, at least 128, and JSON still reads it', () => {
    const padded = pad(text('{"body":"hi"}'));
    assert.equal(padded.length, 128);
    assert.equal(pad(new Uint8Array(129).fill(0x78)).length, 192);
    assert.equal(pad(new Uint8Array(128).fill(0x78)).length, 128);
    assert.equal(JSON.parse(new TextDecoder().decode(padded)).body, 'hi');
  });

  it('shows the same safety number on both sides and another when a key changes', () => {
    const [a, b, c] = [Identity.generate(), Identity.generate(), Identity.generate()];
    const one = safetyNumber({ id: 1, key: a.public }, { id: 2, key: b.public });
    assert.equal(one, safetyNumber({ id: 2, key: b.public }, { id: 1, key: a.public }));
    assert.notEqual(one, safetyNumber({ id: 1, key: a.public }, { id: 2, key: c.public }));
    assert.match(one, /^(\d{5} ){5}\d{5}$/);
  });
});
