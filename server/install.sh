#!/usr/bin/env bash
# Harmony server installer for Debian / Ubuntu / Raspberry Pi OS.
#
# Architecture-agnostic: x86-64, arm64, armv7 and armv6 are all detected below
# and get the matching MediaMTX build.
#
# Installs MediaMTX, installs the Harmony control server, registers both as
# systemd services -- and then, if you let it, does the rest: asks for your
# domain, sets up HTTPS (Caddy on its own, or certbot over Cloudflare DNS),
# writes /etc/harmony/harmony.env, starts everything and checks it answers.
#
# Safe to re-run: it upgrades MediaMTX and the server in place, and only
# touches an existing configuration if you say so.
#
#   sudo ./install.sh              install, then set up if not configured yet
#   sudo ./install.sh --setup      install, then (re)run the setup regardless
#   sudo ./install.sh --no-setup   install only; configure by hand
#
# Unattended: give the answers as environment variables and the setup asks
# nothing it already knows.
#
#   HARMONY_DOMAIN       harmony.example.com
#   HARMONY_TLS          caddy | certbot | none
#   HARMONY_HTTPS_PORT   certbot route only; default 8444
#   HARMONY_ACME_EMAIL   certbot route only
#   CF_API_TOKEN         certbot route only; Zone > DNS > Edit on the domain
#   HARMONY_PUBLIC_URL   none route only; the URL clients use
#   HARMONY_PASSWORD     server password; empty means none

set -euo pipefail

# Pinned deliberately: mediamtx.yml is validated against this release, and
# MediaMTX removes config keys between versions (a stale key aborts startup).
MEDIAMTX_VERSION="${MEDIAMTX_VERSION:-1.21.0}"
PREFIX=/opt/harmony
CONF_DIR=/etc/harmony
ENV_FILE="$CONF_DIR/harmony.env"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SETUP=auto
for arg in "$@"; do
  case "$arg" in
    --setup) SETUP=yes ;;
    --no-setup) SETUP=no ;;
    -h|--help) sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "This script needs root: sudo ./install.sh" >&2
  exit 1
fi

# --- architecture -----------------------------------------------------------
case "$(uname -m)" in
  aarch64|arm64) MTX_ARCH=linux_arm64 ;;
  armv7l)        MTX_ARCH=linux_armv7 ;;
  armv6l)        MTX_ARCH=linux_armv6 ;;
  x86_64)        MTX_ARCH=linux_amd64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
echo "==> Architecture $(uname -m) -> ${MTX_ARCH}"

# --- dependencies -----------------------------------------------------------
# Node 24, not 22: the database is `node:sqlite`, which is only unflagged from
# Node 22.13. Installing the 22.x line risks landing on an earlier 22 where
# `import ... from "node:sqlite"` throws at startup with nothing to install to
# fix it, so take the next LTS line and leave no room for doubt.
if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if (( NODE_MAJOR < 22 )) || { (( NODE_MAJOR == 22 )) && (( NODE_MINOR < 13 )); }; then
  echo "Node 22.13+ required (node:sqlite is flagged before that), found $(node -v)" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash - && sudo apt-get install -y nodejs" >&2
  exit 1
fi

# Fail now rather than at first boot if this build has no SQLite.
if ! node -e 'import("node:sqlite").then(()=>0,()=>process.exit(1))'; then
  echo "This Node build has no node:sqlite module. Install Node 24 from nodesource." >&2
  exit 1
fi
echo "==> Node $(node -v)"

# --- MediaMTX ---------------------------------------------------------------
echo "==> Installing MediaMTX ${MEDIAMTX_VERSION}"
TARBALL="mediamtx_v${MEDIAMTX_VERSION}_${MTX_ARCH}.tar.gz"
URL="https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/${TARBALL}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "$URL" -o "$TMP/$TARBALL"
tar -xzf "$TMP/$TARBALL" -C "$TMP"
install -m 0755 "$TMP/mediamtx" /usr/local/bin/mediamtx
echo "    $(/usr/local/bin/mediamtx --version 2>&1 | head -n1)"

