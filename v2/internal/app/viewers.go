// Watching cameras and screen shares: many at once, each costing nothing until it is opened.
//
// A stream is watched by key (member, kind). Watching opens a WHEP subscription and starts one decoder, but only
// once the first key frame has told the picture's size, so the decoder can be made to produce the size the stream is
// drawn at (SetBox) and never more than was sent. Each stream has a video.Frame that lives from Watch to Unwatch,
// whatever the connection does, so the window keeps one texture per stream and uploads it when the version changed.
//
// The cost is bounded by what is asked for: Unwatch, a stream that ends, a member who leaves, SetViewersPaused and
// leaving the channel each release the subscription, the decoder and the picture buffers. A window that decides
// itself what is visible turns SetAutoWatch off and calls Watch and Unwatch as tiles come and go; otherwise cameras and
// shares are opened as soon as somebody starts them (as the Electron client does) and Unwatch closes one until it ends.
//
// Pictures reach the window without waking it more than needed: every decoded picture calls Options.OnFrame, which
// should do no more than redraw.Request (an atomic store), and the window then asks each Frame for its version while it
// is drawing. Session.Streams, Options.OnChange and the roster say when streams appear and go.
//
// Locks: s.mu is never held while taking viewerSet.mu, and viewerSet.mu before viewer.mu.
package app

import (
	"cmp"
	"context"
	"errors"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"harmony/v2/internal/audio"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/media"
	"harmony/v2/internal/video"
)

// StreamStatus is how far a watched picture has got.
type StreamStatus int

const (
	// StreamIdle: somebody is sending it and it is not being watched; nothing is received or decoded.
	StreamIdle StreamStatus = iota
	// StreamConnecting: being opened, or opened again after the line dropped; no picture yet.
	StreamConnecting
	// StreamLive: pictures are arriving.
	StreamLive
	// StreamFailed: it cannot be shown (the decoder cannot start, or nothing decodable arrives); Err says why.
	StreamFailed
)

// Stream is one camera ("c") or screen share ("s") in the room you are in, yours included.
type Stream struct {
	Mid      int
	Kind     string
	Nick     string
	Own      bool
	Watching bool
	Status   StreamStatus
	// W and H are the size of the picture now in the Frame; 0 before the first and while it is released (paused).
	W, H int
	// Pictures is how many were decoded, which is the Frame's version.
	Pictures uint64
	Err      string
	// Decoder is what decodes the picture: the codec's name (videotoolbox, mediafoundation or vaapi).
	Decoder string
	// User is the account that sends it.
	User int
	// Gain is how loud a share is played (1 as sent, 0 muted); NoAudio is set once a picture has shown for a few seconds
	// without any sound arriving, and for your own share when none is being captured.
	Gain    float64
	NoAudio bool
}

type streamKey struct {
	mid  int
	kind string
}

const (
	boxSettle     = 500 * time.Millisecond
	stagger       = 75 * time.Millisecond
	silentFor     = 20 * time.Second
	stuckFor      = 5 * time.Second
	maxStuck      = 3
	anyGeneration = -1
)

var defaultBox = map[string][2]int{"c": {640, 360}, "s": {1280, 720}}

type viewerSet struct {
	mu      sync.Mutex
	list    map[streamKey]*viewer
	closed  map[streamKey]bool
	paused  bool
	only    *streamKey
	manualC bool
	manualS bool
	mid     int
	roster  []hclient.Member
	listed  []Stream
}

