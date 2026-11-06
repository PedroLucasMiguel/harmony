// The menu behind the microphone and headphone buttons: an arrow beside each, and a right-click on the button itself,
// opening the device and the volume -- input for the microphone, output and the master volume for the headphones.
//
// No server: the buttons are in the window's DOM whether or not anyone is signed in, so the page is made to show them
// and the mouse is driven for real (the buttons are disabled outside a call, and a right-click has to get through that).
//
//   node client/test/audio-menu-ui.mjs

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const PORT = 9572;
const { check, summary } = reporter();
const app = launchApp({
  port: PORT,
  userDataDir: mkdtempSync(join(tmpdir(), 'harmony-audio-menu-')),
  extraArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
process.on('exit', () => { try { app.kill(); } catch { /* gone */ } });
const page = await attach(await findPage(PORT));
await sleep(2500);
await page.evaluate('await harmony.settings.set({ micGain: 100, masterVolume: 100, voiceInputId: "", voiceOutputId: "" }); return true;');

// Show the dock the buttons are in (signed out it is hidden), the way it looks signed in.
await page.evaluate(`
  for (let n = document.getElementById('voice-mute'); n && n !== document.body; n = n.parentElement) {
    n.hidden = false;
    if (getComputedStyle(n).display === 'none') n.style.display = 'flex';
  }
  return true;`);

const centre = (id) => page.evaluate(`const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };`);
const mouse = async (type, x, y, button = 'left') => page.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 });
const click = async (id, button = 'left') => {
  const at = await centre(id);
  await mouse('mouseMoved', at.x, at.y);
  await mouse('mousePressed', at.x, at.y, button);
  await mouse('mouseReleased', at.x, at.y, button);
  await sleep(250);
};
const menu = () => page.evaluate(`
  const m = document.getElementById('audio-menu');
  if (m.hidden) return null;
  const r = m.getBoundingClientRect();
  const rows = [...m.querySelectorAll('.audio-menu-device')].map((b) => ({ id: b.dataset.device, name: b.textContent, on: b.getAttribute('aria-checked') === 'true' }));
  const slider = m.querySelector('.audio-menu-volume');
  return { kind: m.dataset.kind, rows, volume: slider && Number(slider.value), max: slider && Number(slider.max), label: m.querySelector('.volume-value')?.textContent,
    box: [r.x, r.y, r.width, r.height], inside: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    titles: [...m.querySelectorAll('.audio-menu-title')].map((n) => n.textContent), settings: Boolean(m.querySelector('.audio-menu-settings')) };`);

// ---- the buttons are as they were, with an arrow beside each
const mute = await centre('voice-mute');
const caret = await centre('voice-mute-menu');
check('an arrow sits right beside the microphone button, and a small one', caret.x > mute.x && caret.x - mute.x < 40 && caret.w < mute.w, `${JSON.stringify(mute)} ${JSON.stringify(caret)}`);
check('and one beside the headphones', (await centre('voice-deafen-menu')).x > (await centre('voice-deafen')).x);
check('the two buttons are disabled outside a call, as they were, and the arrows are not',
  await page.evaluate(`return document.getElementById('voice-mute').disabled && document.getElementById('voice-deafen').disabled && !document.getElementById('voice-mute-menu').disabled && !document.getElementById('voice-deafen-menu').disabled;`));

