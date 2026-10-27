// System audio minus one application, on Linux (PipeWire).
//
// There is no "everything except" in PipeWire either, so it is built from the
// other direction: a virtual sink of our own, and a link from every
// application's output into it -- except the ones being left out. Nothing is
// moved. Each application keeps playing to the speakers exactly as before; the
// extra link is a second tap on the same stream, which is how Vesktop does its
// own "share system audio without Vesktop". Recording the virtual sink's
// monitor then gives the mix of everything that was linked.
//
//   app A ──► speakers            app A ──► speakers
//   app B ──► speakers     =>     app B ──► speakers
//   (Harmony) ──► speakers        app A ──► harmony-share ──► pw-record
//                                 app B ──► harmony-share
//
// The command-line tools (pw-dump, pw-link, pw-cli, pw-record) rather than
// libpipewire: they ship with every PipeWire install, and there is nothing to
// compile. PulseAudio-only systems are not covered; availability() says so.

const { execFile, spawn } = require('node:child_process');

const processes = require('./processes');
const { alignFrames, stripWavHeader } = require('./pcm');

const FORMAT = { sampleRate: 48000, channels: 2, bitsPerSample: 16 };

const SINK_NAME = 'harmony-share';
const TOOLS = ['pw-dump', 'pw-link', 'pw-cli', 'pw-record'];
/** How often to look for streams that started since the last look. */
const POLL_MS = 500;
const SINK_TIMEOUT_MS = 4000;

// ---------------------------------------------------------------------------
// Reading the graph. Pure, so the tests can feed it a dump.
// ---------------------------------------------------------------------------

const isType = (object, name) => object?.type === `PipeWire:Interface:${name}`;
const propsOf = (object) => object?.info?.props ?? {};

/** Applications currently playing audio: one entry per output stream. */
function streamNodes(dump) {
  const out = [];
  for (const object of dump ?? []) {
    if (!isType(object, 'Node')) continue;
    const props = propsOf(object);
    if (props['media.class'] !== 'Stream/Output/Audio') continue;
    const pid = Number(props['application.process.id'] ?? props['pipewire.sec.pid']);
    out.push({
      id: object.id,
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      name: props['application.name'] ?? props['node.name'] ?? 'Unknown',
      title: props['media.name'] ?? '',
    });
  }
  return out;
}

const portsOf = (dump, nodeId, direction) =>
  (dump ?? []).filter((o) => isType(o, 'Port')
    && propsOf(o)['node.id'] === nodeId
    && (o.info?.direction === direction || propsOf(o)['port.direction'] === (direction === 'input' ? 'in' : 'out')));

/**
 * The links to make so every stream that is not excluded also reaches the
 * sink. Channel by channel -- FL to FL, FR to FR -- and a mono stream to both.
 * Links that already exist are not asked for again.
 *
 * @returns {Array<[number, number]>} [output port id, input port id]
 */
function planLinks(dump, { sink = SINK_NAME, excluded = new Set() } = {}) {
  const sinkNode = (dump ?? []).find((o) => isType(o, 'Node') && propsOf(o)['node.name'] === sink);
  if (!sinkNode) return [];

  const inputs = portsOf(dump, sinkNode.id, 'input');
  if (!inputs.length) return [];
  const inputFor = (channel) =>
    inputs.find((p) => propsOf(p)['audio.channel'] === channel) ?? null;

  const have = new Set(
    (dump ?? [])
      .filter((o) => isType(o, 'Link') && o.info?.['input-node-id'] === sinkNode.id)
      .map((o) => `${o.info['output-port-id']}>${o.info['input-port-id']}`),
  );

  const wanted = [];
  for (const stream of streamNodes(dump)) {
    if (stream.pid != null && excluded.has(stream.pid)) continue;
    const outputs = portsOf(dump, stream.id, 'output');
    outputs.forEach((port, index) => {
      const channel = propsOf(port)['audio.channel'];
      const targets = channel === 'MONO'
        ? inputs
        : [inputFor(channel) ?? inputs[index] ?? null];
      for (const target of targets) {
        if (target && !have.has(`${port.id}>${target.id}`)) wanted.push([port.id, target.id]);
      }
    });
  }
  return wanted;
}

// ---------------------------------------------------------------------------
// Running the tools
// ---------------------------------------------------------------------------

function run(command, args, { timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), err });
    });
  });
}

