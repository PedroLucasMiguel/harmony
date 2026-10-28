// Turning whatever audio file somebody picked into a join sound.
//
// The server will only take a WAV of at most ten seconds -- it has no decoder,
// and a WAV is the one format whose length it can read for itself (see
// server/src/wav.js). So the work is done here, on the machine that can decode
// MP3, M4A, OGG and the rest: decode, cut at ten seconds, mix down to mono and
// write 16-bit PCM at a low rate. Ten seconds of that is 640 KB, which is also
// what keeps it cheap for every client that has to download it.

export const MAX_JOIN_SOUND_SECONDS = 10;

/** Far more than ten seconds of anything; a decoded hour would be hundreds of MB. */
export const MAX_JOIN_SOUND_SOURCE_BYTES = 20 * 1024 * 1024;

/** Mono at 32 kHz keeps everything a notification sound has, in 64 KB a second. */
const RATE = 32000;

/** A short fade at a cut, so it ends on a taper instead of a click. */
const FADE_SECONDS = 0.12;

/**
 * 16-bit mono WAV bytes from float samples.
 * @param {Float32Array} samples
 * @param {number} rate
 */
export function encodeWav(samples, rate = RATE) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at, value) => { for (let i = 0; i < value.length; i += 1) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/**
 * Decode a picked file into a join sound.
 *
 * @param {Blob} file
 * @returns {Promise<{bytes: Uint8Array, seconds: number, trimmed: boolean}>}
 * @throws if the file is too big to bother with or is not audio this build can decode
 */
export async function prepareJoinSound(file) {
  if (file.size > MAX_JOIN_SOUND_SOURCE_BYTES) throw new Error('too_big');

  // Decoded by an offline context of the rate we want, which resamples as it
  // decodes: the buffer that comes back is already at RATE.
  const offline = new OfflineAudioContext(1, 1, RATE);
  let decoded;
  try {
    decoded = await offline.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error('unreadable');
  }

  const wanted = Math.min(decoded.length, Math.round(MAX_JOIN_SOUND_SECONDS * RATE));
  const trimmed = decoded.length > wanted;
  const mixed = new Float32Array(wanted);
  for (let c = 0; c < decoded.numberOfChannels; c += 1) {
    const channel = decoded.getChannelData(c);
    for (let i = 0; i < wanted; i += 1) mixed[i] += channel[i] / decoded.numberOfChannels;
  }
  if (trimmed) {
    const fade = Math.min(wanted, Math.round(FADE_SECONDS * RATE));
    for (let i = 0; i < fade; i += 1) mixed[wanted - fade + i] *= 1 - (i + 1) / fade;
  }
  if (wanted === 0) throw new Error('unreadable');

  return { bytes: encodeWav(mixed), seconds: wanted / RATE, trimmed };
}