# --- Harmony control server -------------------------------------------------
echo "==> Installing Harmony control server to ${PREFIX}"
mkdir -p "$PREFIX"
cp -r "$SRC_DIR/src" "$SRC_DIR/package.json" "$PREFIX/"

# Prefer the committed lockfile so the host gets the same tree that was tested.
if [[ -f "$SRC_DIR/package-lock.json" ]]; then
  cp "$SRC_DIR/package-lock.json" "$PREFIX/"
  (cd "$PREFIX" && npm ci --omit=dev --no-audit --no-fund)
else
  (cd "$PREFIX" && npm install --omit=dev --no-audit --no-fund)
fi

mkdir -p "$CONF_DIR"
install -m 0644 "$SRC_DIR/mediamtx.yml" "$CONF_DIR/mediamtx.yml"

ENV_CREATED=no
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0640 "$SRC_DIR/.env.example" "$ENV_FILE"
  ENV_CREATED=yes
  echo "    Created ${ENV_FILE}"
else
  echo "    Keeping existing ${ENV_FILE}"
fi

# --- service user -----------------------------------------------------------
if ! id -u harmony >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin harmony
fi
chown -R harmony:harmony "$PREFIX"
chown -R root:harmony "$CONF_DIR"
chmod 0750 "$CONF_DIR"

# --- systemd ----------------------------------------------------------------
echo "==> Registering systemd units"
install -m 0644 "$SRC_DIR/systemd/mediamtx.service" /etc/systemd/system/mediamtx.service
install -m 0644 "$SRC_DIR/systemd/harmony-server.service" /etc/systemd/system/harmony-server.service

# Keeps the advertised ICE address correct on a dynamic public IP.
install -m 0755 "$SRC_DIR/ip-watch.sh" /usr/local/bin/harmony-ip-watch.sh
install -m 0644 "$SRC_DIR/systemd/harmony-ip-watch.service" /etc/systemd/system/harmony-ip-watch.service
install -m 0644 "$SRC_DIR/systemd/harmony-ip-watch.timer" /etc/systemd/system/harmony-ip-watch.timer

systemctl daemon-reload
systemctl enable harmony-server mediamtx harmony-ip-watch.timer

# =============================================================================
# Setup: domain, HTTPS, configuration, first start
# =============================================================================

