package media

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	pionmedia "github.com/pion/webrtc/v4/pkg/media"
	"github.com/thesyncim/gopus"
)

const (
	SampleRate   = 48000
	FrameSamples = 960
)

type PCMSink interface {
	Push(pcm []int16)
}

type VoicePublisher struct {
	e        *Engine
	pc       *webrtc.PeerConnection
	track    *webrtc.TrackLocalStaticSample
	resource string

	mu  sync.Mutex
	enc *gopus.Encoder
	buf []byte

	Failed chan struct{}
	once   sync.Once
}

func (e *Engine) PublishVoice(ctx context.Context, url string) (*VoicePublisher, error) {
	pc, err := e.newPC()
	if err != nil {
		return nil, err
	}
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"},
		"audio", "harmony-v2")
	if err != nil {
		pc.Close()
		return nil, err
	}
	if _, err := pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
		pc.Close()
		return nil, err
	}
	enc, err := newVoiceEncoder()
	if err != nil {
		pc.Close()
		return nil, err
	}

	p := &VoicePublisher{e: e, pc: pc, track: track, enc: enc, buf: make([]byte, maxPacketBytes), Failed: make(chan struct{})}
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateClosed {
			p.once.Do(func() { close(p.Failed) })
		}
	})
	if p.resource, err = e.negotiate(ctx, pc, url); err != nil {
		pc.Close()
		return nil, err
	}
	return p, nil
}

// A muted microphone sends silence, not nothing: listeners treat a quiet path as broken and rebuild it.
func (p *VoicePublisher) WriteFrame(pcm []int16) error {
	if len(pcm) != FrameSamples {
		return errors.New("a voice frame is 960 samples")
	}
	p.mu.Lock()
	n, err := p.enc.EncodeInt16(pcm, p.buf)
	var packet []byte
	if err == nil {
		packet = append(packet, p.buf[:n]...)
	}
	p.mu.Unlock()
	if err != nil {
		return err
	}
	return p.track.WriteSample(pionmedia.Sample{Data: packet, Duration: 20 * time.Millisecond})
}

func (p *VoicePublisher) Close() {
	p.e.hangup(p.resource)
	_ = p.pc.Close()
}

type VoiceSubscription struct {
	e        *Engine
	pc       *webrtc.PeerConnection
	resource string

	Failed chan struct{}
	once   sync.Once

	packets    atomic.Int64
	lastPacket atomic.Int64
}

func (e *Engine) SubscribeVoice(ctx context.Context, url string, sink PCMSink) (*VoiceSubscription, error) {
	pc, err := e.newPC()
	if err != nil {
		return nil, err
	}
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		pc.Close()
		return nil, err
	}
	s := &VoiceSubscription{e: e, pc: pc, Failed: make(chan struct{})}
	s.lastPacket.Store(time.Now().UnixNano())
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			s.once.Do(func() { close(s.Failed) })
		}
	})
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if remote.Kind() != webrtc.RTPCodecTypeAudio {
			return
		}
		s.decodeLoop(remote, sink)
	})
	if s.resource, err = e.negotiate(ctx, pc, url); err != nil {
		pc.Close()
		return nil, err
	}
	return s, nil
}

func (s *VoiceSubscription) decodeLoop(remote *webrtc.TrackRemote, sink PCMSink) {
	decodeTrack(remote, sink, func() bool {
		s.packets.Add(1)
		s.lastPacket.Store(time.Now().UnixNano())
		return true
	})
}

// decodeTrack turns a received Opus track into PCM for sink until the track ends. arrived is called for every packet and
// says whether it is wanted; one that is not is dropped undecoded.
func decodeTrack(remote *webrtc.TrackRemote, sink PCMSink, arrived func() bool) {
	dec, err := newDecoder()
	if err != nil {
		return
	}
	pcm := make([]int16, maxFrameSamples*2)
	var pkt rtp.Packet
	var last uint16
	var have bool
	lastSamples := FrameSamples
	raw := make([]byte, 1500)

	for {
		n, _, err := remote.Read(raw)
		if err != nil {
			return
		}
		if err := pkt.Unmarshal(raw[:n]); err != nil || len(pkt.Payload) == 0 {
			continue
		}
		if !arrived() {
			have = false
			continue
		}

		if have {
			gap := int(uint16(pkt.SequenceNumber - last - 1))
			if gap >= 0x8000 {
				continue
			}
			if gap > 0 && gap <= 3 {
				for i := 0; i < gap; i++ {
					if got, err := dec.DecodeInt16(nil, pcm[:lastSamples*2]); err == nil && got > 0 {
						sink.Push(pcm[:got*2])
					}
				}
			}
		}
		last, have = pkt.SequenceNumber, true

		got, err := dec.DecodeInt16(pkt.Payload, pcm)
		if err != nil || got <= 0 {
			continue
		}
		lastSamples = got
		sink.Push(pcm[:got*2])
	}
}

func (s *VoiceSubscription) Packets() int64 { return s.packets.Load() }

func (s *VoiceSubscription) Silent() time.Duration {
	return time.Since(time.Unix(0, s.lastPacket.Load()))
}

func (s *VoiceSubscription) Close() {
	s.e.hangup(s.resource)
	_ = s.pc.Close()
}
