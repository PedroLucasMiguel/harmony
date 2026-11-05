# MediaMTX patches

Harmony's relay is MediaMTX, pinned to one version (`MEDIAMTX_VERSION` in `../Dockerfile` and `../install.sh`).
The patches here are applied to that version's source by `build-mediamtx.sh`, and **they are on by default**: the
image and the installer both build MediaMTX with them. If a build cannot be made, both fall back to the published
binary by themselves and say why (below), so an update or an image build never fails because of a patch.

| Patch | What it changes | Why |
|---|---|---|
| `mediamtx-audio-nack.patch` | A voice can be asked for again: the relay offers NACK for audio, so it asks a publisher for a voice packet it is missing and answers a listener that asks for one. | Without it a lost voice packet is gone, for everyone who is listening. See below. |
| `mediamtx-audio-reorder.patch` | The relay holds sixteen packets of a voice behind a gap instead of sixty-four. | A packet behind a gap waits for its retransmission or for the buffer to fill; with nothing to ask for, one lost packet stopped a voice for sixty-four packets and then let it all out at once. See below. |
| `mediamtx-nack-interval.patch` | The relay asks a publisher for its missing packets every 5 ms instead of every 100 ms. | The relay holds every packet behind a gap until the gap is filled, so the interval is added to each loss as a stall for the whole stream. See below. |
| `mediamtx-video-recovery.patch` | Three things for a picture: the answer to a viewer offers "nack pli" and a viewer's request for a new picture is passed on to the publisher; the periodic request for one is every 10 s instead of 2 s; the hold behind a gap is 256 packets instead of 64. | A viewer who lost part of a picture had no way to ask for it again and waited for the next key frame, and a lost packet in a key frame was given up on before its retransmission could arrive. See below. |

### What the audio patches do

**The wait.** Every packet a publisher sends passes through a reorder buffer in the relay (gortsplib's `rtpreceiver`,
sixty-four packets). A packet that arrives ahead of a missing one is held until the missing one comes or the buffer has
filled and the gap is given up. A video's missing packets are asked for (NACK, below), so it waits for a retransmission.
A voice's were not: nothing negotiates it, so a lost voice packet was only given up when sixty-four more had arrived --
1.3 s of a voice at 20 ms a packet, 2.6 s at 40 ms, far longer while silence is not sent -- and then everything held
came out at once, which a listener hears as the voice stopping and then arriving sped up. On a line that drops a packet
now and then, that is what everybody else hears of that person: not the loss itself (the same loss on the way down, where
there is no such wait, cost about 25 ms of delay and a few per cent of made-up sound).

**The retransmission.** `mediamtx-audio-nack.patch` makes the relay answer an offer of NACK on the voice codec, and the
client offers it (`offerAudioNack` in `client/src/renderer/webrtc.js`; a browser offers it for video and not for voice).
Then the relay asks a publisher for the packet it is missing, within 5 ms (the interval below), and a listener asks the
relay for one it lost. A client that does not offer it, or a published MediaMTX that does not answer, negotiates nothing
and is as it was.

Two people, a real relay, one person's line dropping packets (client/test/voice-loss.mjs: a UDP proxy in front of the
relay that loses them in runs, delays them and reorders them; a recording of speech; 30 s, one run each). What the
other hears of the person with the bad line (on the way up) and what that person hears of the other (on the way down):

| Loss, round trip | Relay | Sent as | Up: delay | Up: made-up sound | Down: lost | Down: made-up sound |
|---|---|---|---|---|---|---|
| 3%, 0 ms | stock | 40 ms, 32 kbit/s (as it was) | 1,574 ms | 10 % | 2.9 % | 2.9 % |
| | stock | 20 ms, 64 kbit/s | 962 ms | 0.6 % | 3.1 % | 2.6 % |
| | reorder 8 | 20 ms, 64 kbit/s | 180 ms | 1.1 % | 3.1 % | 2.6 % |
| | **reorder 8 + NACK** | 20 ms, 64 kbit/s | **59 ms** | **0 %** | **0 %** | **0 %** |
| 5%, 40 ms | stock | 20 ms, 64 kbit/s | 981 ms | 2.1 % | 4.9 % | 3.2 % |
| | **reorder 16 + NACK** | 20 ms, 64 kbit/s | **139 ms** | **0 %** | **0 %** | **0.4 %** |
| 8%, 80 ms | reorder 8, no NACK | 20 ms, 64 kbit/s | 269 ms | 7.4 % | 8.9 % | 6.7 % |
| | reorder 8 + NACK | 20 ms, 64 kbit/s | 217 ms | 3.1 % | 0.1 % | 1.8 % |
| | **reorder 16 + NACK** | 20 ms, 64 kbit/s | 217 ms | **0.9 %** | 0 % | 1.0 % |
| 8%, 200 ms | reorder 16 + NACK | 20 ms, 64 kbit/s | 297 ms | 2.9 % | 0.1 % | 6.3 % |