async function dumpGraph() {
  const { ok, stdout } = await run('pw-dump', []);
  if (!ok) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

let availabilityCache = null;

async function availability() {
  if (availabilityCache) return availabilityCache;

  // Asking each tool for its version is the cheapest check that it exists and
  // runs; ENOENT is the answer when it does not.
  for (const tool of TOOLS) {
    const { err } = await run(tool, ['--version'], { timeout: 3000 });
    if (err?.code === 'ENOENT') {
      return {
        available: false,
        reason: `Excluding an application from the audio needs PipeWire's tools (${tool} was not found).`,
      };
    }
  }
  // Present, but is there a daemon to talk to? Not cached when there is not:
  // somebody may start one.
  if (!(await dumpGraph())) {
    return { available: false, reason: 'PipeWire is installed but not running.' };
  }
  availabilityCache = { available: true, reason: null };
  return availabilityCache;
}

/** Applications that are making sound right now, plus Harmony. */
async function listProcesses() {
  const dump = await dumpGraph();
  const byPid = new Map();
  for (const stream of streamNodes(dump)) {
    if (stream.pid != null && !byPid.has(stream.pid)) {
      byPid.set(stream.pid, { pid: stream.pid, name: stream.name, title: stream.title });
    }
  }
  return processes.withSelf([...byPid.values()]);
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

let session = null;

function stop() {
  const running = session;
  if (!running) return;
  session = null;
  clearTimeout(running.timer);
  running.stopped = true;
  // The sink belongs to the pw-cli process that created it, and the links
  // belong to the sink: killing these two takes everything with them, which is
  // also what happens if Harmony itself is killed.
  for (const child of [running.recorder, running.cli]) {
    try { child?.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createSink() {
  const cli = spawn('pw-cli', [], { stdio: ['pipe', 'ignore', 'ignore'] });
  cli.on('error', () => {});
  // Interactive pw-cli reads commands from stdin, and the node it creates
  // lives exactly as long as that connection -- so stdin is never closed.
  cli.stdin.on('error', () => {});
  cli.stdin.write(
    `create-node adapter { factory.name=support.null-audio-sink node.name=${SINK_NAME}`
    + ' node.description=Harmony-share media.class=Audio/Sink audio.position=[FL,FR]'
    + ' monitor.channel-volumes=true object.linger=false priority.session=0 }\n',
  );

  const deadline = Date.now() + SINK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const dump = await dumpGraph();
    const present = (dump ?? []).some((o) => isType(o, 'Node') && propsOf(o)['node.name'] === SINK_NAME);
    if (present) return cli;
    await sleep(150);
  }
  cli.kill('SIGTERM');
  return null;
}

/**
 * @param {{excludePid: number|null}} opts
 * @param {(chunk: Buffer) => void} onChunk
 */
async function start({ excludePid = null }, onChunk) {
  stop();

  const { available, reason } = await availability();
  if (!available) return { mode: 'none', format: FORMAT, note: `${reason} Sharing without audio.` };

  const cli = await createSink();
  if (!cli) {
    return {
      mode: 'none',
      format: FORMAT,
      note: 'Could not create the capture sink in PipeWire. Sharing without audio.',
    };
  }

  const recorder = spawn('pw-record', [
    '--rate', String(FORMAT.sampleRate),
    '--channels', String(FORMAT.channels),
    '--format', 's16',
    '--target', SINK_NAME,
    // Capture what the sink PLAYS, not an input of the same name.
    '-P', '{ stream.capture.sink=true node.name=harmony-share-reader }',
    '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  recorder.on('error', () => {});
  recorder.stdout.on('data', stripWavHeader(alignFrames(onChunk)));

  const mine = { cli, recorder, timer: null, stopped: false };
  session = mine;

  let died = null;
  recorder.once('exit', (code) => {
    died = code ?? 'a signal';
    if (session === mine) {
      console.warn(`[audio] pw-record exited (${died})`);
      stop();
    }
  });

  // Link whatever is playing now, and keep looking: a stream that starts later
  // (a game launching, a browser tab) is not in the graph yet when we begin.
  const tick = async () => {
    if (mine.stopped) return;
    try {
      const excluded = excludePid ? await processes.tree(excludePid) : new Set();
      const dump = await dumpGraph();
      for (const [out, input] of planLinks(dump, { excluded })) {
        // Fire and forget: pw-link says "File exists" for a link made a moment
        // ago, and that is not a problem worth reporting.
        run('pw-link', [String(out), String(input)], { timeout: 3000 });
      }
    } finally {
      if (!mine.stopped) mine.timer = setTimeout(tick, POLL_MS);
    }
  };
  await tick();

  // Give the recorder a moment to fail loudly, rather than report a capture
  // that never began.
  await sleep(300);
  if (died != null) {
    stop();
    return {
      mode: 'none',
      format: FORMAT,
      note: `Could not record system audio (pw-record exited with ${died}). Sharing without audio.`,
    };
  }

  return excludePid
    ? { mode: 'system-excluding', format: FORMAT, note: null, pid: excludePid }
    : { mode: 'system', format: FORMAT, note: null };
}

module.exports = {
  start, stop, availability, listProcesses, FORMAT,
  // For the tests.
  streamNodes, planLinks,
};