// Watch starts receiving and decoding a stream; it returns at once and the picture follows (see Session.Streams and Frame).
// Your own mid shows what you are sending, decoded from your own encoder, without the relay.
// A stream that stops, or whose sender leaves, is let go by itself.
func (s *Session) Watch(mid int, kind string) error {
	if kind != "c" && kind != "s" {
		return errors.New("a stream is a camera (c) or a screen (s)")
	}
	s.mu.Lock()
	j := s.joined
	var nick string
	var sent bool
	if j != nil {
		for _, m := range s.rosters[j.ChannelID] {
			if m.Mid == mid && m.Publishes(kind) {
				nick, sent = m.Nickname, true
			}
		}
	}
	s.mu.Unlock()
	if j == nil {
		return ErrNotInVoice
	}
	if !sent {
		return errors.New("that stream is not being sent")
	}
	key := streamKey{mid, kind}
	vs := &s.viewers
	vs.mu.Lock()
	delete(vs.closed, key)
	if v := vs.list[key]; v != nil {
		vs.mu.Unlock()
		v.retry()
		return nil
	}
	v := vs.add(s, key, nick, mid == j.Mid)
	if vs.runs(key) {
		v.start(0)
	}
	vs.mu.Unlock()
	s.logf("watching %s's %s", nick, videoName(kind))
	s.changed()
	return nil
}

// Unwatch releases everything the stream used: the subscription, the decoder process and the picture's memory.
// A stream that was opened by auto-watch stays closed until it ends.
func (s *Session) Unwatch(mid int, kind string) {
	key := streamKey{mid, kind}
	vs := &s.viewers
	vs.mu.Lock()
	v := vs.list[key]
	delete(vs.list, key)
	if v != nil && !v.own && vs.has(key) {
		if vs.closed == nil {
			vs.closed = map[streamKey]bool{}
		}
		vs.closed[key] = true
	}
	vs.mu.Unlock()
	if v != nil {
		v.stop()
		s.changed()
	}
}

// Watching reports whether the stream is wanted, whether or not a picture has arrived yet.
func (s *Session) Watching(mid int, kind string) bool {
	s.viewers.mu.Lock()
	defer s.viewers.mu.Unlock()
	return s.viewers.list[streamKey{mid, kind}] != nil
}

// Frame is the stream's latest picture, or nil when it is not watched. The pointer stays valid until Unwatch, across
// reconnects and changes of size.
func (s *Session) Frame(mid int, kind string) *video.Frame {
	s.viewers.mu.Lock()
	defer s.viewers.mu.Unlock()
	if v := s.viewers.list[streamKey{mid, kind}]; v != nil {
		return v.frame
	}
	return nil
}

// SetBox tells the decoder the biggest size, in pixels, the stream is drawn at. The picture is decoded no larger than
// that (and never larger than it was sent), which is what keeps a small tile cheap. It is cheap to call on every
// layout; a change takes effect once it has held for half a second.
func (s *Session) SetBox(mid int, kind string, w, h int) {
	s.viewers.mu.Lock()
	v := s.viewers.list[streamKey{mid, kind}]
	s.viewers.mu.Unlock()
	if v != nil {
		v.setBox(w, h)
	}
}

// SetAutoWatch chooses which streams are opened as soon as somebody starts them (the Electron client's default: both).
func (s *Session) SetAutoWatch(cameras, shares bool) {
	s.viewers.mu.Lock()
	s.viewers.manualC, s.viewers.manualS = !cameras, !shares
	roster := s.viewers.roster
	s.viewers.mu.Unlock()
	s.syncViewers(roster)
}

// SetViewersPaused releases every decoder and subscription while the window is out of sight, and opens them again
// afterwards; what is watched is remembered.
func (s *Session) SetViewersPaused(paused bool) {
	vs := &s.viewers
	vs.mu.Lock()
	if vs.paused == paused {
		vs.mu.Unlock()
		return
	}
	vs.paused = paused
	var idle []*viewer
	for _, v := range vs.list {
		if paused {
			idle = append(idle, v)
		}
	}
	if !paused {
		for i, v := range vs.sorted() {
			if vs.runs(v.key) {
				v.start(time.Duration(i) * stagger)
			}
		}
	}
	vs.mu.Unlock()
	for _, v := range idle {
		v.stop()
	}
	s.changed()
}

// runs says whether a stream is decoded now: not while paused, and when one is picked, only that one.
func (vs *viewerSet) runs(key streamKey) bool {
	return !vs.paused && (vs.only == nil || *vs.only == key)
}

