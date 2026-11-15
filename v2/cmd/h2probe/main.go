// h2probe is the client without a window, for trying voice and screen share between two instances.
package main

import (
	"context"
	"flag"
	"fmt"
	"math"
	"os"
	"os/exec"
	"os/signal"
	"runtime/pprof"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"harmony/v2/internal/app"
	"harmony/v2/internal/audio"
	"harmony/v2/internal/video"
)

var pictures atomic.Int64

func main() {
	server := flag.String("server", "http://127.0.0.1:18280", "server address")
	srvPass := flag.String("server-password", "", "the server's door password, if it has one")
	nick := flag.String("nick", "alice", "nickname")
	pass := flag.String("pass", "hunter22", "account password")
	channel := flag.Int("channel", 2, "voice channel id")
	tone := flag.Float64("tone", 0, "send a tone of this many Hz as the microphone (0: silence)")
	shareSrc := flag.String("share", "", "share a screen: screen (the real one), test (a moving picture with a frame counter) or bars (the colour bars)")
	camSrc := flag.String("camera", "", "send the camera: camera (the real one), test (a moving picture) or bars (the colour bars)")
	encoder := flag.String("encoder", "", "video encoder backend for the share and camera: empty for automatic, or videotoolbox, nvidia, amd, intel, software")
	decoder := flag.String("decoder", "", "video decoder backend for the streams watched: empty for automatic, or videotoolbox, nvidia, amd, intel, software")
	hear := flag.String("expect-hear", "", "comma-separated nicknames that must be heard")
	watch := flag.String("expect-watch", "", "nickname whose screen share (or camera, with -watch-kind c) must be received and decoded")
	watchKind := flag.String("watch-kind", "s", "what to watch: s (screen share) or c (camera)")
	auto := flag.Bool("auto", true, "open every camera and share in the room by itself")
	preview := flag.Bool("preview", false, "also watch your own camera and share")
	box := flag.String("box", "", "size the pictures are drawn at, WxH; the decoders produce no more")
	expectBars := flag.Bool("expect-bars", false, "check that every stream of another person shows the colour bars (the share bars) in their exact colours")
	rebox := flag.String("rebox", "", "WxH@seconds: change the box to WxH after that many seconds")
	expect := flag.Int("expect-streams", 0, "how many streams of other people must produce at least 10 pictures")
	unwatchAt := flag.Duration("unwatch-at", 0, "let go of every stream after this long")
	pauseAt := flag.Duration("pause-at", 0, "pause the viewers after this long, and resume 4 s later")
	insecure := flag.Bool("insecure", false, "accept a self-signed certificate")
	dur := flag.Duration("for", 15*time.Second, "how long to stay")
	cpuProfile := flag.String("cpuprofile", "", "write a CPU profile of the probe here")
	flag.Parse()
	if *cpuProfile != "" {
		f, _ := os.Create(*cpuProfile)
		_ = pprof.StartCPUProfile(f)
		defer pprof.StopCPUProfile()
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	mixer := audio.NewMixer()
	opt := app.Options{
		Server: *server, ServerPassword: *srvPass, Insecure: *insecure, Loopback: true, Mixer: mixer,
		Logf: func(f string, a ...any) { fmt.Printf("[%s] "+f+"\n", append([]any{*nick}, a...)...) },
	}
	if *tone > 0 {
		opt.Mic = &app.ToneMic{Freq: *tone, Amp: 0.3}
	}
	opt.OnFrame = func() { pictures.Add(1) }
	sess, err := app.Connect(ctx, opt, *nick, *pass)
	if err != nil {
		fmt.Println("connect:", err)
		os.Exit(1)
	}
	defer sess.Close()
	sess.SetAutoWatch(*auto, *auto)
	sess.SetVideoDecoder(*decoder)

	var mixRMS, mixPeak float64
	meter := time.NewTicker(10 * time.Millisecond)
	go func() {
		buf := make([]int16, 480*2)
		var sum float64
		var n int
		for range meter.C {
			mixer.Mix(buf)
			for _, v := range buf {
				f := float64(v) / 32768
				sum += f * f
				n++
				mixPeak = math.Max(mixPeak, math.Abs(f))
			}
			if n > 48000 {
				mixRMS = math.Sqrt(sum / float64(n))
				sum, n = 0, 0
			}
		}
	}()

	if err := sess.Join(*channel); err != nil {
		fmt.Println("join:", err)
		os.Exit(1)
	}
	if *shareSrc != "" {
		if err := sess.StartShare(video.CaptureOptions{Source: *shareSrc, Encoder: *encoder, Height: 720, FPS: 30}); err != nil {
			fmt.Println("share:", err)
			os.Exit(1)
		}
	}

	if *camSrc != "" {
		if err := sess.StartCamera(app.CameraRequest{Source: *camSrc, Encoder: *encoder, Size: 360, Rate: 24}); err != nil {
			fmt.Println("camera:", err)
			os.Exit(1)
		}
	}

	boxW, boxH := 0, 0
	if *box != "" {
		w, h, _ := strings.Cut(*box, "x")
		boxW, _ = strconv.Atoi(w)
		boxH, _ = strconv.Atoi(h)
	}
	heard := map[string]bool{}
	best := map[string]uint64{}
	start := time.Now()
	deadline := time.After(*dur)
	tick := time.NewTicker(time.Second)
	var mark usage
	released, paused := false, false
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case <-deadline:
			break loop
		case <-tick.C:
			var line []string
			for _, p := range sess.Peers() {
				line = append(line, fmt.Sprintf("%s pkts=%d level=%.3f live=%v", p.Nick, p.Packets, p.Level, p.Live))
				if p.Level > 0.01 {
					heard[p.Nick] = true
				}
			}
			var streams []string
			for _, v := range sess.Streams() {
				if v.Own && !*preview || released {
					continue
				}
				if *preview && v.Own && !sess.Watching(v.Mid, v.Kind) {
					_ = sess.Watch(v.Mid, v.Kind)
				}
				if *watch != "" && v.Nick == *watch && v.Kind == *watchKind && !sess.Watching(v.Mid, v.Kind) {
					if err := sess.Watch(v.Mid, v.Kind); err != nil {
						fmt.Println("watch:", err)
					}
				}
				if size, at, ok := strings.Cut(*rebox, "@"); ok {
					if secs, _ := strconv.Atoi(at); time.Since(start) > time.Duration(secs)*time.Second {
						w, h, _ := strings.Cut(size, "x")
						boxW, _ = strconv.Atoi(w)
						boxH, _ = strconv.Atoi(h)
					}
				}
				if boxW > 0 {
					sess.SetBox(v.Mid, v.Kind, boxW, boxH)
				}
				streams = append(streams, fmt.Sprintf("%s/%s %s %dx%d pics=%d dec=%s %s", v.Nick, v.Kind, statusName[v.Status], v.W, v.H, v.Pictures, v.Decoder, v.Err))
				key := fmt.Sprintf("%s/%s", v.Nick, v.Kind)
				if v.Own {
					key += "(own)"
				}
				best[key] = max(best[key], v.Pictures)
			}
			fmt.Printf("[%s] peers: %s | mix rms=%.3f peak=%.2f | sent frames=%d cam=%d\n",
				*nick, strings.Join(line, "; "), mixRMS, mixPeak, sess.ShareFrames(), sess.CameraFrames())
			if len(streams) > 0 || released {
				fmt.Printf("[%s] streams: %s | wakes=%d | %s\n", *nick, strings.Join(streams, "; "), pictures.Load(), mark.sample())
			}
			if *unwatchAt > 0 && !released && time.Since(start) > *unwatchAt {
				released = true
				for _, v := range sess.Streams() {
					sess.Unwatch(v.Mid, v.Kind)
				}
				fmt.Printf("[%s] unwatched everything\n", *nick)
			}
			if *pauseAt > 0 && !paused && time.Since(start) > *pauseAt {
				paused = true
				sess.SetViewersPaused(true)
				fmt.Printf("[%s] paused\n", *nick)
				time.AfterFunc(4*time.Second, func() { sess.SetViewersPaused(false); fmt.Printf("[%s] resumed\n", *nick) })
			}
		}
	}

	failed := false
	if *expectBars {
		for _, v := range sess.Streams() {
			if v.Own || v.Watching && v.Pictures == 0 {
				continue
			}
			worst, ok := checkBars(sess.Frame(v.Mid, v.Kind))
			if ok && worst <= 4 {
				fmt.Printf("PASS %s/%s bars colours within %d of exact\n", v.Nick, v.Kind, worst)
			} else {
				fmt.Printf("FAIL %s/%s bars colours (decoded=%v, worst error %d)\n", v.Nick, v.Kind, ok, worst)
				failed = true
			}
		}
	}
	for _, who := range strings.Split(*hear, ",") {
		if who == "" {
			continue
		}
		if heard[who] {
			fmt.Printf("PASS heard %s\n", who)
		} else {
			fmt.Printf("FAIL did not hear %s\n", who)
			failed = true
		}
	}
	good := 0
	for key, n := range best {
		if n >= 10 && !strings.HasSuffix(key, "(own)") {
			good++
		}
	}
	if *expect > 0 {
		if good >= *expect {
			fmt.Printf("PASS %d streams decoded (%v)\n", good, best)
		} else {
			fmt.Printf("FAIL %d of %d streams decoded (%v)\n", good, *expect, best)
			failed = true
		}
	}
	if *watch != "" && *expect == 0 {
		if best[*watch+"/"+*watchKind] >= 10 {
			fmt.Printf("PASS watched %s (%d decoded pictures)\n", *watch, best[*watch+"/"+*watchKind])
		} else {
			fmt.Printf("FAIL watched %s: %v\n", *watch, best)
			failed = true
		}
	}
	if failed {
		os.Exit(1)
	}
}