# Questions go to the terminal even when stdin is a pipe (curl ... | bash),
# and there is no terminal at all under cloud-init or CI -- in which case only
# the environment variables above can answer.
HAVE_TTY=no
if [[ -r /dev/tty && -w /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then HAVE_TTY=yes; fi

ask() {          # ask "Question" "default" -> answer on stdout
  local question=$1 default=${2:-} answer=''
  [[ $HAVE_TTY == yes ]] || { printf '%s' "$default"; return; }
  if [[ -n $default ]]; then printf '%s [%s]: ' "$question" "$default" >/dev/tty
  else printf '%s: ' "$question" >/dev/tty; fi
  IFS= read -r answer </dev/tty || true
  printf '%s' "${answer:-$default}"
}

ask_secret() {   # like ask, without echoing what is typed
  local question=$1 answer=''
  [[ $HAVE_TTY == yes ]] || return 0
  printf '%s: ' "$question" >/dev/tty
  IFS= read -rs answer </dev/tty || true
  printf '\n' >/dev/tty
  printf '%s' "$answer"
}

yes_no() {       # yes_no "Question" "y|n" -> exit status
  local answer
  answer="$(ask "$1 (y/n)" "$2")"
  [[ $answer =~ ^[Yy] ]]
}

# One KEY=value in harmony.env, replacing it whether it was set or commented
# out. Rewritten whole and reinstalled, so the file is never half-written and
# keeps its owner and mode (it holds the password).
set_env() {
  local key=$1 value=$2 tmp
  tmp="$(mktemp)"
  grep -v -E "^#?[[:space:]]*${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  install -m 0640 -o root -g harmony "$tmp" "$ENV_FILE"
  rm -f "$tmp"
}

unset_env() {
  local key=$1 tmp
  tmp="$(mktemp)"
  grep -v -E "^[[:space:]]*${key}=" "$ENV_FILE" > "$tmp" || true
  install -m 0640 -o root -g harmony "$tmp" "$ENV_FILE"
  rm -f "$tmp"
}

# Still the example's placeholder, i.e. never configured.
unconfigured() {
  grep -q -E '^MTX_WEBRTCADDITIONALHOSTS=stream\.example\.com' "$ENV_FILE" 2>/dev/null
}

install_caddy() {
  command -v caddy >/dev/null 2>&1 && return 0
  echo "==> Installing Caddy"
  apt-get update -qq
  # In Debian 12 and Ubuntu 23.04 onwards. Older releases get Caddy's own
  # repository, which is what its documentation recommends anyway.
  if ! apt-get install -y caddy; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y caddy
  fi
}

# The three routes every Harmony site needs. /ws is not optional: channels,
# voice and chat all run over it, and without its own line it falls into the
# catch-all and reaches MediaMTX instead -- while /api keeps working, so the
# server looks healthy. Each block on its own lines: Caddy refuses anything
# after '{' on the same line.
site_routes() {
  printf '\thandle /api/* {\n\t\treverse_proxy 127.0.0.1:8080\n\t}\n'
  printf '\thandle /ws {\n\t\treverse_proxy 127.0.0.1:8080\n\t}\n'
  printf '\thandle {\n\t\treverse_proxy 127.0.0.1:8889\n\t}\n'
}

write_caddyfile() {   # write_caddyfile <content>
  local file=/etc/caddy/Caddyfile
  mkdir -p /etc/caddy
  # Anything there that we did not write is somebody's configuration -- the
  # package's placeholder site, or a real one -- so it is kept, not lost.
  if [[ -f $file ]] && ! grep -q 'Managed by Harmony' "$file"; then
    cp -a "$file" "$file.bak-$(date +%Y%m%d-%H%M%S)"
    echo "    Kept the previous Caddyfile as $file.bak-*"
  fi
  printf '%s' "$1" > "$file"
  caddy fmt --overwrite "$file" >/dev/null 2>&1 || true
  caddy validate --config "$file" --adapter caddyfile >/dev/null
}

open_firewall() {     # open_firewall 443/tcp 8189/udp ...
  command -v ufw >/dev/null 2>&1 || return 0
  ufw status 2>/dev/null | grep -q '^Status: active' || return 0
  local rule
  for rule in "$@"; do ufw allow "$rule" >/dev/null; done
  echo "    Opened in ufw: $*"
}

public_ip() {
  curl -fsS -4 -m 5 https://api.ipify.org 2>/dev/null \
    || curl -fsS -4 -m 5 https://ifconfig.me 2>/dev/null || true
}

wait_for() {          # wait_for <seconds> <command...>
  local deadline=$((SECONDS + $1)); shift
  until "$@" >/dev/null 2>&1; do
    (( SECONDS >= deadline )) && return 1
    sleep 2
  done
}

# Called as `setup || manual_steps`, and bash switches `set -e` off inside a
# function called that way -- so every step that can fail says so itself and
# returns, rather than relying on the script stopping.
setup() {
  echo
  echo "==> Setup"
  echo "    Answer a few questions and this sets up HTTPS, the configuration and"
  echo "    the first start. Leave the domain empty to stop here and do it by hand."
  echo

  # --- domain ----------------------------------------------------------------
  local domain=${HARMONY_DOMAIN:-}
  [[ -n $domain ]] || domain="$(ask 'Domain clients will connect to (e.g. harmony.example.com)')"
  domain="${domain,,}"; domain="${domain#https://}"; domain="${domain#http://}"; domain="${domain%%/*}"
  if [[ -z $domain ]]; then
    echo "    No domain: skipping setup."
    return 1
  fi
  if [[ ! $domain =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]]; then
    echo "That does not look like a domain name: $domain" >&2
    return 1
  fi

  # --- route -----------------------------------------------------------------
  local route=${HARMONY_TLS:-}
  if [[ -z $route && $HAVE_TTY == no ]]; then
    route=caddy
  elif [[ -z $route ]]; then
    cat >/dev/tty <<'EOF'

How should HTTPS be set up?

  1) Caddy, automatic certificate
       This machine is reachable from the internet on ports 80 and 443.
       Usual for a cloud VM or a rented server. Nothing else to provide.

  2) Certbot, over Cloudflare DNS
       Ports 80/443 are blocked (usual on a home connection), so the
       certificate is proven through DNS instead. The domain's DNS must be
       on Cloudflare, and you need an API token with Zone > DNS > Edit.
       HTTPS then runs on a high port of your choice.

  3) None -- I run my own reverse proxy or tunnel

