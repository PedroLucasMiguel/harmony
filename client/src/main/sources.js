// Enumerating what the user can share, and working out which process owns a
// window so its audio can be captured on its own.

const { desktopCapturer, screen } = require('electron');
const { execFile } = require('node:child_process');

const THUMB = { width: 320, height: 180 };

async function list() {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: THUMB,
    fetchWindowIcons: true,
  });

  const displays = screen.getAllDisplays();

  return sources
    // Windows with no title are usually invisible shells and cannot be shared
    // usefully; hide them rather than letting the user pick a black rectangle.
    .filter((s) => s.name && s.name.trim() !== '')
    .map((s) => {
      const isScreen = s.id.startsWith('screen:');
      const display = isScreen ? displays.find((d) => String(d.id) === s.display_id) : null;
      return {
        id: s.id,
        name: s.name,
        kind: isScreen ? 'screen' : 'window',
        thumbnail: s.thumbnail?.isEmpty() ? null : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
        resolution: display ? `${display.size.width}×${display.size.height}` : null,
      };
    })
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'screen' ? -1 : 1));
}

/**
 * Map an Electron window source to the PID that owns it.
 *
 * Electron encodes the native window handle in the source id ("window:<hwnd>:0")
 * but offers no way to resolve it to a process, so we ask Windows directly --
 * one short-lived PowerShell call, only when a window share starts.
 *
 * The handle is resolved through GetWindowThreadProcessId rather than by
 * matching Process.MainWindowHandle. MainWindowHandle only names a process's
 * *primary* window, so anything with several windows -- a browser above all --
 * simply would not match, and per-application audio silently fell back to none.
 *
 * Title matching stays as a fallback for the case where the id is not a handle.
 */
function resolveWindowPid(sourceId, sourceName) {
  if (process.platform !== 'win32') return Promise.resolve(null);

  const handle = String(sourceId).split(':')[1] ?? '';

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Harmony -Name Win -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)]
public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
[DllImport("user32.dll")]
public static extern bool IsWindow(IntPtr hWnd);
'@
$out = @{ pid = 0; name = '' }
$h = [IntPtr]::new([int64]'${handle}')
if ($h -ne [IntPtr]::Zero -and [Harmony.Win]::IsWindow($h)) {
  $p = 0
  [void][Harmony.Win]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -gt 0) { $out.pid = $p }
}
if ($out.pid -eq 0) {
  $m = Get-Process | Where-Object { $_.MainWindowTitle -eq ${JSON.stringify(sourceName ?? '')} } | Select-Object -First 1
  if ($m) { $out.pid = $m.Id }
}
if ($out.pid -gt 0) {
  $proc = Get-Process -Id $out.pid -ErrorAction SilentlyContinue
  if ($proc) { $out.name = $proc.ProcessName }
}
$out | ConvertTo-Json -Compress
`;

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          console.warn('[sources] PID lookup failed:', (stderr || err.message).trim().split('\n')[0]);
          return resolve(null);
        }
        try {
          const { pid, name } = JSON.parse(stdout);
          if (pid > 0) console.log(`[sources] "${sourceName}" -> pid ${pid} (${name})`);
          return resolve(pid > 0 ? pid : null);
        } catch {
          return resolve(null);
        }
      },
    );
  });
}

/**
 * Processes the user could plausibly want excluded from a screen share's audio.
 *
 * Windows has no cheap way to ask "who is making sound right now" without the
 * audio session APIs, which the capture addon does not expose. Listing
 * processes that own a visible window is a good proxy: Discord, TeamSpeak,
 * browsers and games all qualify, while service noise does not.
 */
function listProcesses() {
  if (process.platform !== 'win32') return Promise.resolve([]);

  const script = `
Get-Process |
  Where-Object { $_.MainWindowTitle -ne '' } |
  Select-Object Id, ProcessName, MainWindowTitle |
  ConvertTo-Json -Compress
`;

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        let rows;
        try {
          rows = JSON.parse(stdout);
        } catch {
          return resolve([]);
        }
        if (!Array.isArray(rows)) rows = [rows];

        // One entry per process, not per window.
        const byPid = new Map();
        for (const row of rows) {
          if (!byPid.has(row.Id)) {
            byPid.set(row.Id, {
              pid: row.Id,
              name: row.ProcessName,
              title: row.MainWindowTitle,
            });
          }
        }
        resolve([...byPid.values()].sort((a, b) => a.name.localeCompare(b.name)));
      },
    );
  });
}

module.exports = { list, resolveWindowPid, listProcesses };