On a line with a round trip of 200 ms the retransmissions come after the sound was needed and change little on the way
down (6.3% against 6.4% without), and they cost nothing. Sixteen is the size because a retransmission has to come within
the buffer: with eight, a lost retransmission or a longer round trip is given up too soon (the 8% rows); four gave no
less delay than eight and, with 40 ms of jitter, counted a reordered packet as lost five times as often. It is a power of
two (the receiver indexes it by masking). Video keeps the default.

The client sends differently as well, whichever relay it meets (`client/src/renderer/voice-quality.js`): a published
MediaMTX has neither patch, and there the shorter packets are what limit the damage (962 ms against 1,574 ms above).

### What the video patch does

A picture that cannot be put together is useless until the next whole picture (key frame) arrives, and three things made
that wait long and the key frame itself likely to fail:

- **Nobody could ask for one.** The answer to a viewer did not offer "nack pli" (a picture loss indication), so a browser
  never sent one, and the relay would have thrown it away if it had (it read the viewer's feedback and dropped it). A
  frozen viewer waited for the relay's own request to the publisher, every two seconds, and so did anybody who joined:
  a viewer who came in late waited about 2.2 s for a first picture. Now it is offered, and a request is passed on to the
  publisher (at most one every 500 ms however many viewers ask).
- **A key frame is a burst of about two hundred packets.** The relay holds 64 packets behind a gap (see above), which
  at a few Mbit/s is under 100 ms, less than a retransmission needs on any line with a round trip of 40 ms or more. A
  packet lost in a key frame was given up on before it could be sent again, and the key frame was spoiled. The hold is
  256 packets now. 512 did no better in the tests; 256 keeps what a webcam (a hundred packets a second) waits for a
  packet that can never come to a couple of seconds.
- **A key frame every two seconds is a burst of that size over and over**, and each one pushed the sender's estimate of
  the line down. It is every ten seconds now: a safety net, since a viewer who needs one asks. (With the request
  forwarded but the old timer, the freezes were gone and the frame rate still dipped in some runs; the timer alone, with
  no request forwarded, left a viewer's first picture 8 s away. It is the two together.)

A 1080p60 share (client/test/share-bench, three runs each, 30 s, 20 ms each way unless said; "before" is the relay with
the patches above and not this one; the three figures are the runs):

| Line | | 95th percentile of the delay | Worst gap between pictures | Frames a second |
|---|---|---|---|---|
| 1% lost, upload | before | 802 / 374 / 392 ms | 1,240 / 375 / 809 ms | 45 / 24 / 53 |
| | after | 351 / 374 / 383 ms | 359 / 384 / 391 ms | 50 / 60 / 60 |
| 3% lost, upload | before | 483 / 699 / 1,698 ms | 789 / 1,540 / 2,447 ms | 47 / 16 / 46 |
| | after | 348 / 357 / 407 ms | 350 / 358 / 424 ms | 56 / 58 / 54 |
| 3% lost, upload, 60 ms each way | before | 2,805 / 2,310 / 2,033 ms | 4,530 / 2,832 / 2,342 ms | 34 / 16 / 39 |
| | after | 534 / 679 / 520 ms | 542 / 989 / 976 ms | 37 / 54 / 44 |
| 3% lost, upload, "smooth" priority | before | 364 / 572 / 274 ms | 6,821 / 736 / 559 ms | 35 / 36 / 44 |
| | after | 325 / 366 / 466 ms | 350 / 382 / 491 ms | 60 / 60 / 59 |
| 5% lost, download | before | 192 / 217 / 167 ms | 334 / 600 / 341 ms | 51 / 58 / 50 |
| | after | 157 / 141 / 115 ms | 307 / 316 / 315 ms | 57 / 56 / 60 |
| A viewer joins late (first picture) | before | 2,166 ms | | |
| | after | 185 ms | | |

A clean line is as it was (60 frames a second, 59 ms at the 95th percentile). A download that loses packets was already
mostly fine, because the relay answers a viewer's NACK. What is left on a bad upload is the sender's own estimate of the
line, which a loss of a few per cent still pulls down in some runs (5 to 7 Mbit/s of 12): "smooth" gives up sharpness
and keeps the frame rate when it does, "sharp" keeps the size and lets the rate fall.

Things tried and not kept: disabling Chromium's loss-based bandwidth estimate (`WebRTC-Bwe-LossBasedBweV2`) made the
sender much worse (0 to 11 frames a second at 1% loss); forwarding requests with the old two-second timer and a hold of 64
was no better (some runs had freezes of 5 to 9 s, from a key frame that lost a packet); a hold of 512 packets was no better than 256.

MediaMTX's own test `TestPeerConnectionRecomputeSequenceNumber/preserve_real_gaps` fails with this patch: it sends a few
packets with a gap in them and expects the packets after the gap within two seconds, and with a hold of 256 they wait for
the hold to fill, which is the point of it. (`TestPeerConnectionCandidates` and `TestPeerConnectionConnectivity` also fail
here, on the unpatched source as well: they need a network interface this machine does not give them.)

### What the NACK interval does

A 1080p60 share with seeded loss on the publisher's upload, three runs each, medians (client/test/share-bench):

| Loss | Relay | Median latency | 95th percentile | Worst | fps |
|---|---|---|---|---|---|
| 0.3% | stock (100 ms) | 974 ms | 2.7 s (up to 10.8 s) | 4.0 s (12.5 s) | 43 |
| | 20 ms | 780 ms | 1.7 s (up to 13.5 s) | 4.0 s (15.0 s) | 47 |
| | 10 ms | 667 ms | 1.3 s | 2.4 s | 54 |
| | **5 ms** | **518 ms** | **1.1 s** | **1.6 s** | 57 |
| 1% | stock | 1142 ms | 3.2 s | 4.9 s | 46 |
| | 20 ms | 1084 ms | 3.3 s | 5.3 s | 52 |
| | 10 ms | 1116 ms | 2.1 s | 3.2 s | 42 |
| | **5 ms** | 1081 ms | **1.4 s** | **2.4 s** | **58** |
| 3% | stock | 1380 ms | 4.2 s | 5.0 s | **23** (8 in one run) |
| | 20 ms | 931 ms | 3.5 s | 5.1 s | 41 |
| | 10 ms | 998 ms | 2.7 s | 3.0 s | 44 |
| | **5 ms** | 999 ms | **2.0 s** | **2.7 s** | **48** |

Shorter is better at every loss level tried. A viewer still sits about a second behind at 1% loss and above: that
is what waiting a round trip for each retransmission costs, and no interval removes it.

The price is NACK traffic from the relay to the publisher, only while there is loss: per 35 s run about 350
packets stock, 1,700 at 20 ms, 3,500 at 10 ms and 7,000 at 5 ms (200 a second, a few tens of kbit/s). On a clean
line there are none (0 to 4 in a run, as stock). 2 ms was not tried.

## Using it

**Installer / `--update`** (`install-mediamtx.sh`, called by `install.sh`). Nothing to do: the patched build is made
and installed. It needs no Go on the machine; an official toolchain is fetched, checked against Go's published
checksum, used and removed. It looks at, in order:

1. what is installed: a patched build says which patches it has (`mediamtx --version` prints
   `v1.21.0-harmony.<id>`), so an update that changes a patch builds again and one that does not leaves it alone;
2. the tools (`curl`, `tar`, `patch`);
3. free memory: compiling MediaMTX takes about a gigabyte, and on a smaller machine it would starve the running
   relay, so under 1,500 MB available it does not try (`MIN_FREE_MB` changes that);
4. whether the build succeeds and reports the version it should.

If any step fails it says which, installs the published binary, and carries on with the update; the next run
tries again. `sudo MEDIAMTX_PATCHED=0 ./install.sh --update` installs the published binary on purpose and keeps it.

**Docker** (BuildKit builds only the stage it needs; a patched build that fails falls back to the published
binary in the build log):

    docker build -t harmony-server ./server                                         # patched
    docker build --build-arg MEDIAMTX_SOURCE=release -t harmony-server ./server     # published

## Trying a different interval

    NACK_INTERVAL_MS=2 server/patches/build-mediamtx.sh 1.21.0 /tmp/mediamtx-nack2
    client/test/share-bench/compare-relays.sh stock=$HOME/mediamtx/mediamtx nack2=/tmp/mediamtx-nack2

`--prepare-only` fetches and patches the source without building it, to check a patch against a new version.

## Moving to a newer MediaMTX

Change `MEDIAMTX_VERSION` in both places, then run `build-mediamtx.sh --prepare-only <version> <dir>`: if a
patch no longer applies, it stops there. Patches are plain `git diff` output against the version's source.
