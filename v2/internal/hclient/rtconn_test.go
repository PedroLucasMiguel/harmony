package hclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeServer answers hello and ping like the real one; mute makes it stop answering without closing, as a half-open socket does.
type fakeServer struct {
	*httptest.Server
	hellos  atomic.Int32
	mute    atomic.Bool
	mu      sync.Mutex
	current *websocket.Conn
	valid   atomic.Value
}

func newFakeServer() *fakeServer {
	f := &fakeServer{}
	f.valid.Store("good")
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		f.mu.Lock()
		f.current = conn
		f.mu.Unlock()
		ctx := r.Context()
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			if f.mute.Load() {
				continue
			}
			var m struct {
				Type  string `json:"type"`
				Rid   int    `json:"rid"`
				Token string `json:"token"`
			}
			_ = json.Unmarshal(data, &m)
			reply := map[string]any{"rid": m.Rid, "type": "pong"}
			if m.Type == "hello" {
				f.hellos.Add(1)
				pre, _ := json.Marshal(map[string]any{"type": "presence"})
				_ = conn.Write(ctx, websocket.MessageText, pre)
				if m.Token != f.valid.Load() {
					reply["type"] = "hello-failed"
					raw, _ := json.Marshal(reply)
					_ = conn.Write(ctx, websocket.MessageText, raw)
					_ = conn.Close(4401, "bad token")
					return
				}
				reply["type"], reply["voiceCap"] = "hello-ok", 25
			}
			raw, _ := json.Marshal(reply)
			_ = conn.Write(ctx, websocket.MessageText, raw)
		}
	}))
	return f
}

func (f *fakeServer) drop() {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = f.current.CloseNow()
}

func next(t *testing.T, r *RT) Message {
	t.Helper()
	select {
	case m, ok := <-r.Events:
		if !ok {
			t.Fatal("events closed")
		}
		if m.Type == "presence" {
			return next(t, r)
		}
		return m
	case <-time.After(5 * time.Second):
		t.Fatal("no event")
	}
	return Message{}
}

func shortTimes(t *testing.T) {
	saved := defaultTiming
	defaultTiming = timing{heartbeat: 50 * time.Millisecond, watchdog: 300 * time.Millisecond, ping: 100 * time.Millisecond, check: 20 * time.Millisecond, dial: time.Second, backoff: []time.Duration{10 * time.Millisecond}}
	t.Cleanup(func() { defaultTiming = saved })
}

func TestReconnectsAfterDropAndAfterSilence(t *testing.T) {
	shortTimes(t)
	srv := newFakeServer()
	defer srv.Close()
	client := New(srv.URL, "", false)
	client.Token = "good"
	rt, hello, err := Dial(context.Background(), client)
	if err != nil || hello.VoiceCap != 25 {
		t.Fatalf("dial: %v %+v", err, hello)
	}
	defer rt.Close()

	srv.drop()
	if m := next(t, rt); m.Type != EventDown {
		t.Fatalf("want down, got %s", m.Type)
	}
	if m := next(t, rt); m.Type != EventUp {
		t.Fatalf("want up, got %s", m.Type)
	}
	if _, err := rt.Request(context.Background(), "ping", nil); err != nil {
		t.Fatalf("request after reconnect: %v", err)
	}

	srv.mute.Store(true)
	if m := next(t, rt); m.Type != EventDown {
		t.Fatalf("watchdog: want down, got %s", m.Type)
	}
	srv.mute.Store(false)
	if m := next(t, rt); m.Type != EventUp {
		t.Fatalf("watchdog: want up, got %s", m.Type)
	}
	if srv.hellos.Load() != 3 {
		t.Fatalf("hellos: %d", srv.hellos.Load())
	}
}

func TestRejectedSessionAsksForANewOne(t *testing.T) {
	shortTimes(t)
	srv := newFakeServer()
	defer srv.Close()
	client := New(srv.URL, "", false)
	client.Token = "bad"
	if _, _, err := Dial(context.Background(), client); err != ErrRejected {
		t.Fatalf("want ErrRejected, got %v", err)
	}

	client.Token = "good"
	rt, _, err := Dial(context.Background(), client)
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	client.Relogin = func(context.Context) bool { client.Token = "newer"; srv.valid.Store("newer"); return true }
	srv.valid.Store("other")
	srv.drop()
	for _, want := range []string{EventDown, EventRejected, EventUp} {
		if m := next(t, rt); m.Type != want {
			t.Fatalf("want %s, got %s", want, m.Type)
		}
	}

	client.Relogin = nil
	srv.valid.Store("gone")
	srv.drop()
	for _, want := range []string{EventDown, EventRejected} {
		if m := next(t, rt); m.Type != want {
			t.Fatalf("want %s, got %s", want, m.Type)
		}
	}
	select {
	case <-rt.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("not over after a rejection")
	}
}