var statusName = map[app.StreamStatus]string{app.StreamIdle: "idle", app.StreamConnecting: "connecting", app.StreamLive: "live", app.StreamFailed: "failed"}

type usage struct {
	at   time.Time
	self time.Duration
}

func cpuTime(pid int) (time.Duration, int) {
	out, err := exec.Command("ps", "-o", "cputime=,rss=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0, 0
	}
	f := strings.Fields(string(out))
	if len(f) < 2 {
		return 0, 0
	}
	var m, sec float64
	t := f[0]
	if i := strings.Index(t, ":"); i >= 0 {
		m, _ = strconv.ParseFloat(t[:i], 64)
		sec, _ = strconv.ParseFloat(t[i+1:], 64)
	}
	rss, _ := strconv.Atoi(f[1])
	return time.Duration((m*60 + sec) * float64(time.Second)), rss
}

// sample is the share of a core the probe used since the last sample, and what it holds.
func (u *usage) sample() string {
	now := time.Now()
	self, selfRSS := cpuTime(os.Getpid())
	span := now.Sub(u.at).Seconds()
	line := ""
	if !u.at.IsZero() && span > 0 {
		line = fmt.Sprintf("cpu probe=%.0f%% | ", float64(self-u.self)/float64(time.Second)/span*100)
	}
	u.at, u.self = now, self
	return fmt.Sprintf("%sprobe rss=%dMB", line, selfRSS/1024)
}

// checkBars compares the middle of each colour bar in the frame with the colours the bars source draws and returns the
// largest difference in any channel; ok is false when there is no picture.
func checkBars(f *video.Frame) (worst int, ok bool) {
	var pix []byte
	var w, h int
	f.View(0, func(p []byte, pw, ph int) { pix, w, h = append(pix, p...), pw, ph })
	if len(pix) == 0 {
		return 0, false
	}
	n := len(video.BarColours)
	for i, c := range video.BarColours {
		at := ((h/2)*w + (2*i+1)*w/(2*n)) * 4
		for ch := range 3 {
			worst = max(worst, abs(int(pix[at+ch])-int(c[ch])))
		}
	}
	return worst, true
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
