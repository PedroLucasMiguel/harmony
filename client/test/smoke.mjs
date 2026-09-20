// Smoke test: launch the app and drive its renderer over the DevTools Protocol.
//
// Covers the parts that only break at runtime and that unit tests cannot reach
// -- the custom protocol handler, ES module loading, the preload bridge,
// desktopCapturer, and the main-process HTTP layer. No server needed.
//
//   node client/test/smoke.mjs
//   HARMONY_BIN=dist/win-unpacked/Harmony.exe node client/test/smoke.mjs
//
// The second form checks a packaged build, where asar can break native module
// loading and the custom protocol.

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const PORT = 9333;
const { check, summary } = reporter();

let stderr = '';
const child = launchApp({ port: PORT, onStderr: (s) => (stderr += s) });

async function run() {
  const page = await findPage(PORT);
  const cdp = await attach(page);

  // Give boot() a moment to populate the UI.
  await sleep(1500);

  check('page served over the custom protocol', page.url.startsWith('harmony://app/'), page.url);

  const bridge = await cdp.evaluate('return typeof window.harmony;');
  check('preload bridge is exposed', bridge === 'object', `typeof harmony = ${bridge}`);

  const secure = await cdp.evaluate('return window.isSecureContext;');
  check('renderer is a secure context', secure === true, 'required by getDisplayMedia');

  const view = await cdp.evaluate("return document.querySelector('.view[data-active]')?.id;");
  check('opens on the connect view', view === 'view-connect', view);

  const qualityCount = await cdp.evaluate("return document.getElementById('quality').options.length;");
  check('boot() populated quality presets', qualityCount === 5, `${qualityCount} options`);

  const modulesOk = await cdp.evaluate(
    "return typeof (await import('./webrtc.js')).publish === 'function';",
  );
  check('ES modules load over the custom protocol', modulesOk === true);

  // From here on, go through the renderer's own bridge module -- the exact path
  // the app uses, including its error rebuilding.
  const B = "const { harmony } = await import('./bridge.js');";

  const audio = await cdp.evaluate(`${B} return await harmony.audio.availability();`);
  check(
    'native audio module reports a status',
    audio && typeof audio.available === 'boolean',
    audio?.available ? 'per-application audio AVAILABLE' : `unavailable: ${audio?.reason}`,
  );

  const sources = await cdp.evaluate(
    `${B} const s = await harmony.sources.list(); return { n: s.length, kinds: [...new Set(s.map(x => x.kind))], hasThumb: s.some(x => !!x.thumbnail) };`,
  );
  check(
    'desktopCapturer enumerates sources',
    sources.n > 0,
    `${sources.n} sources (${sources.kinds.join(', ')})`,
  );
  check('sources carry thumbnails', sources.hasThumb === true);

  // The MP4 muxer is served out of node_modules through the `vendor/` route,
  // which is exactly the sort of thing asar packaging breaks.
  const clipModule = await cdp.evaluate(
    "try { const m = await import('./clip-buffer.js'); return 'ok:' + m.CLIP_SECONDS; } catch (e) { return e.message; }",
  );
  check('clip buffer and its muxer load', clipModule === 'ok:30', clipModule);

  // The source picker's tiles are plain <button>s. `font: inherit` does not
  // carry colour, so they fell back to the UA's ButtonText -- black on a
  // charcoal card, and barely readable. Build the same DOM the picker builds
  // and read what the stylesheet actually resolves to.
  const labelColour = await cdp.evaluate(`
    const btn = document.createElement('button');
    btn.className = 'source';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Screen 1 · 2560x1440';
    meta.append(label); btn.append(meta);
    document.getElementById('source-grid').append(btn);
    const rgb = getComputedStyle(label).color.match(/\\d+/g).map(Number);
    btn.remove();
    // Relative luminance, the same measure WCAG contrast is built on.
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    return { rgb, lum: +lum.toFixed(3) };
  `);
  check(
    'source labels are legible on the dark card',
    labelColour.lum > 0.5,
    `rgb(${labelColour.rgb.join(',')}), luminance ${labelColour.lum}`,
  );

  // The connect form has to fit the REAL window, with every optional field
  // showing. Checking this at an emulated 1180x800 passed while the actual app
  // clipped its buttons, because the window is 1180x800 *outside* -- the title
  // bar takes ~39px and the page only gets 761. So measure the window the app
  // actually opens, with no viewport override in play.
  const natural = await cdp.evaluate(`
    document.getElementById('password-field').hidden = false;
    document.getElementById('gpu-preference-field').hidden = false;
    document.querySelector('.options').open = false;
    await new Promise(r => setTimeout(r, 250));
    const card = document.querySelector('.connect-card');
    const inView = (id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    };
    return {
      size: window.innerWidth + 'x' + window.innerHeight,
      cardScrolls: card.scrollHeight > card.clientHeight + 2,
      formHeight: Math.round(card.scrollHeight),
      available: card.clientHeight,
      continueVisible: inView('continue'),
      testVisible: inView('test-connection'),
    };
  `);
  check(
    'the connect form fits the real window without scrolling',
    !natural.cardScrolls && natural.continueVisible && natural.testVisible,
    `${natural.formHeight}px of form in ${natural.available}px at ${natural.size}` +
      (natural.cardScrolls ? ' — SCROLLS' : '') +
      (natural.testVisible ? '' : ', "Test my connection" CLIPPED'),
  );

  // The live list used to grow the page instead of scrolling itself, pushing
  // the username box off the top of the window. Assert the behaviour rather
  // than the mechanism: fill it with more people than could ever fit, and check
  // the page itself still does not scroll -- at a wide window, where the list
  // sits beside the form, and a narrow one, where it drops underneath.
  const crowd = async (w, h) => {
    await cdp.setViewport(w, h);
    await sleep(500);
    return cdp.evaluate(`
      const list = document.getElementById('live-list');
      const ul = document.getElementById('live-items');
      list.hidden = false;
      ul.replaceChildren(...Array.from({ length: 30 }, (_, i) => {
        const li = document.createElement('li');
        const who = document.createElement('span'); who.className = 'who'; who.textContent = 'person' + i;
        li.append(who); return li;
      }));
      await new Promise(r => setTimeout(r, 250));
      const form = document.getElementById('username').getBoundingClientRect();
      return {
        pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 2,
        listScrolls: ul.scrollHeight > ul.clientHeight + 2,
        usernameVisible: form.top >= 0 && form.bottom <= window.innerHeight,
        beside: list.getBoundingClientRect().left > form.right,
      };
    `);
  };

  for (const [w, h, label] of [[1180, 800, 'default'], [760, 620, 'narrow']]) {
    const r = await crowd(w, h);
    check(
      `30 live users do not push the form off screen at ${w}x${h} (${label})`,
      !r.pageScrolls && r.listScrolls && r.usernameVisible,
      `${r.beside ? 'list beside the form' : 'list below the form'}, ` +
        `list scrolls: ${r.listScrolls}, page scrolls: ${r.pageScrolls}, username visible: ${r.usernameVisible}`,
    );
  }
  await cdp.clearViewport();
  await sleep(400);
  await cdp.evaluate(
    "document.getElementById('live-items').replaceChildren(); document.getElementById('live-list').hidden = true; return true;",
  );

  // The field must follow the server, not a fixed default: shown when the
  // configured server says it wants a password, hidden when it does not. This
  // machine may or may not have a server saved, so assert the relationship
  // rather than a particular outcome.
  const passwordUi = await cdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    const server = document.getElementById('server-url').value.trim();
    let required = null;
    if (server) {
      try { required = Boolean((await harmony.api.health(server)).passwordRequired); }
      catch { required = null; }  // unreachable: the field should be left alone
    } else {
      required = false;
    }
    return {
      hasField: !!document.getElementById('server-password'),
      hidden: document.getElementById('password-field').hidden,
      required,
      canSet: typeof harmony.api.setPassword === 'function',
      server: server || '(none configured)',
    };
  `);
  check(
    'the password field follows what the server asks for',
    passwordUi.hasField &&
      passwordUi.canSet &&
      (passwordUi.required === null || passwordUi.hidden === !passwordUi.required),
    passwordUi.required === null
      ? `${passwordUi.server} unreachable, field left as-is`
      : `${passwordUi.server} ${passwordUi.required ? 'requires a password -> field shown' : 'is open -> field hidden'}`,
  );

  // Hardware H.264 encoding (NVENC / AMF / Quick Sync) is Chromium's default on
  // Windows -- there is no vendor SDK to wire up. What matters is that the app
  // reports the capability honestly and never leaves the user stuck: when no GPU
  // encoder exists, software H.264 still has to work.
  const gpuStatus = await cdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    const s = await harmony.gpu.status();
    return { ...s, note: document.getElementById('hw-encoding-note').textContent.slice(0, 80),
             checked: document.getElementById('hw-encoding').checked };
  `);
  check(
    'GPU encode capability is reported',
    typeof gpuStatus.encodeAccelerated === 'boolean' && gpuStatus.videoEncode !== 'unknown',
    `video_encode=${gpuStatus.videoEncode}, video_decode=${gpuStatus.videoDecode}, preference=${gpuStatus.preference}`,
  );
  check(
    'the encoder toggle matches the saved preference',
    gpuStatus.checked === (gpuStatus.preference !== 'off'),
    `checkbox=${gpuStatus.checked}, preference=${gpuStatus.preference}`,
  );

  // The bug this exists to catch: boot() asks about the GPU ~66ms in, but the
  // GPU process does not report for ~300ms, so a one-shot read returns
  // "disabled_software" and the UI claimed "no GPU encoder" for the whole
  // session on a machine that was encoding on its GPU throughout. Compare what
  // is on screen against a reading taken now, long after things have settled.
  const settled = await cdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    const fresh = await harmony.gpu.status();
    const note = document.getElementById('hw-encoding-note').textContent;
    return {
      fresh: fresh.videoEncode,
      accelerated: fresh.encodeAccelerated,
      preference: fresh.preference,
      claimsNoEncoder: /No GPU encoder available/i.test(note),
    };
  `);
  check(
    'the UI does not claim "no GPU encoder" on a machine that has one',
    !(settled.accelerated && settled.claimsNoEncoder),
    settled.accelerated
      ? `video_encode=${settled.fresh}, and the connect screen agrees`
      : `no hardware encoder here (video_encode=${settled.fresh}) — nothing to disagree about`,
  );

  // H.264 must be offered whatever the GPU situation is -- it is the only codec
  // the server and every viewer agree on, and the software encoder is the
  // fallback when hardware is unavailable or turned off.
  const h264 = await cdp.evaluate(`
    const caps = RTCRtpSender.getCapabilities('video');
    const send = caps.codecs.filter(c => c.mimeType === 'video/H264');
    const recv = RTCRtpReceiver.getCapabilities('video').codecs.filter(c => c.mimeType === 'video/H264');
    return { send: send.length, recv: recv.length, profiles: [...new Set(send.map(c => c.sdpFmtpLine?.match(/profile-level-id=([0-9a-f]+)/i)?.[1]).filter(Boolean))] };
  `);
  check(
    'H.264 is available to both send and receive',
    h264.send > 0 && h264.recv > 0,
    `${h264.send} send / ${h264.recv} receive profiles (${h264.profiles.join(', ')})`,
  );

  const worklet = await cdp.evaluate(
    "const c = new AudioContext({ sampleRate: 48000 }); try { await c.audioWorklet.addModule('pcm-worklet.js'); return 'ok'; } catch (e) { return e.message; } finally { c.close(); }",
  );
  check('AudioWorklet module loads', worklet === 'ok', worklet);

  // A server that cannot exist. This proves the failure arrives as a real Error
  // carrying its `code` -- the UI switches on that code to tell "not live yet,
  // keep waiting" apart from "actually broken".
  const unreachable = await cdp.evaluate(
    `${B} try { await harmony.api.session('http://127.0.0.1:1', 'tester'); return 'unexpected success'; } catch (e) { return \`\${e.constructor.name}:\${e.code}\`; }`,
  );
  check(
    'HTTP errors reach the renderer as Errors with a code',
    unreachable === 'Error:unreachable',
    unreachable,
  );

  const badServer = await cdp.evaluate(
    `${B} try { await harmony.api.streams(''); return 'unexpected success'; } catch (e) { return e.code; }`,
  );
  check('empty server address is rejected', badServer === 'no_server', badServer);

  cdp.close();
}

run()
  .catch((err) => check('smoke run completed', false, err.message))
  .finally(async () => {
    child.kill();
    await sleep(500);
    const failed = summary();
    if (failed && stderr.trim()) console.error(`\n--- app stderr ---\n${stderr}`);
    process.exit(failed ? 1 : 0);
  });
