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

# --------------------------------------------------------------------------
# MediaMTX binary
#
# Runs on the BUILD platform and picks the target's architecture by hand, so
# cross-building for a Raspberry Pi does not drag every shell command through
# qemu just to download and untar a file.
# --------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM alpine:${ALPINE_VERSION} AS mediamtx
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
# Production dependencies
#
# Also on the build platform: the only dependency is Express, which is pure
# JavaScript. If a native module is ever added this stage has to move to the
# target platform, or it will install the wrong binaries.
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

# Nothing here needs root: every port is above 1024 and nothing is written to
# disk. `node` already exists in the base image as uid 1000.
USER node

ENV HARMONY_HOST=0.0.0.0 \
    HARMONY_PORT=8080 \
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
