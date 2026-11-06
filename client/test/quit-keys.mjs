// Which key press quits Harmony (Alt+F4), fed key events directly.
//
//   node --test client/test/quit-keys.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { quitsApp } = require('../src/main/quit-keys.js');

const key = (code, mods = {}, extra = {}) => ({
  type: 'keyDown', code, key: code, shift: false, alt: false, control: false, meta: false, ...mods, ...extra,
});

describe('Alt+F4', () => {
  it('quits on Windows and Linux', () => {
    for (const platform of ['win32', 'linux']) {
      assert.equal(quitsApp(key('F4', { alt: true }), platform), true);
    }
  });

  it('is found by its key when the event carries no code', () => {
    assert.equal(quitsApp({ type: 'keyDown', key: 'F4', shift: false, alt: true, control: false, meta: false }, 'win32'), true);
  });

  it('does nothing on macOS, where Cmd+Q is the quit', () => {
    assert.equal(quitsApp(key('F4', { alt: true }), 'darwin'), false);
  });

  it('is not F4 alone, nor with other modifiers', () => {
    assert.equal(quitsApp(key('F4'), 'win32'), false);
    assert.equal(quitsApp(key('F4', { control: true }), 'win32'), false);
    assert.equal(quitsApp(key('F4', { alt: true, control: true }), 'win32'), false);
    assert.equal(quitsApp(key('F4', { alt: true, shift: true }), 'win32'), false);
    assert.equal(quitsApp(key('F4', { alt: true, meta: true }), 'linux'), false);
  });

  it('is not another function key, nor another key with Alt', () => {
    assert.equal(quitsApp(key('F5', { alt: true }), 'win32'), false);
    assert.equal(quitsApp(key('KeyF', { alt: true }), 'win32'), false);
  });

  it('acts on the press, not the release', () => {
    assert.equal(quitsApp(key('F4', { alt: true }, { type: 'keyUp' }), 'win32'), false);
  });
});
