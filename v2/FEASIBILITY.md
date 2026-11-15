# Harmony v2 — Go + raylib: feasibility and prototype

Written for: the project owner, deciding whether to commit to a second client.

## Verdict

**The hard technical question is settled: yes, a Go + raylib client can do what the Electron client does for voice and
screen share, against the server exactly as it is.** The prototype in this directory signs in, joins a voice channel,
hears everyone, is heard, shares a screen and watches other people's shares, and it does so in the same room as the
Electron client. The server was not touched.

**The expensive question is not the media, it is the interface.** The Electron client is 53,000 lines of JavaScript
(75 renderer modules; `app.js` alone is 19,300 lines) for chat, DMs, forums, polls, roles, settings, search and the
rest. The prototype's voice-and-share core is 3,900 lines of Go. raylib draws rectangles and text; it has no text
layout, no editing, no emoji, no IME, no accessibility. That is where a rewrite lives or dies.

**It will not, by itself, fix the laggy-stream problem** (see below). It would give us the control to investigate it
properly; that is a reason to build the prototype further, not a reason to rewrite the client.

## What was built

`v2/` is a separate Go module. Nothing in `client/` or `server/` changed.

```
cmd/harmony2    the raylib window: login, channels, voice room, share, watch
cmd/h2probe     the same client with no window, for tests: talks, shares, reports what it hears and sees
internal/hclient  the server's own protocol: HTTP login, the WebSocket (hello, voice:join, rosters, tokens)
internal/media    Pion WebRTC: WHIP/WHEP to MediaMTX, Opus voice, H.264 screens
internal/audio    the mixer (one stream per person, summed locally) and the sound card (miniaudio via malgo)
internal/video    screen capture + H.264 encode, and H.264 decode (now the system's own codecs, no ffmpeg; the benchmark below is of the earlier ffmpeg pipe)
internal/app      the behaviour: Session (join, reconcile subscriptions, share, watch)
dev/stack.sh      a throw-away server + MediaMTX on local ports, with accounts alice and bob
```

## What was proven, and how

