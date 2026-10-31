# MediaMTX patches

Harmony's relay is MediaMTX, pinned to one version (`MEDIAMTX_VERSION` in `../Dockerfile` and `../install.sh`).
The patches here are applied to that version's source by `build-mediamtx.sh`, and **they are on by default**: the
image and the installer both build MediaMTX with them. If a build cannot be made, both fall back to the published
binary by themselves and say why (below), so an update or an image build never fails because of a patch.

| Patch | What it changes | Why |
|---|---|---|
| `mediamtx-nack-interval.patch` | The relay asks a publisher for its missing packets every 5 ms instead of every 100 ms. | The relay holds every packet behind a gap until the gap is filled, so the interval is added to each loss as a stall for the whole stream. See below. |

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
