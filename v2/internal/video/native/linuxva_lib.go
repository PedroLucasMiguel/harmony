//go:build linux

package native

// VA-API through libva.so.2 and libva-drm.so.2 loaded at run time (no cgo): the library functions, the DRM render node
// scan, and a vaDisplay with the calls the decoder and the encoder make, each returning a Go error with libva's own text.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	pciVendorAMD    = 0x1002
	pciVendorIntel  = 0x8086
	pciVendorNVIDIA = 0x10de
)

type vaFuncs struct {
	getDisplayDRM       func(fd int32) uintptr
	initialize          func(dpy uintptr, major, minor *int32) int32
	terminate           func(dpy uintptr) int32
	errorStr            func(status int32) string
	queryVendorString   func(dpy uintptr) string
	maxNumEntrypoints   func(dpy uintptr) int32
	queryConfigEntrypts func(dpy uintptr, profile int32, eps *int32, n *int32) int32
	getConfigAttributes func(dpy uintptr, profile, entrypoint int32, attribs *vaConfigAttrib, n int32) int32
	createConfig        func(dpy uintptr, profile, entrypoint int32, attribs *vaConfigAttrib, n int32, id *vaConfigID) int32
	destroyConfig       func(dpy uintptr, id vaConfigID) int32
	createSurfaces      func(dpy uintptr, format, w, h uint32, surfaces *vaSurfaceID, n uint32, attribs *vaSurfaceAttrib, nAttribs uint32) int32
	destroySurfaces     func(dpy uintptr, surfaces *vaSurfaceID, n int32) int32
	createContext       func(dpy uintptr, cfg vaConfigID, w, h, flag int32, targets *vaSurfaceID, n int32, ctx *vaContextID) int32
	destroyContext      func(dpy uintptr, ctx vaContextID) int32
	createBuffer        func(dpy uintptr, ctx vaContextID, typ int32, size, num uint32, data unsafe.Pointer, buf *vaBufferID) int32
	mapBuffer           func(dpy uintptr, buf vaBufferID, p *unsafe.Pointer) int32
	unmapBuffer         func(dpy uintptr, buf vaBufferID) int32
	destroyBuffer       func(dpy uintptr, buf vaBufferID) int32
	beginPicture        func(dpy uintptr, ctx vaContextID, target vaSurfaceID) int32
	renderPicture       func(dpy uintptr, ctx vaContextID, bufs *vaBufferID, n int32) int32
	endPicture          func(dpy uintptr, ctx vaContextID) int32
	syncSurface         func(dpy uintptr, s vaSurfaceID) int32
	deriveImage         func(dpy uintptr, s vaSurfaceID, img *vaImage) int32
	createImage         func(dpy uintptr, format *vaImageFormat, w, h int32, img *vaImage) int32
	destroyImage        func(dpy uintptr, id vaImageID) int32
	getImage            func(dpy uintptr, s vaSurfaceID, x, y int32, w, h uint32, id vaImageID) int32
	putImage            func(dpy uintptr, s vaSurfaceID, id vaImageID, sx, sy int32, sw, sh uint32, dx, dy int32, dw, dh uint32) int32
	maxNumImageFormats  func(dpy uintptr) int32
	queryImageFormats   func(dpy uintptr, formats *vaImageFormat, n *int32) int32
}

var (
	vaLoadOnce sync.Once
	vaLib      vaFuncs
	vaLoadErr  error
)

const vaInstallLibva = "install libva (Debian/Ubuntu: libva2 and libva-drm2; Fedora: libva; Arch: libva)"

func loadVA() (*vaFuncs, error) {
	vaLoadOnce.Do(func() { vaLoadErr = vaLib.load() })
	if vaLoadErr != nil {
		return nil, vaLoadErr
	}
	return &vaLib, nil
}

