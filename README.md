# Harmony

> [!WARNING]
> ## 🤖 This project was entirely vibecoded
>
> **Every line of this repository — client, server, tests and these docs — was
> written by an AI coding assistant, prompted by a human who did not review it
> line by line.** It is a recreational project, built for fun and for a handful
> of friends to share screens with. Treat it accordingly.
>
> It does work: it has been run in production for a small group, the test suites
> are real (they drive two actual Electron clients through a real media server,
> nothing mocked), and the measurements quoted throughout this README were taken
> rather than guessed. But *working* and *production-grade* are different claims,
> and only the first one is being made here.
>
> **Before you put this anywhere that matters, know what it does not have:**
>
> - **No authentication whatsoever.** Anyone who can reach the server can claim
>   any free username and broadcast, or watch anyone who is live. This is the
>   design, not an oversight — but it means the server must not be exposed to
>   anyone you would not hand a key to.
> - **No security review, no audit, no fuzzing.** Untrusted input reaches a
>   media server and a native Windows audio module. Nobody has attacked this on
>   purpose.
> - **No rate limiting, no abuse controls, no quotas.** A single client can
>   saturate your upload.
> - **No high availability.** One host, no redundancy, no failover, no backups.
> - **No stability guarantees.** No versioning policy, no migration path, no
>   promise that tomorrow's commit will not break your setup.
>
> Use it on a LAN, or among people you trust, and enjoy it. If you need screen
> sharing that carries real consequences when it fails, use something with an
> operations team behind it. **No warranty — see [LICENSE](LICENSE).**

**Self-hosted screen sharing with sub-second latency, on hardware you already
have.** Sub-second glass to glass, because nothing is ever transcoded and there
is no playback buffer to scrub.

**There are no accounts and no passwords.** Type a username to start sharing
under it. Type a name someone else is already using, and you watch them instead.
That is the whole interaction model.

```
Desktop client (Electron)                    Server (x86-64 or arm64 Linux)
┌────────────────────────┐                  ┌──────────────────────────────┐
│ desktopCapturer        │   WHIP over TLS  │ Harmony control server :8080 │
│   screen │ window      │ ─── signaling ─► │   • username reservation     │
│ loopback-capture       │                  │   • MediaMTX auth hook       │
│   system │ per-process │                  │   • live stream list         │
│ RTCPeerConnection      │   SRTP over UDP  │ MediaMTX :8889 / :8189       │
│   H.264, GPU encoded   │ ═══ media ═════► │   pure packet relay          │
└────────────────────────┘                  └──────────────────────────────┘
          ▲   WHEP + SRTP                                  │
          └────────────── viewers ─────────────────────────┘
```

## What the server needs

Almost nothing, and that is the whole design. **The server never touches a
pixel** — it does not decode, encode, transcode, re-mux or write to disk. The
broadcaster's GPU encodes H.264 and the server forwards the resulting RTP packets
untouched, so its cost per stream is a socket and a memcpy rather than a video
pipeline.

| | |
| --- | --- |
| **CPU** | Any 64-bit Linux box. **x86-64 and arm64** both work, as do armv7 and armv6. No GPU, no hardware encoder, no AVX. |
| **RAM** | 512 MB is comfortable. Nothing is buffered server-side. |
| **Disk** | ~150 MB installed. Nothing is recorded. |
| **Real ceiling** | **Your upload bandwidth.** Every viewer of every stream is a separate copy out of the server: one 8 Mbps broadcaster with three viewers is 24 Mbps up. |

Run in production on a **Raspberry Pi 5** (8 GB, Ubuntu 26.04 aarch64); the
relay and control server also run on **x86-64** on every pass of the e2e suite.
A mini-PC, an old laptop, a VPS or a NAS will all do — and a VPS with real upload
bandwidth is the better choice if your home connection is thin, because bandwidth
is the only resource this is ever short of.

The client is where the actual work happens: it encodes on the GPU and decodes
one stream per tile you open.

---

## Features

### Sharing

- **Screens, windows, and cameras or capture cards** — anything the OS exposes as
  a video input.
- **Audio follows what you share.** A whole screen sends system audio; a single
  window sends only that application's audio (Windows); a capture card takes its
  sound from an audio input you pick beside it.
- **Exclude one app from a screen share** — typically a voice-chat client, so your
  friends do not hear themselves.
- **Change what you are sharing, mid-stream**, without interrupting viewers.
  Quality and encoder priority are live too.
- **Hear your own outgoing audio** with the 🎧 button, for capture cards and
  microphones.