EOF
    case "$(ask 'Choose 1, 2 or 3' '1')" in
      1) route=caddy ;;
      2) route=certbot ;;
      3) route=none ;;
      *) echo "Not one of the choices." >&2; return 1 ;;
    esac
  fi

  local port=443 email='' token='' url=''
  case "$route" in
    caddy) url="https://$domain" ;;
    certbot)
      port=${HARMONY_HTTPS_PORT:-}
      [[ -n $port ]] || port="$(ask 'HTTPS port' '8444')"
      [[ $port =~ ^[0-9]+$ ]] && (( port > 0 && port < 65536 )) \
        || { echo "Not a port: $port" >&2; return 1; }
      email=${HARMONY_ACME_EMAIL:-}
      [[ -n $email ]] || email="$(ask "Email for Let's Encrypt (expiry notices)")"
      [[ $email == *@*.* ]] || { echo "Not an email address: $email" >&2; return 1; }
      token=${CF_API_TOKEN:-}
      [[ -n $token ]] || token="$(ask_secret 'Cloudflare API token (not shown)')"
      [[ -n $token ]] || { echo "The certbot route needs a Cloudflare token." >&2; return 1; }
      if (( port == 443 )); then url="https://$domain"; else url="https://$domain:$port"; fi
      ;;
    none)
      url=${HARMONY_PUBLIC_URL:-}
      [[ -n $url ]] || url="$(ask 'URL clients use to reach this server' "https://$domain")"
      ;;
    *) echo "HARMONY_TLS must be caddy, certbot or none (got: $route)" >&2; return 1 ;;
  esac

  # --- password --------------------------------------------------------------
  local password
  if [[ -n ${HARMONY_PASSWORD+set} ]]; then
    password=$HARMONY_PASSWORD
  else
    password="$(ask_secret 'Server password, asked before anyone can sign in (empty = none)')"
  fi
  # Written single-quoted, which systemd reads literally -- so the one thing
  # that cannot be in it is a single quote.
  if [[ $password == *"'"* || $password == *$'\n'* ]]; then
    echo "The password cannot contain a single quote or a line break." >&2
    return 1
  fi

  # --- DNS -------------------------------------------------------------------
  # The record must lead HERE. Behind Cloudflare's proxy (orange cloud) it
  # resolves to Cloudflare instead: HTTPS fails with 525, and the audio and
  # video -- UDP, which that proxy does not carry -- would have nowhere to go.
  local resolved mine
  resolved="$(getent ahostsv4 "$domain" | awk 'NR==1 {print $1}')"
  mine="$(public_ip)"
  if [[ -z $resolved ]]; then
    echo "    WARNING: $domain does not resolve yet. Point an A record at ${mine:-the public IP of this machine}."
  elif [[ -n $mine && $resolved != "$mine" ]]; then
    echo "    WARNING: $domain resolves to $resolved, but this machine's public IP is $mine."
    echo "             On Cloudflare the record must be DNS only (grey cloud), not proxied."
  else
    echo "    $domain -> $resolved (this machine)"
  fi

  # --- configuration ---------------------------------------------------------
  echo "==> Writing $ENV_FILE"
  set_env HARMONY_SIGNALING_URL "$url"
  set_env MTX_WEBRTCADDITIONALHOSTS "$domain"
  if [[ -n $password ]]; then
    set_env HARMONY_PASSWORD "'$password'"
  else
    unset_env HARMONY_PASSWORD
  fi

  # --- HTTPS -----------------------------------------------------------------
  case "$route" in
    caddy)
      install_caddy || { echo "Could not install Caddy." >&2; return 1; }
      echo "==> Configuring Caddy for https://$domain"
      write_caddyfile "# Managed by Harmony install.sh -- re-run it to change this.
