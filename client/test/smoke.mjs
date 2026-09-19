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
  check('boot() populated quality presets', qualityCount === 4, `${qualityCount} options`);

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
