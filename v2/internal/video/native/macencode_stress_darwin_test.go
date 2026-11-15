//go:build darwin

package native

import (
	"sync"
	"testing"
	"time"
)

func deepStack(n int) int {
	var pad [512]byte
	if n == 0 {
		return int(pad[0])
	}
	return deepStack(n-1) + int(pad[n%512])
}

// Out-parameters of the C calls must not live on a Go stack, which may move while the call is made: that once crashed the
// process in CFRelease(NULL). Frames are sent from goroutines of every stack depth, with a slow consumer, KeyFrame and
// Close racing the senders.
func TestEncodeFromMovingStacks(t *testing.T) {
	if testing.Short() {
		t.Skip("uses the system's video encoder")
	}
	const w, h = 640, 360
	for round := 0; round < 3; round++ {
		enc, err := NewEncoder(EncodeParams{Width: w, Height: h, FPS: 30, BitrateKbps: 1500, Matrix: BT709}, func([]byte) { time.Sleep(time.Millisecond) })
		if err != nil {
			t.Skip(err)
		}
		pix := make([]byte, w*h*4)
		var wg sync.WaitGroup
		for i := 0; i < 150; i++ {
			wg.Add(1)
			go func(depth int) {
				defer wg.Done()
				deepStack(depth)
				if depth%7 == 0 {
					enc.KeyFrame()
				}
				enc.EncodeBGRA(pix, w*4)
			}(i % 40)
			time.Sleep(2 * time.Millisecond)
			if round == 2 && i == 100 {
				enc.Close()
			}
		}
		wg.Wait()
		enc.Close()
	}
}
