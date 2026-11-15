package app

// A running screen share that can be changed without dropping the people watching it: another source or another quality
// reopens the capture and the encoder under the same WebRTC connection, and the first picture of the new one is a key
// frame. The share is also watched once a second: when the computer cannot encode what was asked (see package sharegov) it
// is lowered, and raised again when it can.

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"harmony/v2/internal/media"
	"harmony/v2/internal/sharegov"
	"harmony/v2/internal/video"
)

// ShareConfig is what a share is: where the picture comes from and how it is sent.
type ShareConfig struct {
	// Source is a native.SourceInfo.ID: "screen:<n>", "window:<n>" or "camera:<id>"; "" is the main screen.
	Source  string
	Quality video.ShareQuality
	// Encoder is the codec backend, as video.CaptureOptions.Encoder says.
	Encoder string
	// Auto lowers the share when this computer cannot keep up.
	Auto bool
}

// ShareStats is the live line under a share's preview.
type ShareStats struct {
	Live          bool
	Width, Height int
	FPS           float64
	Kbps          int
	RTT           time.Duration
	Codec         string
	// Mode names the encoder in use.
	Mode string
	// EncodeMs is the average time one picture took in the encoder; EncodeKnown is false where the system does not say.
	EncodeMs    float64
	EncodeKnown bool
	// Loss is the share of packets the relay lost in its last report.
	Loss float64
	// LinkLimited says the connection holds the picture back.
	LinkLimited bool
	// Lowered is set while the governor has the share below what was asked; LoweredHeight and LoweredFPS are what it is at.
	Lowered       bool
	LoweredHeight int
	LoweredFPS    int
}

type shareLive struct {
	mu      sync.Mutex
	cfg     ShareConfig
	opts    video.CaptureOptions
	pending []byte
	gov     *sharegov.Governor
	plan    sharegov.Plan
	stats   ShareStats
	w, h    int
	frames  atomic.Uint64
	bytes   atomic.Uint64
	pub     atomic.Pointer[media.VideoPublisher]
	reopen  sync.Mutex
}

// linkLossLimit is the share of lost packets past which the link, not this computer, is blamed for a poor picture.
const linkLossLimit = 0.05

var errNoShare = errors.New("you are not sharing")

func (l *shareLive) capOf(st *shareState) *video.Capture {
	l.mu.Lock()
	defer l.mu.Unlock()
	return st.cap
}

// next is the next picture to send: the first one of a capture that was swapped in, else the running capture's.
func (l *shareLive) next(st *shareState) ([]byte, error) {
	for {
		l.mu.Lock()
		if au := l.pending; au != nil {
			l.pending = nil
			l.mu.Unlock()
			return au, nil
		}
		c := st.cap
		l.mu.Unlock()
		au, err := c.NextAU()
		if err == nil {
			return au, nil
		}
		l.mu.Lock()
		swapped := l.pending != nil || st.cap != c
		l.mu.Unlock()
		if !swapped {
			return nil, err
		}
	}
}

// sent counts a picture that went out and learns the stream's size from its key frames.
func (l *shareLive) sent(au []byte) {
	l.frames.Add(1)
	l.bytes.Add(uint64(len(au)))
	if video.IsKeyframe(au) {
		if w, h := video.PictureSize(au); w > 0 {
			l.mu.Lock()
			l.w, l.h = w, h
			l.mu.Unlock()
		}
	}
}

func prioOf(q video.ShareQuality) sharegov.Priority {
	if q.Sharp {
		return sharegov.Sharp
	}
	return sharegov.Smooth
}

func askOf(q video.ShareQuality) sharegov.Ask {
	if q.Native() {
		return sharegov.Ask{FPS: q.Rate()}
	}
	h := q.Height()
	return sharegov.Ask{FPS: q.Rate(), Width: h * 16 / 9 / 2 * 2, Height: h}
}

// shareOptions is the capture for a configuration, as the governor has it lowered.
func shareOptions(cfg ShareConfig, plan sharegov.Plan) video.CaptureOptions {
	q := cfg.Quality.Valid()
	o := video.CaptureOptions{Source: "screen", Height: q.Height(), Native: q.Native(), FPS: q.Rate(), BitrateKbps: q.BitrateKbps(), Encoder: cfg.Encoder}
	if plan.Lowered {
		o.FPS = plan.FPS
		if plan.Height > 0 {
			o.Height, o.Native = plan.Height, false
		}
	}
	if id, ok := strings.CutPrefix(cfg.Source, "camera:"); ok {
		o.Source, o.Camera = "camera", id
		o.Native = false
	} else {
		o.SourceID = cfg.Source
	}
	return o
}

// StartShareConfig starts sharing a source at a quality.
func (s *Session) StartShareConfig(cfg ShareConfig) error {
	cfg.Quality = cfg.Quality.Valid()
	l := &s.sharing
	l.mu.Lock()
	l.cfg = cfg
	l.gov = sharegov.New(askOf(cfg.Quality), prioOf(cfg.Quality))
	l.plan = l.gov.Plan()
	l.opts = shareOptions(cfg, l.plan)
	l.stats = ShareStats{}
	l.w, l.h = 0, 0
	opts := l.opts
	l.mu.Unlock()
	return s.startVideo("s", opts)
}

