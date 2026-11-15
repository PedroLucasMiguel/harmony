# v2 benchmark: resource footprint of the Go + raylib client vs the Electron client

Date 2026-11-15. Machine: Apple M4 (10 cores), 16 GB, macOS 27.0.1 (26A434), retina display, Go 1.27.4. Server, MediaMTX and the publishers ran on the same machine.

Builds measured
- v2: `go build -tags nocgo -trimpath -ldflags "-s -w" -o harmony2 ./cmd/harmony2` (plus a TEMPORARY in-process driver for signing in, scrolling and frame timing, since deleted; it adds nothing measurable).
- Electron: `client/` 5.2.8 run from `client/node_modules/electron` (dev Electron, same renderer code, `--remote-debugging-port`, default 1180x800 window, fake camera/microphone devices). No packaged build exists in `client/dist`, so no packaged run (the installed `/Applications/Harmony.app` 5.2.8 was not run: it would use the real settings and auto-update).

## Sizes

| | size |
|---|---|
| `harmony2` release binary | 23.56 MB (22.5 MiB) |
| `h2probe` | 14.10 MB (13.4 MiB) |
| Electron, installed `/Applications/Harmony.app` 5.2.8 | 260 MB |
| Electron, dev `Electron.app` in `client/node_modules` | 288 MB |
| packaged build in `client/` | not measured (none present) |

ffmpeg is a separate dependency of v2 (screen share, camera, stream decode); not counted above.

## Method

