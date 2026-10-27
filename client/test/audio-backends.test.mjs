// The parts of the macOS and Linux audio exclusion that can be checked without
// a Mac's Screen Recording permission or a PipeWire daemon: which processes are
// "the app", how a child's byte stream becomes whole frames, and which links
// the Linux backend decides to make for a given graph.
//
//   node --test client/test/audio-backends.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePs, descendants, appBundleName } = require('../src/main/processes.js');
const { alignFrames, stripWavHeader } = require('../src/main/pcm.js');
const { streamNodes, planLinks } = require('../src/main/audio-linux.js');

describe('process trees', () => {
  const rows = parsePs(`
    1     0 /sbin/launchd
  100     1 /Applications/Harmony.app/Contents/MacOS/Harmony
  101   100 /Applications/Harmony.app/Contents/Frameworks/Harmony Helper.app/Contents/MacOS/Harmony Helper
  102   101 /Applications/Harmony.app/Contents/Frameworks/Harmony Helper.app/Contents/MacOS/Harmony Helper
  200     1 /Applications/Other.app/Contents/MacOS/Other
  `);

  it('reads pid, parent and a command with spaces in it', () => {
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[2], {
      pid: 101,
      ppid: 100,
      command: '/Applications/Harmony.app/Contents/Frameworks/Harmony Helper.app/Contents/MacOS/Harmony Helper',
    });
  });

  it('takes the whole tree under an app, and nothing beside it', () => {
    assert.deepEqual([...descendants(rows, 100)].sort(), [100, 101, 102]);
    assert.deepEqual([...descendants(rows, 200)], [200]);
  });

  it('survives a process that is its own parent', () => {
    assert.deepEqual([...descendants([{ pid: 5, ppid: 5, command: 'x' }], 5)], [5]);
  });

  it('names an app by its bundle', () => {
    assert.equal(appBundleName('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), 'Google Chrome');
    assert.equal(appBundleName('/usr/bin/ssh'), null);
  });
});

describe('frame alignment', () => {
  it('never hands on half a frame', () => {
    const seen = [];
    const push = alignFrames((chunk) => seen.push(Buffer.from(chunk)));
    push(Buffer.from([1, 2, 3, 4, 5, 6]));
    push(Buffer.from([7, 8, 9, 10]));
    assert.deepEqual(seen.map((b) => [...b]), [[1, 2, 3, 4], [5, 6, 7, 8]]);
    push(Buffer.from([11, 12]));
    assert.deepEqual([...seen.at(-1)], [9, 10, 11, 12]);
  });

  it('holds back a chunk shorter than a frame', () => {
    const seen = [];
    const push = alignFrames((chunk) => seen.push(chunk));
    push(Buffer.from([1, 2, 3]));
    assert.equal(seen.length, 0);
  });
});

describe('WAV header', () => {
  const header = (extra = 0) => Buffer.concat([
    Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'),
    Buffer.from('fmt '), Buffer.alloc(4 + 16 + extra),
    Buffer.from('data'), Buffer.alloc(4),
  ]);

  it('is removed when there is one, even split across chunks', () => {
    const out = [];
    const push = stripWavHeader((c) => out.push(...c));
    const wav = Buffer.concat([header(), Buffer.from([9, 9, 9, 9])]);
    push(wav.subarray(0, 10));
    push(wav.subarray(10, 30));
    push(wav.subarray(30));
    assert.deepEqual(out, [9, 9, 9, 9]);
  });

  it('leaves bare PCM alone', () => {
    const out = [];
    const push = stripWavHeader((c) => out.push(...c));
    push(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    push(Buffer.from([9, 10, 11, 12]));
    assert.deepEqual(out, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe('PipeWire link planning', () => {
  const node = (id, props) => ({ id, type: 'PipeWire:Interface:Node', info: { props } });
  const port = (id, nodeId, direction, channel) => ({
    id,
    type: 'PipeWire:Interface:Port',
    info: { direction, props: { 'node.id': nodeId, 'audio.channel': channel } },
  });
  const link = (out, input, outNode, inNode) => ({
    id: 900 + out,
    type: 'PipeWire:Interface:Link',
    info: {
      'output-port-id': out, 'input-port-id': input, 'output-node-id': outNode, 'input-node-id': inNode,
    },
  });
  const stream = (id, pid, name) => node(id, {
    'media.class': 'Stream/Output/Audio', 'application.process.id': pid, 'application.name': name,
  });

  // Harmony (pid 101) and a game (pid 300), both playing; the capture sink is node 10.
  const graph = [
    node(10, { 'node.name': 'harmony-share', 'media.class': 'Audio/Sink' }),
    port(11, 10, 'input', 'FL'),
    port(12, 10, 'input', 'FR'),
    stream(20, 101, 'Harmony'),
    port(21, 20, 'output', 'FL'),
    port(22, 20, 'output', 'FR'),
    stream(30, 300, 'Game'),
    port(31, 30, 'output', 'FL'),
    port(32, 30, 'output', 'FR'),
  ];

  it('finds the streams and the process behind each', () => {
    assert.deepEqual(streamNodes(graph).map((s) => [s.id, s.pid, s.name]), [[20, 101, 'Harmony'], [30, 300, 'Game']]);
  });

  it('links every stream, channel to channel, when nothing is excluded', () => {
    assert.deepEqual(planLinks(graph), [[21, 11], [22, 12], [31, 11], [32, 12]]);
  });

  it('leaves out an excluded process and keeps the rest', () => {
    assert.deepEqual(planLinks(graph, { excluded: new Set([100, 101, 102]) }), [[31, 11], [32, 12]]);
  });

  it('does not ask for a link that is already there', () => {
    const made = [...graph, link(31, 11, 30, 10)];
    assert.deepEqual(planLinks(made, { excluded: new Set([101]) }), [[32, 12]]);
  });

  it('sends a mono stream to both sides', () => {
    const mono = [...graph.filter((o) => o.id < 30), stream(40, 400, 'Mono'), port(41, 40, 'output', 'MONO')];
    assert.deepEqual(planLinks(mono, { excluded: new Set([101]) }), [[41, 11], [41, 12]]);
  });

  it('plans nothing before the sink exists', () => {
    assert.deepEqual(planLinks(graph.filter((o) => o.id !== 10 && o.info?.props?.['node.id'] !== 10)), []);
  });
});