func (f *vaFuncs) load() error {
	main, err := purego.Dlopen("libva.so.2", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return fmt.Errorf("VA-API is not available (%v): %s", err, vaInstallLibva)
	}
	drm, err := purego.Dlopen("libva-drm.so.2", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return fmt.Errorf("VA-API is not available (%v): %s", err, vaInstallLibva)
	}
	var bad []string
	reg := func(fptr any, lib uintptr, name string) {
		if _, err := purego.Dlsym(lib, name); err != nil {
			bad = append(bad, name)
			return
		}
		purego.RegisterLibFunc(fptr, lib, name)
	}
	reg(&f.getDisplayDRM, drm, "vaGetDisplayDRM")
	reg(&f.initialize, main, "vaInitialize")
	reg(&f.terminate, main, "vaTerminate")
	reg(&f.errorStr, main, "vaErrorStr")
	reg(&f.queryVendorString, main, "vaQueryVendorString")
	reg(&f.maxNumEntrypoints, main, "vaMaxNumEntrypoints")
	reg(&f.queryConfigEntrypts, main, "vaQueryConfigEntrypoints")
	reg(&f.getConfigAttributes, main, "vaGetConfigAttributes")
	reg(&f.createConfig, main, "vaCreateConfig")
	reg(&f.destroyConfig, main, "vaDestroyConfig")
	reg(&f.createSurfaces, main, "vaCreateSurfaces")
	reg(&f.destroySurfaces, main, "vaDestroySurfaces")
	reg(&f.createContext, main, "vaCreateContext")
	reg(&f.destroyContext, main, "vaDestroyContext")
	reg(&f.createBuffer, main, "vaCreateBuffer")
	reg(&f.mapBuffer, main, "vaMapBuffer")
	reg(&f.unmapBuffer, main, "vaUnmapBuffer")
	reg(&f.destroyBuffer, main, "vaDestroyBuffer")
	reg(&f.beginPicture, main, "vaBeginPicture")
	reg(&f.renderPicture, main, "vaRenderPicture")
	reg(&f.endPicture, main, "vaEndPicture")
	reg(&f.syncSurface, main, "vaSyncSurface")
	reg(&f.deriveImage, main, "vaDeriveImage")
	reg(&f.createImage, main, "vaCreateImage")
	reg(&f.destroyImage, main, "vaDestroyImage")
	reg(&f.getImage, main, "vaGetImage")
	reg(&f.putImage, main, "vaPutImage")
	reg(&f.maxNumImageFormats, main, "vaMaxNumImageFormats")
	reg(&f.queryImageFormats, main, "vaQueryImageFormats")
	if len(bad) > 0 {
		return fmt.Errorf("libva is too old or broken (no %s): %s", strings.Join(bad, ", "), vaInstallLibva)
	}
	return nil
}

// vaRenderNode is a DRM render node and the PCI vendor of the device behind it (0 when sysfs does not say).
type vaRenderNode struct {
	Path   string
	Vendor uint32
}

func vaRenderNodes() []vaRenderNode {
	paths, _ := filepath.Glob("/dev/dri/renderD*")
	sort.Strings(paths)
	nodes := make([]vaRenderNode, 0, len(paths))
	for _, p := range paths {
		n := vaRenderNode{Path: p}
		if b, err := os.ReadFile("/sys/class/drm/" + filepath.Base(p) + "/device/vendor"); err == nil {
			v, _ := strconv.ParseUint(strings.TrimSpace(string(b)), 0, 32)
			n.Vendor = uint32(v)
		}
		nodes = append(nodes, n)
	}
	return nodes
}

// deviceName is what sysfs and the user's PCI database say of the device behind the node: the driver's own vendor
// string is the fallback.
func (n vaRenderNode) deviceName() string {
	base := "/sys/class/drm/" + filepath.Base(n.Path) + "/device/"
	for _, f := range []string{"product_name", "label"} {
		if b, err := os.ReadFile(base + f); err == nil && len(strings.TrimSpace(string(b))) > 0 {
			return strings.TrimSpace(string(b))
		}
	}
	switch n.Vendor {
	case pciVendorAMD:
		return "AMD graphics"
	case pciVendorIntel:
		return "Intel graphics"
	}
	return "Graphics"
}

func vaDriverHint(vendor uint32) string {
	switch vendor {
	case pciVendorIntel:
		return "install the Intel VA-API driver: intel-media-va-driver (Debian/Ubuntu, Gen8 and newer), intel-media-driver (Fedora, Arch) or i965-va-driver for older chips"
	case pciVendorAMD:
		return "install the AMD VA-API driver: mesa-va-drivers (Debian/Ubuntu), mesa-va-drivers-freeworld from RPM Fusion (Fedora, whose own Mesa has no H.264) or libva-mesa-driver (Arch)"
	}
	return "install the VA-API driver of your graphics card (Intel: intel-media-va-driver, AMD: mesa-va-drivers)"
}

// vaDisplay is an initialised VA-API display on one render node.
type vaDisplay struct {
	fn         *vaFuncs
	file       *os.File
	dpy        uintptr
	Node       vaRenderNode
	Vendor     string
	Entrypoint int32
}

func (d *vaDisplay) Close() {
	if d.dpy != 0 {
		d.fn.terminate(d.dpy)
		d.dpy = 0
	}
	if d.file != nil {
		d.file.Close()
		d.file = nil
	}
}

func (d *vaDisplay) errorf(op string, status int32) error {
	return fmt.Errorf("VA-API %s: %s (0x%x)", op, d.fn.errorStr(status), uint32(status))
}

func (d *vaDisplay) check(op string, status int32) error {
	if status != vaStatusSuccess {
		return d.errorf(op, status)
	}
	return nil
}

