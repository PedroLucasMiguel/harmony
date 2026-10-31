# Running the Harmony server in Docker

```bash
docker run -d --name harmony \
  -p 8080:8080 -p 8889:8889 \
  -p 8189:8189/udp -p 8189:8189/tcp \
  -e MTX_WEBRTCADDITIONALHOSTS=stream.example.com \
  -e HARMONY_SIGNALING_URL=https://stream.example.com:8444 \
  pedrolucasmiguel/harmony-server:3.0.0
```

| File | What |
| --- | --- |
| [docker-compose.yml](docker-compose.yml) | The usual way. Copy `.env.example` to `.env` first. |
| [docker-run.sh](docker-run.sh) | The same thing as one `docker run`, for trying it out. |
| [.env.example](.env.example) | The two settings you must fill in, and the optional password. |

**Image:** [`pedrolucasmiguel/harmony-server`](https://hub.docker.com/r/pedrolucasmiguel/harmony-server)
— `linux/amd64` and `linux/arm64`, so the same tag runs on a mini-PC and on a
Raspberry Pi 5.

## The two things you must set

| Variable | Why |
| --- | --- |
| `MTX_WEBRTCADDITIONALHOSTS` | The public hostname or IP clients will reach. MediaMTX advertises it as an ICE candidate. **Without it nobody outside this machine can connect** — the container would only offer its own `172.17.x.x` address. |
| `HARMONY_SIGNALING_URL` | Where clients reach the signaling endpoint, including its public port. |

The container says so on startup if the first one is missing:

```
[entrypoint] WARNING: MTX_WEBRTCADDITIONALHOSTS is not set.
```

Everything else is in [../DEPLOYMENT.md](../DEPLOYMENT.md), including the
optional server password and its lockout.

## Do not remap the media ports

```
-p 8189:8189/udp -p 8189:8189/tcp     ✅
-p 9000:8189/udp                      ❌ negotiates fine, then plays nothing
```

MediaMTX advertises **the port it is listening on inside the container**. Publish
it as `9000:8189` and clients are told to send media to 9000, where nothing is
listening — so the handshake succeeds, the connection reports itself as
connected, and no picture ever arrives. If you need a different port, change it
on both sides:

```bash
-p 9000:9000/udp -p 9000:9000/tcp \
-e MTX_WEBRTCLOCALUDPADDRESS=:9000 \
-e MTX_WEBRTCLOCALTCPADDRESS=:9000
```

The TCP port is not redundant. Plenty of corporate and campus networks drop UDP
outright, and ICE only falls back to TCP when UDP fails — so it costs nothing
when it is not needed, and it is what those clients connect with instead of a
paid TURN relay.

### Or use host networking

On a Linux host this sidesteps port mapping entirely, and lets MediaMTX see the
real interfaces so LAN clients connect directly:

```bash
docker run -d --name harmony --network host \
  -e MTX_WEBRTCADDITIONALHOSTS=stream.example.com \
  -e HARMONY_SIGNALING_URL=https://stream.example.com:8444 \
  pedrolucasmiguel/harmony-server:3.0.0
```

Note this also exposes MediaMTX's control API on port 9997 to the host's
loopback. That API creates and deletes paths with no authentication, so make
sure 9997 is not forwarded anywhere.

## Why one container and not two

MediaMTX asks the control server to authorise every publish and every read, and
the control server polls MediaMTX's API to learn who is live. That API needs no
authentication at all, which is why `mediamtx.yml` binds it to `127.0.0.1`.

Splitting the two would put both of those links on a Docker network and force
that API to listen somewhere another container could reach it. One container
keeps the loopback-only guarantee the configuration is written around.

The entrypoint starts the control server **first** and waits until it actually
answers before starting MediaMTX — otherwise the publishes and reads that arrive
in that window are refused rather than queued. If either process exits on its
own the container exits non-zero, so it restarts rather than limping along
serving half a service.

## Ports

| Protocol | Port | Purpose |
| --- | --- | --- |
| **UDP** | **8189** | WebRTC media. **Without this nothing plays.** |
| **TCP** | **8189** | Media fallback for clients whose network blocks UDP |
| TCP | 8889 | WHIP/WHEP signaling. Plain HTTP — the one part a reverse proxy or tunnel can carry |
| TCP | 8080 | Control API |
| TCP | 9997 | MediaMTX's control API. **Deliberately not exposed** |

## Checking it works

```bash
docker compose ps                          # should say (healthy)
curl -s localhost:8080/api/health
docker compose logs -f
```

A healthy container means the control server can see MediaMTX. It says nothing
about whether anyone can reach you — for that, run the real thing from a client
machine, ideally on another network:

```bash
HARMONY_SERVER=https://stream.example.com:8444 node client/test/verify-deployment.mjs
```

It publishes a stream, watches it back with a second client, and prints the ICE
candidates the server advertised — which is what actually decides whether
outsiders can connect.

## Updating

```bash
docker compose pull && docker compose up -d
```

Accounts, roles and channels live in SQLite in the `harmony-data` volume and
survive the upgrade. Schema migrations run automatically at startup and are
logged (`[db] migrated to schema vN`); there is nothing to run by hand.

Viewers reconnect. If a password is set, note that watch tokens are generated
per process, so a restart invalidates outstanding watch URLs — clients pick up
fresh ones automatically.

> **Upgrading from 0.1.0?** That release wrote nothing to disk and the compose
> file had no `volumes:` key. Take the new `docker-compose.yml`, or the
> container will refuse to start and tell you what to add — it will not run
> without somewhere to keep accounts.
>
> Server and client are versioned together from 2.0.0 onwards. A 1.0.0 client
> still works against a 2.0.0 server right up until somebody registers an
> account, after which it cannot claim a username and has to be updated.

### The data volume

| | |
|---|---|
| Contents | `harmony.db` (accounts, roles, channels, messages) and `uploads/` |
| Upload quota | `HARMONY_MAX_DISK_BYTES`, default 2 GB — raise it if you back the volume with a real disk |
| Where | the `harmony-data` named volume, mounted at `/var/lib/harmony` |
| Override | `HARMONY_DATA_DIR` |

The container still runs with `read_only: true`; this one volume is the only
writable path, which is strictly better than dropping the hardening.

**Back up:**

```bash
docker run --rm -v harmony_harmony-data:/data -v "$PWD:/out" \
  alpine tar czf /out/harmony-backup.tgz -C /data .
```

**Restore:**

```bash
docker compose down
docker run --rm -v harmony_harmony-data:/data -v "$PWD:/in" \
  alpine sh -c 'rm -rf /data/* && tar xzf /in/harmony-backup.tgz -C /data'
docker compose up -d
```

Taking the backup while the server is running is fine for a friends' server —
SQLite is in WAL mode, so the worst case is losing the last few seconds of
writes. `docker compose stop` first if you want it exact.

**A bind mount instead of a named volume** keeps the *host's* ownership rather
than the image's, so you have to chown it yourself:

```bash
mkdir -p /srv/harmony-data && chown 1000:1000 /srv/harmony-data
# then:  -v /srv/harmony-data:/var/lib/harmony
```

### The owner key

On a brand new server, the first start prints a one-time key:

```bash
docker compose logs harmony | head -20
```

Register in the client, paste it into the *owner key* box, and that account
becomes the owner. It is consumed on use and is not printed again once an owner
exists.

## Building it yourself

```bash
docker build -t harmony-server ./server

# Multi-arch, straight to a registry:
docker buildx build --platform linux/amd64,linux/arm64 \
  -t you/harmony-server:3.0.0 --push ./server
```

`MEDIAMTX_VERSION` is a build arg, pinned to the release `mediamtx.yml` is
validated against — MediaMTX removes configuration keys between versions, and an
unknown key aborts startup rather than warning.

The image carries MediaMTX built from source with the patches in
[`server/patches/`](../server/patches/README.md) applied (a gentler loss recovery for shares). If that cannot be
built it falls back to the published binary and says so in the build log. `MEDIAMTX_SOURCE=release` asks for the
published binary straight away.

```bash
docker build --build-arg MEDIAMTX_SOURCE=release -t harmony-server ./server
```