- **Four quality presets**, from 720p30/3 Mbps to native-resolution 60 fps at
  25 Mbps, and a **priority** switch deciding what the encoder sacrifices when the
  budget runs out — *Sharp* keeps resolution so text stays readable, *Smooth*
  keeps frame rate so motion stays fluid.

### Watching

- **Mosaic view** — watch every live stream at once, or hand-pick a few. The grid
  fits tiles to the window in both directions and reflows as people come and go.
- **Independent audio per tile**, each with its own mute and volume, scaled by a
  master slider in the footer. Nothing is exclusive.
- **Fullscreen any tile** with the ⛶ button or a double-click; **Esc** or ✕ to
  leave. It is the real Fullscreen API, so it covers the taskbar.
- **Broadcast and watch at the same time.** Your own stream is left out of the
  grid — the preview already shows it, and pulling it back down would spend the
  bandwidth twice.
- **Add a stream from inside a stream**: watching one person, pick another, and
  they appear beside them.

### Clips

- **Save the last 30 seconds** of any feed you are sending *or* watching, as an
  MP4 in `Videos/Harmony Clips`. Off by default; one toggle on the connect screen
  turns it on for every feed.
- **Nothing is re-encoded.** The buffer taps WebRTC's *encoded* frames, so a clip
  costs a memcpy rather than a second H.264 encode per feed.

### Connecting

- **Works on networks that block UDP**, via an ICE-TCP fallback on the same port —
  no TURN relay, no third party, no per-gigabyte bill.
- **A connection test** on the connect screen walks health → session → STUN → SDP
  → media and tells you which step failed.
- **One portable .exe**, no installer and no admin rights. Enter a server address
  once and it is remembered.

---

## Getting started

**Server:** clone the repo onto any Linux box, run `sudo server/install.sh`, set
two environment variables, forward port 8189 (UDP **and** TCP). The installer
picks the right MediaMTX build for your architecture.

**Client:** `cd client && npm install && npm run build` gives you
`dist/Harmony-0.1.0-portable.exe`.

The full procedure — TLS on a line whose ISP blocks 80 and 443, dynamic IPs,
packaging, tests and a troubleshooting table — is in
**[DEPLOYMENT.md](DEPLOYMENT.md)**.

---

## Why it is built this way