// openVANode opens one render node and checks that the driver has one of the entrypoints for the profile; the entrypoint
// found first is left in the display's Entrypoint.
func openVANode(fn *vaFuncs, node vaRenderNode, profile int32, entrypoints []int32) (*vaDisplay, error) {
	f, err := os.OpenFile(node.Path, os.O_RDWR, 0)
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return nil, fmt.Errorf("%s cannot be opened (%v): add your user to the render group", node.Path, err)
		}
		return nil, err
	}
	dpy := fn.getDisplayDRM(int32(f.Fd()))
	if dpy == 0 {
		f.Close()
		return nil, fmt.Errorf("%s: libva cannot use this device", node.Path)
	}
	d := &vaDisplay{fn: fn, file: f, dpy: dpy, Node: node}
	var major, minor int32
	if st := fn.initialize(dpy, &major, &minor); st != vaStatusSuccess {
		d.dpy = 0
		d.Close()
		return nil, fmt.Errorf("%s: the VA-API driver did not start (%s): %s", node.Path, fn.errorStr(st), vaDriverHint(node.Vendor))
	}
	d.Vendor = fn.queryVendorString(dpy)
	for _, ep := range entrypoints {
		if d.hasEntrypoint(profile, ep) {
			d.Entrypoint = ep
			return d, nil
		}
	}
	d.Close()
	return nil, fmt.Errorf("%s: the VA-API driver (%s) has no H.264 hardware codec for this job: %s", node.Path, d.Vendor, vaDriverHint(node.Vendor))
}

// openVADisplay opens the first render node of the vendor (0 for any vendor that VA-API serves, so not NVIDIA) whose
// driver offers one of the entrypoints for the profile. The error says what to install.
func openVADisplay(vendor uint32, profile int32, entrypoints ...int32) (*vaDisplay, error) {
	fn, err := loadVA()
	if err != nil {
		return nil, err
	}
	nodes := vaRenderNodes()
	if len(nodes) == 0 {
		return nil, errors.New("no graphics device found (/dev/dri/renderD* is missing): the graphics driver is not loaded, or this system has no GPU")
	}
	var reasons []string
	for _, n := range nodes {
		if vendor != 0 && n.Vendor != vendor || vendor == 0 && n.Vendor == pciVendorNVIDIA {
			continue
		}
		d, err := openVANode(fn, n, profile, entrypoints)
		if err == nil {
			return d, nil
		}
		reasons = append(reasons, err.Error())
	}
	if len(reasons) == 0 {
		return nil, errors.New("no graphics device of the chosen make has a VA-API render node")
	}
	return nil, errors.New(strings.Join(reasons, "; "))
}

func (d *vaDisplay) hasEntrypoint(profile, entrypoint int32) bool {
	n := d.fn.maxNumEntrypoints(d.dpy)
	if n <= 0 || n > 64 {
		return false
	}
	eps := make([]int32, n)
	var got int32
	if d.fn.queryConfigEntrypts(d.dpy, profile, &eps[0], &got) != vaStatusSuccess {
		return false
	}
	for _, e := range eps[:min(got, n)] {
		if e == entrypoint {
			return true
		}
	}
	return false
}

// configAttributes fills in the Value of each attribute (vaAttribNotSupported when the driver lacks it).
func (d *vaDisplay) configAttributes(profile, entrypoint int32, attribs []vaConfigAttrib) error {
	if len(attribs) == 0 {
		return nil
	}
	return d.check("vaGetConfigAttributes", d.fn.getConfigAttributes(d.dpy, profile, entrypoint, &attribs[0], int32(len(attribs))))
}

func (d *vaDisplay) createConfig(profile, entrypoint int32, attribs []vaConfigAttrib) (vaConfigID, error) {
	var id vaConfigID
	var p *vaConfigAttrib
	if len(attribs) > 0 {
		p = &attribs[0]
	}
	err := d.check("vaCreateConfig", d.fn.createConfig(d.dpy, profile, entrypoint, p, int32(len(attribs)), &id))
	return id, err
}

func (d *vaDisplay) destroyConfig(id vaConfigID) { d.fn.destroyConfig(d.dpy, id) }

// createSurfaces makes n surfaces of the RT format (vaRTFormatYUV420) with the NV12 pixel format.
func (d *vaDisplay) createSurfaces(format uint32, w, h, n int, usage int) ([]vaSurfaceID, error) {
	attribs := []vaSurfaceAttrib{vaIntAttrib(vaSurfaceAttribPixelFormat, vaFourccNV12)}
	if usage != 0 {
		attribs = append(attribs, vaIntAttrib(vaSurfaceAttribUsageHint, usage))
	}
	ids := make([]vaSurfaceID, n)
	err := d.check("vaCreateSurfaces", d.fn.createSurfaces(d.dpy, format, uint32(w), uint32(h), &ids[0], uint32(n), &attribs[0], uint32(len(attribs))))
	if err != nil {
		return nil, err
	}
	return ids, nil
}

