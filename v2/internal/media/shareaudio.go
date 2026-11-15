package media

import (
	"errors"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
	pionmedia "github.com/pion/webrtc/v4/pkg/media"
	"github.com/thesyncim/gopus"
)

// A share's sound is music or a game: stereo at a rate for it, as the Electron client sends it.
const (
	shareAudioBitrate    = 128000
	shareAudioComplexity = 5
	shareAudioFmtp       = "minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000"
	maxPending           = SampleRate / 2 * 2
)

// shareAudio is the sound of a share on its way out: whatever block size the capture gives is cut into 20 ms frames.
type shareAudio struct {
	track *webrtc.TrackLocalStaticSample

	mu      sync.Mutex
	enc     *gopus.Encoder
	pending []int16
	out     []byte
	last    time.Time
	done    chan struct{}
	once    sync.Once
}

func newShareAudio() (*shareAudio, error) {
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: SampleRate, Channels: 2, SDPFmtpLine: shareAudioFmtp},
		"audio", "harmony-v2-share")
	if err != nil {
		return nil, err
	}
	enc, err := gopus.NewEncoder(gopus.EncoderConfig{SampleRate: SampleRate, Channels: 2, Application: gopus.ApplicationAudio})
	if err != nil {
		return nil, err
	}
	if err := enc.SetFrameSize(FrameSamples); err != nil {
		return nil, err
	}
	_ = enc.SetBitrate(shareAudioBitrate)
	_ = enc.SetComplexity(shareAudioComplexity)
	a := &shareAudio{track: track, enc: enc, out: make([]byte, maxPacketBytes), pending: make([]int16, 0, FrameSamples*4), done: make(chan struct{})}
	go a.keepAlive()
	return a, nil
}

// keepAlive sends silence while the capture has nothing to say (Windows delivers nothing while nothing plays, and the relay
// only lists a track once its first packet has come).
func (a *shareAudio) keepAlive() {
	silence := make([]int16, FrameSamples*2)
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-a.done:
			return
		case <-tick.C:
		}
		a.mu.Lock()
		quiet := time.Since(a.last) > 3*20*time.Millisecond
		a.mu.Unlock()
		if quiet {
			_ = a.send(silence)
		}
	}
}

func (a *shareAudio) stop() { a.once.Do(func() { close(a.done) }) }

// write takes 48 kHz stereo samples and sends every complete 20 ms frame.
func (a *shareAudio) write(pcm []int16) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.last = time.Now()
	a.pending = append(a.pending, pcm...)
	if over := len(a.pending) - maxPending; over > 0 {
		a.pending = append(a.pending[:0], a.pending[over:]...)
	}
	var first error
	for len(a.pending) >= FrameSamples*2 {
		n, err := a.enc.EncodeInt16(a.pending[:FrameSamples*2], a.out)
		a.pending = append(a.pending[:0], a.pending[FrameSamples*2:]...)
		if err != nil {
			return err
		}
		packet := append([]byte(nil), a.out[:n]...)
		if err := a.track.WriteSample(pionmedia.Sample{Data: packet, Duration: 20 * time.Millisecond}); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// send encodes and sends one 20 ms frame, outside of the pending queue.
func (a *shareAudio) send(frame []int16) error {
	a.mu.Lock()
	n, err := a.enc.EncodeInt16(frame, a.out)
	var packet []byte
	if err == nil {
		packet = append(packet, a.out[:n]...)
	}
	a.mu.Unlock()
	if err != nil {
		return err
	}
	return a.track.WriteSample(pionmedia.Sample{Data: packet, Duration: 20 * time.Millisecond})
}

// WriteAudio sends the sound that goes with the picture: 48 kHz stereo interleaved, any length. It fails when the
// publisher has no sound track.
func (p *VideoPublisher) WriteAudio(pcm []int16) error {
	if p.audio == nil {
		return errors.New("this stream has no sound track")
	}
	return p.audio.write(pcm)
}

// HasAudio is whether the publisher sends a sound track.
func (p *VideoPublisher) HasAudio() bool { return p.audio != nil }
