// How voice is sent so that a line that wobbles does not take the sound with it.
//
// Measured (client/test/voice-loss.mjs: two real clients, a real MediaMTX, loss and jitter put on one client's line by a
// UDP proxy, what each hears of the other), with 3% of one person's packets lost on the way up:
//
//   relay      sent as                       what the others hear: delay   sound made up by the decoder
//   stock      40 ms, 32 kbit/s (as it was)           1.5 s                        10 %
//   stock      20 ms, 64 kbit/s                       0.96 s                      0.6 %
//   patched    20 ms, 64 kbit/s, asking for lost packets again     59 ms           0 %
//
// What is behind that, and what is done about each part.
//
//   The relay. MediaMTX holds every packet behind a gap until the gap is filled or sixty-four more have arrived, and a
//   voice was not asked to be sent again, so one lost packet stopped the voice for sixty-four packets and then let it all
//   out at once: a second and a half at 40 ms a packet, and what came out was the speech sped up to catch up. That is what
//   a listener heard of anybody on a line that merely drops a packet now and then. The relay Harmony builds waits for
//   sixteen and asks for the packet again (server/patches/mediamtx-audio-*.patch), and the offers made here ask for it
//   too (offerAudioNack in webrtc.js): on the way down as well, where the same loss cost the listener 3% of the sound.
//
//   The sending. A published MediaMTX has neither patch, and a relay's CPU is what the tuning of 40 ms packets, silence
//   suppressed and 32 kbit/s was saving. It is the wrong one for a lossy line: a lost 40 ms packet is a bigger hole than a
//   20 ms one, and sixty-four of them are a longer wait; a silence that is not sent is a word's start that can be lost
//   with nothing to say it was there; and an encoder held to 32 kbit/s that is also asked to carry forward error
//   correction has fewer bits left for the voice. CPU is a cost of how many share a channel (every packet is forwarded to
//   every listener), so small channels get the tuning for the line and large ones keep the saving.
//
// Tried and not kept: growing the listener's jitter buffer when the line wobbles (RTCRtpReceiver.jitterBufferTarget).
// Under loss and up to 90 ms of jitter the browser's own buffer did as well, and the hint only added delay.

/** What a channel of this many people is sent with: packet length, whether silence is suppressed, the bit rate. */
export function senderProfile(people, override = null) {
  const legacy = { ptime: 40, dtx: true, bitrate: 32_000, name: 'saving' };
  if (override === 'legacy') return legacy;
  // For comparing one thing at a time (test/voice-loss.mjs).
  if (override === 'long-packets') return { ...legacy, dtx: false, name: 'long-packets' };
  if (override === 'ptime10') return { ptime: 10, dtx: false, bitrate: 64_000, name: 'ptime10' };
  if (override === 'few-bits') return { ptime: 20, dtx: false, bitrate: 32_000, name: 'few-bits' };
  // A few people: the relay has CPU to spare, and the line is what matters.
  if (people <= 6) return { ptime: 20, dtx: false, bitrate: 64_000, name: 'line' };
  // A medium channel: shorter packets and more bits, with silence still suppressed.
  if (people <= 12) return { ptime: 20, dtx: true, bitrate: 48_000, name: 'balanced' };
  return legacy;
}
