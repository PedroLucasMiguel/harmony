# syntax=docker/dockerfile:1.7
#
# The Harmony server: the control server and MediaMTX, in one image.
#
# They are deliberately not split into two containers. The whole design rests on
# them being able to reach each other over loopback and nowhere else:
#
#   * MediaMTX calls the control server's auth hook for every publish and read
#   * the control server polls MediaMTX's API to learn who is live
#
# MediaMTX's control API can create and delete paths with no authentication at
# all, which is why mediamtx.yml binds it to 127.0.0.1. Split across containers
# those two links would have to cross a Docker network, and that API would have
# to listen on an address something else could reach. One container keeps the
# loopback-only guarantee that the configuration is written around.
#
#   docker build -t harmony-server ./server
#
# See ../docker/ for compose and run examples.

ARG NODE_VERSION=24-alpine
ARG ALPINE_VERSION=latest

# Pinned for the same reason install.sh pins it: MediaMTX removes configuration
# keys between releases, and an unknown key aborts startup rather than warning.
ARG MEDIAMTX_VERSION=1.21.0

# Which MediaMTX goes in: `patched` is the same version built from source with the patches in patches/ applied
# (what they are for: patches/README.md), `release` is the published binary. A patched build that cannot be
# made falls back to the published one and says so in the build log, so an image is never left without a relay.
#
#   docker build --build-arg MEDIAMTX_SOURCE=release -t harmony-server ./server    # the published binary
ARG MEDIAMTX_SOURCE=patched
# What the patched build compiles with; MediaMTX asks for the version in its go.mod (1.26 for MediaMTX 1.21).
ARG GO_VERSION=1.26

# --------------------------------------------------------------------------
# MediaMTX binary
#
# Runs on the BUILD platform and picks the target's architecture by hand, so
# cross-building for a Raspberry Pi does not drag every shell command through
# qemu just to download and untar a file.
# --------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM alpine:${ALPINE_VERSION} AS mediamtx-release
ARG MEDIAMTX_VERSION
ARG TARGETARCH
ARG TARGETVARIANT
RUN apk add --no-cache curl tar
RUN set -eu; \
    case "${TARGETARCH}${TARGETVARIANT}" in \
      amd64)   MTX_ARCH=linux_amd64  ;; \
      arm64)   MTX_ARCH=linux_arm64  ;; \
      armv7)   MTX_ARCH=linux_armv7  ;; \
      armv6)   MTX_ARCH=linux_armv6  ;; \
      *) echo "unsupported platform: ${TARGETARCH}${TARGETVARIANT}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/mediamtx.tar.gz \
      "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_${MTX_ARCH}.tar.gz"; \
    tar -xzf /tmp/mediamtx.tar.gz -C /tmp; \
    install -m 0755 /tmp/mediamtx /mediamtx

# --------------------------------------------------------------------------
# MediaMTX, built from source with Harmony's patches
#
# Also on the build platform: Go cross-compiles, so the target's architecture is a variable and not
# an emulated machine. Only built when MEDIAMTX_SOURCE=patched -- BuildKit skips a stage nothing needs.
# --------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS mediamtx-patched
ARG MEDIAMTX_VERSION
ARG TARGETARCH
ARG TARGETVARIANT
RUN apk add --no-cache curl tar patch
COPY patches/ /patches/
RUN set -eu; \
    case "${TARGETARCH}${TARGETVARIANT}" in \
      amd64) export GOARCH=amd64 MTX_ARCH=linux_amd64 ;; \
      arm64) export GOARCH=arm64 MTX_ARCH=linux_arm64 ;; \
      armv7) export GOARCH=arm GOARM=7 MTX_ARCH=linux_armv7 ;; \
      armv6) export GOARCH=arm GOARM=6 MTX_ARCH=linux_armv6 ;; \
      *) echo "unsupported platform: ${TARGETARCH}${TARGETVARIANT}" >&2; exit 1 ;; \
    esac; \
    if ! GOOS=linux sh /patches/build-mediamtx.sh "${MEDIAMTX_VERSION}" /mediamtx; then \
      echo "!!  MediaMTX with Harmony's patches did not build; using the published ${MEDIAMTX_VERSION} instead." >&2; \
      curl -fsSL -o /tmp/mediamtx.tar.gz \
        "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_${MTX_ARCH}.tar.gz"; \
      tar -xzf /tmp/mediamtx.tar.gz -C /tmp mediamtx; \
      install -m 0755 /tmp/mediamtx /mediamtx; \
    fi

