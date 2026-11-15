//go:build linux

package native

// Cameras through V4L2 from Go with ioctls and mmap'd buffers: the nodes that can capture, the format and size that give the
// asked frame rate, and a goroutine that waits for each picture in the kernel's own queue (no polling).

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

func v4l2Ioctl(fd int, req uintptr, arg unsafe.Pointer) error {
	for {
		_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), req, uintptr(arg))
		if errno == syscall.EINTR {
			continue
		}
		if errno != 0 {
			return errno
		}
		return nil
	}
}

// v4l2Nodes are the /dev/video* devices in numeric order.
func v4l2Nodes() []string {
	nodes, _ := filepath.Glob("/dev/video[0-9]*")
	sort.Slice(nodes, func(i, j int) bool {
		a, _ := strconv.Atoi(strings.TrimPrefix(nodes[i], "/dev/video"))
		b, _ := strconv.Atoi(strings.TrimPrefix(nodes[j], "/dev/video"))
		return a < b
	})
	return nodes
}

// v4l2Query says whether the node captures video with a format this package reads, and its name.
func v4l2Query(fd int) (name string, ok bool) {
	var capab v4l2Capability
	if v4l2Ioctl(fd, vidiocQueryCap, unsafe.Pointer(&capab)) != nil {
		return "", false
	}
	caps := capab.Capabilities
	if caps&v4l2CapDeviceCaps != 0 {
		caps = capab.DeviceCaps
	}
	if caps&v4l2CapVideoCapture == 0 || caps&v4l2CapStreaming == 0 || len(v4l2Formats(fd)) == 0 {
		return "", false
	}
	return cString(capab.Card[:]), true
}

func cString(b []byte) string {
	if i := strings.IndexByte(string(b), 0); i >= 0 {
		b = b[:i]
	}
	return string(b)
}

func listCameras() []CameraInfo {
	var out []CameraInfo
	for _, node := range v4l2Nodes() {
		f, err := os.OpenFile(node, os.O_RDWR, 0)
		if err != nil {
			continue
		}
		if name, ok := v4l2Query(int(f.Fd())); ok {
			out = append(out, CameraInfo{ID: node, Name: name})
		}
		f.Close()
	}
	return out
}

// v4l2Formats are the pixel formats of the device that this package reads.
func v4l2Formats(fd int) []uint32 {
	var out []uint32
	for i := uint32(0); i < 64; i++ {
		d := v4l2FmtDesc{Index: i, Type: v4l2BufTypeVideoCapture}
		if v4l2Ioctl(fd, vidiocEnumFmt, unsafe.Pointer(&d)) != nil {
			break
		}
		switch d.PixelFormat {
		case v4l2PixNV12, v4l2PixYUYV, v4l2PixMJPG:
			out = append(out, d.PixelFormat)
		}
	}
	return out
}

type v4l2Mode struct {
	fourcc uint32
	w, h   int
	fps    float64
}

// v4l2BestSize is the size of the format closest to the height wanted from above, the largest when none is tall enough.
func v4l2BestSize(fd int, fourcc uint32, wantH int) (w, h int) {
	for i := uint32(0); i < 128; i++ {
		e := v4l2FrmSizeEnum{Index: i, PixelFormat: fourcc}
		if v4l2Ioctl(fd, vidiocEnumFrameSizes, unsafe.Pointer(&e)) != nil {
			break
		}
		cw, ch := int(e.Union[0]), int(e.Union[1])
		if e.Type != v4l2FrmSizeDiscrete {
			// Stepwise: the range's own steps are rarely used by cameras; take the wanted height at 16:9 inside the range.
			ch = min(max(wantH, int(e.Union[3])), int(e.Union[4]))
			cw = min(max(ch*16/9, int(e.Union[0])), int(e.Union[1]))
		}
		better := h == 0 ||
			ch >= wantH && (h < wantH || ch < h || ch == h && cw > w) ||
			ch < wantH && h < wantH && ch > h
		if better {
			w, h = cw, ch
		}
		if e.Type != v4l2FrmSizeDiscrete {
			break
		}
	}
	return w, h
}

// v4l2MaxFPS is the highest frame rate the device has at the size.
func v4l2MaxFPS(fd int, fourcc uint32, w, h int) float64 {
	best := 0.0
	for i := uint32(0); i < 64; i++ {
		e := v4l2FrmIvalEnum{Index: i, PixelFormat: fourcc, Width: uint32(w), Height: uint32(h)}
		if v4l2Ioctl(fd, vidiocEnumFrameIvals, unsafe.Pointer(&e)) != nil {
			break
		}
		if e.Type != v4l2FrmIvalDiscrete {
			// Stepwise: the shortest interval is the first fraction.
			if e.Union[0] > 0 {
				best = max(best, float64(e.Union[1])/float64(e.Union[0]))
			}
			break
		}
		if e.Union[0] > 0 {
			best = max(best, float64(e.Union[1])/float64(e.Union[0]))
		}
	}
	return best
}

