package app

import (
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"harmony/v2/internal/video"
)

// What the screen is told about the camera, as translation keys (it shows them in its hint banner).
const (
	NoteUnplugged    = "app.your_chosen_camera_is_unplugged"
	NoteSwitchFailed = "app.could_not_switch_camera"
	NoteStopped      = "app.the_camera_stopped_turn_it"
	NoteCouldNotOpen = "app.that_camera_could_not_be"
	NoteCannotDoThat = "app.that_camera_cannot_do_that"
	NoteReopenFailed = "app.the_camera_could_not_be"
)

const (
	blackLook    = 2500 * time.Millisecond
	blackEvery   = 250 * time.Millisecond
	blackRetries = 2
	blackLetGo   = 400 * time.Millisecond
)

// CameraRequest is what the person chose for the camera: which one ("" is the default), the size and rate (0 is native)
// and the encoder. Source is "camera" unless a synthetic one stands in for it.
type CameraRequest struct {
	Source  string
	Device  string
	Size    int
	Rate    int
	Encoder string
}

// cameraPart is what the session keeps of the camera: how it was asked for, whether there is another to switch to, the
// check for a black picture, and the note waiting for the screen.
type cameraPart struct {
	mu       sync.Mutex
	req      CameraRequest
	several  atomic.Bool
	healing  atomic.Bool
	flipping atomic.Bool
	probe    atomic.Pointer[video.BlackProbe]
	note     atomic.Pointer[string]
}

func (c *cameraPart) request() CameraRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.req
}

func (c *cameraPart) feed(au []byte) {
	if p := c.probe.Load(); p != nil {
		p.Feed(au)
	}
}

func (s *Session) cameraNote(key string) {
	s.camera.note.Store(&key)
	s.changed()
}

// TakeCameraNote is the translation key of what happened to the camera since it was last asked, or "".
func (s *Session) TakeCameraNote() string {
	if key := s.camera.note.Swap(nil); key != nil {
		return *key
	}
	return ""
}

// CanSwitchCamera is whether the camera that is on has another to switch to.
func (s *Session) CanSwitchCamera() bool { return s.camera.several.Load() }

// SwitchingCamera is whether SwitchCamera is at work.
func (s *Session) SwitchingCamera() bool { return s.camera.flipping.Load() }

// CameraDevice is the camera that is being sent ("" for the default one).
func (s *Session) CameraDevice() string { return s.camera.request().Device }

func (s *Session) cameraOn() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cam != nil
}

// StartCamera opens the camera as asked and sends it, and looks in the background at whether it gives a picture.
func (s *Session) StartCamera(req CameraRequest) error {
	probe, err := s.openCamera(req)
	if err != nil {
		return err
	}
	go s.healCamera(probe)
	return nil
}

func (s *Session) openCamera(req CameraRequest) (*video.BlackProbe, error) {
	if req.Source == "" {
		req.Source = "camera"
	}
	cameras := video.Cameras()
	s.camera.several.Store(len(cameras) > 1)
	if req.Device != "" && !slices.ContainsFunc(cameras, func(c video.Camera) bool { return c.ID == req.Device }) {
		s.cameraNote(NoteUnplugged)
		req.Device = ""
	}
	height, fps := req.Size, req.Rate
	if req.Source == "camera" {
		height, fps = video.CameraMode(req.Device, req.Size, req.Rate)
	} else {
		height, fps = video.CameraMode("", req.Size, req.Rate)
	}
	s.camera.mu.Lock()
	s.camera.req = req
	s.camera.mu.Unlock()
	probe := &video.BlackProbe{RequestKeyFrame: s.cameraKeyFrame}
	s.camera.probe.Store(probe)
	err := s.startVideo("c", video.CaptureOptions{
		Source: req.Source, Camera: req.Device, Encoder: req.Encoder, Height: height, FPS: fps,
		BitrateKbps: video.CameraBitrateKbps(height, fps),
	})
	if err != nil {
		s.camera.probe.CompareAndSwap(probe, nil)
		probe.Close()
		return nil, err
	}
	return probe, nil
}

func (s *Session) cameraKeyFrame() {
	s.mu.Lock()
	st := s.cam
	s.mu.Unlock()
	if st != nil {
		st.cap.KeyFrame()
	}
}

