// "Native" for a camera: the biggest picture it can move at a rate worth having.
//
//   node client/test/camera-best.test.mjs

import { openBestCamera, floorsFor, SIZES } from '../src/renderer/camera-best.js';
import { reporter } from './cdp.mjs';

const { check, summary } = reporter();

/** A camera with a list of modes [width, height, maxFps], answering the way a browser does. */
function camera(modes, { liar = false } = {}) {
  const asked = [];
  const stopped = [];
  const getUserMedia = async ({ video }) => {
    asked.push(video);
    if (video.deviceId?.exact === 'gone') {
      const e = new Error('gone'); e.name = 'OverconstrainedError'; e.constraint = 'deviceId'; throw e;
    }
    const fits = modes
      .filter(([w, h, fps]) => w >= (video.width.min ?? 0) && h >= (video.height.min ?? 0) && fps >= (video.frameRate.min ?? 0))
      // The one closest to what is wished: the nearest size, then the fastest.
      .sort((a, b) => Math.abs(a[0] - video.width.ideal) - Math.abs(b[0] - video.width.ideal) || b[2] - a[2]);
    if (!fits.length) { const e = new Error('no mode'); e.name = 'OverconstrainedError'; e.constraint = 'width'; throw e; }
    const [width, height, fps] = fits[0];
    const track = { getSettings: () => ({ width, height, frameRate: liar ? 2 : Math.min(fps, video.frameRate.ideal) }), stop: () => stopped.push(width) };
    return { getVideoTracks: () => [track], getTracks: () => [track], size: [width, height] };
  };
  return { getUserMedia, asked, stopped };
}

const C920 = [[640, 360, 30], [1280, 720, 30], [1920, 1080, 30], [2304, 1536, 2]];
const FOUR_K = [[1280, 720, 60], [1920, 1080, 60], [3840, 2160, 30]];
const SMALL = [[640, 480, 30], [320, 240, 30]];

let cam = camera(C920);
let stream = await openBestCamera(cam.getUserMedia, { rate: 0 });
check('a webcam whose biggest mode crawls is given its biggest mode that does not: 1080p', stream.size.join('x') === '1920x1080', stream.size.join('x'));

cam = camera(FOUR_K);
stream = await openBestCamera(cam.getUserMedia, { rate: 0 });
check('a 4K camera that does 4K at 30 fps gets 4K', stream.size.join('x') === '3840x2160', stream.size.join('x'));

cam = camera(FOUR_K);
stream = await openBestCamera(cam.getUserMedia, { rate: 60 });
check('and when 60 fps is what is wanted, the biggest picture at 60: 1080p', stream.size.join('x') === '1920x1080', stream.size.join('x'));

cam = camera(SMALL);
stream = await openBestCamera(cam.getUserMedia, { rate: 0 });
check('a small camera is opened at what it has, not refused', stream.size.join('x') === '640x480', stream.size.join('x'));

cam = camera([[1920, 1080, 10], [1280, 720, 12]]);
stream = await openBestCamera(cam.getUserMedia, { rate: 0 });
check('a camera slower than every floor is still opened, at the fastest picture it can ask for', Boolean(stream), String(stream?.size));

cam = camera([[1920, 1080, 20], [640, 360, 20]]);
stream = await openBestCamera(cam.getUserMedia, { rate: 0 });
check('when no mode reaches 30 fps the floor drops to 15 and the biggest picture there is chosen', stream.size.join('x') === '1920x1080', stream.size.join('x'));

cam = camera(C920, { liar: true });
stream = await openBestCamera(cam.getUserMedia, { rate: 0 });
check('a camera that says yes to a rate it does not keep is let go and the next tried', cam.stopped.length > 0 && Boolean(stream), `${cam.stopped.length} let go`);

cam = camera(C920);
await openBestCamera(cam.getUserMedia, { rate: 0, device: { deviceId: { exact: 'camera-1' } } });
check('the camera chosen is asked for in every request', cam.asked.every((v) => v.deviceId?.exact === 'camera-1'), String(cam.asked.length));

cam = camera(C920);
const gone = await openBestCamera(cam.getUserMedia, { rate: 0, device: { deviceId: { exact: 'gone' } } }).then(() => 'opened', (e) => `${e.name}:${e.constraint}`);
check('a camera that is gone fails at once, so the caller can fall back, instead of being asked over and over', gone === 'OverconstrainedError:deviceId' && cam.asked.length === 1, `${gone}, ${cam.asked.length} asks`);

check('the rates tried go from the one chosen down', JSON.stringify([floorsFor(0), floorsFor(24), floorsFor(30), floorsFor(60)]) === '[[30,15],[24,15],[30,15],[60,30,15]]', JSON.stringify([floorsFor(0), floorsFor(60)]));
check('and the sizes from the biggest down', SIZES.every((s, i) => i === 0 || s[0] * s[1] < SIZES[i - 1][0] * SIZES[i - 1][1]));

const failed = summary();
process.exit(failed ? 1 : 0);
