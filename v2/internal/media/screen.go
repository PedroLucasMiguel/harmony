package media

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	pionmedia "github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/samplebuilder"
)

type VideoPublisher struct {
	e        *Engine
	pc       *webrtc.PeerConnection
	track    *webrtc.TrackLocalStaticSample
	audio    *shareAudio
	resource string

	Failed chan struct{}
	once   sync.Once
	last   time.Time
}

// PublishVideo opens a peer connection that sends H.264 of the given profile-level-id (what the first access unit's
// parameter set says; "" for constrained baseline 3.1).
func (e *Engine) PublishVideo(ctx context.Context, url, profile string) (*VideoPublisher, error) {
	return e.PublishVideoAudio(ctx, url, profile, false)
}

// PublishVideoAudio is PublishVideo with a stereo Opus track beside the picture when withAudio is set; WriteAudio feeds it.
func (e *Engine) PublishVideoAudio(ctx context.Context, url, profile string, withAudio bool) (*VideoPublisher, error) {
	if profile == "" {
		profile = "42e01f"
	}
	pc, err := e.newPC()
	if err != nil {
		return nil, err
	}
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeH264, ClockRate: 90000,
		SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=" + profile,
	}, "video", "harmony-v2-video")
	if err != nil {
		pc.Close()
		return nil, err
	}
	sender, err := pc.AddTrack(track)
	if err != nil {
		pc.Close()
		return nil, err
	}
	go func() {
		for {
			if _, _, err := sender.ReadRTCP(); err != nil {
				return
			}
		}
	}()
	p := &VideoPublisher{e: e, pc: pc, track: track, Failed: make(chan struct{})}
	if withAudio {
		var asender *webrtc.RTPSender
		if p.audio, err = newShareAudio(); err == nil {
			asender, err = pc.AddTrack(p.audio.track)
		}
		if err != nil {
			pc.Close()
			return nil, err
		}
		go func() {
			for {
				if _, _, err := asender.ReadRTCP(); err != nil {
					return
				}
			}
		}()
	}
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

func (p *VideoPublisher) WriteAU(au []byte) error {
	now := time.Now()
	d := 33 * time.Millisecond
	if !p.last.IsZero() {
		d = min(max(now.Sub(p.last), time.Millisecond), time.Second)
	}
	p.last = now
	return p.track.WriteSample(pionmedia.Sample{Data: au, Duration: d})
}

// Profile is the profile-level-id the negotiation settled on, the one the offer announced.
func (p *VideoPublisher) Profile() string {
	for _, kv := range strings.Split(p.track.Codec().SDPFmtpLine, ";") {
		if id, ok := strings.CutPrefix(kv, "profile-level-id="); ok {
			return id
		}
	}
	return ""
}

func (p *VideoPublisher) Close() {
	if p.audio != nil {
		p.audio.stop()
	}
	p.e.hangup(p.resource)
	_ = p.pc.Close()
}

// VideoSubscription is one camera or screen being received; every access unit goes to the function given to WatchVideo.
type VideoSubscription struct {
	e        *Engine
	pc       *webrtc.PeerConnection
	resource string

	Failed chan struct{}
	once   sync.Once

	ssrc       atomic.Uint32
	lastPacket atomic.Int64

	audioPackets atomic.Int64
	audioWanted  atomic.Bool
}

func (e *Engine) WatchVideo(ctx context.Context, url string, onAU func(au []byte)) (*VideoSubscription, error) {
	return e.WatchShare(ctx, url, onAU, nil)
}

// WatchShare is WatchVideo that also takes the stream's sound, decoded into sink, when sink is not nil. A stream without
// sound simply never delivers any (see AudioPackets).
func (e *Engine) WatchShare(ctx context.Context, url string, onAU func(au []byte), sink PCMSink) (*VideoSubscription, error) {
	pc, err := e.newPC()
	if err != nil {
		return nil, err
	}
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		pc.Close()
		return nil, err
	}
	if sink != nil {
		if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			pc.Close()
			return nil, err
		}
	}
	s := &VideoSubscription{e: e, pc: pc, Failed: make(chan struct{})}
	s.lastPacket.Store(time.Now().UnixNano())
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			s.once.Do(func() { close(s.Failed) })
		}
	})
	s.audioWanted.Store(true)
	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if remote.Kind() == webrtc.RTPCodecTypeAudio && sink != nil {
			decodeTrack(remote, sink, func() bool {
				s.audioPackets.Add(1)
				return s.audioWanted.Load()
			})
			return
		}
		if remote.Kind() != webrtc.RTPCodecTypeVideo {
			return
		}
		s.ssrc.Store(uint32(remote.SSRC()))
		s.RequestKeyframe()

		builder := samplebuilder.New(96, &codecs.H264Packet{}, 90000)
		for {
			pkt, _, err := remote.ReadRTP()
			if err != nil {
				return
			}
			s.lastPacket.Store(time.Now().UnixNano())
			builder.Push(pkt)
			for sample := builder.Pop(); sample != nil; sample = builder.Pop() {
				onAU(sample.Data)
			}
		}
	})
	if s.resource, err = e.negotiate(ctx, pc, url); err != nil {
		pc.Close()
		return nil, err
	}
	return s, nil
}

// AudioPackets is how many packets of sound have arrived; a stream that has none after a few seconds has no sound.
func (s *VideoSubscription) AudioPackets() int64 { return s.audioPackets.Load() }

// SetAudioWanted tells whether the sound is to be decoded; a share turned down to nothing costs no decoding.
func (s *VideoSubscription) SetAudioWanted(wanted bool) { s.audioWanted.Store(wanted) }

// RequestKeyframe asks the sender for a picture that can be decoded from nothing.
func (s *VideoSubscription) RequestKeyframe() {
	if ssrc := s.ssrc.Load(); ssrc != 0 {
		_ = s.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: ssrc}})
	}
}

// Silent is how long since a packet arrived.
func (s *VideoSubscription) Silent() time.Duration {
	return time.Since(time.Unix(0, s.lastPacket.Load()))
}

// Close lets go of the subscription; it does not wait for the relay to answer.
func (s *VideoSubscription) Close() {
	go s.e.hangup(s.resource)
	_ = s.pc.Close()
}
