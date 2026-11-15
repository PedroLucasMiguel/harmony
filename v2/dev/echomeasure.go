//go:build ignore && darwin

// echomeasure plays a synthetic voice-like signal through the speakers and measures how loud it comes back on the microphone, with and without echo cancellation. Nothing captured is kept: only levels are computed.
package main

import (
	"fmt"
	"math"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"harmony/v2/internal/audio"
)

const rate = 48000

// voice makes stereo 48 kHz sound that moves like speech: a gliding pitch, vowel-like resonances and a syllable rhythm. peak is 0 to 1.
type voice struct {
	n    int
	peak float64
	tone bool
}

func (v *voice) fill(out []int16) {
	for i := 0; i < len(out)/2; i++ {
		t := float64(v.n) / rate
		v.n++
		var s float64
		if v.tone {
			s = math.Sin(2 * math.Pi * 1000 * t)
		} else {
			f0 := 120 + 40*math.Sin(2*math.Pi*0.7*t)
			syll := math.Max(0, math.Sin(2*math.Pi*3.2*t))
			phase := 2 * math.Pi * f0 * t
			formant := 700 + 500*math.Sin(2*math.Pi*0.9*t)
			for k := 1; k <= 40; k++ {
				fk := f0 * float64(k)
				w := math.Exp(-math.Pow((fk-formant)/350, 2)) + 0.6*math.Exp(-math.Pow((fk-2400)/500, 2)) + 0.05
				s += w * math.Sin(float64(k)*phase) / float64(k) * 4
			}
			s *= syll
		}
		q := int16(max(-1, min(1, s*v.peak)) * 32767)
		out[i*2], out[i*2+1] = q, q
	}
}

type meter struct {
	mu     sync.Mutex
	sum    float64
	n      int
	re, im float64
	t      int
}

func (m *meter) add(f []int16) {
	m.mu.Lock()
	for _, v := range f {
		m.sum += float64(v) * float64(v)
		a := 2 * math.Pi * 1000 * float64(m.t) / rate
		m.re += float64(v) * math.Cos(a)
		m.im += float64(v) * math.Sin(a)
		m.t++
	}
	m.n += len(f)
	m.mu.Unlock()
}

// take is the level of everything and of the 1 kHz component alone (a sine's dBFS) since the last call.
func (m *meter) take() (all, line float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.n == 0 {
		return math.Inf(-1), math.Inf(-1)
	}
	all = 10 * math.Log10(m.sum/float64(m.n)/(32768*32768))
	line = 20 * math.Log10(2*math.Hypot(m.re, m.im)/float64(m.n)/32768)
	m.sum, m.n, m.re, m.im = 0, 0, 0, 0
	return
}

func main() {
	var play atomic.Pointer[voice]
	var mic meter
	devices, err := audio.OpenDevices()
	if err != nil {
		fmt.Println("open:", err)
		os.Exit(1)
	}
	defer devices.Close()
	mixer := audio.NewMixer()
	source := mixer.NewSource("measure")
	go func() {
		tick := time.NewTicker(10 * time.Millisecond)
		buf := make([]int16, 960)
		for range tick.C {
			if v := play.Load(); v != nil {
				v.fill(buf)
				source.Push(buf)
			}
		}
	}()
	if err := devices.StartSpeakers(mixer); err != nil {
		fmt.Println("speakers:", err)
	}
	if err := devices.StartMicrophone(mic.add); err != nil {
		fmt.Println("microphone:", err)
	}

	run := func(name string, v *voice, seconds int) (float64, float64) {
		play.Store(v)
		mic.take()
		var all, lines []float64
		for range seconds {
			time.Sleep(time.Second)
			a, l := mic.take()
			all, lines = append(all, a), append(lines, l)
		}
		mean := func(list []float64) float64 {
			tail := list[len(list)/2:]
			var sum float64
			for _, d := range tail {
				sum += math.Pow(10, d/10)
			}
			return 10 * math.Log10(sum/float64(len(tail)))
		}
		fmt.Printf("%-30s all %5.1f\n%30s 1 kHz %5.1f\n", name, all, "", lines)
		return mean(all), mean(lines)
	}
	peak := 0.7
	if len(os.Args) > 1 {
		fmt.Sscan(os.Args[1], &peak)
	}
	fmt.Printf("synthetic signal peak %.2f of full scale\n", peak)
	var results [2][3]float64
	for i, on := range []bool{false, true} {
		devices.SetEchoCancellation(on)
		fmt.Printf("\n== echo cancellation %v ==\n", on)
		results[i][0], _ = run("room only", nil, 4)
		results[i][1], _ = run("voice-like playing", &voice{peak: peak}, 12)
		_, results[i][2] = run("1 kHz tone playing", &voice{peak: peak, tone: true}, 12)
	}
	fmt.Printf("\nvoice-like: off %.1f dBFS, on %.1f dBFS (room floor off %.1f, on %.1f): %.1f dB lower\n", results[0][1], results[1][1], results[0][0], results[1][0], results[0][1]-results[1][1])
	fmt.Printf("1 kHz tone: off %.1f dBFS, on %.1f dBFS: %.1f dB lower\n", results[0][2], results[1][2], results[0][2]-results[1][2])
}
