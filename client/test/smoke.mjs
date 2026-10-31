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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const PORT = 9333;
const { check, summary } = reporter();

let stderr = '';
/**
 * A throwaway profile, so the suite never sees the developer's real settings.
 *
 * Without this the app boots with whatever server address, password and
 * session token happen to be saved on this machine, reaches that server, and
 * the connect screen configures itself from the answer. Several checks here
 * assert what the screen looks like with NO server -- they passed for as long
 * as the saved server happened to have no accounts, and started failing the
 * moment it did. A test that depends on the state of someone's home server is
 * not testing the thing it claims to.
 */
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-smoke-'));
const child = launchApp({ port: PORT, userDataDir, onStderr: (s) => (stderr += s) });

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

  const presetCount = await cdp.evaluate(`
    return document.querySelectorAll('#resolution button').length
      + document.querySelectorAll('#framerate button').length;
  `);
  check('boot() populated resolutions and frame rates', presetCount === 8, `${presetCount} buttons`);
  const rates = await cdp.evaluate("return [...document.querySelectorAll('#framerate button')].map((b) => b.textContent.trim());");
  check('a live can be set to the screen\'s own frame rate, as Native', rates.join(',') === '30 fps,60 fps,120 fps,Native', rates.join(','));

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
    // Reveal every optional field to measure the worst case, then put the DOM
    // back exactly as it was. Leaving it mutated made a later check read a
    // password field this one had opened -- which looked fine for as long as
    // the machine happened to have a password-protected server saved, and
    // failed the moment the suite got its own empty profile.
    //
    // The two password fields are no longer in this list: they are always
    // on screen now, so the worst case already includes them.
    const was = {
      confirm: document.getElementById('account-confirm-field').hidden,
      owner: document.getElementById('owner-key-field').hidden,
      gpu: document.getElementById('gpu-preference-field').hidden,
      options: document.querySelector('.options').open,
    };
    document.getElementById('account-confirm-field').hidden = false;
    document.getElementById('owner-key-field').hidden = false;
    document.getElementById('gpu-preference-field').hidden = false;
    document.querySelector('.options').open = false;
    await new Promise(r => setTimeout(r, 250));
    const card = document.querySelector('.connect-card');
    const inView = (id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    };
    const result = {
      size: window.innerWidth + 'x' + window.innerHeight,
      cardScrolls: card.scrollHeight > card.clientHeight + 2,
      formHeight: Math.round(card.scrollHeight),
      available: card.clientHeight,
      continueVisible: inView('continue'),
    };
    document.getElementById('account-confirm-field').hidden = was.confirm;
    document.getElementById('owner-key-field').hidden = was.owner;
    document.getElementById('gpu-preference-field').hidden = was.gpu;
    document.querySelector('.options').open = was.options;
    return result;
  `);
  check(
    'the connect form fits the real window without scrolling',
    !natural.cardScrolls && natural.continueVisible,
    `${natural.formHeight}px of form in ${natural.available}px at ${natural.size}` +
      (natural.cardScrolls ? ' — SCROLLS' : '') +
      (natural.continueVisible ? '' : ', Connect CLIPPED'),
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
      // Always on screen now. What the probe changes is the LABEL, not
      // whether the box exists -- a field that appears a second after the
      // window opens rearranges the form under the cursor, and one that is
      // not there yet is one people assume is not wanted.
      hidden: document.getElementById('password-field').hidden,
      label: document.querySelector('#password-field span').textContent,
      required,
      canSet: typeof harmony.api.setPassword === 'function',
      server: server || '(none configured)',
    };
  `);
  /*
   * With no server configured the label makes no claim either way, and that
   * is the point rather than a gap in the check: nothing has been asked, so
   * "(not needed)" would be a guess printed as a fact. The suffix is only
   * required to track the answer once there IS an answer.
   */
  const labelFits = passwordUi.server === '(none configured)'
    ? !passwordUi.label.includes('not needed')
    : passwordUi.required === null
      || passwordUi.label.includes('not needed') === !passwordUi.required;
  check(
    'the server password box is always there, and says whether it is needed',
    passwordUi.hasField && passwordUi.canSet && passwordUi.hidden === false && labelFits,
    passwordUi.required === null
      ? `${passwordUi.server} unreachable, label left as-is: "${passwordUi.label}"`
      : `${passwordUi.server} -> "${passwordUi.label}"`,
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

  // The preview is the most expensive thing the app draws, and the whole reason
  // it is affordable is that a cloned track takes its own downscale and frame
  // rate while the published one stays at full resolution. That is a Chromium
  // behaviour, not ours, so pin it: if a future Electron stops honouring it the
  // preview silently goes back to costing a game 20-30 fps.
  const copy = await cdp.evaluate(`
    ${B}
    const sources = await harmony.sources.list();
    await harmony.sources.select(sources.find((s) => s.kind === 'screen').id, { loopbackAudio: false });
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60, max: 60 } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    const clone = track.clone();
    await clone.applyConstraints({ width: { max: 960 }, height: { max: 540 }, frameRate: { max: 10 } });
    const result = { source: track.getSettings(), preview: clone.getSettings() };
    clone.stop();
    track.stop();
    return result;
  `);
  check(
    'a cloned capture track downscales without touching the original',
    copy.preview.height <= 540 &&
      copy.preview.frameRate <= 10 &&
      copy.source.height > copy.preview.height,
    `source ${copy.source.width}x${copy.source.height}@${copy.source.frameRate} -> ` +
      `preview ${copy.preview.width}x${copy.preview.height}@${copy.preview.frameRate}`,
  );

  // The single most expensive bug this app has had: Chromium offers H.264
  // constrained baseline first, no NVIDIA encoder or decoder accepts baseline,
  // and so every call ran on the CPU while the UI said "GPU encode". Pin the
  // ordering that fixed it -- and pin that baseline is still offered, because a
  // machine with no hardware encoder can only speak baseline and must still be
  // able to publish.
  const codecs = await cdp.evaluate(`
    const { preferCodec } = await import('./webrtc.js');
    const pc = new RTCPeerConnection();
    const tx = pc.addTransceiver('video', { direction: 'sendonly' });
    // What preferCodec actually handed to setCodecPreferences, which is the
    // thing under test -- the offer SDP renegotiates the level separately.
    const preferred = preferCodec(tx, 'H264') ?? [];
    const offer = await pc.createOffer();
    pc.close();
    return {
      preferred: preferred
        .filter((c) => /H264/i.test(c.mimeType))
        .map((c) => /profile-level-id=([0-9a-fA-F]{6})/.exec(c.sdpFmtpLine ?? '')?.[1] ?? '?'),
      offered: [...offer.sdp.matchAll(/profile-level-id=([0-9a-fA-F]{6})/g)].map((m) => m[1]),
    };
  `);
  const { preferred } = codecs;
  check(
    'H.264 prefers High profile over baseline, and still offers baseline',
    preferred[0]?.slice(0, 2).toLowerCase() === '64' &&
      preferred.some((p) => p.startsWith('42')),
    `preference order: ${preferred.join(', ')}`,
  );
  // High at level 3.1 caps around 720p30, so taking the first High on
  // Chromium's own list would quietly cap a native-resolution stream.
  const highs = preferred.filter((p) => p.slice(0, 2).toLowerCase() === '64');
  check(
    'the first H.264 choice is the highest level of the best profile',
    parseInt(preferred[0].slice(4), 16) === Math.max(...highs.map((p) => parseInt(p.slice(4), 16))),
    `chose ${preferred[0]} from High profiles ${highs.join(', ')}`,
  );
  check(
    'the negotiated offer leads with High profile',
    codecs.offered[0]?.slice(0, 2).toLowerCase() === '64',
    `offer order: ${codecs.offered.join(', ')}`,
  );

  // Amplification past 100% only works because the element is muted and a gain
  // node does the playing. If the element ever comes back unmuted the sound
  // doubles, and if the slider ceiling drops back to 100 the feature is gone.
  const gainSetup = await cdp.evaluate(`
    const { MAX_GAIN, asPercent, createSink } = await import('./gain.js');
    // A real stream, so createSink exercises the same path a viewer does.
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = new AudioContext();
    const dst = ctx.createMediaStreamDestination();
    ctx.createOscillator().connect(dst);
    const sink = createSink(dst.stream);
    sink.set(3.2);
    const clamped = (sink.set(99), sink.value);
    sink.close();
    ctx.close();
    return {
      max: MAX_GAIN,
      watchSlider: Number(document.getElementById('volume').max),
      masterSlider: Number(document.getElementById('mosaic-volume').max),
      set: sink.value,
      clamped,
      asPercent: asPercent(MAX_GAIN),
    };
  `);
  check(
    'volume goes to 350% and clamps there',
    gainSetup.watchSlider === 350 && gainSetup.masterSlider === 350 && gainSetup.clamped === 3.5,
    `sliders max ${gainSetup.watchSlider}/${gainSetup.masterSlider}, gain clamps at ${gainSetup.clamped}`,
  );

  // Fullscreen hides the chrome; the pointer reaching the bottom brings it
  // back. Drive the same mousemove the app listens for, with a faked
  // fullscreenElement, since real fullscreen needs a user gesture.
  const hud = await cdp.evaluate(`
    const view = document.getElementById('view-watch');
    const rect = { bottom: 800, height: 800 };
    // The handler reads document.fullscreenElement; stand one in.
    Object.defineProperty(document, 'fullscreenElement', { value: view, configurable: true });
    view.getBoundingClientRect = () => rect;

    const at = (y) => document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: y }));

    at(100);
    const middle = view.classList.contains('hud-visible');
    at(780);
    const bottom = view.classList.contains('hud-visible');
    at(100);
    const away = view.classList.contains('hud-visible');
    view.classList.remove('hud-visible');
    return { middle, bottom, away };
  `);
  check(
    'fullscreen controls appear only near the bottom edge',
    hud.middle === false && hud.bottom === true && hud.away === false,
    `middle=${hud.middle} bottom=${hud.bottom} back-to-middle=${hud.away}`,
  );

  // The dual-GPU warning is now the only thing telling a user about the
  // cross-adapter trap, which costs about 10% of the machine and cannot be
  // fixed from inside the app. If it stops appearing, nobody finds out.
  const warning = await cdp.evaluate(`
    ${B}
    const gpu = await harmony.gpu.status();
    return {
      adapters: (gpu.adapters ?? []).map((a) => a.vendor),
      shown: !document.getElementById('gpu-hint').hidden,
      text: document.getElementById('gpu-hint-text').textContent,
    };
  `);
  if (warning.adapters.length > 1) {
    check(
      'the dual-GPU warning appears on a machine with two GPUs',
      warning.shown === true && /wired|MUX|Optimus/i.test(warning.text),
      `${warning.adapters.join(' + ')} -> ${warning.shown ? 'shown' : 'MISSING'}`,
    );
  } else {
    check(
      'the dual-GPU warning stays hidden on a single-GPU machine',
      warning.shown === false,
      `${warning.adapters.join(', ') || 'one adapter'} -> hidden`,
    );
  }

  // Losing focus must NOT stop the preview. It used to, and a picture that
  // blanks itself whenever you click elsewhere reads as a broken stream.
  const focus = await cdp.evaluate(`
    window.dispatchEvent(new Event('blur'));
    await new Promise((r) => setTimeout(r, 300));
    return {
      panelShown: !document.getElementById('preview-off').hidden,
      title: document.getElementById('preview-off-title').textContent,
    };
  `);
  check(
    'losing focus does not pause the preview',
    focus.panelShown === false,
    focus.panelShown ? `panel appeared saying "${focus.title}"` : 'preview left alone',
  );

  // ---------------------------------------------------------------------
  // Accounts (Phase 1)
  //
  // The account fields are ALWAYS on screen now -- a form that rearranges
  // itself a second after the window opens is worse than a box somebody
  // fills in for nothing. What must not regress is the MODE: against a
  // server with no account system (every 0.1.0 deployment, and what the
  // app shows before reaching any server) nothing may claim an account is
  // required, and the typed password must be ignored rather than sent.
  // ---------------------------------------------------------------------
  const accountsHidden = await cdp.evaluate(`
    return {
      hidden: document.getElementById('account-fields').hidden,
      mode: document.body.dataset.authMode,
      button: document.getElementById('continue').textContent,
      hint: document.getElementById('username-hint').textContent,
      signUp: document.getElementById('auth-mode-toggle').textContent,
    };
  `);
  check(
    'a server with no accounts is in no auth mode, and asks for nothing',
    accountsHidden.hidden === false && accountsHidden.mode === 'none',
    `hidden=${accountsHidden.hidden} mode=${accountsHidden.mode} button="${accountsHidden.button}"`,
  );
  // The way to make an account cannot be behind having one already.
  check(
    'the sign-up link is offered before any server has been reached',
    accountsHidden.signUp.length > 0,
    `"${accountsHidden.signUp}"`,
  );
  check(
    'the original single-box hint is unchanged without accounts',
    /Free name/.test(accountsHidden.hint),
    accountsHidden.hint.slice(0, 60),
  );

  // Registering and signing in are different forms, because the server
  // deliberately will not say whether a nickname exists -- so the user has to
  // choose, and the choice has to be visible.
  const toggled = await cdp.evaluate(`
    const before = {
      confirm: document.getElementById('account-confirm-field').hidden,
      label: document.getElementById('account-password-label').textContent,
      button: document.getElementById('continue').textContent,
    };
    document.getElementById('auth-mode-toggle').click();
    const after = {
      confirm: document.getElementById('account-confirm-field').hidden,
      label: document.getElementById('account-password-label').textContent,
      button: document.getElementById('continue').textContent,
      toggle: document.getElementById('auth-mode-toggle').textContent,
    };
    document.getElementById('auth-mode-toggle').click();
    return { before, after };
  `);
  check(
    'switching to register asks for a confirmation and renames the action',
    toggled.before.confirm === true
      && toggled.after.confirm === false
      && /Create account/.test(toggled.after.button)
      && /Choose/.test(toggled.after.label),
    `"${toggled.before.button}"/${toggled.before.label} -> "${toggled.after.button}"/${toggled.after.label}`,
  );

  // The owner key is only meaningful while registering on a server that has no
  // owner. Showing it the rest of the time invites people to hunt for a key
  // that does not exist.
  const ownerKey = await cdp.evaluate(`
    const field = document.getElementById('owner-key-field');
    const toggle = document.getElementById('auth-mode-toggle');
    toggle.click();                       // -> register, but needsOwner is false
    const registeringWithoutOwnerNeeded = field.hidden;
    toggle.click();                       // back to login
    return { registeringWithoutOwnerNeeded, loginMode: field.hidden };
  `);
  check(
    'the owner key box stays hidden unless the server actually needs an owner',
    ownerKey.registeringWithoutOwnerNeeded === true && ownerKey.loginMode === true,
    `register=${ownerKey.registeringWithoutOwnerNeeded} login=${ownerKey.loginMode}`,
  );

  // "Stay signed in" keeps a session token, never the password. Unticking it
  // has to forget what is already stored, or the setting only points one way.
  const remember = await cdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    const box = document.getElementById('remember-account');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 150));
    const on = await harmony.settings.get();
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 150));
    const off = await harmony.settings.get();
    return {
      onRemember: on.rememberAccount,
      offRemember: off.rememberAccount,
      offToken: off.sessionToken,
      storesPassword: Object.prototype.hasOwnProperty.call(off, 'accountPassword'),
    };
  `);
  check(
    'unticking "stay signed in" forgets the stored token',
    remember.onRemember === true && remember.offRemember === false && !remember.offToken,
    `on=${remember.onRemember} off=${remember.offRemember} token=${JSON.stringify(remember.offToken)}`,
  );
  check(
    'the account password is never written to settings',
    remember.storesPassword === false,
    'only the revocable session token is persisted',
  );

  // ---------------------------------------------------------------------
  // The bridge surface
  //
  // bridge.js re-declares every preload method by hand so it can wrap each one
  // in lift(). That means a method added to the preload and forgotten in
  // bridge.js is simply `undefined` at runtime, with no error until something
  // calls it -- which is exactly what happened to the whole accounts API: it
  // shipped, passed every test, and would have thrown the first time a real
  // user pressed Continue against a server with accounts.
  // ---------------------------------------------------------------------
  const surface = await cdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    const missing = [];
    const check = (groupName, rawGroup, liftedGroup) => {
      for (const key of Object.keys(rawGroup ?? {})) {
        if (typeof liftedGroup?.[key] !== 'function') missing.push(groupName + '.' + key);
      }
    };
    check('api', window.harmony.api, harmony.api);
    check('realtime', window.harmony.realtime, harmony.realtime);
    check('settings', window.harmony.settings, harmony.settings);
    check('sources', window.harmony.sources, harmony.sources);
    check('audio', window.harmony.audio, harmony.audio);
    check('clips', window.harmony.clips, harmony.clips);
    return {
      missing,
      apiCount: Object.keys(window.harmony.api).length,
    };
  `);
  check(
    'every preload method is exposed through bridge.js',
    surface.missing.length === 0,
    surface.missing.length
      ? `missing from bridge.js: ${surface.missing.join(', ')}`
      : `${surface.apiCount} api methods, all lifted`,
  );

  // The voice session is the one piece of Phase 2 that can be exercised with
  // no server at all: muting is a local track operation by design, so that it
  // never costs a renegotiation.
  const voice = await cdp.evaluate(`
    const { VoiceSession } = await import('./voice.js');
    const session = new VoiceSession();
    session.configure({ channelId: 1, mid: 7, token: 'tok en', whepBase: 'http://s:8889' });
    const url = session.peerUrl(3);
    const muted = session.setMuted(true);
    const unmuted = session.setMuted(false);
    const deafened = session.setDeafened(true);
    return { url, muted, unmuted, deafened, mid: session.mid };
  `);
  check(
    'a voice peer URL is built from the channel path and token',
    voice.url === 'http://s:8889/vc-1-3-v/whep?token=tok%20en',
    voice.url,
  );
  check(
    'mic mute and deafen are local toggles, needing no connection',
    voice.muted === true && voice.unmuted === false && voice.deafened === true,
    `mute ${voice.muted}/${voice.unmuted}, deafen ${voice.deafened}`,
  );

  // Channel video: the camera and screen paths a member publishes into, and
  // the subscriptions that make them other people's tiles. Nothing here needs
  // a server -- it is URL construction and bookkeeping, which is exactly the
  // part that was missing rather than broken.
  const channelVideo = await cdp.evaluate(`
    const { VoiceSession } = await import('./voice.js');
    const session = new VoiceSession();
    session.configure({
      channelId: 1, mid: 7, token: 'tok', whepBase: 'http://s:8889',
      publish: { voice: 'w/v', cam: 'w/c', screen: 'w/s' },
    });
    session.lastRoster = [
      { mid: 7, nickname: 'me', publishing: ['v', 'c'] },
      { mid: 3, nickname: 'them', publishing: ['v', 'c', 's'] },
      { mid: 4, nickname: 'quiet', publishing: ['v'] },
    ];
    return {
      cam: session.peerUrl(3, 'c'),
      screen: session.peerUrl(3, 's'),
      publishCam: session.publishUrls.cam,
      missing: session.hasMissingVideo,
      tiles: session.videoTiles.length,
      camLive: session.camLive,
    };
  `);
  check(
    'channel camera and screen have their own WHEP paths',
    channelVideo.cam === 'http://s:8889/vc-1-3-c/whep?token=tok'
      && channelVideo.screen === 'http://s:8889/vc-1-3-s/whep?token=tok',
    `${channelVideo.cam} / ${channelVideo.screen}`,
  );
  check(
    'the publish URLs the server minted are kept, never rebuilt',
    channelVideo.publishCam === 'w/c',
    channelVideo.publishCam,
  );
  check(
    'a roster with video to watch is reported as having tiles missing',
    channelVideo.missing === true && channelVideo.tiles === 0 && channelVideo.camLive === false,
    `missing=${channelVideo.missing}, open=${channelVideo.tiles}`,
  );

  // The channels view has to carry a control for everything the server grew a
  // route for, or the route is unreachable -- which is precisely how avatars,
  // reordering and message deletion shipped as dead code in 2.0.0.
  const controls = await cdp.evaluate(`
    const ids = [
      'avatar-button', 'avatar-file', 'channels-avatar',
      'channel-video', 'voice-screen', 'voice-cam', 'voice-camera',
      'channel-stage', 'peer-menu', 'voice-panel', 'voice-soundboard',
      'soundpad-volume', 'soundpad-mute', 'voice-config', 'devices',
      'voice-signal', 'self-status', 'member-list', 'member-items',
      'channels-members', 'theme-grid',
    ];
    const missing = ids.filter((id) => !document.getElementById(id));
    // An id that appears twice is worse than one that is missing:
    // getElementById silently returns the first, so the second copy is a
    // control nothing is ever wired to. index.html carried two #ask
    // dialogs for a release this way.
    const seen = new Map();
    for (const node of document.querySelectorAll('[id]')) {
      seen.set(node.id, (seen.get(node.id) ?? 0) + 1);
    }
    const duplicated = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    return [...missing, ...duplicated.map((id) => id + ' (duplicated)')];
  `);
  check(
    'the channels view has an avatar control, a video grid and a screen button',
    controls.length === 0,
    controls.length ? `missing: ${controls.join(', ')}` : 'all present',
  );

  // ---------------------------------------------------------------------
  // Soundpad and media
  //
  // The single easiest thing to get wrong in the soundpad is routing a clip
  // into the OUTGOING mix instead of the playback context, which re-broadcasts
  // it to people who are already playing it locally. playSample() must live on
  // the same AudioContext as createSink(), and AudioBridge must be untouched.
  // ---------------------------------------------------------------------
  const soundpad = await cdp.evaluate(`
    const gain = await import('./gain.js');
    const bridge = await import('./audio-bridge.js');
    return {
      hasPlaySample: typeof gain.playSample === 'function',
      // playSample must NOT be reachable through AudioBridge -- if it is,
      // somebody has wired the clip into the published mix.
      bridgeHasPlay: typeof bridge.AudioBridge?.prototype?.playSample === 'function',
    };
  `);
  check(
    'soundpad clips play through the playback context, not the outgoing mix',
    soundpad.hasPlaySample === true && soundpad.bridgeHasPlay === false,
    `gain.playSample=${soundpad.hasPlaySample}, AudioBridge.playSample=${soundpad.bridgeHasPlay}`,
  );

  // The media route has to live under app/ or the CSP blocks every image it
  // was added to allow: the scheme is {standard: true}, so the host is part of
  // the origin and harmony://media would be a different one.
  const media = await cdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    const url = harmony.mediaUrl('a'.repeat(64));
    const sameOrigin = new URL(url).origin === location.origin;
    // A bad hash must be refused by the protocol handler rather than reaching
    // the network.
    const bad = await fetch(harmony.mediaUrl('nope')).then((r) => r.status).catch(() => 'threw');
    return { url, sameOrigin, bad };
  `);
  check(
    'media URLs are same-origin, so the CSP never has to be loosened',
    media.sameOrigin === true && media.url.startsWith('harmony://app/media/'),
    media.url,
  );
  check(
    'the media route refuses anything that is not a content hash',
    media.bad === 400,
    `status ${media.bad}`,
  );

  // ---------------------------------------------------------------------
  // Voice subscription retry
  //
  // MediaMTX answers a WHIP publish with 201 as soon as signalling finishes,
  // but the path is not readable until the first RTP packet arrives. A peer
  // subscribing inside that window gets 404. Measured on a real 16-member
  // channel against the Pi: every other member failed to subscribe to one
  // slot for exactly that reason.
  //
  // Retrying only on the next roster push is not enough -- in a settled
  // channel there is no next push, so that person stays silently inaudible.
  // ---------------------------------------------------------------------
  const retry = await cdp.evaluate(`
    const { VoiceSession } = await import('./voice.js');
    const session = new VoiceSession();
    session.configure({ channelId: 1, mid: 1, token: 't', whepBase: 'http://127.0.0.1:1' });

    const roster = [
      { mid: 1, nickname: 'me', publishing: ['v'] },
      { mid: 2, nickname: 'them', publishing: ['v'] },
    ];

    // Nothing is listening on port 1, so every subscribe fails -- which is
    // the case this guards.
    const first = await session.syncPeers(roster);
    const missingAfterFailure = session.hasMissingPeers;

    // The retry path must work from the REMEMBERED roster, with no argument.
    const second = await session.syncPeers();

    // A peer who stops publishing must stop being chased.
    await session.syncPeers([{ mid: 1, nickname: 'me', publishing: ['v'] }]);
    const missingAfterTheyLeave = session.hasMissingPeers;

    return {
      firstMissed: first.missed.length,
      missingAfterFailure,
      secondRetried: second.missed.length,
      missingAfterTheyLeave,
    };
  `);
  check(
    'a failed voice subscription is remembered as missing, not forgotten',
    retry.firstMissed === 1 && retry.missingAfterFailure === true,
    `missed=${retry.firstMissed} flagged=${retry.missingAfterFailure}`,
  );
  check(
    'the retry works from the remembered roster, with no new push',
    retry.secondRetried === 1,
    'syncPeers() with no argument re-attempted the failed peer',
  );
  check(
    'a peer who stops publishing is no longer chased',
    retry.missingAfterTheyLeave === false,
    'the retry timer goes quiet once nothing is missing',
  );

  cdp.close();
}

run()
  .catch((err) => check('smoke run completed', false, err.message))
  .finally(async () => {
    child.kill();
    await sleep(500);
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    const failed = summary();
    if (failed && stderr.trim()) console.error(`\n--- app stderr ---\n${stderr}`);
    process.exit(failed ? 1 : 0);
  });
