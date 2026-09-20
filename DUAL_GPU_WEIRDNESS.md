# Dual-GPU weirdness

Notes from tracking down why a WebRTC screen share on a hybrid-graphics Windows
laptop cost far more than it should have.

Almost none of this is written down anywhere. Every individual piece is
discoverable — a Chromium source file here, a five-year-old mailing list thread
there — but the combination cost several days to work out, and the largest
single problem turned out to be a six-character string in an SDP offer. This
document is the map we wish we had had.

Everything below was measured, not reasoned about. Where a theory turned out to
be wrong, it is left in, because the wrong theories are most of the value.

**Contents**

- [The symptom](#the-symptom)
- [The measurement toolkit](#the-measurement-toolkit) — the commands, copy-pasteable
- [Problem 1: the preview was fed the full capture](#problem-1-the-preview-was-fed-the-full-capture)
- [Problem 2: the H.264 profile](#problem-2-the-h264-profile-the-big-one)
- [Problem 3: the cross-adapter display tax](#problem-3-the-cross-adapter-display-tax)
- [Things that seemed obvious and were wrong](#things-that-seemed-obvious-and-were-wrong)
- [The chronology](#the-chronology)
- [Checking your own machine](#checking-your-own-machine)

---

## The symptom

Streaming a game with Harmony, on a laptop with an NVIDIA discrete GPU and an
Intel integrated one:

- the game still reported a high frame rate
- but it *felt* like 20 fps
- watching someone else's stream hurt too, and got worse over time
- minimising Harmony made the problem vanish entirely
- none of it happened with a certain other well-known Electron chat app

That last point is the one worth holding on to. Discord's desktop client is
Electron, just like this one, and it does not have this problem.

## The machine

| | |
|---|---|
| Discrete GPU | NVIDIA GeForce RTX 5060 Laptop, driver 32.0.16.1692 |
| Integrated GPU | Intel UHD Graphics, driver 32.0.101.7076 |
| CPU | 32 logical processors |
| Internal panel | 2560×1600 @ 240 Hz |
| External display | 3840×2160 @ 60 Hz |
| OS | Windows 11, build 26200 |
| Runtime | Electron 44.4.3 |

---

## The measurement toolkit

Most of the work was building trust in a number. The tooling matters more than
the conclusions, because your machine will differ. Everything here is what was
actually run.

### 1. Which GPU is which

**Do this first, and do it again after any display change.** Which LUID belongs
to the discrete GPU is not stable — switching a MUX renumbers the adapters, and
a stale mapping silently relabels every row of your results. (This happened
during this investigation: every process appeared to migrate to the Intel GPU,
which was nonsense.)

Identify the discrete adapter by dedicated memory — it is the one holding
gigabytes:

```powershell
(Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage' -MaxSamples 1).CounterSamples |
  ForEach-Object {
    $luid = if ($_.InstanceName -match 'luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)') { $Matches[1] } else { $_.InstanceName }
    "{0,-30} {1,10:N0} MB" -f $luid, ($_.CookedValue / 1MB)
  } | Sort-Object -Unique
```

```
0x00000000_0x000105c3               2,833 MB     <- NVIDIA
0x00000000_0x00011bfe                   0 MB
0x00000000_0x00011c57                   0 MB
```

Cross-check the adapter names and their driver versions:

```powershell
Get-CimInstance Win32_VideoController |
  Select-Object Name, AdapterCompatibility, DriverVersion,
                CurrentHorizontalResolution, CurrentVerticalResolution, CurrentRefreshRate
```

Note that `Current*Resolution` on this class is unreliable after a MUX switch —
it reports a mode per adapter, not per display. For the real desktop layout:

```powershell
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens |
  ForEach-Object { "{0,-18} {1,-24} primary={2}" -f $_.DeviceName, $_.Bounds, $_.Primary }
```

### 2. What engines exist on this machine

```powershell
(Get-Counter '\GPU Engine(*)\Utilization Percentage' -MaxSamples 1).CounterSamples |
  ForEach-Object { ($_.InstanceName -split '_engtype_')[-1] } | Sort-Object -Unique
```

```
3d
copy
jpeg_decode_0
legacyoverlay
ofa_0
security
videodecode
videoencode
videoprocessing
vr
```

The four that matter: **`3d`** (rendering and compositing), **`videoencode`**
(NVENC / AMF / Quick Sync), **`videodecode`** (NVDEC etc.), **`copy`** (DMA,
including cross-adapter transfers).

If `videoencode` and `videodecode` do not appear at all, stop here — this
machine cannot report what you are trying to measure.

### 3. Sampling per-process, per-engine, per-adapter GPU use

This is what Task Manager's "GPU Engine" column reads. Instance names look like:

```
pid_19600_luid_0x00000000_0x00010994_phys_0_eng_3_engtype_videoencode
```

so you can group by process, adapter and engine. **Export to CSV and aggregate
elsewhere** — some counter instances return malformed samples that poison
`Measure-Object` and `Group-Object` with confusing type errors, and chasing that
wastes real time:

```powershell
$out = "$env:TEMP\gpuprobe"
New-Item -ItemType Directory -Force -Path $out | Out-Null

Get-Process | Select-Object Id, Name |
  Export-Csv "$out\procs.csv" -NoTypeInformation -Encoding UTF8

(Get-Counter '\GPU Engine(*)\Utilization Percentage' `
    -SampleInterval 1 -MaxSamples 10 -ErrorAction SilentlyContinue).CounterSamples |
  Select-Object InstanceName, CookedValue |
  Export-Csv "$out\gpu.csv" -NoTypeInformation -Encoding UTF8
```

Aggregate with `node agg.mjs` from that directory:

```js
// agg.mjs -- totals GPU engine samples by process / adapter / engine.
import { readFileSync } from 'node:fs';

const SAMPLES = 10;                                    // must match -MaxSamples
const DISCRETE = '0x00000000_0x000105c3';              // from step 1

const csv = (f) => {
  const [head, ...lines] = readFileSync(f, 'utf8').trim().split(/\r?\n/);
  const cols = head.replace(/"/g, '').split(',');
  return lines.map((l) => {
    const cells = l.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0);
    return Object.fromEntries(
      cols.map((c, i) => [c, (cells[i] ?? '').replace(/^"|"$/g, '').replace(/""/g, '"')]),
    );
  });
};

const names = new Map(csv('procs.csv').map((r) => [r.Id, r.Name]));
const agg = new Map();

for (const row of csv('gpu.csv')) {
  const v = Number(row.CookedValue);
  if (!Number.isFinite(v) || v <= 0.01) continue;
  const n = row.InstanceName;
  const pid = /pid_(\d+)/.exec(n)?.[1] ?? '0';
  const gpu = n.includes(`luid_${DISCRETE}`) ? 'DISCRETE' : 'integrated';
  const eng = n.split('_engtype_').pop();
  const key = `${(names.get(pid) ?? 'pid ' + pid).padEnd(22)} ${gpu.padEnd(10)} ${eng}`;
  agg.set(key, (agg.get(key) ?? 0) + v);
}

[...agg.entries()]
  .map(([k, v]) => [k, v / SAMPLES])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 25)
  .forEach(([k, v]) => console.log(`${k.padEnd(50)} ${v.toFixed(2).padStart(7)}`));
```

Typical output while streaming, on a correctly configured machine:

```
League of Legends      DISCRETE   3d                          18.49
Harmony                DISCRETE   videoencode                 15.63
Harmony                DISCRETE   3d                           5.06
Harmony                DISCRETE   videodecode                  4.49
Harmony                DISCRETE   copy                         1.49
dwm                    DISCRETE   3d                           1.46
```

### 4. Validate the counters before trusting a zero

**A zero is only meaningful if you have proved the counter can be non-zero.**
Play an ordinary H.264 file in any media player and sample again:

```powershell
Start-Process "C:\path\to\some-video.mp4"
# ...sample as in step 3...
```

```
NVIDIA  videodecode              7.06 %      <- counters work
```

Skipping this step is how you conclude "the hardware decoder is broken" when
your measurement is.

### 5. Power, thermal and overall headroom

```powershell
& "C:\Windows\System32\nvidia-smi.exe" `
  --query-gpu=name,display_active,power.draw,temperature.gpu,utilization.gpu,memory.used `
  --format=csv
```

```
NVIDIA GeForce RTX 5060 Laptop GPU, Enabled, 25.45 W, 65, 16 %, 2813 MiB
```

Useful for ruling out thermal or power throttling as an explanation, and for
noticing when nothing is saturated — which is itself a finding.

### 6. Per-process CPU

Remember to divide by the logical processor count; the raw counter is a
percentage of *one* core, so 800% is eight cores:

```powershell
(Get-Counter '\Process(*)\% Processor Time' -SampleInterval 1 -MaxSamples 5 `
    -ErrorAction SilentlyContinue).CounterSamples |
  Select-Object InstanceName, CookedValue | Export-Csv "$env:TEMP\gpuprobe\cpu.csv" -NoTypeInformation

(Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 5).CounterSamples |
  Measure-Object CookedValue -Average | ForEach-Object { "total CPU: {0:N1}%" -f $_.Average }
```

Software H.264 encoding at 1080p shows up here unmistakably — several whole
cores. Hardware encoding barely registers.

### 7. WebRTC's own view, via getStats()

```js
const report = await pc.getStats();
report.forEach((s) => {
  if (s.type === 'outbound-rtp' && s.kind === 'video') {
    console.log(s.encoderImplementation, s.powerEfficientEncoder);
  }
  if (s.type === 'inbound-rtp' && s.kind === 'video') {
    console.log(s.decoderImplementation, s.powerEfficientDecoder);
  }
});
```

```
MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)   true
ExternalDecoder (D3D11VideoDecoder)                                true
```

**The absence of these fields is itself the signal.** Chromium only populates
them once a hardware path is actually running. We spent a while believing this
Electron build simply did not expose `encoderImplementation`; in fact it was
absent *because* software encoding was in use, and it appeared the instant
hardware engaged.

### 8. A loopback probe: does WebRTC use the hardware, with no server?

The single most useful tool of the whole investigation. It stands up a
`RTCPeerConnection` pair inside one renderer, so it exercises the real encode
and decode factories without needing a signalling server or a second machine.

```js
// Force resolution to stay up: at 540p the encoder load is too small to read
// on a GPU counter, and loopback bandwidth estimation will shrink it if allowed.
const track = stream.getVideoTracks()[0];
track.contentHint = 'detail';

const pc1 = new RTCPeerConnection();
const pc2 = new RTCPeerConnection();
pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);

const tx = pc1.addTransceiver(track, { direction: 'sendonly' });

// Swap this filter to compare profiles -- this is the experiment that mattered.
const h264 = RTCRtpSender.getCapabilities('video').codecs.filter(
  (c) => /H264/i.test(c.mimeType) && c.sdpFmtpLine.includes('profile-level-id=640032'),
);
tx.setCodecPreferences(h264);

await tx.sender.setParameters({
  ...tx.sender.getParameters(),
  degradationPreference: 'maintain-resolution',
  encodings: [{ maxBitrate: 20_000_000, maxFramerate: 60, scaleResolutionDownBy: 1 }],
});

await pc1.setLocalDescription(await pc1.createOffer());
await pc2.setRemoteDescription(pc1.localDescription);
await pc2.setLocalDescription(await pc2.createAnswer());
await pc1.setRemoteDescription(pc2.localDescription);

// Chromium starts on software and swaps to hardware once the accelerator is up,
// so an early read lies. Give it ~10s, then sample the GPU counters from outside
// while the call is held open.
```

Drive it over the DevTools Protocol against a running Electron app — launch with
`--remote-debugging-port=9333`, find the page at `http://127.0.0.1:9333/json/list`,
and `Runtime.evaluate` the above. Harmony's `client/test/cdp.mjs` is a ~140-line
implementation of exactly that, if you want a starting point.

### 9. Measuring per-track constraints

To confirm a cloned capture track really does take its own resolution and frame
rate (see [Problem 1](#problem-1-the-preview-was-fed-the-full-capture)), count
presented frames on each with `requestVideoFrameCallback` rather than trusting
`getSettings()` alone:

```js
async function rate(track, seconds) {
  const v = document.createElement('video');
  v.muted = true; v.autoplay = true; v.srcObject = new MediaStream([track]);
  document.body.appendChild(v);
  await v.play().catch(() => {});
  let frames = 0, size = null;
  const tick = (_now, meta) => { frames++; size = `${meta.width}x${meta.height}`; v.requestVideoFrameCallback(tick); };
  v.requestVideoFrameCallback(tick);
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  v.srcObject = null; v.remove();
  return { fps: frames / ((performance.now() - t0) / 1000), size };
}
```

Measure the tracks **sequentially**, not at once, or they compete for the same
GPU budget and both read low.

### 10. What none of this can tell you

**GPU utilisation cannot detect stutter.** A GPU can sit at 20% and still
deliver visibly terrible frame pacing, because the cost is a stall in the
present path rather than throughput. If the symptom is "feels bad" while every
utilisation number says the machine is idle, stop measuring utilisation and
measure frame times — [PresentMon](https://github.com/GameTechDev/PresentMon)
logs per-frame present intervals and displayed-frame latency.

---

## Problem 1: the preview was fed the full capture

The `<video>` element showing the broadcaster their own screen was given the
published `MediaStream` directly — native resolution, full frame rate. On a
native-resolution preset that is a 4K60 surface being scaled and composited
every frame, to draw a window a few hundred pixels wide.

Painting that costs GPU work on the same adapter the game uses, and unlike
encoding it scales with **source resolution**, not bitrate.

### The fix: clone the track and constrain the clone

Chromium gives every track taken off a source its own downscale and frame-rate
decimation. A clone can be throttled hard while the track being encoded stays
untouched:

```js
const clone = track.clone();
await clone.applyConstraints({
  width: { max: 960 },
  height: { max: 540 },
  frameRate: { max: 10 },
});
```

Measured with the method in [§9](#9-measuring-per-track-constraints) — the
original is genuinely unaffected:

| | resolution | fps | pixels/sec |
|---|---|---|---|
| original (published) | 2560×1440 | 60 | 221 M |
| constrained clone (preview) | 864×486 | 10 | 4.2 M |

**~50× less work** through the path that was costing the frames, for a picture
whose entire job is to confirm you are sharing the right window.

This behaviour is not guaranteed by spec in any strong sense, so pin it in a
test. If a future Chromium stops honouring per-clone constraints, the preview
silently goes back to costing a game 20–30 fps.

---

## Problem 2: the H.264 profile (the big one)

This is the one nobody tells you.

**Chromium offers H.264 constrained baseline first. NVIDIA's encoder and
decoder Media Foundation Transforms do not accept baseline at all.** The result
is that every WebRTC call — sending *and* receiving — silently runs on the CPU,
on a machine with a perfectly good hardware encoder sitting idle.

Measured with the loopback probe from [§8](#8-a-loopback-probe-does-webrtc-use-the-hardware-with-no-server)
plus the counter sampling from [§3](#3-sampling-per-process-per-engine-per-adapter-gpu-use).
Same build, same capture, same everything; only the negotiated profile changed:

| NVIDIA engine | baseline `42001f` | High `640032` |
|---|---|---|
| **videoencode** | **0.00 %** | **19.03 %** |
| **videodecode** | **0.00 %** | **3.67 %** |
| 3d | 18.2 % | 10.6 % |

Control ([§4](#4-validate-the-counters-before-trusting-a-zero)): an ordinary
H.264 file playing in the Windows media player put `videodecode` at **7.06 %**
on the same adapter. The counters were fine. WebRTC genuinely used none of it.

### The fix: order the profiles

Order, do not filter. A machine with no hardware encoder falls back to OpenH264,
which only speaks constrained baseline — remove baseline from the list and such
a machine cannot publish at all.

```js
const H264_PROFILE_RANK = { 64: 0, '4d': 1, 42: 2 };   // High, Main, baseline

function h264Rank(codec) {
  const fmtp = codec.sdpFmtpLine ?? '';
  const match = /profile-level-id=([0-9a-fA-F]{6})/.exec(fmtp);
  return {
    profile: match ? H264_PROFILE_RANK[match[1].slice(0, 2).toLowerCase()] ?? 3 : 3,
    packetization: /packetization-mode=1/.test(fmtp) ? 0 : 1,
    level: match ? parseInt(match[1].slice(4, 6), 16) : 0,
  };
}

function byH264Preference(a, b) {
  const ra = h264Rank(a), rb = h264Rank(b);
  return ra.profile - rb.profile || ra.packetization - rb.packetization || rb.level - ra.level;
}
```

Then `transceiver.setCodecPreferences([...sortedH264, ...everythingElse])`.

Three details that are easy to get wrong:

- **Level matters.** Chromium lists High at level 3.1 (`64001f`) *ahead of*
  High at level 5.0 (`640032`). Level 3.1 tops out around 720p30, so taking the
  first High on the list quietly caps a native-resolution stream. Sort by level
  descending within a profile.
- **Packetization mode 1** allows a frame to span multiple packets. Anything
  above a small picture needs it.
- **Do the receive side too.** A `recvonly` transceiver with no codec
  preferences offers baseline first, and the hardware decoder is never chosen.
  This is why *watching* a stream cost as much as sending one. Use
  `RTCRtpReceiver.getCapabilities('video')` for that side.

There is no getter for codec preferences on a transceiver, so to test this,
return the ordered array from your own helper and assert on that. The offer's
`profile-level-id` may still read `64001f` even when you preferred `640032` —
Chromium renegotiates the level separately, and `level-asymmetry-allowed=1`
means each side encodes to its own level.

### Why `getGPUFeatureStatus()` does not warn you

Electron's `app.getGPUFeatureStatus()` reported `video_encode: enabled`
throughout all of the above, while every call ran on the CPU.

**That flag describes ordinary media playback. It says nothing about WebRTC.**
Do not use it to tell a user whether their stream is hardware-encoded. Use
`encoderImplementation` from `getStats()`, and treat its absence as "software".

(Related trap, unrelated to profiles: `getGPUFeatureStatus()` returns
`disabled_software` for roughly the first 300 ms after launch, before the GPU
process reports. Ask too early and cache the answer and you will report "no GPU"
forever. Poll until it settles, and listen for `gpu-info-update`.)

---

## Problem 3: the cross-adapter display tax

**Chromium cannot composite across GPUs on Windows.**

On a hybrid laptop the internal panel is normally wired to the *integrated* GPU,
while Chromium renders on the *discrete* one. Every frame of the app's window
therefore has to be copied between adapters before the desktop compositor can
draw it. That copy does not appear as your process's cost. It appears as
**`dwm`**, on the *integrated* GPU.

Measured with two Harmony instances open (one streaming, one watching) and a
game running:

| | split GPU, 240 Hz | split GPU, 60 Hz | display wired to discrete |
|---|---|---|---|
| **dwm — total** | **29.0 %** | **25.1 %** | **1.46 %** |
| ↳ on Intel | 20.50 | 19.27 | **0.00** |
| ↳ on NVIDIA | 8.50 | 5.84 | 1.46 |
| app — total | 24.3 % | 24.5 % | 26.7 % |
| Total CPU | 25.3 % | 19.8 % | **15.5 %** |

The controlled version: closing the app entirely, in the split configuration,
took `dwm` on the Intel from 20.50 % to **0.00 %**. That whole load was two
application windows being copied between GPUs.

### The fix is not in the application

There is no flag an Electron app can set for this. It is a firmware/driver
setting: a **MUX switch**, **NVIDIA Advanced Optimus**, or a "display mode"
option in the laptop vendor's utility. Point the panel at the discrete GPU and
the tax disappears.

All an app can honestly do is *tell the user*, which is what Harmony now does
on the connect screen when it detects two adapters.

Caveats on that table, in the interest of not overclaiming: switching the MUX
also reset the external display from 3840×2160 to 2560×1440 and the internal
panel's refresh rate back to 240 Hz, so the game's own row is not comparable
across columns. The `dwm` rows are, and they are the point.

---

## Things that seemed obvious and were wrong

**"Move the app to the integrated GPU."** This was the original fix, via
Chromium's `--force_low_power_gpu`. It did help — but only because it dodged
the cross-adapter copy for *display*, at the cost of making every captured frame
cross instead. With encoding stuck in software it made streams visibly laggy.
Once the profile bug was fixed and the panel was wired to the discrete GPU, this
option became actively wrong: the discrete GPU is where the game being captured
already lives, so capture and encode are both local to it.

The option is still in Harmony for troubleshooting. It is no longer recommended.

**"The 240 Hz panel is multiplying the compositor's work."** Predicted a ~4×
reduction from dropping to 60 Hz. Actual: 20.50 % → 19.27 %. **DWM composites on
content change, not once per refresh** — if the content is a video updating
constantly, a lower refresh rate saves almost nothing. The change bought about
4 points of GPU, worth keeping but not the story.

**"Utilisation numbers will show us the stutter."** They never did. Through the
worst of it the game sat at 23 % of a GPU drawing 21 W at 65 °C, with the CPU at
20 % of 32 threads, while feeling like 20 fps. Nothing was saturated. Throughput
metrics cannot see frame pacing.

**"A canvas-sourced track is a fair stand-in for screen capture."** It is not.
The first loopback probe used `canvas.captureStream(60)` and showed no hardware
encoding — which happened to be the right answer for the wrong reason, and
briefly contradicted an earlier real-app measurement. Re-run anything important
against a real `getDisplayMedia` source before believing it.

**"We need to rewrite the capture path like OBS."** Seriously considered: native
DXGI/WGC capture in a N-API addon, ffmpeg `h264_nvenc` on D3D11 hardware frames,
native WHIP via Pion or libdatachannel, preview rendered into a child HWND
parented to `BrowserWindow.getNativeWindowHandle()`. All genuinely possible —
Electron is not the blocker, and it is roughly what Discord does in
`discord_voice.node`, which is why Discord's desktop client avoids all of this
while Discord *in a browser* does not.

It was not necessary. The gap closed with a codec preference ordering and a
display setting.

---

## The chronology

Roughly how it actually went, including the detours:

1. **Symptom reported**: games feel like 20 fps while streaming, worse with the
   preview visible, fine when minimised.
2. **First measurement** (counter sampling, [§3](#3-sampling-per-process-per-engine-per-adapter-gpu-use)):
   the app was taking ~20 % of the same GPU as the game, and `dwm` another ~22 %
   across both adapters. Concluded, correctly, that cross-adapter compositing
   was involved.
3. **Applied `--force_low_power_gpu`.** It helped. We did not yet understand why,
   and the explanation we gave was incomplete.
4. **Fixed the preview** ([Problem 1](#problem-1-the-preview-was-fed-the-full-capture)):
   ~50× less work in the preview path. Real improvement, not the root cause.
5. **Asked whether an OBS-style native rewrite was needed.** Researching that
   turned up an old chromium-dev thread about WebRTC H.264 and NVIDIA profile
   support, which did not match what we believed about our own app.
6. **Built the loopback probe** ([§8](#8-a-loopback-probe-does-webrtc-use-the-hardware-with-no-server)).
   First run used a canvas source and showed zero hardware use — which
   contradicted an earlier in-app measurement, so we distrusted the probe.
7. **Re-ran against real screen capture.** Still zero. Then
   [validated the counters](#4-validate-the-counters-before-trusting-a-zero)
   against a plain video file: 7.06 % `videodecode`. The counters were fine.
8. **Changed one thing — the profile — and re-ran.** `videoencode` 0.00 % →
   19.03 %. That was the bug.
9. **Fixed send and receive ordering**, verified through a real relay
   end-to-end, and confirmed `videoencode` 6.59 % in the real app where it had
   been 0.00 %.
10. **Remaining symptom** was still there but smaller. Sampling showed `dwm` at
    25 % across two adapters. A controlled A/B — close the app, re-sample —
    attributed 20.5 % of it to two application windows.
11. **Predicted the 240 Hz panel was the cause. Wrong** (see above): dropping to
    60 Hz changed almost nothing.
12. **Wired the internal panel to the discrete GPU via the MUX.** `dwm` fell to
    1.46 % total, the integrated GPU went fully idle, and total CPU dropped from
    25.3 % to 15.5 %.

---

## Checking your own machine

1. **Is WebRTC actually using the hardware?** Start a stream and read
   `encoderImplementation` from `getStats()` ([§7](#7-webrtcs-own-view-via-getstats)).
   If it is missing, you are on the CPU. Cross-check `videoencode` in the GPU
   engine counters ([§3](#3-sampling-per-process-per-engine-per-adapter-gpu-use)),
   having first proved the counters work ([§4](#4-validate-the-counters-before-trusting-a-zero)).
2. **Is your window on the wrong GPU's display?** Sample the counters and look
   at `dwm` split by adapter. Significant `dwm` load on the *integrated* GPU
   while your app renders on the discrete one is the cross-adapter tax.
3. **Does it still feel bad when every number looks fine?** Measure frame times,
   not utilisation ([§10](#10-what-none-of-this-can-tell-you)).

Also worth a look: background clip recorders. Another Electron chat app on the
test machine held **5 % of NVENC continuously**, recording nothing anyone had
asked for, on the same GPU as the game.

---

## Where this lives in the code

| What | Where |
|---|---|
| H.264 profile ordering | `client/src/renderer/webrtc.js` — `H264_PROFILE_RANK`, `preferCodec` |
| Downscaled preview clone | `client/src/renderer/app.js` — `previewCopy`, `PREVIEW` |
| Honest encoder reporting | `client/src/renderer/app.js` — `encoderLabel` |
| Adapter detection and the warning | `client/src/main/gpu.js`, `refreshGpuStatus` |
| CDP harness used by every probe here | `client/test/cdp.mjs` |
| Regression tests for all of it | `client/test/smoke.mjs` |

## References

- [Chromium `media_switches.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/base/media_switches.cc) — the Media Foundation and D3D11 feature flags, most of the zero-copy ones disabled by default
- [chromium-dev: H264 hardware accelerated decoding of WebRTC inbound streams](https://groups.google.com/a/chromium.org/g/chromium-dev/c/D9LsobXOfN8) — the profile mismatch, noticed years ago and never really fixed
- [BlogGeek.me: the challenging path to WebRTC H.264 hardware support](https://bloggeek.me/webrtc-h264-video-codec-hardware-support/) — why this is fragile everywhere, not just here
- [PresentMon](https://github.com/GameTechDev/PresentMon) — frame times, for when utilisation lies
