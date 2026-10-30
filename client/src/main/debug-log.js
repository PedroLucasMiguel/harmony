// The debug log: a plain text file of what the machine and the app are doing,
// for working out why a call crackles or a connection stutters on somebody
// else's computer.
//
// OFF by default and off at every start. Nothing here is read from the
// settings file on purpose: a log that was left on would be writing to disk,
// and polling the system, for somebody who has forgotten it exists. Turning it
// on is a choice made in this run of the app and gone with it.
//
// Two halves write to the one file. This one samples what only the main process
// can see -- every process of the app and how much CPU each is using, the
// machine's CPU and memory, which other programs are busy, power state -- and
// the renderer sends the rest (the audio and video connections, the page's own
// stalls) through write().
//
// What is NOT in it, deliberately: addresses (candidates are logged by type and
// protocol only), account names, passwords, tokens, server URLs and the
// message text. It is meant to be sent to somebody; see header().

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { app, powerMonitor, screen, shell } = require('electron');

const SAMPLE_MS = 2000;
/** The other programs on the machine are looked at less often: asking costs a process of its own. */
const BUSY_EVERY_MS = 15_000;
/** A log that has grown past this stops: somebody left it on. */
const MAX_BYTES = 64 * 1024 * 1024;

let stream = null;
let file = null;
let bytes = 0;
let timer = null;
let busyAt = 0;
let busyRunning = false;
let lastCpu = null;
let stopped = '';

const logsDir = () => path.join(app.getPath('userData'), 'logs');

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** Local time with milliseconds: what somebody comparing the log with a clock expects. */
function stamp(date = new Date()) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function fileName(date = new Date()) {
  return `harmony-debug-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.txt`;
}

/** One line, as it goes in the file. */
function line(kind, text) {
  return `[${stamp()}] ${kind.padEnd(5)} ${text}\n`;
}

function write(text) {
  if (!stream) return;
  if (bytes > MAX_BYTES) {
    if (!stopped) {
      stopped = 'size';
      stream.write(line('LOG', `stopped: the file passed ${MAX_BYTES / 1024 / 1024} MB`));
    }
    return;
  }
  bytes += Buffer.byteLength(text);
  stream.write(text);
}

const mb = (kb) => Math.round(kb / 1024);

/** Whole-machine CPU use since the last call, in percent, and the busiest single core. */
function cpuNow() {
  const cores = os.cpus().map((c) => ({
    idle: c.times.idle,
    total: Object.values(c.times).reduce((a, b) => a + b, 0),
  }));
  const before = lastCpu;
  lastCpu = cores;
  if (!before || before.length !== cores.length) return null;
  const used = cores.map((c, i) => {
    const total = c.total - before[i].total;
    return total > 0 ? 100 * (1 - (c.idle - before[i].idle) / total) : 0;
  });
  return {
    all: used.reduce((a, b) => a + b, 0) / used.length,
    busiest: Math.max(...used),
    over90: used.filter((u) => u > 90).length,
    cores: used.length,
  };
}

/** The app's own processes, with what each costs. */
function appProcesses() {
  return app.getAppMetrics()
    .map((m) => {
      const name = m.name || m.type;
      return `${m.type === 'Tab' ? 'Renderer' : name}#${m.pid}`
        + `:cpu=${m.cpu.percentCPUUsage.toFixed(1)}%`
        + `,mem=${mb(m.memory.workingSetSize)}MB`
        + `${m.cpu.idleWakeupsPerSecond != null ? `,wakeups=${m.cpu.idleWakeupsPerSecond}` : ''}`;
    })
    .join(' | ');
}

function sample() {
  const cpu = cpuNow();
  const mem = process.getSystemMemoryInfo?.() ?? {};
  write(line('SYS', [
    cpu ? `cpu=${cpu.all.toFixed(0)}%` : 'cpu=?',
    cpu ? `busiestCore=${cpu.busiest.toFixed(0)}%` : '',
    cpu ? `coresOver90=${cpu.over90}/${cpu.cores}` : '',
    `memFree=${mb(mem.free ?? os.freemem() / 1024)}MB`,
    mem.total ? `memTotal=${mb(mem.total)}MB` : '',
    mem.swapUsed != null ? `swapUsed=${mb(mem.swapUsed)}MB` : '',
    `load=${os.loadavg().map((n) => n.toFixed(2)).join('/')}`,
    `battery=${powerMonitor.isOnBatteryPower?.() ? 'yes' : 'no'}`,
  ].filter(Boolean).join(' ')));
  write(line('PROC', appProcesses()));

  if (Date.now() - busyAt >= BUSY_EVERY_MS) {
    busyAt = Date.now();
    busiestPrograms();
  }
}

/**
 * The programs using the most CPU on the machine, by name -- the "other
 * things that were running" of a report that says it only crackles while the
 * machine is busy. Asked with the system's own tools, off the main thread, and
 * never twice at once.
 */
function busiestPrograms() {
  if (busyRunning) return;
  busyRunning = true;
  const done = (err, out) => {
    busyRunning = false;
    if (!stream) return;
    if (err) {
      write(line('BUSY', `unavailable (${String(err.message).split('\n')[0].slice(0, 120)})`));
      return;
    }
    write(line('BUSY', out.trim().split(/\r?\n/).filter(Boolean).slice(0, 8).join(' | ')));
  };
  const opts = { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 };
  if (process.platform === 'win32') {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | '
      + 'Where-Object { $_.Name -ne "_Total" -and $_.Name -ne "Idle" } | '
      + 'Sort-Object PercentProcessorTime -Descending | Select-Object -First 8 | '
      + 'ForEach-Object { "$($_.Name):cpu=$($_.PercentProcessorTime)%" }',
    ], opts, done);
  } else {
    // pcpu is the share of one core over the process's life on some systems; with -r it is
    // still the best a plain `ps` offers, and the names are what matter.
    execFile('ps', ['-Aceo', 'pcpu,comm', '-r'], opts, (err, out) => {
      if (err) return done(err);
      return done(null, out.split('\n').slice(1, 9)
        .map((l) => l.trim().replace(/^(\S+)\s+(.*)$/, '$2:cpu=$1%')).join('\n'));
    });
  }
}

