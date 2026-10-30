// The hotkeys a global shortcut cannot take -- a button of the mouse, the numpad's
// Enter, the numpad with Num Lock off -- through the key hook, with the hook and
// Electron both faked: nothing here listens to a real keyboard or mouse.
//
//   node --test client/test/hotkeys-hook.test.mjs

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

const UiohookKey = { Numpad7: 71, NumpadHome: 60999, NumpadEnter: 3612, V: 47, Enter: 28 };
let registered;
let hook;
let hookAvailable;

const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'electron') {
    return {
      globalShortcut: {
        register: (accel, fn) => { registered.set(accel, fn); return true; },
        unregister: (accel) => registered.delete(accel),
      },
      systemPreferences: { isTrustedAccessibilityClient: () => true },
    };
  }
  if (request === 'uiohook-napi') {
    if (!hookAvailable) throw new Error('not installed');
    return { UiohookKey, uIOhook: hook };
  }
  return realLoad.call(this, request, ...rest);
};

const freshHotkeys = () => {
  for (const name of ['../src/main/hotkeys.js', '../src/main/key-hook.js']) delete require.cache[require.resolve(name)];
  return require('../src/main/hotkeys.js');
};

const mods = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };

describe('hotkeys through the key hook', () => {
  let hotkeys;
  let fired;
  beforeEach(() => {
    registered = new Map();
    fired = [];
    hookAvailable = true;
    hook = Object.assign(new EventEmitter(), { running: false, start() { this.running = true; }, stop() { this.running = false; } });
    delete process.env.HARMONY_NO_KEY_HOOK;
    hotkeys = freshHotkeys();
    hotkeys.onFire((id) => fired.push(id));
  });

  it('a button of the mouse fires when it goes down, and is not a shortcut', () => {
    const [r] = hotkeys.set([{ id: 'mute', accelerator: 'Mouse4' }]);
    assert.equal(r.ok, true);
    assert.equal(registered.size, 0);
    hook.emit('mousedown', { button: 5, ...mods });
    assert.deepEqual(fired, []);
    hook.emit('mousedown', { button: 4, ...mods });
    hook.emit('mouseup', { button: 4, ...mods });
    assert.deepEqual(fired, ['mute']);
  });

  it('with its modifier, and not without', () => {
    hotkeys.set([{ id: 'mute', accelerator: 'Ctrl+Mouse4' }]);
    hook.emit('mousedown', { button: 4, ...mods });
    hook.emit('mouseup', { button: 4, ...mods });
    assert.deepEqual(fired, []);
    hook.emit('mousedown', { button: 4, ...mods, ctrlKey: true });
    assert.deepEqual(fired, ['mute']);
  });

  it('the numpad\'s Enter is the hook\'s', () => {
    const [r] = hotkeys.set([{ id: 'deafen', accelerator: 'numenter' }]);
    assert.equal(r.ok, true);
    hook.emit('keydown', { keycode: UiohookKey.NumpadEnter, ...mods });
    hook.emit('keyup', { keycode: UiohookKey.NumpadEnter, ...mods });
    assert.deepEqual(fired, ['deafen']);
    // The main Enter is not it.
    hook.emit('keydown', { keycode: UiohookKey.Enter, ...mods });
    assert.deepEqual(fired, ['deafen']);
  });

  it('a numpad key stays a shortcut, and the hook only adds what it sends with Num Lock off', () => {
    const [r] = hotkeys.set([{ id: 'camera', accelerator: 'num7' }]);
    assert.equal(r.ok, true);
    assert.deepEqual([...registered.keys()], ['num7']);
    // The same press, seen by the hook with Num Lock on, is the shortcut's: not counted twice.
    hook.emit('keydown', { keycode: UiohookKey.Numpad7, ...mods });
    hook.emit('keyup', { keycode: UiohookKey.Numpad7, ...mods });
    assert.deepEqual(fired, []);
    hook.emit('keydown', { keycode: UiohookKey.NumpadHome, ...mods });
    assert.deepEqual(fired, ['camera']);
  });

  it('the hook runs only while a binding needs it', () => {
    hotkeys.set([{ id: 'mute', accelerator: 'Ctrl+Shift+M' }]);
    assert.equal(hook.running, false);
    hotkeys.set([{ id: 'mute', accelerator: 'Mouse4' }]);
    assert.equal(hook.running, true);
    hotkeys.set([{ id: 'mute', accelerator: 'Ctrl+Shift+M' }]);
    assert.equal(hook.running, false);
    hotkeys.clear();
    assert.equal(hook.listenerCount('mousedown'), 0);
  });

  it('without the hook, what only it can take says so, and a numpad key still works as a shortcut', () => {
    hookAvailable = false;
    const results = hotkeys.set([{ id: 'a', accelerator: 'Mouse4' }, { id: 'b', accelerator: 'numenter' }, { id: 'c', accelerator: 'num7' }]);
    assert.deepEqual(results.map((r) => [r.ok, r.error ?? null]), [[false, 'hook'], [false, 'hook'], [true, null]]);
    assert.deepEqual([...registered.keys()], ['num7']);
  });

  it('with the hook switched off, the same', () => {
    process.env.HARMONY_NO_KEY_HOOK = '1';
    hotkeys = freshHotkeys();
    const [r] = hotkeys.set([{ id: 'a', accelerator: 'Mouse5' }]);
    assert.deepEqual([r.ok, r.error], [false, 'hook']);
  });

  it('the left and right buttons are never a binding', () => {
    const [r] = hotkeys.set([{ id: 'a', accelerator: 'Mouse1' }]);
    assert.equal(r.ok, false);
  });
});
