// Which key presses change the size of the interface, fed key events directly.
//
//   node --test client/test/zoom-keys.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { zoomKey } = require('../src/main/zoom-keys.js');

const key = (code, keyChar, mods = {}) => ({
  type: 'keyDown', code, key: keyChar, shift: false, alt: false, control: false, meta: false, ...mods,
});
const ctrl = { control: true };

describe('making the interface bigger', () => {
  it('Ctrl+= (the + key without Shift), Ctrl+Shift+= and the numpad\'s +', () => {
    assert.equal(zoomKey(key('Equal', '=', ctrl), 'win32'), 'bigger');
    assert.equal(zoomKey(key('Equal', '+', { ...ctrl, shift: true }), 'win32'), 'bigger');
    assert.equal(zoomKey(key('NumpadAdd', '+', ctrl), 'linux'), 'bigger');
  });

  it('a layout with + on a key of its own, by the character it gives', () => {
    assert.equal(zoomKey(key('BracketRight', '+', ctrl), 'win32'), 'bigger');
  });

  it('Cmd+= on macOS, and not Ctrl+=', () => {
    assert.equal(zoomKey(key('Equal', '=', { meta: true }), 'darwin'), 'bigger');
    assert.equal(zoomKey(key('Equal', '=', ctrl), 'darwin'), null);
  });
});

describe('making it smaller and putting it back', () => {
  it('Ctrl+- and the numpad\'s -', () => {
    assert.equal(zoomKey(key('Minus', '-', ctrl), 'win32'), 'smaller');
    assert.equal(zoomKey(key('NumpadSubtract', '-', ctrl), 'win32'), 'smaller');
  });

  it('Ctrl+0, and the numpad\'s 0', () => {
    assert.equal(zoomKey(key('Digit0', '0', ctrl), 'win32'), 'reset');
    assert.equal(zoomKey(key('Numpad0', '0', ctrl), 'linux'), 'reset');
  });
});

describe('what is left alone', () => {
  it('the keys without the modifier, with Alt (AltGr types characters), or on release', () => {
    assert.equal(zoomKey(key('Equal', '='), 'win32'), null);
    assert.equal(zoomKey(key('Minus', '-'), 'win32'), null);
    assert.equal(zoomKey(key('Equal', '=', { control: true, alt: true }), 'win32'), null);
    assert.equal(zoomKey({ ...key('Equal', '=', ctrl), type: 'keyUp' }, 'win32'), null);
  });

  it('other keys with the modifier', () => {
    assert.equal(zoomKey(key('KeyA', 'a', ctrl), 'win32'), null);
    assert.equal(zoomKey(key('Digit1', '1', ctrl), 'win32'), null);
  });
});