function listen() {
  const note = (what) => () => write(line('POWER', what));
  for (const name of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'on-battery', 'on-ac']) {
    powerMonitor.on(name, note(name));
  }
  powerMonitor.on('thermal-state-change', (state) => write(line('POWER', `thermal=${state?.state ?? state}`)));
  powerMonitor.on('speed-limit-change', (limit) => write(line('POWER', `cpuSpeedLimit=${limit?.limit ?? limit}%`)));
}
let listening = false;

/** Everything that does not change while the app runs, once, at the top. */
async function header(extra) {
  const lines = [];
  lines.push('Harmony debug log');
  lines.push(`started   ${new Date().toString()}`);
  lines.push(`app       ${app.getVersion()}  electron ${process.versions.electron}  chrome ${process.versions.chrome}  node ${process.versions.node}`);
  lines.push(`system    ${os.type()} ${os.release()} ${os.arch()}  (${process.platform})`);
  const cpus = os.cpus();
  lines.push(`cpu       ${cpus[0]?.model ?? '?'} x${cpus.length}`);
  lines.push(`memory    ${mb(os.totalmem() / 1024)} MB total`);
  try {
    const gpu = await app.getGPUInfo('basic');
    const devices = (gpu.gpuDevice ?? []).map((d) => `${d.active ? '*' : ''}vendor=0x${(d.vendorId ?? 0).toString(16)} device=0x${(d.deviceId ?? 0).toString(16)} driver=${d.driverVersion ?? '?'}`);
    lines.push(`gpu       ${devices.join(' ; ') || '?'}${gpu.auxAttributes?.glRenderer ? `  ${gpu.auxAttributes.glRenderer}` : ''}`);
  } catch {
    lines.push('gpu       unavailable');
  }
  try {
    const features = app.getGPUFeatureStatus();
    lines.push(`gpu-feat  ${Object.entries(features).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  } catch { /* before the GPU process is up */ }
  lines.push(`displays  ${screen.getAllDisplays().map((d) => `${d.size.width}x${d.size.height}@${d.displayFrequency ?? '?'}Hz x${d.scaleFactor}`).join(' ; ')}`);
  lines.push(`power     ${powerMonitor.isOnBatteryPower?.() ? 'on battery' : 'on AC or no battery'}`);
  for (const [key, value] of Object.entries(extra ?? {})) lines.push(`${key.padEnd(9)} ${value}`);
  lines.push('');
  lines.push('Lines are:  [time] KIND  key=value ...   Counters in the NET lines are changes since the');
  lines.push('previous sample (about two seconds). SYS/PROC/BUSY come from the app\'s main process;');
  lines.push('NET/AUDIO/PAGE/EVENT from the page. Nothing here names an account, address or server.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * Start a new log file and begin sampling.
 *
 * @param {object} [extra]  more lines for the header, from the page: key -> text
 * @returns {Promise<{enabled: true, file: string}>}
 */
async function start(extra) {
  if (stream) return status();
  fs.mkdirSync(logsDir(), { recursive: true });
  file = path.join(logsDir(), fileName());
  stream = fs.createWriteStream(file, { flags: 'a' });
  stream.on('error', () => { /* a full disk must not take the app with it */ });
  bytes = 0;
  stopped = '';
  lastCpu = null;
  busyAt = 0;
  write(await header(extra));
  if (remembered.length) {
    write('Before this log was started:\n');
    write(remembered.splice(0).join(''));
    write('\n');
  }
  if (!listening) {
    listening = true;
    listen();
  }
  cpuNow();
  timer = setInterval(sample, SAMPLE_MS);
  timer.unref?.();
  return status();
}

/** Stop sampling and close the file. */
function stop() {
  if (!stream) return status();
  clearInterval(timer);
  timer = null;
  write(line('LOG', 'stopped by the user'));
  stream.end();
  stream = null;
  return status();
}

const status = () => ({ enabled: Boolean(stream), file, dir: logsDir() });

/** Open the folder the logs are in, with the newest one selected when there is one. */
async function openFolder() {
  fs.mkdirSync(logsDir(), { recursive: true });
  // Tests press the button without wanting a file manager opened on the desktop.
  if (process.env.HARMONY_NO_OPEN) return true;
  if (file && fs.existsSync(file)) {
    shell.showItemInFolder(file);
    return true;
  }
  const error = await shell.openPath(logsDir());
  if (error) throw new Error(error);
  return true;
}

/**
 * What happened since launch that a log started later should still show: the
 * program's own processes dying is exactly what is wanted after the fact.
 */
const remembered = [];
const REMEMBER_MAX = 40;

/** A line from the page (or from the app itself). Kept briefly even when no log is running. */
function event(kind, text) {
  const entry = line(String(kind).slice(0, 5).toUpperCase(), String(text).slice(0, 4000));
  if (!stream) {
    remembered.push(entry);
    if (remembered.length > REMEMBER_MAX) remembered.shift();
    return false;
  }
  write(entry);
  return true;
}

module.exports = { start, stop, status, openFolder, event, logsDir, fileName, stamp };
