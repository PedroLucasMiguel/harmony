// The broadcaster's audio mixer.
//
//   native PCM (system / one app)  ─┐
//                                   ├─► gain ─► MediaStreamDestination ─► WHIP
//   input device (mic, line-in)    ─┘      └──► speakers, when monitoring
//
// The important property is that the destination track is created once and
// never replaced. Whatever the user switches to mid-stream -- a different
// screen, a webcam, another microphone -- the audio track the peer connection
// is sending stays the same object, so switching never needs renegotiation and
// viewers never see a gap.

import { harmony } from './bridge.js';

const SAMPLE_RATE = 48000;

export class AudioBridge {
  #context = null;
  #pcmNode = null;
  #deviceNode = null;
  #deviceStream = null;
  #gain = null;
  #monitorGain = null;
  #destination = null;
  #unsubscribe = null;
  #monitoring = false;

  get monitoring() {
    return this.#monitoring;
  }

  /**
   * Build the graph and hand back the single track that will be published.
   * @returns {Promise<MediaStreamTrack>}
   */
  async start() {
    await this.stop();

    // Must match the native capture rate exactly; resampling here would cost
    // CPU and add latency for no benefit.
    this.#context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    await this.#context.audioWorklet.addModule('pcm-worklet.js');

    this.#gain = this.#context.createGain();
    this.#destination = this.#context.createMediaStreamDestination();
    this.#gain.connect(this.#destination);

    // Monitoring hangs off its own gain so it can be switched without
    // disturbing what is being sent. Starts silent and disconnected.
    this.#monitorGain = this.#context.createGain();
    this.#monitorGain.gain.value = 1;

    // A context created without user activation starts suspended, and resume()
    // does not settle until activation arrives -- awaiting it can hang forever.
    // Kick it off without blocking, and try again on the next interaction.
    if (this.#context.state === 'suspended') {
      this.#context.resume().catch(() => {});
      const retry = () => this.#context?.resume().catch(() => {});
      window.addEventListener('pointerdown', retry, { once: true });
      window.addEventListener('keydown', retry, { once: true });
    }

    return this.#destination.stream.getAudioTracks()[0];
  }

  /** Feed the mixer from the native loopback capture running in the main process. */
  attachPcm() {
    this.detachPcm();
    if (!this.#context) return;

    this.#pcmNode = new AudioWorkletNode(this.#context, 'pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.#pcmNode.connect(this.#gain);

    this.#unsubscribe = harmony.audio.onPcm((chunk) => {
      // `chunk` arrives as a Uint8Array view over an IPC buffer. Copy it into a
      // transferable ArrayBuffer so the audio thread owns the memory.
      const copy = new ArrayBuffer(chunk.byteLength);
      new Uint8Array(copy).set(chunk);
      this.#pcmNode?.port.postMessage({ type: 'pcm', payload: copy }, [copy]);
    });
  }

  detachPcm() {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#pcmNode) {
      this.#pcmNode.port.postMessage({ type: 'close' });
      this.#pcmNode.disconnect();
      this.#pcmNode = null;
    }
  }

  /**
   * Feed the mixer from an input device: a microphone, a line-in, or the audio
   * side of a capture card.
   * @returns {Promise<string>} the device's label
   */
  async attachDevice(deviceId) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // A capture card carries programme audio, not speech: cleaning it up
        // would chew the top off music and game sound.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.attachStream(stream, { owned: true });
    return stream.getAudioTracks()[0]?.label ?? 'Audio input';
  }

  /**
   * Route an existing MediaStream's audio into the mixer. Used for Chromium's
   * own loopback track, which arrives attached to the display capture.
   * @param {boolean} owned  whether stopping should also stop those tracks
   */
  attachStream(stream, { owned = false } = {}) {
    this.detachDevice();
    if (!this.#context || !stream?.getAudioTracks().length) return;

    this.#deviceStream = owned ? stream : null;
    this.#deviceNode = this.#context.createMediaStreamSource(stream);
    this.#deviceNode.connect(this.#gain);
  }

  detachDevice() {
    this.#deviceNode?.disconnect();
    this.#deviceNode = null;
    this.#deviceStream?.getTracks().forEach((t) => t.stop());
    this.#deviceStream = null;
  }

  /**
   * Play what is being sent through the broadcaster's own speakers.
   *
   * Only ever used for input devices. Monitoring a system-audio capture would
   * feed the speakers back into the very mix being captured; and there is no
   * point anyway, since the machine is already playing that sound out loud.
   */
  setMonitor(enabled) {
    if (!this.#context || !this.#gain) return;
    if (enabled === this.#monitoring) return;

    if (enabled) {
      this.#gain.connect(this.#monitorGain);
      this.#monitorGain.connect(this.#context.destination);
    } else {
      try {
        this.#monitorGain.disconnect();
        this.#gain.disconnect(this.#monitorGain);
      } catch {
        // Already disconnected.
      }
      // Keep the send path alive regardless of monitoring.
      this.#gain.connect(this.#destination);
    }
    this.#monitoring = enabled;
  }

  setMonitorVolume(value) {
    if (this.#monitorGain) this.#monitorGain.gain.value = value;
  }

  setGain(value) {
    if (this.#gain) this.#gain.gain.value = value;
  }

  async stop() {
    this.detachPcm();
    this.detachDevice();
    this.#monitoring = false;

    this.#monitorGain?.disconnect();
    this.#monitorGain = null;
    this.#gain?.disconnect();
    this.#gain = null;
    this.#destination?.disconnect();
    this.#destination = null;

    if (this.#context) {
      await this.#context.close().catch(() => {});
      this.#context = null;
    }
  }
}
