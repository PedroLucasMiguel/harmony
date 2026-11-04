// The "is typing" line: the words for one, two, three and more people, how long somebody stays shown, and that
// one's own typing is announced at most once every few seconds.
//
//   node --test client/test/typing-ui.test.mjs

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createTyping, SHOWN_MS, SEND_EVERY_MS, IDLE_MS } from '../src/renderer/typing-ui.js';

const words = {
  'typing.one': '{a} is typing…',
  'typing.two': '{a} and {b} are typing…',
  'typing.three': '{a}, {b} and {c} are typing…',
  'typing.many': 'Several people are typing…',
};
const t = (key, v = {}) => (words[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => v[k]);
const names = { 1: 'Ana Maria', 2: 'Bruno', 3: 'Carla', 4: 'Diego', 5: 'Eva' };
const make = (extra = {}) => {
  const seen = [];
  return { seen, typing: createTyping({ t, nameOf: (id) => names[id], changed: (key) => seen.push(key), ...extra }) };
};

describe('the line', () => {
  it('is empty when nobody is typing', () => {
    assert.equal(make().typing.text('c:1'), '');
  });

  it('says one name, with their display name', () => {
    const { typing } = make();
    typing.note('c:1', 1);
    assert.equal(typing.text('c:1'), 'Ana Maria is typing…');
  });

  it('says two, and three, in the order they began', () => {
    const { typing } = make();
    typing.note('c:1', 2);
    typing.note('c:1', 1);
    assert.equal(typing.text('c:1'), 'Bruno and Ana Maria are typing…');
    typing.note('c:1', 3);
    assert.equal(typing.text('c:1'), 'Bruno, Ana Maria and Carla are typing…');
  });

  it('says "several" past three', () => {
    const { typing } = make();
    for (const id of [1, 2, 3, 4]) typing.note('c:1', id);
    assert.equal(typing.text('c:1'), 'Several people are typing…');
    typing.remove('c:1', 4);
    assert.equal(typing.text('c:1'), 'Ana Maria, Bruno and Carla are typing…');
  });

  it('keeps each place to itself', () => {
    const { typing } = make();
    typing.note('c:1', 1);
    typing.note('d:9', 2);
    assert.equal(typing.text('c:1'), 'Ana Maria is typing…');
    assert.equal(typing.text('d:9'), 'Bruno is typing…');
  });

  it('says one person once, however often they are seen', () => {
    const { typing } = make();
    typing.note('c:1', 1);
    typing.note('c:1', 1);
    assert.equal(typing.text('c:1'), 'Ana Maria is typing…');
  });
});

describe('who stays shown', () => {
  it('is dropped after a few seconds without another sign, and kept by one', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { typing, seen } = make();
      typing.note('c:1', 1);
      mock.timers.tick(SHOWN_MS - 1000);
      typing.note('c:1', 1);
      mock.timers.tick(SHOWN_MS - 1000);
      assert.equal(typing.text('c:1'), 'Ana Maria is typing…', 'seen again, so kept');
      mock.timers.tick(1500);
      assert.equal(typing.text('c:1'), '');
      assert.equal(seen.length, 2, 'told when they came and when they went, and not for being seen again');
    } finally {
      mock.timers.reset();
    }
  });

  it('is dropped at once when what they wrote arrives', () => {
    const { typing, seen } = make();
    typing.note('c:1', 1);
    typing.remove('c:1', 1);
    assert.equal(typing.text('c:1'), '');
    assert.equal(seen.length, 2);
    typing.remove('c:1', 1);
    assert.equal(seen.length, 2, 'nothing to say about somebody who was not there');
  });
});

describe('announcing one\'s own', () => {
  it('is sent at most once every few seconds, for each place', async () => {
    let at = 0;
    const { typing } = make({ now: () => at });
    const sent = [];
    const send = (key) => () => { sent.push(key); return Promise.resolve(); };
    typing.ping('c:1', send('c:1'));
    typing.ping('c:1', send('c:1'));
    typing.ping('d:2', send('d:2'));
    at = SEND_EVERY_MS - 1;
    typing.ping('c:1', send('c:1'));
    at = SEND_EVERY_MS;
    typing.ping('c:1', send('c:1'));
    assert.deepEqual(sent, ['c:1', 'd:2', 'c:1']);
  });

  it('is never an error, whatever the server does', async () => {
    const { typing } = make();
    typing.ping('c:1', () => Promise.reject(new Error('did not answer')));
    await new Promise((done) => setTimeout(done, 10));
  });

  it('can start again at once after a message was sent', () => {
    const { typing } = make();
    let n = 0;
    typing.ping('c:1', () => { n += 1; });
    typing.rest('c:1');
    typing.ping('c:1', () => { n += 1; });
    assert.equal(n, 2);
  });
});

describe('stopping', () => {
  it('is said once the keys have been still for a moment, and not before', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { typing } = make();
      const said = [];
      const send = () => said.push('typing');
      const stop = () => said.push('stopped');
      typing.ping('c:1', send, stop);
      mock.timers.tick(IDLE_MS - 100);
      typing.ping('c:1', send, stop);
      mock.timers.tick(IDLE_MS - 100);
      assert.deepEqual(said, ['typing'], 'a key now and then keeps it going');
      mock.timers.tick(200);
      assert.deepEqual(said, ['typing', 'stopped']);
      typing.ping('c:1', send, stop);
      assert.deepEqual(said, ['typing', 'stopped', 'typing'], 'and the next key starts again at once');
    } finally {
      mock.timers.reset();
    }
  });

  it('is said at once when the box is emptied, and only if typing had been said', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { typing } = make();
      const said = [];
      typing.quiet('c:1', () => said.push('stopped'));
      assert.deepEqual(said, [], 'nothing to take back');
      typing.ping('c:1', () => said.push('typing'), () => said.push('stopped'));
      typing.quiet('c:1', () => said.push('stopped'));
      assert.deepEqual(said, ['typing', 'stopped']);
      mock.timers.tick(IDLE_MS * 2);
      assert.deepEqual(said, ['typing', 'stopped'], 'and not said again later');
    } finally {
      mock.timers.reset();
    }
  });

  it('is not said for a message that was sent: its arrival does that', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { typing } = make();
      const said = [];
      typing.ping('c:1', () => said.push('typing'), () => said.push('stopped'));
      typing.rest('c:1');
      mock.timers.tick(IDLE_MS * 2);
      assert.deepEqual(said, ['typing']);
    } finally {
      mock.timers.reset();
    }
  });
});
