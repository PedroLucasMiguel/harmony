// Package echo cancels what the speakers play out of the microphone using the operating system's own facilities, called without cgo:
// Apple's voice processing unit on a Mac, the Voice Capture DSP on Windows, PulseAudio's echo-cancel module on Linux.
package echo

const sampleRate = 48000