// SetViewersOnly decodes just the one stream and lets the others rest, for a window that shows one at a time; with on false
// every watched stream runs again. It is cheap to call on every frame.
func (s *Session) SetViewersOnly(mid int, kind string, on bool) {
	vs := &s.viewers
	key := streamKey{mid, kind}
	vs.mu.Lock()
	if on == (vs.only != nil) && (!on || *vs.only == key) {
		vs.mu.Unlock()
		return
	}
	vs.only = nil
	if on {
		vs.only = &key
	}
	var idle []*viewer
	for _, v := range vs.sorted() {
		if vs.runs(v.key) {
			v.start(0)
		} else {
			idle = append(idle, v)
		}
	}
	vs.mu.Unlock()
	for _, v := range idle {
		v.stop()
	}
	s.changed()
}

func (vs *viewerSet) add(s *Session, key streamKey, nick string, own bool) *viewer {
	if vs.list == nil {
		vs.list = map[streamKey]*viewer{}
	}
	box := defaultBox[key.kind]
	v := &viewer{s: s, key: key, nick: nick, own: own, boxW: box[0], boxH: box[1], frame: video.NewFrame(s.opt.OnFrame)}
	if s.opt.GPUFrames {
		v.frame.EnableGPU()
	}
	vs.list[key] = v
	return v
}

// has reports whether the stream is being sent, by the last roster.
func (vs *viewerSet) has(key streamKey) bool {
	for _, m := range vs.roster {
		if m.Mid == key.mid && m.Publishes(key.kind) {
			return true
		}
	}
	return false
}

func (vs *viewerSet) sorted() []*viewer {
	out := make([]*viewer, 0, len(vs.list))
	for _, v := range vs.list {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].key.mid < out[j].key.mid || out[i].key.mid == out[j].key.mid && out[i].key.kind < out[j].key.kind
	})
	return out
}

// syncViewers follows the roster: streams that ended are let go, new ones are opened if auto-watch says so.
func (s *Session) syncViewers(roster []hclient.Member) {
	s.mu.Lock()
	j := s.joined
	s.mu.Unlock()
	vs := &s.viewers
	vs.mu.Lock()
	if j == nil {
		vs.mu.Unlock()
		return
	}
	vs.roster, vs.mid = roster, j.Mid

	var gone []*viewer
	for key, v := range vs.list {
		if !vs.has(key) {
			gone = append(gone, v)
			delete(vs.list, key)
		}
	}
	for key := range vs.closed {
		if !vs.has(key) {
			delete(vs.closed, key)
		}
	}
	var fresh []*viewer
	for _, m := range roster {
		if m.Mid == j.Mid {
			continue
		}
		for _, kind := range [...]string{"c", "s"} {
			key := streamKey{m.Mid, kind}
			if !m.Publishes(kind) || vs.closed[key] || vs.list[key] != nil || kind == "c" && vs.manualC || kind == "s" && vs.manualS {
				continue
			}
			v := vs.add(s, key, m.Nickname, false)
			if vs.runs(key) {
				v.start(time.Duration(len(fresh)) * stagger)
			}
			fresh = append(fresh, v)
		}
	}
	vs.mu.Unlock()
	for _, v := range gone {
		v.stop()
		s.logf("%s's %s ended", v.nick, videoName(v.key.kind))
	}
	for _, v := range fresh {
		s.logf("watching %s's %s", v.nick, videoName(v.key.kind))
	}
	if len(gone)+len(fresh) > 0 {
		s.changed()
	}
}

// stopViewers lets go of every stream, and returns when the decoders are gone.
func (s *Session) stopViewers() {
	vs := &s.viewers
	vs.mu.Lock()
	all := vs.sorted()
	vs.list, vs.closed, vs.roster = nil, nil, nil
	vs.mu.Unlock()
	for _, v := range all {
		<-v.stop()
	}
}

