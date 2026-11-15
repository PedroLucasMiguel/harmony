package app

import (
	"math"
	"sync"
	"time"

	"harmony/v2/internal/audio"
)

type MicSource interface {
	Start(onFrame func(frame []int16)) error
	Stop()
}

type DeviceMic struct{ Devices *audio.Devices }

func (m DeviceMic) Start(onFrame func([]int16)) error { return m.Devices.StartMicrophone(onFrame) }

func (m DeviceMic) Stop() { m.Devices.StopMicrophone() }

type ToneMic struct {
	Freq, Amp float64

	mu   sync.Mutex
	stop chan struct{}
}

func (t *ToneMic) Start(onFrame func([]int16)) error {
	t.mu.Lock()
	t.stop = make(chan struct{})
	stop := t.stop
	t.mu.Unlock()
	go func() {
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		var n int
		frame := make([]int16, 960)
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				for i := range frame {
					frame[i] = int16(t.Amp * 32767 * math.Sin(2*math.Pi*t.Freq*float64(n)/48000))
					n++
				}
				onFrame(frame)
			}
		}
	}()
	return nil
}

func (t *ToneMic) Stop() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.stop != nil {
		close(t.stop)
		t.stop = nil
	}
}

type SilentMic struct {
	mu   sync.Mutex
	stop chan struct{}
}

func (s *SilentMic) Start(onFrame func([]int16)) error {
	s.mu.Lock()
	s.stop = make(chan struct{})
	stop := s.stop
	s.mu.Unlock()
	go func() {
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		frame := make([]int16, 960)
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				onFrame(frame)
			}
		}
	}()
	return nil
}

func (s *SilentMic) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stop != nil {
		close(s.stop)
		s.stop = nil
	}
}