$domain {
$(site_routes)
}
" || { echo "Caddy rejected the configuration: caddy validate --config /etc/caddy/Caddyfile" >&2; return 1; }
      open_firewall 80/tcp 443/tcp
      ;;
    certbot)
      install_caddy || { echo "Could not install Caddy." >&2; return 1; }
      echo "==> Installing certbot"
      apt-get install -y certbot python3-certbot-dns-cloudflare >/dev/null         || { echo "Could not install certbot." >&2; return 1; }
      mkdir -p /etc/letsencrypt/renewal-hooks/deploy /etc/caddy/tls
      install -m 0600 /dev/null /etc/letsencrypt/cloudflare.ini
      printf 'dns_cloudflare_api_token = %s\n' "$token" > /etc/letsencrypt/cloudflare.ini
      token=''

      echo "==> Requesting the certificate over DNS (takes about a minute)"
      certbot certonly --dns-cloudflare \
        --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
        --dns-cloudflare-propagation-seconds 30 \
        -d "$domain" --agree-tos -m "$email" -n --keep-until-expiring || {
          echo "certbot could not get a certificate. The usual causes: the token cannot" >&2
          echo "edit DNS for $domain's zone, or the domain is not on that Cloudflare account." >&2
          return 1
        }

      # Caddy cannot read /etc/letsencrypt as its own user, so the certificate
      # is copied where it can -- now, and by certbot after every renewal.
      cat > /etc/letsencrypt/renewal-hooks/deploy/harmony-caddy.sh <<EOF
#!/usr/bin/env bash
# Installed by Harmony's install.sh: hand a renewed certificate to Caddy.
install -m 0644 -o caddy -g caddy /etc/letsencrypt/live/$domain/fullchain.pem /etc/caddy/tls/fullchain.pem
install -m 0600 -o caddy -g caddy /etc/letsencrypt/live/$domain/privkey.pem /etc/caddy/tls/privkey.pem
systemctl reload caddy 2>/dev/null || systemctl restart caddy
EOF
      chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/harmony-caddy.sh
      install -m 0644 -o caddy -g caddy "/etc/letsencrypt/live/$domain/fullchain.pem" /etc/caddy/tls/fullchain.pem         && install -m 0600 -o caddy -g caddy "/etc/letsencrypt/live/$domain/privkey.pem" /etc/caddy/tls/privkey.pem         || { echo "Could not copy the certificate for Caddy." >&2; return 1; }

      echo "==> Configuring Caddy for $url"
      # disable_redirects: Caddy would otherwise bind port 80 for HTTP->HTTPS
      # redirects even on a site that only listens on a high port.
      write_caddyfile "# Managed by Harmony install.sh -- re-run it to change this.
{
	auto_https disable_redirects
}

https://$domain:$port {
	tls /etc/caddy/tls/fullchain.pem /etc/caddy/tls/privkey.pem
