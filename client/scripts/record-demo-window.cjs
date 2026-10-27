// The window the demo recording shares. Run by record-demo.mjs, never by the app.
//
//   electron scripts/record-demo-window.cjs "<window title>"
//
// It is a plain page that keeps moving -- a clock, bars and a line that never
// sit still -- because a shared window of a static slide would show nothing the
// encoder is there for. Its content is made up for the purpose and says nothing
// about whoever is recording.

const { app, BrowserWindow } = require('electron');

const title = process.argv[2] || 'Release slides';

const page = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { height: 100vh; overflow: hidden; color: #e8ecf7; font: 28px/1.4 "Segoe UI", system-ui, sans-serif;
         background: radial-gradient(1200px 700px at 20% 10%, #243055 0%, #0d1017 60%); padding: 56px 72px; }
  h1 { font-size: 76px; letter-spacing: -2px; }
  h1 small { font-size: 30px; font-weight: 400; color: #8e9bc0; margin-left: 18px; letter-spacing: 0; }
  ul { list-style: none; padding: 0; margin-top: 34px; width: 56%; }
  li { padding: 14px 0; border-bottom: 1px solid #ffffff1a; display: flex; justify-content: space-between; }
  li b { color: #7aa2ff; font-variant-numeric: tabular-nums; }
  canvas { position: absolute; right: 72px; top: 150px; width: 40%; height: 470px;
           background: #ffffff0a; border: 1px solid #ffffff1f; border-radius: 18px; }
  #clock { position: absolute; right: 72px; top: 56px; font-size: 44px; color: #7aa2ff;
           font-variant-numeric: tabular-nums; }
  #bar { position: absolute; left: 72px; bottom: 64px; width: calc(100% - 144px); height: 14px;
         border-radius: 8px; background: #ffffff14; overflow: hidden; }
  #bar i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #5b8cff, #9a7bff); }
</style></head><body>
  <h1>Harmony 3.6.0<small>release walkthrough</small></h1>
  <ul>
    <li>Audio exclusion on every OS <b>done</b></li>
    <li>Tabbed settings <b>done</b></li>
    <li>Drawers close with a swipe <b>done</b></li>
    <li>Text channels remember where you were <b>done</b></li>
    <li>Screen shares up to 120 fps <b id="fps">60 fps</b></li>
  </ul>
  <div id="clock">00:00</div>
  <canvas id="c" width="1000" height="940"></canvas>
  <div id="bar"><i id="fill"></i></div>
<script>
  const c = document.getElementById('c'), g = c.getContext('2d');
  const t0 = performance.now();
  function frame(now) {
    const t = (now - t0) / 1000;
    g.clearRect(0, 0, c.width, c.height);
    for (let i = 0; i < 12; i += 1) {
      const h = 120 + 300 * Math.abs(Math.sin(t * 1.3 + i * 0.55));
      g.fillStyle = 'hsl(' + (215 + i * 7) + ' 85% 62%)';
      g.fillRect(40 + i * 78, c.height - 40 - h, 54, h);
    }
    g.strokeStyle = '#ffffffcc'; g.lineWidth = 5; g.beginPath();
    for (let x = 0; x <= c.width; x += 10) {
      const y = 190 + Math.sin(x / 90 + t * 2.4) * 70 + Math.sin(x / 31 + t * 5) * 18;
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    const s = Math.floor(t);
    document.getElementById('clock').textContent =
      String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    document.getElementById('fill').style.width = ((t * 9) % 100) + '%';
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
</script></body></html>`;

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280, height: 720, x: 120, y: 120, title, show: true, backgroundColor: '#0d1017',
    webPreferences: { backgroundThrottling: false },
  });
  win.setTitle(title);
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  win.on('page-title-updated', (event) => event.preventDefault());
});

app.on('window-all-closed', () => app.quit());