// ---- the microphone's arrow
await click('voice-mute-menu');
let m = await menu();
check('the microphone arrow opens the input menu', m?.kind === 'input', JSON.stringify(m));
check('it lists the system default first, in words, and the devices there are', m?.rows[0]?.id === '' && m.rows[0].name === 'System default' && m.rows.length >= 2, JSON.stringify(m?.rows));
check('the one in use is marked, and only one', m?.rows.filter((r) => r.on).length === 1 && m.rows[0].on, JSON.stringify(m?.rows));
check('the input volume is the microphone setting, out of 200', m?.volume === 100 && m.max === 200 && m.label === '100%', JSON.stringify(m));
check('it says what its two parts are, and leads on to the voice settings', m?.titles.join('|') === 'Input device|Input volume' && m.settings, JSON.stringify(m?.titles));
check('and it is wholly on screen', m?.inside === true, JSON.stringify(m?.box));
check('the arrow says it is open', await page.evaluate(`return document.getElementById('voice-mute-menu').getAttribute('aria-expanded') === 'true';`));
writeFileSync(join(tmpdir(), 'audio-menu-input.png'), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

// its arrow again closes it
await click('voice-mute-menu');
check('pressing the arrow again closes it', (await menu()) === null);

// picking a device
await click('voice-mute-menu');
m = await menu();
const other = m.rows.find((r) => r.id !== '');
if (other) {
  await page.evaluate(`document.querySelector('#audio-menu .audio-menu-device[data-device="${other.id}"]').click(); return true;`);
  await sleep(600);
  const saved = await page.evaluate('const s = await harmony.settings.get(); return (s.data ?? s).voiceInputId;');
  check('picking a device saves it as the microphone, as the dialog does', saved === other.id, String(saved));
  check('and the dialog\'s own picker follows', await page.evaluate(`return document.getElementById('voice-input').value === ${JSON.stringify(other.id)};`));
  m = await menu();
  check('and the menu stays open with the mark moved', m?.rows.find((r) => r.id === other.id)?.on === true && m.rows[0].on === false, JSON.stringify(m?.rows));
} else check('there is a second microphone to pick', false, 'the fake devices gave only one');

// the volume: moved, and the one in the dialog moves with it
await page.evaluate(`
  const slider = document.querySelector('#audio-menu .audio-menu-volume');
  slider.value = '150';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  return true;`);
await sleep(600);
const gain = await page.evaluate('const s = await harmony.settings.get(); return { saved: (s.data ?? s).micGain, dialog: document.getElementById("mic-gain").value, now: window.__harmonyVoice().micGain };');
check('moving the input volume sets the microphone\'s gain, now and in the settings', gain.saved === 150 && gain.dialog === '150' && Math.abs(gain.now - 1.5) < 1e-9, JSON.stringify(gain));
check('and the number beside it says so', (await menu())?.label?.startsWith('150%'), JSON.stringify((await menu())?.label));

// Escape and a press elsewhere close it
await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(150);
check('Escape closes it', (await menu()) === null);

// ---- the headphones: a right-click on a disabled button
await click('voice-deafen', 'right');
m = await menu();
check('a right-click on the headphones, disabled as it is, opens the output menu', m?.kind === 'output', JSON.stringify(m));
check('with the output devices and the master volume', m?.titles.join('|') === 'Output device|Output volume' && m.volume === 100 && m.max === 200 && m.rows.length >= 1, JSON.stringify(m));
writeFileSync(join(tmpdir(), 'audio-menu-output.png'), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
await page.evaluate(`
  const slider = document.querySelector('#audio-menu .audio-menu-volume');
  slider.value = '60';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  slider.dispatchEvent(new Event('change', { bubbles: true }));
  return true;`);
await sleep(700);
const master = await page.evaluate(`const s = await harmony.settings.get(); const g = await import('./gain.js'); return { saved: (s.data ?? s).masterVolume, dialog: document.getElementById('master-volume').value, now: g.getMasterVolume() };`);
check('moving the output volume is the master volume: now, in the settings, and in the dialog', master.saved === 60 && master.dialog === '60' && Math.abs(master.now - 0.6) < 1e-9, JSON.stringify(master));

// a right-click on the microphone button while the other is open switches to it
await click('voice-mute', 'right');
check('a right-click on the microphone button while the headphones\' menu is open shows the microphone\'s', (await menu())?.kind === 'input');
// a press anywhere else closes it
await mouse('mousePressed', 5, 5);
await mouse('mouseReleased', 5, 5);
await sleep(150);
check('a press elsewhere closes it', (await menu()) === null);

// "Voice settings" opens the dialog
await click('voice-deafen-menu');
await page.evaluate(`document.querySelector('#audio-menu .audio-menu-settings').click(); return true;`);
await sleep(400);
check('"Voice settings" closes the menu and opens the dialog', (await menu()) === null && await page.evaluate(`return document.getElementById('devices').open;`));

// the narrowest window: it still fits
await page.evaluate(`document.getElementById('devices').close(); await harmony.settings.set({ masterVolume: 100, micGain: 100, voiceInputId: '' }); return true;`);
await page.setViewport(380, 700);
await sleep(300);
await click('voice-mute-menu');
m = await menu();
check('on a phone-width window it is still wholly on screen', m?.inside === true, JSON.stringify(m?.box));
await page.clearViewport();

const failed = summary();
setTimeout(() => process.exit(failed ? 1 : 0), 200);
