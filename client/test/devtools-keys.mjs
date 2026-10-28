// Which key presses open the developer tools, fed key events directly.
//
//   node --test client/test/devtools-keys.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { opensDevTools } = require('../src/main/devtools-keys.js');

const key = (code, mods = {}) => ({
  type: 'keyDown', code, shift: false, alt: false, control: false, meta: false, isAutoRepeat: false, ...mods,
});

describe('opening the developer tools', () => {
  it('Ctrl+Shift+I on Windows and Linux', () => {
    for (const platform of ['win32', 'linux']) {
      assert.equal(opensDevTools(key('KeyI', { control: true, shift: true }), platform), true);
    }
  });

  it('Ctrl+Alt+I on Windows and Linux, for when the first is taken', () => {
    for (const platform of ['win32', 'linux']) {
      assert.equal(opensDevTools(key('KeyI', { control: true, alt: true }), platform), true);
    }
  });

  it('Cmd+Shift+I and Cmd+Option+I on macOS', () => {
    assert.equal(opensDevTools(key('KeyI', { meta: true, shift: true }), 'darwin'), true);
    assert.equal(opensDevTools(key('KeyI', { meta: true, alt: true }), 'darwin'), true);
  });

  it('goes by the physical key, so a layout with another letter there still works', () => {
    // `code` names the key's place, `key` (not read at all) would be the letter.
    assert.equal(opensDevTools({ ...key('KeyI', { control: true, shift: true }), key: 'ı' }, 'win32'), true);
    assert.equal(opensDevTools(key('KeyJ', { control: true, shift: true }), 'win32'), false);
  });

  it('is not Ctrl alone, Shift alone or all three', () => {
    assert.equal(opensDevTools(key('KeyI', { control: true }), 'win32'), false);
    assert.equal(opensDevTools(key('KeyI', { shift: true }), 'win32'), false);
    assert.equal(opensDevTools(key('KeyI', { control: true, shift: true, alt: true }), 'win32'), false);
  });

  it('is the other platform\'s modifier only where it belongs', () => {
    assert.equal(opensDevTools(key('KeyI', { control: true, shift: true }), 'darwin'), false);
    assert.equal(opensDevTools(key('KeyI', { meta: true, shift: true }), 'win32'), false);
    assert.equal(opensDevTools(key('KeyI', { control: true, meta: true, shift: true }), 'darwin'), false);
  });

  it('acts on the press, once: not the release, not a held key repeating', () => {
    assert.equal(opensDevTools({ ...key('KeyI', { control: true, shift: true }), type: 'keyUp' }, 'win32'), false);
    assert.equal(opensDevTools({ ...key('KeyI', { control: true, shift: true }), isAutoRepeat: true }, 'win32'), false);
  });

  it('leaves F12 to the hotkeys', () => {
    assert.equal(opensDevTools(key('F12'), 'win32'), false);
    assert.equal(opensDevTools(key('F12', { control: true, shift: true }), 'win32'), false);
  });
});