// healCamera looks at the pictures a camera that has just been opened sends, and when they are only black opens it again,
// up to twice: what a person does by hand with a webcam that comes up dark, while everybody watches a black square.
func (s *Session) healCamera(probe *video.BlackProbe) {
	if !s.camera.healing.CompareAndSwap(false, true) {
		s.dropProbe(probe)
		return
	}
	defer s.camera.healing.Store(false)
	for attempt := 1; ; attempt++ {
		black := s.watchBlack(probe)
		s.dropProbe(probe)
		if !black {
			if attempt > 1 {
				s.logf("the camera picture came back after %d reopening(s)", attempt-1)
			}
			return
		}
		if attempt > blackRetries {
			s.logf("the camera is still black after being opened again; left as it is")
			return
		}
		s.logf("the camera is delivering black pictures; opening it again (%d/%d)", attempt, blackRetries)
		req := s.camera.request()
		s.StopCamera()
		time.Sleep(blackLetGo)
		var err error
		if probe, err = s.openCamera(req); err != nil {
			s.logf("the camera could not be opened again: %v", err)
			s.cameraNote(NoteReopenFailed)
			return
		}
	}
}

func (s *Session) dropProbe(p *video.BlackProbe) {
	s.camera.probe.CompareAndSwap(p, nil)
	p.Close()
}

// watchBlack waits for the first picture with something in it, or for the look to run out with only black seen.
func (s *Session) watchBlack(p *video.BlackProbe) bool {
	end := time.Now().Add(blackLook)
	for time.Now().Before(end) {
		time.Sleep(blackEvery)
		if p.Lit() {
			return false
		}
		if !s.cameraOn() || s.camera.probe.Load() != p {
			return false
		}
	}
	return p.Verdict()
}

// FixVideo puts every picture back: each stream being watched is opened again from fresh key frames, and a camera that is
// on is looked at for black. It returns how many streams were opened again.
func (s *Session) FixVideo() int {
	vs := &s.viewers
	vs.mu.Lock()
	var list []*viewer
	for _, v := range vs.list {
		if !v.own {
			list = append(list, v)
		}
	}
	vs.mu.Unlock()
	opened := 0
	for _, v := range list {
		v.mu.Lock()
		running := v.cancel != nil
		v.mu.Unlock()
		if running {
			v.stop()
			v.start(time.Duration(opened) * stagger)
			opened++
		}
	}
	if s.cameraOn() && !s.camera.healing.Load() {
		probe := &video.BlackProbe{RequestKeyFrame: s.cameraKeyFrame}
		s.camera.probe.Store(probe)
		go s.healCamera(probe)
	}
	return opened
}

// SwitchCamera moves to the next camera, letting go of the one in use first (some cannot be held beside another). When the
// next one will not open the one that was in use is put back.
func (s *Session) SwitchCamera() {
	if !s.cameraOn() || !s.camera.flipping.CompareAndSwap(false, true) {
		return
	}
	defer func() {
		s.camera.flipping.Store(false)
		s.changed()
	}()
	prev := s.camera.request()
	cameras := video.Cameras()
	if len(cameras) < 2 {
		return
	}
	at := max(slices.IndexFunc(cameras, func(c video.Camera) bool { return c.ID == prev.Device }), 0)
	next := prev
	next.Device = cameras[(at+1)%len(cameras)].ID
	s.StopCamera()
	if err := s.StartCamera(next); err != nil {
		s.logf("could not switch camera: %v", err)
		s.cameraNote(NoteSwitchFailed)
		if err := s.StartCamera(prev); err != nil {
			s.cameraNote(NoteStopped)
		}
	}
}

// ChangeCamera moves a camera that is on to what was chosen now. A camera that will not do it is put back as it was, and
// the note says why; reverted is whether the choice was given up. quality is a change of size or rate only, which keeps the
// camera that is running.
func (s *Session) ChangeCamera(next, prev CameraRequest, quality bool) (note string, reverted bool) {
	if quality {
		next.Device, prev.Device = s.camera.request().Device, s.camera.request().Device
	}
	s.StopCamera()
	err := s.StartCamera(next)
	if err == nil {
		return "", false
	}
	s.logf("the camera could not be changed: %v", err)
	note = NoteCouldNotOpen
	if quality {
		note = NoteCannotDoThat
	}
	if s.StartCamera(prev) != nil {
		return NoteReopenFailed, true
	}
	return note, true
}
