// Volume past 100%.
//
// A <video> element's `volume` is clamped to 1.0, so a stream that was quiet at
// the source can never be made loud enough. Routing the audio through a
// GainNode lifts that ceiling: the element stays muted and Web Audio does the
// playing, which is the only way to amplify a MediaStream in a renderer.
//
// The cost is that `video.volume` and `video.muted` stop being the source of
// truth, so everything that used to read them reads `sink.gain` instead.

/** Loudest we will go. Past this, most sources are more distortion than signal. */
export const MAX_GAIN = 3.5;

let ctx = null;

/**
 * One AudioContext for every stream being played.
 *
 * Created on first use rather than at load: a context made before any user
 * gesture starts suspended, and Chromium counts the click that joined a stream
 * as activation, so by the time anything needs playing there is a gesture to
 * ride on.
 */
function context() {
  if (!ctx) ctx = new AudioContext();
  // Autoplay policy can still park it; resuming is free when already running.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/**
 * Route a received stream's audio through a gain node.
 *
 * @param {MediaStream} stream
 * @returns {{ set: (value: number) => void, value: number, close: () => void }}
 */
export function createSink(stream) {
  const node = context().createGain();
  node.gain.value = 1;
  node.connect(context().destination);

  // The audio track often arrives after the video one -- WHEP delivers them as
  // separate `track` events -- and createMediaStreamSource captures whatever
  // audio track exists at the moment it is called. So connect when there is
  // something to connect, and again if a track turns up later.
  let source = null;
  const connect = () => {
    if (source || stream.getAudioTracks().length === 0) return;
    try {
      source = context().createMediaStreamSource(stream);
      source.connect(node);
    } catch (err) {
      console.warn('[gain] could not route stream audio:', err.message);
    }
  };
  connect();
  stream.addEventListener('addtrack', connect);

  const sink = {
    value: 1,
    set(value) {
      const clamped = Math.max(0, Math.min(MAX_GAIN, value));
      sink.value = clamped;
      // setTargetAtTime rather than a bare assignment: stepping gain straight
      // from 0 to 3.5 is an audible click.
      node.gain.setTargetAtTime(clamped, context().currentTime, 0.015);
    },
    close() {
      stream.removeEventListener('addtrack', connect);
      try {
        source?.disconnect();
      } catch {
        /* already gone */
      }
      try {
        node.disconnect();
      } catch {
        /* already gone */
      }
      source = null;
    },
  };
  return sink;
}

/** Percent for the UI, from the 0..MAX_GAIN scale. */
export const asPercent = (gain) => Math.round(gain * 100);