// streams lists what is being sent in the room, with what is known of each that is watched. The result is in a buffer
// the next call reuses.
func (vs *viewerSet) streams(roster []hclient.Member, me int) []Stream {
	vs.mu.Lock()
	defer vs.mu.Unlock()
	out := vs.listed[:0]
	for _, m := range roster {
		for _, kind := range [...]string{"c", "s"} {
			if !m.Publishes(kind) {
				continue
			}
			st := Stream{Mid: m.Mid, Kind: kind, Nick: m.Nickname, Own: m.Mid == me, User: m.UserID, Gain: 1}
			if v := vs.list[streamKey{m.Mid, kind}]; v != nil {
				v.fill(&st)
			}
			out = append(out, st)
		}
	}
	slices.SortStableFunc(out, func(a, b Stream) int {
		return cmp.Or(cmp.Compare(a.Mid, b.Mid), strings.Compare(a.Kind, b.Kind))
	})
	vs.listed = out
	return out
}

// previewAU is called with every access unit this client sends, to show your own camera or share.
func (s *Session) previewAU(kind string, au []byte) {
	vs := &s.viewers
	vs.mu.Lock()
	v := vs.list[streamKey{vs.mid, kind}]
	vs.mu.Unlock()
	if v != nil {
		v.feed(anyGeneration, au)
	}
}

// A viewer has two locks. mu is for the small state State reads and is never held for long. dmu serializes the access
// units and the starting and stopping of the decoder, which take milliseconds. dmu is taken before mu.
type viewer struct {
	s     *Session
	key   streamKey
	nick  string
	own   bool
	frame *video.Frame
	aus   atomic.Int64

	asrc     atomic.Pointer[audio.Source]
	audioSub atomic.Pointer[media.VideoSubscription]
	noAudio  atomic.Bool

	mu         sync.Mutex
	cancel     context.CancelFunc
	last       chan struct{}
	ctx        context.Context
	gen        int
	boxW, boxH int
	resize     *time.Timer
	base       uint64
	failure    string

	dmu        sync.Mutex
	sub        *media.VideoSubscription
	dec        *video.Decoder
	decoding   atomic.Pointer[video.Decoder]
	srcW, srcH int
	srcColour  video.Colour
}

func (v *viewer) fill(st *Stream) {
	v.mu.Lock()
	defer v.mu.Unlock()
	st.Watching = true
	st.W, st.H = v.frame.Size()
	st.Pictures = v.frame.Version()
	st.Err = v.failure
	st.NoAudio = v.noAudio.Load()
	if d := v.decoding.Load(); d != nil {
		st.Decoder = d.Mode()
	}
	switch {
	case v.cancel == nil:
	case v.failure != "":
		st.Status = StreamFailed
	case st.Pictures > v.base:
		st.Status = StreamLive
	default:
		st.Status = StreamConnecting
	}
}

// start begins an attempt to show the stream; it does nothing when one is running. An attempt that was stopped is
// waited for first, so that two never share the subscription and the decoder.
func (v *viewer) start(delay time.Duration) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.cancel != nil {
		return
	}
	var ctx context.Context
	ctx, v.cancel = context.WithCancel(v.s.ctx)
	v.ctx, v.failure, v.base = ctx, "", v.frame.Version()
	prev, done := v.last, make(chan struct{})
	v.last = done
	go func() {
		defer close(done)
		defer v.frame.Release()
		defer v.release()
		if prev != nil {
			<-prev
		}
		v.run(ctx, delay)
	}()
}

// stop ends the attempt; the returned channel closes when the subscription, the decoder and the picture are gone.
func (v *viewer) stop() <-chan struct{} {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.cancel != nil {
		v.cancel()
		v.cancel = nil
	}
	if v.resize != nil {
		v.resize.Stop()
	}
	if v.last == nil {
		return closedChan
	}
	return v.last
}

var closedChan = func() chan struct{} {
	c := make(chan struct{})
	close(c)
	return c
}()

// retry opens a stream that failed again.
func (v *viewer) retry() {
	v.mu.Lock()
	failed := v.failure != ""
	v.mu.Unlock()
	if failed {
		v.stop()
		v.start(0)
	}
}