// ShareConfig is the running share's configuration; ok is false when not sharing.
func (s *Session) ShareConfig() (ShareConfig, bool) {
	s.mu.Lock()
	on := s.share != nil
	s.mu.Unlock()
	s.sharing.mu.Lock()
	defer s.sharing.mu.Unlock()
	return s.sharing.cfg, on
}

// ShareStats is the share's live line.
func (s *Session) ShareStats() ShareStats {
	s.sharing.mu.Lock()
	defer s.sharing.mu.Unlock()
	return s.sharing.stats
}

// UpdateShare changes the running share to cfg: another source or quality keeps the viewers and sends a key frame at once.
func (s *Session) UpdateShare(cfg ShareConfig) error {
	cfg.Quality = cfg.Quality.Valid()
	l := &s.sharing
	s.mu.Lock()
	st := s.share
	s.mu.Unlock()
	if st == nil {
		return errNoShare
	}
	l.reopen.Lock()
	defer l.reopen.Unlock()
	l.mu.Lock()
	old, wasLowered := l.cfg, l.plan.Lowered
	l.cfg = cfg
	if old.Quality != cfg.Quality || old.Source != cfg.Source || old.Auto && !cfg.Auto {
		l.plan = l.gov.Ask(askOf(cfg.Quality), prioOf(cfg.Quality))
	}
	plan := l.plan
	l.mu.Unlock()
	same := old.Source == cfg.Source && old.Quality.Resolution == cfg.Quality.Resolution && old.Quality.FPS == cfg.Quality.FPS && old.Encoder == cfg.Encoder
	if same && !(wasLowered && !plan.Lowered) {
		return nil
	}
	if err := s.swapCapture(st, shareOptions(cfg, plan)); err != nil {
		l.mu.Lock()
		l.cfg = old
		l.mu.Unlock()
		return err
	}
	if old.Source != cfg.Source {
		go s.shareSourceChanged()
	}
	return nil
}

// swapCapture opens a capture with opts and puts it in place of the running one; the old one keeps going until the new
// one has its first picture, so nothing is lost when the new one cannot be opened.
func (s *Session) swapCapture(st *shareState, opts video.CaptureOptions) error {
	l := &s.sharing
	capture, first, err := s.openCapture("screen", opts)
	if err != nil {
		return err
	}
	l.mu.Lock()
	old := st.cap
	st.cap = capture
	l.pending = append([]byte(nil), first...)
	l.opts = opts
	l.mu.Unlock()
	old.Close()
	s.logf("the share was changed (%s, %d lines, %d fps)", capture.Mode(), opts.Height, opts.FPS)
	return nil
}

// closeCap stops whatever capture the share has now.
func (l *shareLive) closeCap(st *shareState) { l.capOf(st).Close() }

// governShare reads the share's numbers once a second, keeps the live line, and lowers or raises the share.
func (s *Session) governShare(ctx context.Context, st *shareState) {
	l := &s.sharing
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	var lastBytes, lastFrames uint64
	var lastAt time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick.C:
			pub := l.pub.Load()
			if pub == nil {
				continue
			}
			ss := pub.SendStats()
			frames, bytes := l.frames.Load(), l.bytes.Load()
			capture := l.capOf(st)
			es, known := capture.Stats()

			l.mu.Lock()
			out := ShareStats{Live: true, Width: l.w, Height: l.h, RTT: ss.RTT, Codec: "H264", Mode: capture.Mode(), Loss: ss.FractionLost, EncodeKnown: known}
			if !lastAt.IsZero() {
				dt := now.Sub(lastAt).Seconds()
				out.FPS = float64(frames-lastFrames) / dt
				out.Kbps = int(float64(bytes-lastBytes) * 8 / dt / 1000)
			}
			lastAt, lastFrames, lastBytes = now, frames, bytes
			if known && es.Frames > 0 {
				out.EncodeMs = es.EncodeSeconds / float64(es.Frames) * 1000
			}
			out.LinkLimited = ss.FractionLost > linkLossLimit
			var change *sharegov.Plan
			if l.cfg.Auto && known {
				change = l.gov.Sample(sharegov.Sample{At: now, Frames: frames, EncodeSeconds: es.EncodeSeconds, LinkLimited: out.LinkLimited, Width: l.w, Height: l.h})
				if change != nil {
					l.plan = *change
				}
			}
			out.Lowered, out.LoweredHeight, out.LoweredFPS = l.plan.Lowered, l.plan.Height, l.plan.FPS
			l.stats = out
			cfg := l.cfg
			l.mu.Unlock()

			if change != nil {
				s.logf("the share is at %d lines, %d fps (lowered=%v)", change.Height, change.FPS, change.Lowered)
				l.reopen.Lock()
				if err := s.swapCapture(st, shareOptions(cfg, *change)); err != nil {
					s.logf("could not change the share: %v", err)
				}
				l.reopen.Unlock()
			}
		}
	}
}

func (s *Session) nextAU(kind string, st *shareState) ([]byte, error) {
	if kind == "s" {
		return s.sharing.next(st)
	}
	return st.cap.NextAU()
}

func (s *Session) closeCapture(kind string, st *shareState) {
	if kind == "s" {
		s.sharing.closeCap(st)
		return
	}
	st.cap.Close()
}