- Data: server on port 18280 seeded with 150 messages in #general (6 PNG and 3 JPEG pictures 480x640 to 1920x1080, a 60-line text file, a GitHub link card, 3 polls with votes, reactions, replies, markdown), 60 end-to-end DM messages and 3 pictures from bob to alice. Chat scenarios first scroll the log to the top (loading all history) and back, so the whole log has been loaded and decoded.
- Each scenario: 5 s settle, then 30 s measured, sampled once a second by `dev/bench.sh`: RSS from `ps -o rss` (summed over the process tree: for Electron main, renderer, GPU, utility, crashpad; for v2 also the ffmpeg children), memory footprint and CPU from `top` (CPU is the change over each second, as % of one core), threads, idle wakeups per second (change of top's running total).
- RSS counts shared pages once per process, so the Electron sum (about 800 MB) overstates what it really holds; the memory footprint (what Activity Monitor shows, includes GPU memory) is the fair figure. Both are given.
- v2 frame statistics come from a timer inside the process: "draw" is from the start of a frame to just before the buffer swap (the UI pass plus raylib's batch flush), "frame" includes the swap (vsync). Heap allocations per frame from `runtime.MemStats` (separate pass, 20 s, with a heap profile to attribute them).
- Wheel input for the scroll scenarios: 60 events/s, 48 px each, alternating direction every 3 s (v2: injected into the frame loop's input; Electron: CDP `Input.dispatchMouseEvent mouseWheel`).
- Remote streams: `h2probe -nick bob|carol|dave -share test -auto=false` (testsrc2 720p30, libx264); alice (v2 or Electron) watches them, plus her own camera (test source 360p24 in v2, the fake device in Electron). Verified each time (v2 stream list; Electron `<video>` elements playing 1280x720).
- Not quiet machine: five leaked Electron test instances from earlier agents (`harmony-tree-*`) were running throughout, idle at about 1% CPU each; I was not allowed to kill them. Memory pressure was high (about 300 MB free, 4.5 GB compressed), which can compress RSS of idle pages; footprint is less affected.
- The window was the frontmost window during all v2 runs except the ones marked unfocused.

## Startup (to first presented frame)

| | v2 | Electron |
|---|---|---|
| first run (fresh binary / fresh profile) | 683 ms | 525 ms (first contentful paint) |
| warm (3 runs / 1 run) | 368, 312, 291 ms | 333 ms |
| RSS right after the first frame | 185-191 MB | 550-554 MB (tree sum) |
| RSS 3 s later | 186-192 MB | 563 MB |

v2 time is spawn to the end of the first frame's buffer swap (process init alone is 79-141 ms warm, 467 ms on the first run). "Cold" is a never-run copy of the binary, not a purged disk cache (needs root).

## Scenarios, v2 vs Electron

RSS and footprint in MB (mean), CPU in % of one core (mean / p95), threads, idle wakeups per second. v2 numbers include the ffmpeg children where there are any.

| # | scenario | v2 RSS | v2 footprint | v2 CPU mean / p95 | v2 thr | v2 wake/s | Electron RSS (sum) | Electron footprint | Electron CPU mean / p95 | Electron thr |
|---|---|---|---|---|---|---|---|---|---|---|
| 2 | connect screen idle | 191.6 | 301 | 1.78 / 2.30 | 21 | 103 | 561 | 163 | 1.54 / 4.90 | 114 |
| 3 | #general, 150 messages, idle | 274.0 | 369 | 2.16 / 2.50 | 21 | 144 | 794 | 327 | 1.74 / 3.20 | 110 |
| 4 | same, scrolling 20 s+ | 260.4 | 372 | 26.6 / 29.2 | 21 | 307 | 788 | 340 | 10.6 / 30.2 | 112 |
| 5 | message + typing every second | 271.4 | 371 | 4.49 / 5.60 | 21 | 102 | 808 | 421 | 7.86 / 10.1 | 110 |
| 6a | emoji picker open, scrolling | 286.5 | 384 | 24.9 / 28.6 | 20 | 324 | not measured | | | |
| 6b | settings window open, idle | 274.8 | 369 | 2.57 / 3.10 | 22 | 131 | not measured | | | |
| 6c | DM conversation open (E2E), idle | 198.8 | 306 | 2.07 / 2.50 | 21 | 122 | not measured | | | |
| 7 | voice channel alone, tone mic | 205.2 | 308 | 9.73 / 10.7 | 21 | 948 | 807 | 405 | 7.09 / 9.40 | 118 |
| 8a | voice, watching 1 share + own camera | 334 | 398 | 29.7 / 31.3 | 78 | 443 | 861 | 418 | 21.6 / 25.8 | 127 |
| 8b | voice, watching 3 shares + own camera | 390.5 | 431 | 36.1 / 38.9 | 108 | 450 | 899 | 468 | 21.7 / 24.0 | 127 |
| 9a | window minimised, chat | 262.7 | 275 (360 before) | 0.12 / 1.60 | 19 | 1 | not measured | | | |
| 9b | window covered by a full-screen window | 267.7 | 367 | 2.24 / 2.90 | 22 | 104 | not measured | | | |
| 9c | window not frontmost (Finder active), chat | 267.7 | 365 | 4.10 / 10.6 (incl. 5 s of repaint on losing focus; steady 2 fps) | 21 | 0.5 | not measured | | | |
| 9d | window not frontmost, connect screen | 185.0 | 294 | 2.80 / 3.50 | 19 | 0.1 | not measured | | | |
| 9e | window focused, chat | 260.6 | 364 | 2.22 / 2.70 | 21 | 125 | not measured | | | |

Process trees at the last sample: v2 8a = main 249 MB RSS / 354 footprint + camera encoder ffmpeg 60/30 + one decoder 29/18. v2 8b = main 259/367 + encoder 59/30 + three decoders 24/12 each (decoded at the size drawn, 592x332). Electron: 6 processes (main 205, GPU 135, utility 47+45, renderer 306, crashpad/other 53 MB RSS in chat; renderer footprint 146 MB, GPU 87 MB).

Idle wakeup figures are top's counter; it reported a flat 0 in three early runs and 0.1 to 0.5 in the not-frontmost runs (App Nap coalesces timers), so treat the low values as unreliable and the 100-150/s typical idle as the real order.

Frame statistics for v2 (ms):

| scenario | frames/s | draw mean / p95 / max | frame (with swap) mean / p95 / max | allocations per frame |
|---|---|---|---|---|
| connect idle | 2.0 | 4.7 / 5.9 / 6.2 | 5.6 / 7.0 / 7.3 | not measured |
| chat idle | 2.0 | 7.8 / 9.1 / 10.6 | 9.1 / 10.6 / 11.9 | 3130 |
| chat scrolling | 94 | 7.9 / 10.6 / 12.1 | 10.6 / 13.2 / 28.1 | 4796 (4792 in a second run) |
| emoji picker scrolling | 75 | 9.4 / 12.1 / 16.2 | 13.4 / 27.3 / 28.8 | not measured |
| settings idle | 2.0 | 9.2 / 11.3 / 14.3 | 12.6 / 15.3 / 18.2 | not measured |
| DM idle | 2.0 | 7.3 / 9.1 / 9.3 | 8.2 / 10.4 / 10.4 | not measured |
| voice alone | 9 | 5.9 / 7.5 / 10.6 | 7.1 / 8.9 / 13.6 | not measured |
| watching 3 + camera | 70 | 4.4 / 5.7 / 9.8 | 6.4 / 12.5 / 22.2 | not measured |

Electron's scroll rendered 63.7 frames/s (rAF interval mean 16.7 ms, p95 17.3 ms: locked to 60 Hz); v2 draws 94 frames/s for 60 wheel events/s because each input is followed by two "settle" frames. Allocations per frame must be about 0 on a steady frame: they are 3000-4800 (see the cut list). They are counted for the whole process, so goroutines other than the UI add a little, but the heap profile attributes 98% to `Painter.Text` and the raylib FFI calls on the UI thread.

## Memory breakdown, v2, chat idle (scenario 3)

`vmmap -summary` / `footprint` of the running process: physical footprint 341 MB (peak 385 MB), RSS about 275 MB.

| contributor | MB | what it is |
|---|---|---|
| GPU-owned window and driver memory ("owned physical footprint (unmapped) (graphics)") | 103 | OpenGL-on-Metal backing of the window (retina 2360x1600), not in RSS |
| Go heap and other anonymous memory ("Untagged", dirty) | 95 (+39 reclaimable) | Go heap: 55 MB in use, 131 MB reserved (76 MB idle, 20 MB returned) |
| IOSurface | 72 | the window's swap buffers (5 surfaces of about 15 MB), not in RSS |
| IOAccelerator (graphics) | 33 | GPU buffers and textures: glyph atlas, pictures, vertex buffers |
| malloc zones (libs, Metal/GL driver) | 21 | |
| owned unmapped, `__DATA`, stacks (21 threads, 0.5 MB) and the rest | 15 | |
| the binary and libraries (`__TEXT` 329 MB resident) | 0 dirty | file-backed, mostly the shared dyld cache; the binary itself is 23.6 MB on disk and counts in RSS only |

Fonts are not mapped: they are embedded (or read) and parsed into the Go heap. The Go heap profile (`inuse_space`, 50.3 MB): `go-text` font parsing 45.6 MB (variable-font `gvar` tables 29.8 MB, `unpackDeltas` 9.2 MB, Apple Color Emoji `morx` 7.7 MB; 37 MB while loading the text typefaces at startup and 8 MB when the emoji font is first needed), shaping 9.9 MB, everything else (messages, layout, pictures' CPU side) under 5 MB. Memstats at the same point: HeapInuse 55.1 MB, HeapSys 131 MB, HeapIdle 76 MB, HeapReleased 20 MB, StackInuse 0.8 MB, GCSys 6.6 MB, Sys 144 MB, 13 GCs in 40 s (startup churn), 12.0M mallocs.

Connect screen vs chat: 192 -> 274 MB RSS and 301 -> 369 MB footprint: the emoji font (8 MB heap), the picture textures and the atlas growing, and the larger heap slack. A DM conversation or the voice view with a small log is 199-205 MB RSS / 306-308 footprint.

Minimising frees the GPU surfaces: footprint 360 -> 265 MB and CPU 0.12%, wakeups 1/s: the window really stops when minimised.

## What to cut, ranked (findings of the first run; status after the fixes marked in bold, details in "After the footprint fixes")

1. **Partly done** (idle window footprint 369 -> 205 MB; the 72 MB of IOSurface swap buffers remain). Window GPU memory, about 175 MB footprint (103 + 72), half of the process. It is the retina swap chain and driver backing; macOS drops about 90 MB of it when the window is minimised. Candidates: fewer/smaller swap buffers, no depth/stencil buffer, a Metal drawable with 2 buffers; check what raylib allocates. Estimate 60-100 MB, unverified. Electron's whole GPU process is 87 MB.
2. **Partly done** (Go heap "Untagged" 95+39 -> 71 MB, HeapSys 131 -> 67 MB, HeapInuse 55 -> 37 MB). Parsed fonts in the Go heap, about 46 MB: `gvar` tables parsed eagerly for the whole variable SF fonts (30 MB), and the emoji font's `morx` (8 MB). Pre-instance the few weights used, or parse lazily, or share the table memory (mmap). Plus about 76 MB of idle Go heap (GC slack): `debug.SetGCPercent` lower / `FreeOSMemory` after loading. Estimate 40-70 MB RSS.
3. **Done** (allocations per frame 3130 -> 105 idle, 4796 -> 81 scrolling; draw 7.8 -> 0.9-1.1 ms). Per-frame allocation and FFI cost, which is also the CPU cost: 3130 allocations on an idle frame and 4800 while scrolling, 75% from `ffi.Fun.Call` boxing the arguments of every raylib call (one `DrawTexturePro` per glyph = 2.5M allocations in 2600 frames), the rest `Painter.Text`. Batch glyph quads into one vertex buffer / a few calls per text run, and cache runs. This is what makes a static idle frame cost 8 ms and a scroll frame 8 ms of CPU.
4. **Done** (chat idle 2.16% -> 0.88% with the caret blinking, 0.05% once it stops after 10 s; connect 1.78% -> 0.10%; minimised 0.00%). Idle CPU is about 2.2% in chat and 1.8% on the connect screen, more than Electron's 1.7% / 1.5%: two full-window redraws a second (caret blink, 8-10 ms each) plus the 16 ms sleep loop (about 62 wakeups/s of its own). The blink continues when the window is not frontmost (steady 2 frames/s measured) and when the window is covered (the toolkit has no occlusion event). Fixes: draw only the caret's rectangle (or skip frames whose only change is the caret), stop blinking when the window is not focused, wait for events with a timeout instead of sleeping 16 ms. Settings, DM and chat all idle at 2 frames/s because a text box is focused; I did not find an idle screen at 0 frames/s other than minimised, and did not test chat with no field focused.
5. **Partly done** (26.6% -> 17.4% at 54 frames/s, Electron 10.6% at 64). Scrolling: 27% CPU at 94 frames/s against Electron's 10.6% at 64. The two "settle" frames after each input make 3 frames per wheel event; one frame per event (about 60/s) would cut a third, and item 3 the rest.
6. **Partly done** (9.73% -> 7.0%, 9 -> 1 frames/s; what is left is not drawing). Voice alone costs 9.7% CPU: `redraw.After(100 ms)` for the speaking indicator redraws the whole window at 9 frames/s (6 ms each). Redraw only when a level crosses the speaking threshold.
7. **Partly done** (36.1% -> 30.0% for three streams plus camera with VideoToolbox decode and encode; footprint 431 -> 369 MB). Video: v2 spends 30-36% CPU with ffmpeg (software H.264 encode of the camera, ffmpeg decoders) against Electron's 21% with hardware decode, but less memory (431 vs 468 MB footprint with three streams). Each ffmpeg child costs 12-30 MB footprint and one process; a VideoToolbox decode path would also cut CPU.

Also seen while measuring (not a resource issue): in `h2probe`, a share started just before another person joined the room was stopped with "microphone path dropped: rebuilding" / "stopped sending the screen" and then sent nothing; publishers were restarted until all streams ran. Worth a look in `internal/app/session.go` (the rebuild of the peer paths stops a running share).

## After the footprint fixes

Re-measured on 2026-11-15 after the paint, loop, mem, gpu and video lanes landed. Same machine, same seeded server (port 18280, 150 messages in #general with pictures, a text file, an embed, polls and reactions; the log is scrolled to the top and back so all history is loaded). v2 only: the Electron columns are the unchanged numbers from the tables above. One run per scenario, 5 s settle (15 s for 3b), 20 s sample, window frontmost (checked with System Events before each sample), a temporary in-process driver (in a scratch copy of the tree, not in it) for sign-in, wheel input, frame count and `MemStats`. Method differences from the first run: CPU is the change of `ps -o cputime` over the sample (v2 main plus ffmpeg children), not `top`; RSS is the mean of the tree sampled every 5 s; footprint is `footprint <pid>` taken once at the end of the sample, summed over the tree; threads from `ps -M`. Allocations per frame are the `MemStats.Mallocs` delta over the sample divided by frames drawn, so they include other goroutines.

Build: `go build -tags nocgo -trimpath -ldflags "-s -w"` gives `harmony2` 23.69 MB (22.6 MiB), before 23.56 MB.

Startup to the first presented frame (connect screen, warm, 3 runs): 297, 280, 271 ms, mean 283 ms (before 368, 312, 291, mean 324; Electron 333). Process init 74-77 ms. RSS at the first frame 129-131 MB (before 185-191; Electron 550), 131-132 MB 3 s later.

| # | scenario | v2 before: RSS / footprint / CPU % / thr | v2 now: RSS / footprint / CPU % / thr | frames/s now (before) | allocs per frame now (before) | Electron: RSS / footprint / CPU % / thr |
|---|---|---|---|---|---|---|
| 2 | connect screen idle | 191.6 / 301 / 1.78 / 21 | 130.6 / 113 / 0.10 / 16 | 0.15 (2.0) | 361 (n/m) | 561 / 163 / 1.54 / 114 |
| 3a | chat idle, caret blinking (a character typed every 8 s) | 274.0 / 369 / 2.16 / 21 | 207.9 / 290 / 0.88 / 21 | 2.29 (2.0) | 82 (3130) | 794 / 327 / 1.74 / 110 |
| 3b | chat idle, 15 s after the last input, caret steady | (not separate) | 209.0 / 205 / 0.05 / 19 | 0 (2.0) | n/a | same row as 3a |
| 4 | chat scrolling, 60 wheel events/s | 260.4 / 372 / 26.6 / 21 | 200.8 / 285 / 17.4 / 23 | 54.4 (94) | 81 (4796) | 788 / 340 / 10.6 / 112 |
| 5 | voice alone, `-tone 440` | 205.2 / 308 / 9.73 / 21 | 148.7 / 228 / 7.01 / 21 | 1.02 (9) | 845 (n/m) | 807 / 405 / 7.09 / 118 |
| 6 | voice, 3 remote shares + own camera | 390.5 / 431 / 36.1 / 108 | 362 / 369 / 30.0 (main 18.3 + ffmpeg 11.8) / 96 | 75.6 (70) | 160 (n/m) | 899 / 468 / 21.7 / 127 |
| 7 | window minimised, chat | 262.7 / 275 / 0.12 / 19 | 209.1 / 204 / 0.00 / 21 | 0 | n/a | not measured |

Draw time per frame (UI pass up to the buffer swap): chat idle 1.10 ms mean / 1.37 p95 (before 7.8 / 9.1), scrolling 0.90 / 1.19 (7.9 / 10.6), connect 0.64 / 0.82 (4.7 / 5.9), watching 0.76 / 1.70 (4.4 / 5.7). The 0.0 CPU of 3b and 7 is the process truly asleep.

Scenario 6 modes: all three remote streams decode with `videotoolbox` (hardware; `STREAM ... decoder="videotoolbox"`, 800x450, about 30 pictures/s each, nothing fell back to software), and the camera encodes with `h264_videotoolbox` (log line "sending the camera (h264_videotoolbox)"). Process tree: v2 main 197 MB RSS / 281 footprint, three decoder ffmpegs 36 / 20 each, the encoder ffmpeg 57 / 28.

Footprint depends on whether the window is being drawn: 290 MB while frames are drawn (3a, scrolling), 205 MB once idle frames stop (3b, minimised 204): macOS drops the GPU driver backing of a window that is not presenting. A first attempt at 3a with the window not frontmost (no blink, 0.3 frames/s) read 214 MB and was discarded, as was an earlier 3b with the same problem.

Memory breakdown, scenario 3b (`footprint` 205 MB, RSS 209 MB), before in brackets:

| contributor | MB | before |
|---|---|---|
| IOSurface (swap buffers) | 72 | 72 |
| Go heap and other anonymous ("Untagged") | 71 | 95 (+39 reclaimable) |
| IOAccelerator (GPU buffers, textures, atlas) | 30 (+12 reclaimable) | 33 |
| Malloc small and large (libs, GL driver) | 18 | 21 |
| Owned physical footprint (unmapped, graphics) | 3.5 | 103 |
| `__DATA`, stacks, page table, the rest | about 10 | 15 |

At the end of the 3-stream run the same breakdown reads: owned graphics 77 + 12 unmapped, IOSurface 72, Untagged 71, IOAccelerator 19, malloc 19, i.e. the 77 MB of driver memory comes back while video is presenting. Go heap during chat idle: HeapInuse 37 MB (before 55), HeapSys 67 MB (131), 12 GCs.

Caveats: single runs, so differences under about 10% are inside the noise; the three Electron test instances (`harmony-tree-*`) were left running and idle; RSS of the 3-stream run is the sum of five processes sampled every 5 s; the voice allocation figure (845) counts the audio and network goroutines, which are most of what runs while only about 1 frame/s is drawn; the first 3b attempt showed that the number is only meaningful with the window frontmost.

What is still left to cut
1. IOSurface, 72 MB (the retina swap chain, 6 surfaces), now the largest single item: a smaller or fewer-buffer swap chain, if raylib/GLFW allows it. And the 77 MB of driver memory that returns while a video stream is presenting (scenario 6) and the 70-85 MB footprint difference between a drawing and an idle window.
2. Go heap: Untagged 71 MB, HeapSys 67 MB for 37 MB in use; parsed fonts are the bulk of what is live. Lazy or shared font tables and a lower GC percent after loading.
3. Voice alone: 7% CPU with one frame a second; this is the audio path (tone source, mixer, capture/playback callbacks, network), about 845 allocations per drawn frame are mostly not drawing. Profile the audio thread.
4. Scrolling: 17.4% against Electron's 10.6%; about 0.9 ms of drawing per frame is not the cost any more, so look at the per-frame upload of text and picture vertices and at the 54 swaps per second.
5. Video: 30% for three streams plus a camera against Electron's 21.7%; each ffmpeg child still costs 20-57 MB RSS and one process; in-process VideoToolbox decode would remove the pipes and four processes.
6. The `h2probe` publisher logs "microphone path dropped: rebuilding" about once a second for the whole run (293 times in 5 minutes) while another client is in the room; not a v2 client footprint issue, but worth a look in `internal/app/session.go`.

## Without ffmpeg

2026-11-15, same machine and method as "After the footprint fixes" (one 20 s sample per row, `ps` cputime deltas, `footprint` at the end, scratch copy with the temporary driver, deleted). Video decode, encode and capture are now in-process VideoToolbox. `pgrep ffmpeg` showed nothing and the viewer had one process; `native.Decoders()` lists only `videotoolbox`, `Encoders()` lists `videotoolbox` and `software` (the same API), so the forced-other-backend run (d) was skipped.

| scenario | RSS MB | footprint MB | CPU % | threads | frames/s | before (with ffmpeg): footprint / CPU |
|---|---|---|---|---|---|---|
| voice alone, `-tone 440` | 153 | 223 | 7.2 | 20 | 1.1 | 228 / 7.0 |
| voice, watching 3 remote streams (bars 720p share, test 720p share, 360p camera), no own camera | 177 | 273 | 17.6 | 25 | 66.8 | 369 / 30.0 (with own camera) |

- Streams decode with `videotoolbox` at 800x450 (share) and 640x360 (camera), 30.0 / 30.0 / 24 pictures/s, no drops. Colour bars (`-share bars`, `-expect-bars`): every channel within 4 of exact.
- Footprint and CPU of three streams fall: 273 MB and 17.6% without the camera against 369 MB and 30.0% (18.3% main + 11.8% ffmpeg) before; five processes became one. This is not a like-for-like run (the old one had the own camera), see the next item.
- Not measured: own synthetic camera, publisher CPU, bars check against an in-process publisher. The in-process VideoToolbox encoder of the synthetic source (`patternSource` -> `vtEncoder.EncodeBGRA`, `macencode_vt_darwin.go:254`, the deferred `CFRelease`) dies with SIGTRAP within seconds, in `h2probe` (any share or camera, usually once a second person is in the room, later also alone) and in the window with `HARMONY2_TEST_CAMERA=1` while watching 3 streams (twice in two tries). The three publishers of the table, and the bars check, therefore ran the older ffmpeg `h2probe` of the previous benchmark; the viewer side is the current tree.

## What was not measured

- Electron: emoji picker, settings, DM, minimised, covered and unfocused states; a packaged build.
- v2 occlusion: a full-screen window was put over it, but I cannot confirm from here that the OS treated it as covered (no screen capture of the user's display); the number shows v2 behaves the same as uncovered, as it does not listen for occlusion at all.
- Heap allocations per frame outside chat (picker, settings, DM, voice).
- GPU time per frame (needs Metal tooling); only CPU time is measured.
- A true cold start (purged disk cache needs root).
- Windows and Linux.

## Rerun

```sh
# a stack with alice and bob (password hunter22), then the window; sign in and open #general by hand
HARMONY_PORT=18280 dev/stack.sh &
go build -tags nocgo -trimpath -ldflags "-s -w" -o /tmp/harmony2 ./cmd/harmony2
/tmp/harmony2 -server http://127.0.0.1:18280 &            # add -tone 440 to send a microphone tone in voice
dev/bench.sh $! 30 5                                       # PID, seconds, settle seconds
# Electron: dev Electron with the remote-debugging port, then the same
node -e "import('./client/test/cdp.mjs').then(m=>{const a=m.launchApp({port:9701,userDataDir:'/tmp/el'});console.log(a.pid)})"   # or start client/ by hand and use its main pid
dev/bench.sh <electron main pid> 30 5
# memory breakdown
vmmap -summary <pid>; footprint <pid>
# binary sizes
ls -l /tmp/harmony2; go build -tags nocgo -trimpath -ldflags "-s -w" -o /tmp/h2probe ./cmd/h2probe && ls -l /tmp/h2probe
```

The in-process driver used for the numbers above (auto sign-in, wheel injection, frame timer, heap dump) was a temporary file and is not in the tree; `dev/bench.sh` is the permanent part. Stats, scripts and raw logs of this run: `/private/tmp/claude-501/-Users-predo-git-harmony/b2f1353e-5318-4cbe-b90e-07cdb4ee06f9/scratchpad/bench/` (`logs/ALL.txt`, `ALL2.txt`, `ALL3.txt`, `EL.txt`).