# The one the runtime image takes.
FROM mediamtx-${MEDIAMTX_SOURCE} AS mediamtx

# --------------------------------------------------------------------------
# Production dependencies
#
# Also on the build platform: the only dependency is Express, which is pure
# JavaScript. If a native module is ever added this stage has to move to the
# target platform, or it will install the wrong binaries.
#
# The database is `node:sqlite`, built into Node, specifically so that stays
# true. Watch for optional native addons arriving with a future dependency --
# `ws`, for instance, has optional peerDependencies (bufferutil,
# utf-8-validate) that npm does not install by default but would break arm64
# cross-builds here if something ever pulled them in.
# --------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION} AS deps
WORKDIR /opt/harmony
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --------------------------------------------------------------------------
# Runtime
# --------------------------------------------------------------------------
FROM node:${NODE_VERSION}

LABEL org.opencontainers.image.title="Harmony server" \
      org.opencontainers.image.description="Relay-only WebRTC screen sharing: control server + MediaMTX" \
      org.opencontainers.image.source="https://github.com/PedroLucasMiguel/harmony" \
      org.opencontainers.image.licenses="MIT"

# tini reaps zombies and forwards signals; bash is for the entrypoint's
# `wait -n`, which busybox ash does not have.
RUN apk add --no-cache tini bash

COPY --from=mediamtx /mediamtx /usr/local/bin/mediamtx

WORKDIR /opt/harmony
COPY --from=deps /opt/harmony/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY mediamtx.yml /etc/harmony/mediamtx.yml
COPY docker-entrypoint.sh /usr/local/bin/harmony-entrypoint
RUN chmod 0755 /usr/local/bin/harmony-entrypoint

# The one writable path. Created and chowned while still root -- uid 1000
# cannot create it later under `--read-only`, and the failure would only show
# up at runtime on a fresh volume.
#
# A NAMED volume inherits this ownership (Docker copies the image directory's
# contents and ownership into an empty one). A BIND mount does NOT -- it keeps
# the host's ownership, so a bind-mounting operator must chown 1000:1000 the
# directory themselves. The server says so on startup if it cannot write.
#
# Deliberately NO `VOLUME` instruction: it would make `docker run` without -v
# silently create an anonymous volume, which looks like persistence, cannot be
# found again, and is orphaned by every `docker rm`. Better that an unmounted
# container fails loudly, which it does.
RUN mkdir -p /var/lib/harmony && chown node:node /var/lib/harmony

# Nothing here needs root: every port is above 1024 and the only writable path
# is the data volume above. `node` already exists in the base image as uid 1000.
USER node

ENV HARMONY_HOST=0.0.0.0 \
    HARMONY_PORT=8080 \
    HARMONY_DATA_DIR=/var/lib/harmony \
    NODE_ENV=production

# 8080  control API        8889  WHIP/WHEP signaling (HTTP)
# 8189  WebRTC media, UDP and TCP -- the TCP one is the fallback for clients
#       whose network drops UDP.
# 9997 is MediaMTX's control API and is deliberately NOT exposed.
EXPOSE 8080/tcp 8889/tcp 8189/udp 8189/tcp

# /api/health is outside the password gate precisely so it can be probed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${HARMONY_PORT}/api/health" | grep -q '"mediamtx":"up"' || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/harmony-entrypoint"]