| Claim | How it was checked | Result |
|---|---|---|
| Signs in and speaks the realtime protocol | Real server, `hello`, `voice:join`, rosters, token refresh | works |
| Hears people, is heard (Go ↔ Go) | Two `h2probe`s, a 440 Hz and a 660 Hz tone, through the real server and MediaMTX | each hears the other |
| Screen share, Go → Go | x264 test picture, decoded by the viewer | 30 pictures/s arrive and decode |
| **Go ↔ Electron, voice** | A one-off script (since removed, as a feature-level test): Electron's tone heard by Go, Go's tone heard by Electron | 3/3 checks |
| **Go ↔ Electron, picture** | Electron decodes Go's H.264 share; Go decodes Electron's camera (Chromium's own H.264 encoder) | 3/3 checks |
| Real screen capture, hardware encode | macOS screen → `h264_videotoolbox` → relay → viewer window | works, ~30 fps (screenshot checked) |
| Opus is bit-compatible with libopus | Packets from ffmpeg's libopus decode with ours; ours decode in ffmpeg's libopus (checked once by hand with ffmpeg; those tests were removed with ffmpeg) | both directions passed |
| Windows / Linux builds | `CGO_ENABLED=0 GOOS=windows go build` (21 MB `.exe`) | **builds; never run** |

Not verified: anything on Windows or Linux at runtime, the microphone (needs an OS permission I could not grant here),
the speakers (not played, to keep the machine quiet), more than two people, a TURN relay, a password-protected server.

## What went wrong on the way (and what it says about the approach)

1. **Opus in Go.** The first library tried (libopus transpiled to Go) aborted on the first packet of every
   subscription, always: its generated code keeps pointers into the goroutine stack, and Go moves that stack when a new
   goroutine's first call grows it. It passed every test run from a long-lived goroutine, which is why it looked fine.
   Replaced by **gopus** (a hand-written Opus in Go), with interoperability tests against real libopus. `gopus` needs
   Go 1.27.3 or newer. No libopus to ship, no cgo.
2. **raylib and the sound card each bundle miniaudio**, and linking both fails with duplicate symbols. Fixed by using
   raylib-go's no-cgo mode (build tag `nocgo`: raylib is loaded from an embedded shared library), which also means the
   window needs no C compiler.
3. **The sound card is the one piece that needs cgo.** Everything else builds with `CGO_ENABLED=0` for any OS. A build
   without cgo has no sound (a stub is provided) but does the rest, which is how the Windows `.exe` above is made.
4. **Waste is visible immediately.** The first viewer allocated a 3.7 MB buffer per picture; that alone was 22% of a
   core. Reusing buffers took the whole window to 5%.

## Measured

| | Go prototype | Electron (from the friend's debug log, while sharing) |
|---|---|---|
| Memory | ~190 MB (window, font, a 720p texture) + ~26 MB decoder process | ~1,180 MB across 6 processes |
| CPU | ~5% of one core viewing a 720p30 share and in a call (+ ~12% for the ffmpeg decoder) | not comparable: different machine and load |
| Binary | 21 MB (ffmpeg is no longer needed: video runs on the system's own codecs) | ~100+ MB installed |

These are not like for like (the prototype has no chat, no images, no fonts beyond one) and should be read as "the
floor", not as a promise.

## What v2 does not fix: the friend's laggy stream

His logs show a game using all of the GPU and starving both the screen capture and the hardware encoder. A Go client
that captures through the same Windows API and encodes through the same AMD media encoder starves the same way. What v2
gives is **control over which of those it uses**, and the prototype already exposes it:

- `-grabber gdigrab` (CPU capture, needs nothing from the GPU) or `ddagrab` (GPU capture),
- `-encoder libx264` (CPU) or `h264_amf` / `h264_nvenc` / `h264_qsv` (the GPU's).

So the cheap experiment, before any rewrite: run `h2probe`/`harmony2` on his PC with `-grabber gdigrab -encoder libx264`
(nothing on our side touches the GPU) while the game runs. If that is smooth, the lag is the GPU path and the answer is
a CPU-capture-and-encode fallback, which the **Electron** client could also grow. If it is not smooth, it is not the GPU.

## The real cost: the interface

What Chromium gives Electron that a raylib client must build or buy:

- text layout and editing (selection, caret, IME for CJK and accents, bidi), links, markdown, **colour emoji**,
- scrolling lists with thousands of rows, image and GIF decoding and display, video attachments, drag and drop,
- accessibility (screen readers) — raylib has none, and this cannot be added later cheaply,
- **echo cancellation, noise suppression and automatic gain** — the browser's WebRTC audio processing. The Electron
  client uses them (and an RNNoise worker); in Go each would be a separate cgo library,
- hardware video decode and encode wired up in-process (done in wave 5: the prototype's ffmpeg pipe is gone),
- auto-update, code signing and installers (electron-builder today).

The Electron client's other builds (web, Android via Capacitor) cannot move: v2 is desktop only.

## Risks

| Risk | Weight | Note |
|---|---|---|
| Interface parity (chat, DMs, forums, roles, settings, i18n in 3 languages) | very high | the bulk of the 53k lines; no layout engine to lean on |
| Audio processing (AEC/NS/AGC) | high | not in Go; needs cgo libraries and tuning |
| Video: in-process hardware encode/decode per OS | high | done: the ffmpeg pipe was replaced by the system codecs |
| Accessibility | high | not available in raylib |
| Sound card layer needs cgo (a C toolchain on Windows) | medium | contained to one package |
| Newness of dependencies (`gopus` needs Go 1.27.3+; raylib-go's no-cgo mode) | medium | tested here, young |
| Two clients to maintain against one server | medium | the protocol is small and stable; the cost is features |

## Recommendation

1. **Do not replace the Electron client on this evidence.** Keep it as the product.
2. **Keep v2 as a test bed for voice and screen share** (it is small and fast to change), and use it to answer the
   GPU-starvation question on the friend's machine this week.
3. If a full rewrite is still wanted after that: start with **audio processing and in-process video**, the two places
   Go is weakest, and prove them on Windows before drawing a single chat bubble. The text/UI layer is where most of the
   months will go; budget for it, and decide about accessibility before starting, not after.