func (v *viewer) release() {
	v.dmu.Lock()
	sub, dec := v.sub, v.dec
	v.sub, v.dec, v.srcW, v.srcH = nil, nil, 0, 0
	v.audioSub.Store(nil)
	v.noAudio.Store(false)
	v.decoding.Store(nil)
	v.dmu.Unlock()
	if sub != nil {
		sub.Close()
	}
	if dec != nil {
		dec.Close()
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func (v *viewer) run(ctx context.Context, delay time.Duration) {
	if v.own {
		<-ctx.Done()
		return
	}
	if !sleep(ctx, delay) {
		return
	}
	if v.key.kind == "s" {
		src := v.s.mixer.NewSource(v.nick + "'s screen")
		v.asrc.Store(src)
		v.applyGain()
		defer func() {
			v.asrc.Store(nil)
			v.s.mixer.Remove(src)
		}()
	}
	backoff := 500 * time.Millisecond
	stuck := 0
	quiet := false
	for ctx.Err() == nil {
		t, channelID, ok := v.s.tokens()
		if !ok {
			return
		}
		gen := v.nextGeneration()
		var sink media.PCMSink
		if src := v.asrc.Load(); src != nil {
			sink = src
		}
		sub, err := v.s.engine.WatchShare(ctx, t.PeerURL(channelID, v.key.mid, v.key.kind), func(au []byte) { v.feed(gen, au) }, sink)
		if err != nil {
			if !errors.Is(err, media.ErrNotLive) && !quiet {
				quiet = true
				v.s.logf("watching %s's %s: %v", v.nick, videoName(v.key.kind), err)
			}
			if !sleep(ctx, backoff) {
				return
			}
			backoff = min(backoff*2, 8*time.Second)
			continue
		}
		backoff, quiet = 500*time.Millisecond, false
		v.dmu.Lock()
		v.sub = sub
		v.dmu.Unlock()
		v.audioSub.Store(sub)
		v.applyGain()
		end, pictured := v.supervise(ctx, sub)
		if pictured {
			stuck = 0
		}
		switch end {
		case verdictStuck:
			if stuck++; stuck >= maxStuck {
				v.fail("no picture could be decoded")
				return
			}
		case verdictEnded:
			return
		}
		v.release()
		if !sleep(ctx, backoff) {
			return
		}
	}
}

type verdict int

const (
	verdictDropped verdict = iota
	verdictStuck
	verdictEnded
)

// supervise watches a subscription until it fails, goes silent, or its pictures stop coming out of the decoder: the
// black tile that has packets arriving and nothing drawn.
func (v *viewer) supervise(ctx context.Context, sub *media.VideoSubscription) (end verdict, pictured bool) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	lastPictures := v.frame.Version()
	since := time.Now()
	started := since
	ausAtPicture := v.aus.Load()
	for n := 0; ; n++ {
		select {
		case <-ctx.Done():
			return verdictEnded, pictured
		case <-sub.Failed:
			return verdictDropped, pictured
		case <-tick.C:
		}
		v.mu.Lock()
		failure := v.failure
		v.mu.Unlock()
		aus := v.aus.Load()
		if v.key.kind == "s" && pictured {
			v.checkAudio(sub, started)
		}
		switch pictures := v.frame.Version(); {
		case failure != "":
			return verdictEnded, pictured
		case pictures != lastPictures:
			lastPictures, since, ausAtPicture, pictured = pictures, time.Now(), aus, true
		case sub.Silent() > silentFor:
			v.s.logf("%s's %s went silent on the wire: reconnecting", v.nick, videoName(v.key.kind))
			return verdictDropped, pictured
		case aus-ausAtPicture >= 3 && time.Since(since) > stuckFor:
			v.s.logf("%s's %s arrives but does not decode: opening it again", v.nick, videoName(v.key.kind))
			return verdictStuck, pictured
		case !pictured && n%2 == 1:
			sub.RequestKeyframe()
		}
	}
}

func (v *viewer) nextGeneration() int {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.gen++
	return v.gen
}

// applyGain puts the person's chosen level on the share's sound; a share turned down to nothing is not decoded.
func (v *viewer) applyGain() {
	src, sub := v.asrc.Load(), v.audioSub.Load()
	gain := v.s.StreamGain(v.s.userOf(v.key.mid))
	if src != nil {
		src.SetGain(gain)
	}
	if sub != nil {
		sub.SetAudioWanted(gain > 0)
	}
}

// checkAudio tells the window when a picture that has been showing for a while has no sound with it, and when some comes.
func (v *viewer) checkAudio(sub *media.VideoSubscription, since time.Time) {
	silent := sub.AudioPackets() == 0 && time.Since(since) > noAudioAfter
	if v.noAudio.Swap(silent) != silent {
		v.s.changed()
	}
}

func (v *viewer) fail(reason string) {
	v.mu.Lock()
	v.failure = reason
	v.mu.Unlock()
	v.s.logf("%s's %s: %s", v.nick, videoName(v.key.kind), reason)
	v.s.changed()
}

// feed takes one access unit, from the subscription or, for your own stream, from your encoder.
func (v *viewer) feed(gen int, au []byte) {
	v.mu.Lock()
	skip := v.cancel == nil || v.failure != "" || gen != anyGeneration && gen != v.gen
	v.mu.Unlock()
	if skip {
		return
	}
	v.aus.Add(1)
	v.dmu.Lock()
	var err error
	if p := video.ParsePicture(au); p.W > 0 && (p.W != v.srcW || p.H != v.srcH || p.Colour != v.srcColour || v.dec == nil) {
		v.srcW, v.srcH, v.srcColour = p.W, p.H, p.Colour
		err = v.startDecoder()
	}
	if err == nil && v.dec != nil && v.dec.Write(au) && v.sub != nil {
		v.sub.RequestKeyframe()
	}
	v.dmu.Unlock()
	if err != nil {
		v.fail(err.Error())
	}
}

// startDecoder (re)starts the decoder at the size the box allows for the picture the stream now has; dmu is held.
func (v *viewer) startDecoder() error {
	if v.dec != nil {
		v.dec.Close()
		v.dec = nil
		v.decoding.Store(nil)
	}
	v.mu.Lock()
	boxW, boxH := v.boxW, v.boxH
	v.mu.Unlock()
	w, h := fit(v.srcW, v.srcH, boxW, boxH)
	dec, err := v.s.newDecoder(w, h, v.srcColour, v.frame)
	if err != nil {
		return err
	}
	v.dec = dec
	v.decoding.Store(dec)
	return nil
}

func (v *viewer) setBox(w, h int) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if w == v.boxW && h == v.boxH || w <= 0 || h <= 0 {
		return
	}
	v.boxW, v.boxH = w, h
	if v.cancel == nil {
		return
	}
	if v.resize == nil {
		v.resize = time.AfterFunc(boxSettle, v.applyBox)
	} else {
		v.resize.Reset(boxSettle)
	}
}