**Relay, never transcode.** This is not a micro-optimisation, and the constraint
that forced it is worth stating plainly: the Raspberry Pi 5 has *no hardware
H.264 encoder at all* (the Pi 4's was dropped), so a design that transcoded would
have been capped at a few frames per second there. Building for the weakest
plausible host is why it now runs on anything — an arm64 SBC, an x86-64 mini-PC,
a cheap VPS — and why adding viewers costs bandwidth rather than CPU.

**Two independent locks on a username.** A short-lived token claim in the control
server covers the seconds between picking a name and the first packet arriving;
`overridePublisher: no` in MediaMTX means that even with a valid token, a second
publisher cannot take a live path away from whoever holds it. Neither lock
depends on the other being correct.

One wrinkle worth knowing, because it is measured in the e2e suite: MediaMTX
answers a WHIP offer *before* it decides whether that publisher may have the
path. A rejected second publisher therefore gets a perfectly successful handshake
and then streams into nothing. So the client does not trust the `201` — after
publishing it waits for the control server to confirm the stream is actually
live, and reports a clear error if it never appears.

**Liveness is never tracked, only observed.** The control server polls MediaMTX
and mirrors what it reports. If a broadcaster's laptop sleeps, the connection
drops, MediaMTX forgets the path, and the username frees itself. There is no
bookkeeping to leak.

**Media and signaling are separated on purpose.** Signaling is ordinary HTTP and
goes through a reverse proxy or a Cloudflare Tunnel happily. Media is UDP and
cannot: `cloudflared` has no public UDP support, so a tunnel alone would give you
a connection that negotiates perfectly and then plays nothing. The media port has
to be forwarded.

**Per-application audio is Windows-only.** Chromium's loopback capture is
system-wide; capturing a single app needs the Windows WASAPI process-loopback API
through the optional native `loopback-capture` module. On macOS and Linux a window
share falls back to whatever you pick in the client — silent by default, so other
applications' sound never leaks into a stream by accident.

---

## Notes from building it

Things that were surprising, measured rather than assumed, and worth knowing
before you change the code.

<details>
<summary><b>Chromium throttles a renderer you cannot see — down to 1 fps</b></summary>

A minimised or covered window drags the encoder to a few frames per second, which
looks exactly like a network problem and is not. The client disables it with
`backgroundThrottling: false` plus three matching command-line switches. If you
fork the client, keep them.

Separately, **low frame rates are usually a bitrate ceiling.** Measured on a
1080p screen full of motion: *Sharp* at a 4 Mbps ceiling gives ~31 fps at full
resolution, and raising the ceiling to 10 Mbps takes it to ~58 fps still at 1080p.
Raise the preset before reaching for *Smooth*.
</details>

<details>
<summary><b><code>encodedInsertableStreams</code> is not free to leave switched on</b></summary>

With the flag set and nothing reading the encoded stream, Chromium keeps encoding
and sends *nothing at all* — measured at 178 frames encoded, 0 bytes sent. So the
flag is only set on connections whose frames something will actually read, which
is why toggling clips takes effect on the **next** stream rather than the current
one.
</details>

<details>
<summary><b>Clips carry Opus audio in MP4</b></summary>

Legal, and it plays in Chromium, VLC, ffmpeg and anything browser-based — but a
few older Windows players will show video with no sound. Converting to AAC would
need a decode/encode pass, which is the one cost this design exists to avoid.

Memory is simply bitrate × 30 s per stream: ~11 MB at the Low preset, ~30 MB at
Balanced, ~94 MB at Ultra, with a hard 192 MB ceiling and the oldest frames
dropped continuously.
</details>

<details>
<summary><b>ICE-TCP instead of a TURN relay</b></summary>

MediaMTX leaves its TCP media listener off by default, because TCP carries
real-time media badly — one lost packet stalls everything behind it, so a
congested link degrades into growing delay rather than dropped frames. That is
the right default for a server where everyone can use UDP, and the wrong one for
a self-hosted tool whose users sit on corporate and campus networks that drop UDP
outright. ICE only falls back to it when UDP fails, so it costs nothing when it
is not needed. Verified by stripping every UDP candidate from the server's answer
and confirming the session still connected.
</details>

<details>
<summary><b>The published audio track is created once and never replaced</b></summary>

Everything feeds a Web Audio mixer behind it. That is what lets you switch from a
screen to a webcam mid-stream without renegotiating: `replaceTrack()` changes the
video sender in place, and the audio change is just the mixer listening to
something else.
</details>

<details>
<summary><b>WASAPI excludes one process tree per capture</b></summary>

`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` takes a single target. That
platform limit is why the audio-exclusion picker is single-select rather than a
list of checkboxes — not a simplification.
</details>

<details>
<summary><b>Fit tiles to the window in both dimensions, not just width</b></summary>

The mosaic tries every column count and keeps whichever makes each 16:9 tile
largest while still fitting the height. Sizing on width alone — the obvious
approach, and the first one here — had a real consequence: four tiles in two
columns of a wide window made rows taller than the window, and the bottom row's
volume and fullscreen controls sat below the fold where they could not be clicked
at all.
</details>

---

## Layout

```
server/
  mediamtx.yml            relay config — annotated, worth reading before changing
  src/rooms.js            username reservation
  src/mediamtx-api.js     liveness polling
  src/index.js            HTTP API + MediaMTX auth hook
  install.sh              installer (detects architecture)
client/
  src/main/               Electron main: capture, native audio, all HTTP
  src/preload/            the one bridge into the renderer
  src/renderer/           UI, WHIP/WHEP, PCM → WebRTC audio pipeline
  test/                   smoke (packaged builds), e2e (two real clients)
```

## Tests

```bash
npm --prefix server test          # reservation logic + auth hook
npm --prefix client test          # launches the app, drives it over CDP

MEDIAMTX_BIN=/path/to/mediamtx npm --prefix client run test:e2e
```

The e2e suite starts MediaMTX and the control server, then drives two Electron
clients — one publishes its screen over WHIP, the other enters the same username
and must end up decoding that video over WHEP. Nothing is mocked.

## Known limits

- **One stream per username.** That is the design, not a bug.
- **No accounts.** Anyone who can reach the server can claim any free username.
  Do not expose it where that is not acceptable.
- **No recording on the server.** MediaMTX can do it without re-encoding
  (`record: yes` in `pathDefaults`) but it is off — partly because an SD card is a
  poor place for video, partly because writing to disk is the one thing that
  would give the server a cost that scales. Client-side clips cover the common
  case.
- **No adaptive simulcast.** Every viewer gets the broadcaster's single encoding.
  Adding simulcast would move work onto the broadcaster rather than the server,
  so it is feasible — just not done.
- **Viewer "pause" freezes on the last frame** and resumes at live. There is no
  buffer to scrub, which is the normal trade for sub-second latency.

## Built on

[MediaMTX](https://github.com/bluenviron/mediamtx) · [Electron](https://www.electronjs.org/)
· [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) · [loopback-capture](https://www.npmjs.com/package/loopback-capture)

## License

MIT