func (d *vaDisplay) destroySurfaces(ids []vaSurfaceID) {
	if len(ids) > 0 {
		d.fn.destroySurfaces(d.dpy, &ids[0], int32(len(ids)))
	}
}

func (d *vaDisplay) createContext(cfg vaConfigID, w, h int, targets []vaSurfaceID) (vaContextID, error) {
	var ctx vaContextID
	err := d.check("vaCreateContext", d.fn.createContext(d.dpy, cfg, int32(w), int32(h), vaProgressive, &targets[0], int32(len(targets)), &ctx))
	return ctx, err
}

func (d *vaDisplay) destroyContext(ctx vaContextID) { d.fn.destroyContext(d.dpy, ctx) }

// createBuffer copies size*num bytes from data into a new buffer (data may be nil for a buffer the driver fills, such as
// a coded buffer: size is then its capacity).
func (d *vaDisplay) createBuffer(ctx vaContextID, typ int32, size, num int, data unsafe.Pointer) (vaBufferID, error) {
	var id vaBufferID
	err := d.check("vaCreateBuffer", d.fn.createBuffer(d.dpy, ctx, typ, uint32(size), uint32(num), data, &id))
	return id, err
}

func (d *vaDisplay) mapBuffer(id vaBufferID) (unsafe.Pointer, error) {
	var p unsafe.Pointer
	if err := d.check("vaMapBuffer", d.fn.mapBuffer(d.dpy, id, &p)); err != nil {
		return nil, err
	}
	return p, nil
}

func (d *vaDisplay) unmapBuffer(id vaBufferID)   { d.fn.unmapBuffer(d.dpy, id) }
func (d *vaDisplay) destroyBuffer(id vaBufferID) { d.fn.destroyBuffer(d.dpy, id) }

func (d *vaDisplay) beginPicture(ctx vaContextID, target vaSurfaceID) error {
	return d.check("vaBeginPicture", d.fn.beginPicture(d.dpy, ctx, target))
}

// renderPicture sends buffers; the caller still destroys them after endPicture.
func (d *vaDisplay) renderPicture(ctx vaContextID, bufs ...vaBufferID) error {
	return d.check("vaRenderPicture", d.fn.renderPicture(d.dpy, ctx, &bufs[0], int32(len(bufs))))
}

func (d *vaDisplay) endPicture(ctx vaContextID) error {
	return d.check("vaEndPicture", d.fn.endPicture(d.dpy, ctx))
}

func (d *vaDisplay) syncSurface(s vaSurfaceID) error {
	return d.check("vaSyncSurface", d.fn.syncSurface(d.dpy, s))
}

// deriveImage gives direct access to a surface's memory; unmap with unmapBuffer(img.Buf) and destroyImage.
func (d *vaDisplay) deriveImage(s vaSurfaceID, img *vaImage) error {
	return d.check("vaDeriveImage", d.fn.deriveImage(d.dpy, s, img))
}

func (d *vaDisplay) createImage(format *vaImageFormat, w, h int, img *vaImage) error {
	return d.check("vaCreateImage", d.fn.createImage(d.dpy, format, int32(w), int32(h), img))
}

func (d *vaDisplay) destroyImage(id vaImageID) { d.fn.destroyImage(d.dpy, id) }

func (d *vaDisplay) getImage(s vaSurfaceID, w, h int, id vaImageID) error {
	return d.check("vaGetImage", d.fn.getImage(d.dpy, s, 0, 0, uint32(w), uint32(h), id))
}

// putImage copies the top left w by h pixels of the image into the surface.
func (d *vaDisplay) putImage(s vaSurfaceID, id vaImageID, w, h int) error {
	return d.check("vaPutImage", d.fn.putImage(d.dpy, s, id, 0, 0, uint32(w), uint32(h), 0, 0, uint32(w), uint32(h)))
}

// imageFormat finds the driver's image format with the fourcc (NV12).
func (d *vaDisplay) imageFormat(fourcc uint32) (vaImageFormat, bool) {
	n := d.fn.maxNumImageFormats(d.dpy)
	if n <= 0 || n > 128 {
		return vaImageFormat{}, false
	}
	fmts := make([]vaImageFormat, n)
	var got int32
	if d.fn.queryImageFormats(d.dpy, &fmts[0], &got) != vaStatusSuccess {
		return vaImageFormat{}, false
	}
	for _, f := range fmts[:min(got, n)] {
		if f.Fourcc == fourcc {
			return f, true
		}
	}
	return vaImageFormat{}, false
}