// v4l2Choose picks the format: of those that reach the frame rate the cheapest to convert (NV12, then YUYV, then JPEG),
// else the one with the highest rate. A camera that cannot say its rates counts as reaching it.
func v4l2Choose(fd int, wantH, wantFPS int) (v4l2Mode, error) {
	var modes []v4l2Mode
	for _, f := range v4l2Formats(fd) {
		w, h := v4l2BestSize(fd, f, wantH)
		if h == 0 {
			continue
		}
		fps := v4l2MaxFPS(fd, f, w, h)
		if fps == 0 {
			fps = float64(wantFPS)
		}
		modes = append(modes, v4l2Mode{f, w, h, fps})
	}
	if len(modes) == 0 {
		return v4l2Mode{}, errors.New("the camera has no picture format this client reads (NV12, YUYV or Motion-JPEG)")
	}
	rank := func(m v4l2Mode) int {
		switch m.fourcc {
		case v4l2PixNV12:
			return 0
		case v4l2PixYUYV:
			return 1
		}
		return 2
	}
	sort.SliceStable(modes, func(i, j int) bool { return rank(modes[i]) < rank(modes[j]) })
	for _, m := range modes {
		if m.fps >= float64(wantFPS)-0.5 {
			return m, nil
		}
	}
	best := modes[0]
	for _, m := range modes {
		if m.fps > best.fps {
			best = m
		}
	}
	return best, nil
}

type v4l2Camera struct {
	fd       int
	bufs     [][]byte
	conv     *camConverter
	sink     *captureSink
	onEnd    func(error)
	mode     string
	closing  chan struct{}
	finished chan struct{}
	once     sync.Once
}

func openCamera(p CaptureParams, onAU func([]byte), onEnd func(error)) (Capture, error) {
	node := p.CameraID
	if node == "" {
		cams := listCameras()
		if len(cams) == 0 {
			return nil, errors.New("no camera found")
		}
		node = cams[0].ID
	}
	fd, err := syscall.Open(node, syscall.O_RDWR|syscall.O_CLOEXEC, 0)
	if err != nil {
		switch err {
		case syscall.EACCES, syscall.EPERM:
			return nil, fmt.Errorf("the camera %s cannot be opened: add your user to the video group", node)
		case syscall.EBUSY:
			return nil, fmt.Errorf("the camera %s is in use by another program", node)
		}
		return nil, fmt.Errorf("the camera %s cannot be opened: %w", node, err)
	}
	c, err := startV4L2(fd, p, onAU, onEnd)
	if err != nil {
		syscall.Close(fd)
		return nil, err
	}
	return c, nil
}

func startV4L2(fd int, p CaptureParams, onAU func([]byte), onEnd func(error)) (*v4l2Camera, error) {
	if _, ok := v4l2Query(fd); !ok {
		return nil, errors.New("this device is not a camera this client can read")
	}
	m, err := v4l2Choose(fd, p.Height, p.FPS)
	if err != nil {
		return nil, err
	}
	f := v4l2Format{Type: v4l2BufTypeVideoCapture}
	f.Pix = v4l2PixFormat{Width: uint32(m.w), Height: uint32(m.h), PixelFormat: m.fourcc, Field: v4l2FieldNone}
	if err := v4l2Ioctl(fd, vidiocSFmt, unsafe.Pointer(&f)); err != nil {
		return nil, fmt.Errorf("the camera does not take %dx%d: %w", m.w, m.h, err)
	}
	m.w, m.h = int(f.Pix.Width), int(f.Pix.Height)
	if f.Pix.PixelFormat != m.fourcc || m.w < 2 || m.h < 2 {
		return nil, errors.New("the camera did not accept the picture format asked for")
	}
	parm := v4l2StreamParm{Type: v4l2BufTypeVideoCapture, Numerator: 1, Denominator: uint32(p.FPS)}
	v4l2Ioctl(fd, vidiocSParm, unsafe.Pointer(&parm))

	dw, dh := streamSize(m.w, m.h, p.Height)
	c := &v4l2Camera{fd: fd, onEnd: onEnd, closing: make(chan struct{}), finished: make(chan struct{})}
	c.conv = newCamConverter(m.fourcc, m.w, m.h, int(f.Pix.BytesPerLine), dw, dh)
	if err := c.mapBuffers(); err != nil {
		c.unmap()
		return nil, err
	}
	enc, err := newEncoder(EncodeParams{Width: dw, Height: dh, FPS: p.FPS, BitrateKbps: p.BitrateKbps, Matrix: p.Matrix, Backend: p.Backend}, onAU)
	if err != nil {
		c.unmap()
		return nil, err
	}
	c.mode = enc.Mode()
	c.sink = newCaptureSink(enc, dw, dh, p.FPS, p.Matrix, c.end)
	typ := int32(v4l2BufTypeVideoCapture)
	if err := v4l2Ioctl(fd, vidiocStreamOn, unsafe.Pointer(&typ)); err != nil {
		c.sink.close()
		c.unmap()
		return nil, fmt.Errorf("the camera does not start: %w", err)
	}
	go c.run()
	return c, nil
}

