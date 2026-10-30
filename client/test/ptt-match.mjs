// Push to talk's key matching, fed key events directly: what the global key hook
// would send, with no keyboard, no Electron and no permission involved.
//
//   node --test client/test/ptt-match.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse, createMatcher } = require('../src/main/ptt-match.js');

// The hook's key table, as far as these tests need it.
const K = {
  V: 47, F13: 91, Space: 57, Enter: 28, NumpadEnter: 3612, Numpad5: 76, Numpad7: 71, NumpadHome: 60999, NumpadDecimal: 83, NumpadDelete: 61011,
  NumLock: 69, Minus: 12, CapsLock: 58, ArrowUp: 57416,
};

const mouse = (button, mods = {}) => ({ button, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
const ev = (keycode, mods = {}) => ({ keycode, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
const run = (accelerator, steps) => {
  const seen = [];
  const matcher = createMatcher(parse(accelerator, K), (held) => seen.push(held));
  for (const [type, event] of steps) matcher[type](event);
  return seen;
};

describe('parsing a binding', () => {
  it('reads a bare key, a function key and a combination', () => {
    assert.deepEqual(parse('V', K).codes, [K.V]);
    assert.deepEqual(parse('F13', K).codes, [K.F13]);
    const combo = parse('Ctrl+Shift+V', K);
    assert.deepEqual([combo.ctrl, combo.shift, combo.alt, combo.meta], [true, true, false, false]);
  });
  it('knows the names the recorder writes', () => {
    assert.deepEqual(parse('Space', K).codes, [K.Space]);
    assert.deepEqual(parse('num5', K).codes, [K.Numpad5]);
    assert.deepEqual(parse('-', K).codes, [K.Minus]);
    assert.deepEqual(parse('Capslock', K).codes, [K.CapsLock]);
    assert.deepEqual(parse('Up', K).codes, [K.ArrowUp]);
    assert.equal(parse('Command+V', K).meta, true);
    assert.equal(parse('Super+V', K).meta, true);
  });
  it('takes either Enter, since the recorder cannot tell them apart', () => {
    assert.deepEqual(parse('Enter', K).codes, [K.Enter, K.NumpadEnter]);
  });
  it('refuses what it cannot watch for', () => {
    assert.equal(parse('MediaPlayPause', K), null);
    assert.equal(parse('Ctrl+Nonsense+V', K), null);
    assert.equal(parse('', K), null);
  });
});

describe('held and not held', () => {
  it('reports the press once however long the key repeats, then the release', () => {
    assert.deepEqual(run('V', [['keydown', ev(K.V)], ['keydown', ev(K.V)], ['keydown', ev(K.V)], ['keyup', ev(K.V)]]), [true, false]);
  });
  it('ignores other keys', () => {
    assert.deepEqual(run('V', [['keydown', ev(K.Space)], ['keyup', ev(K.Space)]]), []);
  });
  it('takes exact modifiers: a bare binding is not Ctrl + the key', () => {
    assert.deepEqual(run('V', [['keydown', ev(K.V, { ctrlKey: true })], ['keyup', ev(K.V, { ctrlKey: true })]]), []);
  });
  it('and a combination is not a smaller or a bigger one', () => {
    const steps = (mods) => [['keydown', ev(K.V, mods)], ['keyup', ev(K.V, mods)]];
    assert.deepEqual(run('Ctrl+Shift+V', steps({ ctrlKey: true })), []);
    assert.deepEqual(run('Ctrl+Shift+V', steps({ ctrlKey: true, shiftKey: true, altKey: true })), []);
    assert.deepEqual(run('Ctrl+Shift+V', steps({ ctrlKey: true, shiftKey: true })), [true, false]);
  });
  it('lets go when a modifier comes up before the key', () => {
    const both = { ctrlKey: true, shiftKey: true };
    assert.deepEqual(run('Ctrl+Shift+V', [
      ['keydown', ev(K.V, both)],
      ['keyup', ev(29, { shiftKey: true })], // Ctrl released: the flags no longer match
      ['keyup', ev(K.V, { shiftKey: true })],
    ]), [true, false]);
  });
  it('is not confused by a release that was never preceded by a press', () => {
    assert.deepEqual(run('V', [['keyup', ev(K.V)]]), []);
  });
  it('reset closes a key that was down, once', () => {
    const seen = [];
    const matcher = createMatcher(parse('V', K), (held) => seen.push(held));
    matcher.keydown(ev(K.V));
    matcher.reset();
    matcher.reset();
    assert.deepEqual(seen, [true, false]);
  });
});

describe('the numpad', () => {
  it('knows the numpad\'s own Enter and Num Lock', () => {
    assert.deepEqual(parse('numenter', K).codes, [K.NumpadEnter]);
    assert.deepEqual(parse('Numlock', K).codes, [K.NumLock]);
  });
  it('takes a numpad key the same with Num Lock off, when it sends the key printed on it', () => {
    assert.deepEqual(parse('num7', K).codes, [K.Numpad7, K.NumpadHome]);
    assert.deepEqual(parse('num7', K).aliases, [K.NumpadHome]);
    assert.deepEqual(parse('numdec', K).codes, [K.NumpadDecimal, K.NumpadDelete]);
    // Num 5 has nothing printed under it.
    assert.deepEqual(parse('num5', K).aliases, []);
  });
  it('holds for either', () => {
    assert.deepEqual(run('num7', [['keydown', ev(K.NumpadHome)], ['keyup', ev(K.NumpadHome)]]), [true, false]);
    assert.deepEqual(run('num7', [['keydown', ev(K.Numpad7)], ['keyup', ev(K.Numpad7)]]), [true, false]);
  });
});

describe('the mouse', () => {
  it('reads the buttons past left and right, and refuses those two', () => {
    assert.equal(parse('Mouse4', K).button, 4);
    assert.equal(parse('Mouse5', K).button, 5);
    assert.equal(parse('Mouse3', K).button, 3);
    assert.deepEqual(parse('Mouse4', K).codes, []);
    assert.equal(parse('Mouse1', K), null);
    assert.equal(parse('Mouse2', K), null);
  });
  it('can be combined with the modifiers', () => {
    const b = parse('Ctrl+Mouse4', K);
    assert.deepEqual([b.button, b.ctrl], [4, true]);
  });
  const mrun = (accelerator, steps) => {
    const seen = [];
    const matcher = createMatcher(parse(accelerator, K), (held) => seen.push(held));
    for (const [type, event] of steps) matcher[type](event);
    return seen;
  };
  it('is held while the button is down', () => {
    assert.deepEqual(mrun('Mouse4', [['mousedown', mouse(4)], ['mouseup', mouse(4)]]), [true, false]);
  });
  it('ignores the other buttons and the keyboard', () => {
    assert.deepEqual(mrun('Mouse4', [['mousedown', mouse(5)], ['mouseup', mouse(5)], ['keydown', ev(K.V)], ['keyup', ev(K.V)]]), []);
    assert.deepEqual(mrun('V', [['mousedown', mouse(4)], ['mouseup', mouse(4)]]), []);
  });
  it('takes exact modifiers, and lets go when one comes up first', () => {
    assert.deepEqual(mrun('Mouse4', [['mousedown', mouse(4, { ctrlKey: true })], ['mouseup', mouse(4, { ctrlKey: true })]]), []);
    assert.deepEqual(mrun('Ctrl+Mouse4', [['mousedown', mouse(4, { ctrlKey: true })], ['keyup', ev(29)], ['mouseup', mouse(4)]]), [true, false]);
  });
});
