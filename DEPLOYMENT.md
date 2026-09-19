# Deploying Harmony

Everything needed to stand the server up on any 64-bit Linux box and to compile
the client. Read [README.md](README.md) first if you want to know *why* it is
shaped this way — this file is the procedure.

> [!WARNING]
> **This project was entirely vibecoded and is recreational.** It has no
> authentication, no security review and no high availability. Deploy it for
> yourself and people you trust, not for anything that matters when it breaks.
> The full caveat is at the top of the [README](README.md#harmony).

- [Part 1 — the server](#part-1--the-server)
- [Part 2 — the client](#part-2--the-client)
- [Troubleshooting](#troubleshooting)

---

# Part 1 — the server

## What you are deploying

Two processes on one host, plus something to terminate TLS. Neither process
transcodes, and neither buffers — that is what keeps latency under a second and
the hardware requirements this low.

```
                         your domain
                              │
        ┌─────────────────────┴──────────────────────┐
        │ TCP (signaling)                 UDP+TCP 8189
        ▼                                            ▼
┌──────────────────────────────┐          ┌────────────────────────┐
│ TLS terminator (Caddy, or a  │          │ MediaMTX media ports   │
│ tunnel)                      │          │   SRTP, relayed        │
│   /api/*  -> 127.0.0.1:8080  │          │   straight to viewers  │
│   /*      -> 127.0.0.1:8889  │          │   NEVER proxied        │
└──────────────────────────────┘          └────────────────────────┘
        │                    │
        ▼                    ▼
  harmony-server        MediaMTX :8889
  127.0.0.1:8080        (WHIP/WHEP signaling)
```

The split that governs every decision below: **signaling is HTTP and can be
proxied or tunnelled; media is UDP and cannot.** The media port must be reachable
from the internet directly.

### Requirements

The server relays packets and nothing else — no decode, no encode, no disk — so
the bar is low and the architecture does not matter.

| | |
| --- | --- |
| Architecture | **x86-64** or **arm64/aarch64**; armv7 and armv6 also supported. `install.sh` detects it and fetches the matching MediaMTX build. |
| OS | Debian 12+, Ubuntu 22.04+, Raspberry Pi OS Bookworm, or anything systemd-based close to them |
| RAM | 512 MB is comfortable — nothing is buffered server-side |
| Disk | ~150 MB installed. Nothing is recorded. |
| Node | 20.6 or newer — the installer fetches Node 22 if none is present |
| A domain | Needed for TLS. A dynamic-DNS name is fine; keep it updated (`ddclient` works well). |

**Run in production on a Raspberry Pi 5** (8 GB, Ubuntu 26.04 aarch64). The relay
and control server also run on x86-64 on every pass of the e2e suite, though
`install.sh` itself has only been exercised on arm64 — if you hit a rough edge on
another architecture it will be in the installer, not the software. A mini-PC, an
old laptop, a NAS or a small VPS are all equally valid hosts.

**Your upload bandwidth is the only resource this is ever short of.** Every
viewer of every stream is a separate copy out of the server: one 8 Mbps
broadcaster with three viewers is 24 Mbps up. Size the host on its network link,
not its CPU — and if your home connection is thin, a cheap VPS with real upload
will outperform better hardware behind it.

## 1. Install

Two ways. Docker is the shorter one; `install.sh` gives you systemd units and
files you can edit in place.

### With Docker

```bash
docker run -d --name harmony --restart unless-stopped \
  -p 8080:8080 -p 8889:8889 -p 8189:8189/udp -p 8189:8189/tcp \
  -e MTX_WEBRTCADDITIONALHOSTS=stream.example.com \
  -e HARMONY_SIGNALING_URL=https://stream.example.com:8444 \
  pedrolucasmiguel/harmony-server:0.1.0
```

Published for `linux/amd64` and `linux/arm64`. Compose and shell examples, plus
the reasoning, are in [docker/](docker/); the settings below are all passed as
environment variables. Two things specific to containers:

- **The media ports must be published 1:1.** MediaMTX advertises the port it
  listens on *inside* the container, so `-p 9000:8189` tells clients to send
  media where nothing is listening — the handshake succeeds and no picture ever
  arrives. Change `MTX_WEBRTCLOCALUDPADDRESS`/`..TCPADDRESS` too if you need a
  different port, or use `--network host` on Linux.
- **Both processes share one container on purpose.** MediaMTX's control API
  needs no authentication and is bound to loopback; splitting them would put it
  on a Docker network where something else could reach it.

### With the installer

```bash
git clone https://github.com/PedroLucasMiguel/harmony.git
cd harmony/server
sudo ./install.sh
```

The installer is safe to re-run. It:

- picks the MediaMTX build matching `uname -m` and installs **v1.21.0** to
  `/usr/local/bin/mediamtx` (pinned deliberately — MediaMTX removes config keys
  between releases, and an unknown key aborts startup);
- installs the control server to `/opt/harmony` with `npm ci --omit=dev`;
- creates the system user `harmony`;
- writes `/etc/harmony/mediamtx.yml` and, on first run only,
  `/etc/harmony/harmony.env` from `.env.example`;
- registers `harmony-server`, `mediamtx` and `harmony-ip-watch.timer`.

An existing `harmony.env` is never overwritten, so upgrading is just
`git pull && sudo ./install.sh`.

## 2. Configure

```bash
sudo nano /etc/harmony/harmony.env
```

Two settings actually matter; the rest have working defaults.

| Variable | What it does |
| --- | --- |
| **`HARMONY_SIGNALING_URL`** | Where **clients** reach MediaMTX's WHIP/WHEP endpoint, e.g. `https://stream.example.com:8444`. May point at a reverse proxy or a tunnel. |
| **`MTX_WEBRTCADDITIONALHOSTS`** | Your public hostname or static IP. MediaMTX advertises this as an ICE candidate. **Without it, nobody outside your LAN can connect** — remote viewers only ever see the server's private address. |
| **`HARMONY_PASSWORD`** | A shared password for the whole server. Leave it unset and the server is open to anyone who can reach it. See below. |

### Setting a password

```bash
# In /etc/harmony/harmony.env
HARMONY_PASSWORD=something-long-and-boring
```

Restart with `sudo systemctl restart harmony-server`. The log says which mode it
came up in:

```
[harmony] password required — 3 tries, then 5/10/30/60 minute lockouts
[harmony] NO PASSWORD SET — anyone who can reach this server can use it
```

The client discovers this on its own: `/api/health` is deliberately the one
endpoint outside the gate, so the app can ask *"does this server want a
password?"* and show the field only when the answer is yes. Nothing else is
readable until the password is right.

**Wrong answers are rate limited, and the penalty escalates.** Three wrong
passwords from one address buys a 5-minute wait, the next three 10 minutes, then
30, then 60, and it stays at 60. The ladder is what matters: a flat 5-minute
penalty still permits ~860 guesses a day, while this caps a single address at 72.
A correct password clears the count and the escalation. Tune it if you like:

| Variable | Default | What it does |
| --- | --- | --- |
| `HARMONY_MAX_LOGIN_ATTEMPTS` | `3` | Wrong answers allowed before a lockout |
| `HARMONY_LOCKOUT_MINUTES` | `5,10,30,60` | The ladder; the last value repeats forever |

Three things worth knowing about how far this goes:

- **The media is covered too.** A password on the API alone would be a front door
  with the back door open, because MediaMTX listens on its own port and anyone
  who guessed a username could watch by going straight to WHEP. So when a
  password is set, watch URLs carry a token the control server generates at
  startup, and the auth hook refuses reads without it. Restarting the server
  invalidates outstanding watch URLs, which costs viewers a reconnect.
- **It is keyed on the client's IP**, which is only as trustworthy as
  `trust proxy`. Harmony trusts loopback only, so the address comes from the
  proxy on the same machine rather than from a header the client wrote. Someone
  with many source addresses is not slowed down by this; a shared password is
  not the right control for that threat.
- **A request carrying no password at all does not spend an attempt** — only a
  wrong one does. The client polls the stream list from the moment it opens, and
  counting that would let someone lock themselves out of their own server in
  three refreshes without ever mistyping anything.

The password is stored in the clear in `harmony.env` (mode `0640`, `root:harmony`)
and, on the client, in `settings.json` under the user's app-data directory. It is
a shared room password, not a credential that protects anything else.

<details>
<summary>The rest of the settings</summary>

| Variable | Default | What it does |
| --- | --- | --- |
| `HARMONY_PORT` | `8080` | Control server port |
| `HARMONY_HOST` | `0.0.0.0` | Control server bind address |
| `HARMONY_MEDIAMTX_API` | `http://127.0.0.1:9997` | MediaMTX control API, loopback only |
| `HARMONY_POLL_INTERVAL_MS` | `1000` | How often liveness is re-read from MediaMTX |
| `HARMONY_CLAIM_TTL_MS` | `30000` | How long a username stays reserved before publishing starts |
| `HARMONY_STUN_URLS` | Google + Cloudflare | Comma-separated STUN servers handed to clients |
| `HARMONY_MAX_LOGIN_ATTEMPTS` | `3` | Wrong passwords allowed before a lockout |
| `HARMONY_LOCKOUT_MINUTES` | `5,10,30,60` | Escalating lockout ladder, in minutes |
| `HARMONY_TURN_URL` / `_USERNAME` / `_PASSWORD` | unset | Optional TURN relay — see [When a client still cannot connect](#when-a-client-still-cannot-connect) |
| `MTX_WEBRTCLOCALUDPADDRESS` | `:8189` | UDP media port |
| `MTX_WEBRTCLOCALTCPADDRESS` | `:8189` | TCP media port (ICE-TCP fallback) |

Anything prefixed `MTX_` is read by MediaMTX, not by Harmony, and overrides the
matching key in `mediamtx.yml`. MediaMTX does **not** interpolate `${VAR}` inside
its YAML, which is why per-deployment values are set this way.

</details>

## 3. Forward the ports

| Protocol | Port | Purpose |
| --- | --- | --- |
| **UDP** | **8189** | WebRTC media. **Without this nothing plays.** |
| **TCP** | **8189** | Media fallback for clients whose network blocks UDP |
| TCP | 8444 (or 443) | Signaling + control API over TLS |

Forward all three to the server's LAN address.

**TCP 8189 is worth forwarding even though it looks redundant.** Plenty of
corporate and campus firewalls — and some mobile carriers — drop UDP outright,
and those clients otherwise have no working candidate pair at all. ICE only falls
back to TCP when UDP fails, so it costs nothing when it is not needed, and it
beats paying for a TURN relay. MediaMTX leaves it off by default because TCP
carries real-time media badly (one lost packet stalls everything behind it, so a
congested link degrades into growing delay rather than dropped frames) — the
right default for a server where everyone can use UDP, and the wrong one here.

## 4. Terminate TLS

Media is always encrypted — SRTP, end to end, regardless of what you do here —
but the signaling carries the publish token, so it should be encrypted too.
Pick whichever of these matches your situation.

### A. You can use ports 80 and 443

The easy case. Caddy gets a certificate by itself:

```
stream.example.com {
    handle /api/* { reverse_proxy 127.0.0.1:8080 }
    handle        { reverse_proxy 127.0.0.1:8889 }
}
```

Set `HARMONY_SIGNALING_URL=https://stream.example.com`. You still forward UDP
8189 separately.

### B. Your ISP blocks inbound 80 and 443

Common on residential lines. You do not need either port: listen on a high port
and get the certificate over **DNS-01**, which requires no inbound connection at
all. With Cloudflare DNS:

```bash
sudo apt install caddy certbot python3-certbot-dns-cloudflare

# A token scoped to Zone -> DNS -> Edit on your zone. Keep it out of shell
# history and out of argv -- pipe it in.
sudo install -m 600 /dev/null /etc/letsencrypt/cloudflare.ini
printf 'dns_cloudflare_api_token = %s\n' "$TOKEN" | sudo tee /etc/letsencrypt/cloudflare.ini >/dev/null

sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d stream.example.com --agree-tos -m you@example.com -n
```

```
https://stream.example.com:8444 {
    tls /etc/caddy/tls/fullchain.pem /etc/caddy/tls/privkey.pem
    handle /api/* { reverse_proxy 127.0.0.1:8080 }
    handle        { reverse_proxy 127.0.0.1:8889 }
}
```

Caddy cannot read `/etc/letsencrypt` as its own user, so copy the certificate
where it can and re-copy after each renewal —
`/etc/letsencrypt/renewal-hooks/deploy/harmony-caddy.sh`:

```bash
#!/usr/bin/env bash
install -m 0644 -o caddy -g caddy \
  /etc/letsencrypt/live/stream.example.com/fullchain.pem /etc/caddy/tls/fullchain.pem
install -m 0600 -o caddy -g caddy \
  /etc/letsencrypt/live/stream.example.com/privkey.pem /etc/caddy/tls/privkey.pem
systemctl reload caddy
```

Two things to watch:

- Add `auto_https disable_redirects` to the global block if anything else
  already owns port 80 — Caddy binds it for HTTP→HTTPS redirects even when you
  never asked for port 80.
- **The DNS token is what keeps the certificate alive.** DNS-01 renewal needs it
  every 60 days. A temporary token will silently break renewal when it expires;
  put a permanent, DNS-Edit-scoped one in place before then.

Set `HARMONY_SIGNALING_URL=https://stream.example.com:8444`.

### C. A Cloudflare Tunnel

Works, but **for signaling only**. `cloudflared` has no public UDP support (UDP
works only inside private networks with the WARP client installed), so the audio
and video would never arrive. Point the tunnel at `localhost:8889`, add a second
route for `/api/*` to `localhost:8080`, and **still forward UDP 8189 on your
router**. If you cannot forward a port at all — CGNAT, for instance — a tunnel
will not save you; you need TURN.

### Keeping the advertised address correct

MediaMTX resolves `webrtcAdditionalHosts` once, when it builds ICE candidates,
and never re-resolves. On a dynamic residential connection the public IP
eventually moves: your dynamic-DNS client updates the record, but MediaMTX keeps
handing clients the old address and every external connection fails silently.

`harmony-ip-watch.timer` (installed and enabled for you) checks every 5 minutes
and restarts MediaMTX when the address behind your hostname changes. The restart
is not the cost it appears to be — when the public IP changes, every in-flight
session is already dead.

If your hostname is on Cloudflare, it must stay **grey-cloud (DNS-only)**.
Proxying it would point the name at Cloudflare's edge, and the UDP media would
have nowhere to land.

## 5. Start it and check

```bash
sudo systemctl start harmony-server mediamtx
```

Order matters on a cold start: the control server answers MediaMTX's auth hook.

```bash
systemctl status harmony-server mediamtx caddy
journalctl -u harmony-server -u mediamtx -f

curl -s http://127.0.0.1:8080/api/health             # on the server itself
curl -s https://stream.example.com:8444/api/health   # from anywhere else
```

`/api/health` reporting `mediamtx: true` means the two processes can see each
other. It says nothing about whether anyone can reach you — for that, run the
end-to-end check from a client machine, on a different network if you can:

```bash
HARMONY_SERVER=https://stream.example.com:8444 node client/test/verify-deployment.mjs
```

It publishes a synthetic stream, watches it back with a second client, and
prints the ICE candidates the server advertised — which is the thing that
actually decides whether outsiders can connect.

### The API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Status, and whether a password is required. The only endpoint outside the password gate |
| `GET` | `/api/streams` | Who is live, viewer counts, watch URLs, ICE servers |
| `POST` | `/api/session` | Claim a username; returns a broadcaster token or a watch URL |
| `POST` | `/api/session/heartbeat` | Hold a claim while setting up |
| `POST` | `/api/session/release` | Give a username back at once |
| `POST` | `/mediamtx/auth` | Called by MediaMTX for every publish and read |

### Files an install touches

| Path | What |
| --- | --- |
| `/opt/harmony` | Control server, owned by user `harmony` |
| `/etc/harmony/harmony.env` | All settings, `0640 root:harmony` |
| `/etc/harmony/mediamtx.yml` | Relay config |
| `/usr/local/bin/mediamtx` | The relay binary |
| `/usr/local/bin/harmony-ip-watch.sh` | Dynamic-IP watcher |
| `/var/lib/harmony/advertised-ip` | Last public IP it saw |
| `/etc/systemd/system/{harmony-server,mediamtx,harmony-ip-watch}.*` | Units |

### Uninstall

```bash
sudo systemctl disable --now harmony-server mediamtx harmony-ip-watch.timer
sudo rm -rf /opt/harmony /etc/harmony /var/lib/harmony /usr/local/bin/mediamtx \
            /usr/local/bin/harmony-ip-watch.sh \
            /etc/systemd/system/{harmony-server,mediamtx,harmony-ip-watch}.{service,timer}
sudo systemctl daemon-reload
sudo userdel harmony
```

---

# Part 2 — the client

## Running from source

```bash
cd client
npm install
npm start
```

Needs Node 20+ and whatever `electron` pulls down (~200 MB on first install).

## Building

```bash
npm run build        # -> dist/Harmony-<version>-portable.exe
npm run build:all    # additionally a Linux AppImage and a macOS dmg
```

`npm run build` produces a **single portable .exe of about 82 MB**: no installer,
no admin rights, nothing written outside `%TEMP%` at runtime. `unpackDirName:
Harmony` keeps the extraction directory stable, so Windows Firewall rules and the
saved server address survive an upgrade.

Essentially all of that size is the Chromium runtime — the app itself is under a
megabyte. The build trims it by shipping only the `en-US` locale (Chromium
carries 55, ~48 MB), deleting `dxcompiler.dll` and `dxil.dll` (27 MB of DirectX
shader compilation for WebGPU, which Harmony does not use), and compressing at
maximum. If a trimmed file ever turns out to be needed on some machine, the list
is one array in [client/scripts/after-pack.js](client/scripts/after-pack.js).
Verify any change to it against a packaged build, not just `npm start`:

```bash
HARMONY_BIN=client/dist/win-unpacked/Harmony.exe npm --prefix client test
```

Cross-building has the usual limits: a Windows `.exe` builds anywhere, a macOS
`.dmg` really wants macOS, and an AppImage wants Linux.

### The native audio module

`loopback-capture` is an **optional** dependency, and deliberately so — the build
succeeds without it on every platform. It is what provides true per-application
audio on Windows through the WASAPI process-loopback API. Without it, a window
share falls back to whatever the user picks in the client (silent by default, so
other applications' sound never leaks into a stream by accident).

It ships as a prebuilt binary, so no Visual Studio toolchain is needed. One thing
matters for packaging: it resolves its `.node` file from the filesystem via the
`bindings` package, which cannot see inside an asar archive. `asarUnpack` in
[client/electron-builder.yml](client/electron-builder.yml) is what makes it work
in a packaged build — if you change that file, keep the entry.

### First run

The client asks for the control-server address — `https://stream.example.com:8444`,
or `192.168.1.50:8080` on a LAN — and a username. That one URL is all it needs;
the control server hands it the WHIP/WHEP endpoints and the ICE servers.

The address is remembered, so a built `.exe` can be handed to someone who then
only types a name.

## Tests

```bash
npm --prefix server test    # reservation, password gate, lockout  (38 checks)
npm --prefix client test    # launches the app, drives it over CDP  (16 checks)

MEDIAMTX_BIN=/path/to/mediamtx npm --prefix client run test:e2e   # (93 checks)
```

The e2e suite is the real thing: it starts MediaMTX and the control server, then
drives two Electron clients over the DevTools Protocol — one publishes its screen
over WHIP, the other enters the same username and must end up decoding that video
over WHEP. Nothing is mocked. It needs a MediaMTX binary; download one from
[the releases page](https://github.com/bluenviron/mediamtx/releases) for your
machine's architecture.

To check a **packaged** build, which is where asar breaks native modules and
custom protocols:

```bash
HARMONY_BIN=client/dist/win-unpacked/Harmony.exe npm --prefix client test
```

One gotcha if you run these from an environment that sets it: `ELECTRON_RUN_AS_NODE=1`
makes Electron start as plain Node and every test fails confusingly. The harness
clears it for the processes it spawns.

---

# Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Works on the LAN, nothing from outside | `MTX_WEBRTCADDITIONALHOSTS` unset, so only private candidates are advertised | Set it, restart `mediamtx` |
| Viewer gets audio, video stays "connecting" | Almost always UDP 8189 not forwarded | Forward it; verify with `verify-deployment.mjs` |
| Every WebRTC session fails, log says `netlinkrib: address family not supported` | Systemd sandboxing blocked netlink, which MediaMTX needs to enumerate interfaces | `RestrictAddressFamilies` must include `AF_NETLINK` (the shipped unit does) |
| MediaMTX exits at startup complaining about a config key | Version mismatch — keys are added and removed between releases | Use the pinned version; `MEDIAMTX_VERSION` in `install.sh` |
| `403` on publish | The username is live and held by someone else | By design: `overridePublisher: no` plus the control server's token claim |
| `401` on everything, client shows a password box | The server has `HARMONY_PASSWORD` set | Enter it. `/api/health` still answers, and says `passwordRequired` |
| `429` with a `Retry-After` | Three wrong passwords from your address | Wait it out; the correct password is refused too until it expires |
| Viewers get `401` from the media server after a restart | Watch tokens are generated per process | Reconnect; the client picks up a fresh URL from `/api/streams` |
| Caddy will not start, port 80 in use | It binds 80 for redirects even on a high-port site | `auto_https disable_redirects` |
| Certificate stops renewing | DNS token expired | Replace it in `/etc/letsencrypt/cloudflare.ini`, then `sudo certbot renew --dry-run` |
| Everything works, then breaks hours later | Public IP moved | Check `harmony-ip-watch.timer` is active and your DDNS is current |
| Stream is 5–10 fps | Usually the client's bitrate ceiling, not the network | Raise the quality preset; read the ⚠ line in the client's stats for `bandwidth` vs `cpu` |

## When a client still cannot connect

In order, cheapest first:

1. **Confirm UDP 8189 really is open**, from outside your network. This is the
   cause the majority of the time.
2. **Confirm TCP 8189 is forwarded too.** This alone fixes clients on networks
   that block UDP, at no cost and with no third party involved.
3. Only then, **TURN**. Set `HARMONY_TURN_URL`, `HARMONY_TURN_USERNAME` and
   `HARMONY_TURN_PASSWORD`; the control server passes them to every client.

TURN is last for a reason: relayed traffic is charged per gigabyte and screen
sharing is measured in megabits per second, so treat any free tier as a handful
of hours rather than a default path. Only clients that cannot connect otherwise
will use it. `server/.env.example` lists the free tiers that work here.

The client has a **Test connection** button on the connect screen that walks
health → session → STUN → SDP → media and reports which step failed, which is
usually faster than guessing.

## Security notes

- **There are still no accounts.** `HARMONY_PASSWORD` is one shared secret for
  everyone, not per-user identity: it decides *whether* you are in, never *who*
  you are. Anyone who knows it can claim any free username and watch anyone.
  Without it the server is open to whoever can reach it.
- **Keep secrets out of the repo.** `.gitignore` covers `.env`, `*.key`,
  `*.pem`, `*.crt`, `cloudflare.ini` and `*.local.md`. Note that running
  MediaMTX from a checkout makes it drop a self-signed `auto.key` in the working
  directory.
- **The MediaMTX control API (9997) is loopback-only** and must stay that way —
  it can create and delete paths without authentication.
- Keep a record of your own install (hostname, LAN address, which ports you
  opened) in a `*.local.md` file; it is gitignored for exactly that purpose.