func (c *v4l2Camera) mapBuffers() error {
	req := v4l2RequestBuffers{Count: 4, Type: v4l2BufTypeVideoCapture, Memory: v4l2MemoryMMap}
	if err := v4l2Ioctl(c.fd, vidiocReqBufs, unsafe.Pointer(&req)); err != nil {
		return fmt.Errorf("the camera has no buffers: %w", err)
	}
	for i := uint32(0); i < req.Count; i++ {
		b := v4l2Buffer{Index: i, Type: v4l2BufTypeVideoCapture, Memory: v4l2MemoryMMap}
		if err := v4l2Ioctl(c.fd, vidiocQueryBuf, unsafe.Pointer(&b)); err != nil {
			return err
		}
		mem, err := syscall.Mmap(c.fd, int64(b.Offset), int(b.Length), syscall.PROT_READ, syscall.MAP_SHARED)
		if err != nil {
			return err
		}
		c.bufs = append(c.bufs, mem)
		if err := v4l2Ioctl(c.fd, vidiocQBuf, unsafe.Pointer(&b)); err != nil {
			return err
		}
	}
	if len(c.bufs) < 2 {
		return errors.New("the camera gave fewer than two buffers")
	}
	return nil
}

func (c *v4l2Camera) unmap() {
	for _, b := range c.bufs {
		syscall.Munmap(b)
	}
	c.bufs = nil
}

// run takes each picture off the kernel's queue (the call blocks until one is ready), converts it, and gives the buffer
// back at once.
func (c *v4l2Camera) run() {
	defer close(c.finished)
	for {
		b := v4l2Buffer{Type: v4l2BufTypeVideoCapture, Memory: v4l2MemoryMMap}
		if err := v4l2Ioctl(c.fd, vidiocDQBuf, unsafe.Pointer(&b)); err != nil {
			select {
			case <-c.closing:
			default:
				c.end(fmt.Errorf("the camera stopped: %w", err))
			}
			return
		}
		if int(b.Index) < len(c.bufs) && b.Flags&v4l2BufFlagError == 0 {
			if dst := c.sink.begin(frameNV12); dst != nil {
				if err := c.conv.convert(dst, c.bufs[b.Index][:min(int(b.BytesUsed), len(c.bufs[b.Index]))]); err != nil {
					c.sink.abort()
				} else {
					c.sink.commit()
				}
			}
		}
		if err := v4l2Ioctl(c.fd, vidiocQBuf, unsafe.Pointer(&b)); err != nil {
			select {
			case <-c.closing:
			default:
				c.end(fmt.Errorf("the camera stopped: %w", err))
			}
			return
		}
	}
}

func (c *v4l2Camera) end(err error) {
	c.once.Do(func() {
		select {
		case <-c.closing:
		default:
			go c.onEnd(err)
		}
	})
}

func (c *v4l2Camera) Mode() string { return "v4l2+" + c.mode }

func (c *v4l2Camera) KeyFrame() { c.sink.keyFrame() }

func (c *v4l2Camera) Close() {
	select {
	case <-c.closing:
		return
	default:
	}
	close(c.closing)
	typ := int32(v4l2BufTypeVideoCapture)
	v4l2Ioctl(c.fd, vidiocStreamOff, unsafe.Pointer(&typ))
	select {
	case <-c.finished:
	case <-time.After(2 * time.Second):
		// The driver did not wake the waiting call: the mappings stay, as a picture may still be written to them.
		c.sink.close()
		return
	}
	c.sink.close()
	c.unmap()
	syscall.Close(c.fd)
}
