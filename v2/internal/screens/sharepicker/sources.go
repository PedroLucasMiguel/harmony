package sharepicker

import (
	"sync"
	"time"

	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
	"harmony/v2/internal/video/native"
)

const (
	thumbWidth    = 320
	thumbInterval = 3 * time.Second
)

// thumb is one source's small picture: written by the loader, uploaded to a texture by the frame loop.
type thumb struct {
	surface widget.Surface
	mu      sync.Mutex
	pix     []byte
	w, h    int
	version uint64
}

func (t *thumb) View(have uint64, fn func(pix []byte, w, h int)) uint64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.version == have || t.pix == nil {
		return have
	}
	fn(t.pix, t.w, t.h)
	return t.version
}

func (t *thumb) set(pix []byte, w, h int) {
	t.mu.Lock()
	t.pix, t.w, t.h = pix, w, h
	t.version++
	t.mu.Unlock()
}

// catalog is what can be shared now, kept up to date while the picker is open.
type catalog struct {
	mu      sync.Mutex
	list    []native.SourceInfo
	loading bool
	loaded  bool
	thumbs  map[string]*thumb
	kind    native.SourceKind
	stop    chan struct{}
	gen     int
}

func (k *catalog) snapshot() (list []native.SourceInfo, loading bool) {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.list, k.loading
}

func (k *catalog) thumbFor(id string) *thumb {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.thumbs == nil {
		k.thumbs = map[string]*thumb{}
	}
	t := k.thumbs[id]
	if t == nil {
		t = &thumb{}
		k.thumbs[id] = t
	}
	return t
}

// load lists the sources again and refreshes the pictures of the ones on show.
func (k *catalog) load() {
	k.mu.Lock()
	if k.loading {
		k.mu.Unlock()
		return
	}
	k.loading = true
	k.gen++
	k.mu.Unlock()
	redraw.Request()
	go func() {
		list := native.Sources()
		k.mu.Lock()
		k.list, k.loading, k.loaded = list, false, true
		k.mu.Unlock()
		redraw.Request()
		k.refreshThumbs()
	}()
}

// refreshThumbs takes one new picture of every screen or window of the tab on show, one at a time.
func (k *catalog) refreshThumbs() {
	k.mu.Lock()
	list, kind := k.list, k.kind
	k.mu.Unlock()
	for _, s := range list {
		if s.Kind != kind || s.Kind == native.KindCamera {
			continue
		}
		select {
		case <-k.stop:
			return
		default:
		}
		if pix, w, h, ok := native.Thumbnail(s.ID, thumbWidth); ok {
			k.thumbFor(s.ID).set(pix, w, h)
			redraw.Request()
		}
	}
}

// watch keeps the pictures fresh until close.
func (k *catalog) watch() {
	k.stop = make(chan struct{})
	go func() {
		tick := time.NewTicker(thumbInterval)
		defer tick.Stop()
		for {
			select {
			case <-k.stop:
				return
			case <-tick.C:
				if k.settled() {
					k.refreshThumbs()
				}
			}
		}
	}()
}

func (k *catalog) settled() bool {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.loaded && !k.loading
}

func (k *catalog) setKind(kind native.SourceKind) {
	k.mu.Lock()
	k.kind = kind
	k.mu.Unlock()
	if k.settled() {
		go k.refreshThumbs()
	}
}

// close stops the loading and gives the textures back; the frame loop calls it.
func (k *catalog) close() {
	select {
	case <-k.stop:
	default:
		close(k.stop)
	}
	k.mu.Lock()
	for _, t := range k.thumbs {
		t.surface.Close()
	}
	k.thumbs = nil
	k.mu.Unlock()
}
