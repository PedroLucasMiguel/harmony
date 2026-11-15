#!/usr/bin/env bash
# Footprint of a process and everything it started (macOS): dev/bench.sh PID [SECONDS=30] [SETTLE=5]
# Waits SETTLE seconds, then samples the tree once a second: RSS from ps, memory footprint (what Activity Monitor
# shows), CPU as percent of one core over the second, threads and idle wakeups per second (top reports a running
# total; this is its change) , process count.
# Prints mean / p95 / peak, then the tree's processes at the last sample.
set -euo pipefail
PID="${1:?usage: bench.sh PID [SECONDS] [SETTLE]}"; N="${2:-30}"; SETTLE="${3:-5}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
sleep "$SETTLE"
top -l $((N + 1)) -s 1 -stats pid,ppid,cpu,threads,idlew,mem,command 2>/dev/null | awk '/^PID/ { n++ } /^[0-9]/ { print n, $0 }' >"$T/top" &
for i in $(seq $((N + 1))); do ps -axo pid=,ppid=,rss=,comm= | sed "s/^/$i /" >>"$T/ps"; sleep 1; done
wait
[ -z "${BENCH_RAW:-}" ] || cp "$T/top" "$BENCH_RAW"
awk -v root="$PID" '
function mb(s,  u, v) { gsub(/[+-]$/, "", s); u = substr(s, length(s)); v = substr(s, 1, length(s) - 1) + 0
  return u == "K" ? v / 1024 : u == "G" ? v * 1024 : u == "B" ? v / 1048576 : v }
function pct(a, n, p,  i, j, t) { for (i = 2; i <= n; i++) { t = a[i]; for (j = i - 1; j >= 1 && a[j] > t; j--) a[j + 1] = a[j]; a[j + 1] = t } return a[int(p * (n - 1) + 0.5) + 1] }
FILENAME ~ /top$/ { s = $1; p = $2; key[s, p] = 1; cpu[s, p] = $4; split($5, a, "/"); th[s, p] = a[1]; idle[s, p] = $6 + 0; mem[s, p] = mb($7); cmd[s, p] = $8; if (s > ns) ns = s; next }
{ s = $1; rss[s, $2] = $4 / 1024; ppid[s, $2] = $3; pids[s] = pids[s] " " $2 }
END {
  for (s = 2; s <= ns; s++) {
    split(pids[s], list, " "); delete tree; tree[root] = 1
    for (pass = 0; pass < 8; pass++) for (i in list) if ((list[i] in tree) == 0 && (ppid[s, list[i]] in tree)) tree[list[i]] = 1
    c = r = m = t = w = k = 0
    for (p in tree) { if (!((s, p) in key)) continue; c += cpu[s, p]; r += rss[s, p]; m += mem[s, p]; t += th[s, p]; if ((s - 1, p) in key) w += idle[s, p] - idle[s - 1, p]; k++; if (s == ns) last[p] = cmd[s, p] " rss " int(rss[s, p]) " MB, footprint " int(mem[s, p]) " MB" }
    n++; C[n] = c; R[n] = r; M[n] = m; T[n] = t; W[n] = w; K[n] = k
  }
  for (i = 1; i <= n; i++) { sc += C[i]; sr += R[i]; sm += M[i]; st += T[i]; sw += W[i]; c2[i] = C[i]; r2[i] = R[i]; if (R[i] > pr) pr = R[i]; if (M[i] > pm) pm = M[i]; if (C[i] > pc) pc = C[i] }
  printf "samples %d, processes %d\n", n, K[n]
  printf "RSS MB       mean %.1f  p95 %.1f  peak %.1f\n", sr / n, pct(r2, n, .95), pr
  printf "footprint MB mean %.1f  peak %.1f\n", sm / n, pm
  printf "CPU %%core    mean %.2f  p95 %.2f  peak %.2f\n", sc / n, pct(c2, n, .95), pc
  printf "threads      mean %.1f\n", st / n
  printf "idle wakeups mean %.1f /s\n", sw / n
  for (p in last) printf "  pid %s  %s\n", p, last[p] }' "$T/top" "$T/ps"