$(site_routes)
}
" || { echo "Caddy rejected the configuration: caddy validate --config /etc/caddy/Caddyfile" >&2; return 1; }
      open_firewall "$port/tcp"
      ;;
  esac
  open_firewall 8189/udp 8189/tcp

  # --- start -------------------------------------------------------------------
  echo "==> Starting Harmony"
  # Only this start's log is searched for the owner key below; an older one
  # could hold a key that has since been used.
  local started
  started="$(date '+%Y-%m-%d %H:%M:%S')"
  # The control server first: it answers MediaMTX's auth hook.
  systemctl restart harmony-server
  wait_for 30 curl -fsS http://127.0.0.1:8080/api/health || {
    echo "The control server did not start. See: journalctl -u harmony-server -n 50" >&2
    return 1
  }
  systemctl restart mediamtx
  if [[ $route != none ]]; then
    systemctl enable caddy >/dev/null 2>&1 || true
    systemctl restart caddy
  fi

  local healthy=no
  if [[ $route != none ]]; then
    echo "==> Checking $url (Caddy may still be fetching its certificate)"
    if wait_for 90 curl -fsS "$url/api/health"; then healthy=yes; fi
  fi

  # --- done ------------------------------------------------------------------
  local key
  key="$(journalctl -u harmony-server --no-pager --since "$started" 2>/dev/null \
    | grep -A6 'owner key' | grep -oE '[A-Za-z0-9_-]{22}' | tail -n1 || true)"

  echo
  echo "==> Done."
  echo
  echo "  Address for the app:  $url"
  if [[ $route != none ]]; then
    if [[ $healthy == yes ]]; then
      echo "  Reachable over HTTPS: yes"
    else
      echo "  Reachable over HTTPS: NOT YET -- check the ports below, the DNS record,"
      echo "                        and: journalctl -u caddy -n 50"
    fi
  fi
  if [[ -n $key ]]; then
    echo
    echo "  Owner key: $key"
    echo "    Register in the app and paste it into the \"owner key\" box to become"
    echo "    this server's owner. It works once."
  fi
  echo
  echo "  Open these to this machine (router port forward, or the cloud firewall):"
  case "$route" in
    caddy)   echo "    TCP 80 and 443        HTTPS, and Caddy's certificate checks" ;;
    certbot) echo "    TCP $port              HTTPS" ;;
    none)    echo "    whatever your own proxy listens on" ;;
  esac
  echo "    UDP and TCP 8189      audio and video -- the same number outside and in"
  if [[ $route == certbot ]]; then
    echo
    echo "  The certificate renews itself every 60 days using the Cloudflare token in"
    echo "  /etc/letsencrypt/cloudflare.ini. Use a permanent token: a temporary one"
    echo "  stops renewal the day it expires. Test renewal with: certbot renew --dry-run"
  fi
  echo
}

manual_steps() {
  cat <<EOF

==> Installed.

Next steps:

  1. Edit the configuration:
       sudo nano ${ENV_FILE}

     At minimum set HARMONY_SIGNALING_URL and MTX_WEBRTCADDITIONALHOSTS to the
     address clients will actually use. Or let this script do it, HTTPS
     included:  sudo ./install.sh --setup

  2. Forward UDP and TCP port 8189 on your router to this host. WebRTC media
     travels over it, and a Cloudflare Tunnel cannot carry it.

  3. Start both services (the control server first -- it answers MediaMTX's
     auth hook):
       sudo systemctl start harmony-server mediamtx

  4. Check it:
       curl -s http://127.0.0.1:8080/api/health
       journalctl -u harmony-server -u mediamtx -f

EOF
}

# --- run setup, or say what is left ---------------------------------------------
run_setup=no
case "$SETUP" in
  yes) run_setup=yes ;;
  no)  run_setup=no ;;
  auto)
    if [[ $ENV_CREATED == yes ]] || unconfigured; then
      run_setup=yes
    elif [[ $HAVE_TTY == yes ]] && yes_no "Harmony is already configured. Run the setup again?" "n"; then
      run_setup=yes
    else
      # Configured already: an upgrade restarts onto the new code.
      systemctl restart harmony-server mediamtx
      echo
      echo "==> Upgraded and restarted. Configuration left as it was."
      exit 0
    fi
    ;;
esac

if [[ $run_setup == yes && ( $HAVE_TTY == yes || -n ${HARMONY_DOMAIN:-} ) ]]; then
  setup || manual_steps
else
  manual_steps
fi
