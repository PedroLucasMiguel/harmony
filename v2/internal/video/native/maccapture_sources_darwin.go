//go:build darwin

package native

// What can be shared on a Mac, from ScreenCaptureKit: the displays and the windows with a title, a small picture of each
// (SCScreenshotManager), the permission question, and the content filter a capture starts from.

import (
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"sync"
	"time"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

type cgRect struct{ X, Y, W, H float64 }

// minWindowEdge hides the slivers (menu bar items, tooltips) that have a title and nothing to show.
const minWindowEdge = 100

var mcCG struct {
	once                                     sync.Once
	width, height, bytesPerRow, bitsPerPixel func(img uintptr) uint64
	provider                                 func(img uintptr) uintptr
	copyData                                 func(p uintptr) uintptr
	dataPtr                                  func(d uintptr) uintptr
	dataLen                                  func(d uintptr) int
	imageRelease                             func(img uintptr)
}

func mcCGLoad() {
	mcCG.once.Do(func() {
		purego.RegisterLibFunc(&mcCG.width, mc.cg, "CGImageGetWidth")
		purego.RegisterLibFunc(&mcCG.height, mc.cg, "CGImageGetHeight")
		purego.RegisterLibFunc(&mcCG.bytesPerRow, mc.cg, "CGImageGetBytesPerRow")
		purego.RegisterLibFunc(&mcCG.bitsPerPixel, mc.cg, "CGImageGetBitsPerPixel")
		purego.RegisterLibFunc(&mcCG.provider, mc.cg, "CGImageGetDataProvider")
		purego.RegisterLibFunc(&mcCG.copyData, mc.cg, "CGDataProviderCopyData")
		purego.RegisterLibFunc(&mcCG.dataPtr, mx.cf, "CFDataGetBytePtr")
		purego.RegisterLibFunc(&mcCG.dataLen, mx.cf, "CFDataGetLength")
		purego.RegisterLibFunc(&mcCG.imageRelease, mc.cg, "CGImageRelease")
	})
}

func mcLoadSCK() error {
	if err := mcLoad(); err != nil {
		return err
	}
	if _, err := purego.Dlopen("/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit", purego.RTLD_LAZY|purego.RTLD_GLOBAL); err != nil {
		return fmt.Errorf("ScreenCaptureKit is not available: %w", err)
	}
	return nil
}

// mcShareable is SCShareableContent, retained; the caller releases it.
func mcShareable() (objc.ID, error) {
	type result struct {
		content objc.ID
		err     string
	}
	ch := make(chan result, 1)
	blk := objc.NewBlock(func(_ objc.Block, content, err objc.ID) {
		if content != 0 {
			content.Send(objc.RegisterName("retain"))
		}
		ch <- result{content, mcErrorOrEmpty(err)}
	})
	mcClass("SCShareableContent").Send(objc.RegisterName("getShareableContentWithCompletionHandler:"), blk)
	r, err := mcWait(ch, 15*time.Second, "ScreenCaptureKit")
	blk.Release()
	if err != nil {
		return 0, err
	}
	if r.content == 0 {
		return 0, errors.New(r.err)
	}
	return r.content, nil
}

// mcDisplays is the displays of the content with the main one first.
func mcDisplays(content objc.ID) []objc.ID {
	displays := mcArray(objc.Send[objc.ID](content, objc.RegisterName("displays")))
	idSel := objc.RegisterName("displayID")
	main := mc.cgMainDisplay()
	for i, d := range displays {
		if objc.Send[uint32](d, idSel) == main && i > 0 {
			displays[0], displays[i] = displays[i], displays[0]
			break
		}
	}
	return displays
}

// mcShareableWindows are the windows worth offering: on screen, at the normal layer, with a title and a size.
func mcShareableWindows(content objc.ID) []objc.ID {
	var out []objc.ID
	for _, w := range mcArray(objc.Send[objc.ID](content, objc.RegisterName("windows"))) {
		if !objc.Send[bool](w, objc.RegisterName("isOnScreen")) || objc.Send[int](w, objc.RegisterName("windowLayer")) != 0 {
			continue
		}
		if mcGoString(objc.Send[objc.ID](w, objc.RegisterName("title"))) == "" || objc.Send[objc.ID](w, objc.RegisterName("owningApplication")) == 0 {
			continue
		}
		if f := objc.Send[cgRect](w, objc.RegisterName("frame")); f.W < minWindowEdge || f.H < minWindowEdge {
			continue
		}
		out = append(out, w)
	}
	return out
}

func listSources() []SourceInfo {
	if mcLoadSCK() != nil {
		return nil
	}
	defer mcPool()()
	content, err := mcShareable()
	if err != nil {
		return nil
	}
	defer mcRelease(content)
	var out []SourceInfo
	for i, d := range mcDisplays(content) {
		id := objc.Send[uint32](d, objc.RegisterName("displayID"))
		out = append(out, SourceInfo{
			ID: "screen:" + strconv.Itoa(int(id)), Kind: KindScreen, Name: "Screen " + strconv.Itoa(i+1),
			W: objc.Send[int](d, objc.RegisterName("width")), H: objc.Send[int](d, objc.RegisterName("height")),
		})
	}
	for _, w := range mcShareableWindows(content) {
		app := objc.Send[objc.ID](w, objc.RegisterName("owningApplication"))
		f := objc.Send[cgRect](w, objc.RegisterName("frame"))
		out = append(out, SourceInfo{
			ID: "window:" + strconv.Itoa(int(objc.Send[uint32](w, objc.RegisterName("windowID")))), Kind: KindWindow,
			Name: mcGoString(objc.Send[objc.ID](w, objc.RegisterName("title"))),
			App:  mcGoString(objc.Send[objc.ID](app, objc.RegisterName("applicationName"))),
			W:    int(f.W), H: int(f.H),
		})
	}
	return out
}

// mcFilter is a retained SCContentFilter for the source with this ID (the Display's index when there is none), and its
// size in points.
func mcFilter(sourceID string, display int) (filter objc.ID, w, h int, err error) {
	if err = mcLoadSCK(); err != nil {
		return
	}
	if !mc.cgPreflight() {
		mc.cgRequest()
		return 0, 0, 0, errors.New(screenPermission)
	}
	content, err := mcShareable()
	if err != nil {
		return
	}
	defer mcRelease(content)
	if id, ok := parseSourceNumber(sourceID, KindWindow); ok {
		for _, win := range mcArray(objc.Send[objc.ID](content, objc.RegisterName("windows"))) {
			if objc.Send[uint32](win, objc.RegisterName("windowID")) != id {
				continue
			}
			f := objc.Send[cgRect](win, objc.RegisterName("frame"))
			if f.W < 2 || f.H < 2 {
				break
			}
			filter = mcClass("SCContentFilter").Send(mc.selAlloc).Send(objc.RegisterName("initWithDesktopIndependentWindow:"), win)
			return filter, int(f.W), int(f.H), nil
		}
		return 0, 0, 0, errors.New("that window is gone")
	}
	displays := mcDisplays(content)
	var d objc.ID
	if id, ok := parseSourceNumber(sourceID, KindScreen); ok {
		for _, cand := range displays {
			if objc.Send[uint32](cand, objc.RegisterName("displayID")) == id {
				d = cand
			}
		}
		if d == 0 {
			return 0, 0, 0, errors.New("that screen is gone")
		}
	} else {
		if display < 0 || display >= len(displays) {
			return 0, 0, 0, fmt.Errorf("screen %d does not exist: there are %d", display, len(displays))
		}
		d = displays[display]
	}
	w, h = objc.Send[int](d, objc.RegisterName("width")), objc.Send[int](d, objc.RegisterName("height"))
	if w <= 0 || h <= 0 {
		return 0, 0, 0, errors.New("the screen has no size")
	}
	filter = mcClass("SCContentFilter").Send(mc.selAlloc).Send(objc.RegisterName("initWithDisplay:excludingWindows:"), d, mcNSArray())
	return filter, w, h, nil
}

func sourceThumbnail(id string, maxW int) (rgba []byte, w, h int, ok bool) {
	if mcLoadSCK() != nil || !mc.cgPreflight() {
		return nil, 0, 0, false
	}
	defer mcPool()()
	filter, sw, sh, err := mcFilter(id, 0)
	if err != nil {
		return nil, 0, 0, false
	}
	defer mcRelease(filter)
	manager := mcClass("SCScreenshotManager")
	if manager == 0 {
		return nil, 0, 0, false
	}
	tw := min(maxW, sw)
	th := max(2, tw*sh/sw)
	cfg := mcNewObject("SCStreamConfiguration")
	defer mcRelease(cfg)
	cfg.Send(objc.RegisterName("setWidth:"), uint(tw))
	cfg.Send(objc.RegisterName("setHeight:"), uint(th))
	cfg.Send(objc.RegisterName("setShowsCursor:"), false)
	ch := make(chan uintptr, 1)
	blk := objc.NewBlock(func(_ objc.Block, img, _ objc.ID) {
		if img != 0 {
			objc.Send[uintptr](img, objc.RegisterName("retain"))
		}
		ch <- uintptr(img)
	})
	manager.Send(objc.RegisterName("captureImageWithFilter:configuration:completionHandler:"), filter, cfg, blk)
	img, werr := mcWait(ch, 5*time.Second, "the screenshot")
	blk.Release()
	if werr != nil || img == 0 {
		return nil, 0, 0, false
	}
	mcCGLoad()
	defer mcCG.imageRelease(img)
	return mcImagePixels(img)
}

// mcImagePixels reads a 32 bit CGImage (BGRA, which is what ScreenCaptureKit makes) as RGBA.
func mcImagePixels(img uintptr) ([]byte, int, int, bool) {
	w, h, stride := int(mcCG.width(img)), int(mcCG.height(img)), int(mcCG.bytesPerRow(img))
	if mcCG.bitsPerPixel(img) != 32 || w <= 0 || h <= 0 || stride < w*4 {
		return nil, 0, 0, false
	}
	data := mcCG.copyData(mcCG.provider(img))
	if data == 0 {
		return nil, 0, 0, false
	}
	defer mxCFRelease(data)
	if mcCG.dataLen(data) < stride*(h-1)+w*4 {
		return nil, 0, 0, false
	}
	src := mxBytes(mcCG.dataPtr(data), stride*(h-1)+w*4)
	out := make([]byte, w*h*4)
	for y := 0; y < h; y++ {
		row, dst := src[y*stride:], out[y*w*4:]
		for x := 0; x < w; x++ {
			dst[x*4], dst[x*4+1], dst[x*4+2], dst[x*4+3] = row[x*4+2], row[x*4+1], row[x*4], 255
		}
	}
	return out, w, h, true
}

func screenAccess() bool {
	if mcLoad() != nil {
		return true
	}
	return mc.cgPreflight()
}

func openScreenSettings() {
	_ = exec.Command("open", "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture").Start()
}
