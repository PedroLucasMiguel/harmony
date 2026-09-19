# Running the Harmony server in Docker

```bash
docker run -d --name harmony \
  -p 8080:8080 -p 8889:8889 \
  -p 8189:8189/udp -p 8189:8189/tcp \
  -e MTX_WEBRTCADDITIONALHOSTS=stream.example.com \
  -e HARMONY_SIGNALING_URL=https://stream.example.com:8444 \
  pedrolucasmiguel/harmony-server:0.1.0
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
  pedrolucasmiguel/harmony-server:0.1.0
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

Nothing is stored on disk, so there is nothing to migrate. Viewers reconnect.
If a password is set, note that watch tokens are generated per process, so a
restart invalidates outstanding watch URLs — clients pick up fresh ones
automatically.

## Building it yourself

```bash
docker build -t harmony-server ./server

# Multi-arch, straight to a registry:
docker buildx build --platform linux/amd64,linux/arm64 \
  -t you/harmony-server:0.1.0 --push ./server
```

`MEDIAMTX_VERSION` is a build arg, pinned to the release `mediamtx.yml` is
validated against — MediaMTX removes configuration keys between versions, and an
unknown key aborts startup rather than warning.
