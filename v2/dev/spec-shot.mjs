// Screenshot of the Electron client's current screen at a fixed size and scale: the reference every v2 screen is matched to.
//
//   node v2/dev/spec-shot.mjs out.png [--theme midnight] [--steps "js to run first"] [--settings '{"servers":[...]}']
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, sleep } from '../../client/test/cdp.mjs';

const [out = 'spec.png', ...rest] = process.argv.slice(2);
const option = (name, fallback) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback);
const theme = option('--theme', 'midnight');
const steps = option('--steps', '');
const width = Number(option('--width', 1180));
const height = Number(option('--height', 800));
const scale = Number(option('--scale', 2));

const port = Number(option('--port', 9600 + Math.floor(Math.random() * 300)));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-spec-'));
if (option('--settings', '')) writeFileSync(join(userDataDir, 'settings.json'), option('--settings', ''));
const app = launchApp({ port, userDataDir });
process.on('exit', () => { try { app.kill(); } catch { /* gone */ } });

const page = await attach(await findPage(port));
await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
await sleep(2500);
await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true;`);
if (steps) await page.evaluate(steps);
await sleep(800);
const shot = await page.send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
process.exit(0);