func (v *viewer) applyBox() {
	v.dmu.Lock()
	defer v.dmu.Unlock()
	if v.dec == nil {
		return
	}
	v.mu.Lock()
	running, boxW, boxH := v.cancel != nil, v.boxW, v.boxH
	v.mu.Unlock()
	if w, _ := fit(v.srcW, v.srcH, boxW, boxH); !running || !worthRestarting(v.dec.W, w) {
		return
	}
	if err := v.startDecoder(); err != nil {
		go v.fail(err.Error())
	} else if v.sub != nil {
		v.sub.RequestKeyframe()
	}
}

// fit is the largest picture of the source's shape that is inside the box, never larger than the source, with even sides.
func fit(srcW, srcH, boxW, boxH int) (w, h int) {
	w, h = srcW, srcH
	if w > boxW || h > boxH {
		if w*boxH > h*boxW {
			w, h = boxW, h*boxW/w
		} else {
			w, h = w*boxH/h, boxH
		}
	}
	return max(w&^1, 2), max(h&^1, 2)
}

// worthRestarting is whether the picture is wanted enough bigger (a decoder start and a wait for a key frame) or
// enough smaller (memory and work saved) than it is now.
func worthRestarting(have, want int) bool {
	return want*100 > have*105 || want*10 < have*6
}
