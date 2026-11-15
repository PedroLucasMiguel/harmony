//go:build windows

// The graphics adapters of the machine through DXGI, which of them decode H.264, and a Direct3D 11 device on one of them
// for a Media Foundation transform to use.
package native

import (
	"syscall"
	"unsafe"
)

var (
	dllDXGI  = syscall.NewLazyDLL("dxgi.dll")
	dllD3D11 = syscall.NewLazyDLL("d3d11.dll")

	procCreateDXGIFactory1 = dllDXGI.NewProc("CreateDXGIFactory1")
	procD3D11CreateDevice  = dllD3D11.NewProc("D3D11CreateDevice")
)

// dxgiAdapterDesc1 is DXGI_ADAPTER_DESC1; Go's layout rules give the padding the C struct has.
type dxgiAdapterDesc1 struct {
	description     [128]uint16
	vendorID        uint32
	deviceID        uint32
	subSysID        uint32
	revision        uint32
	dedicatedVideo  uintptr
	dedicatedSystem uintptr
	sharedSystem    uintptr
	luidLow         uint32
	luidHigh        int32
	flags           uint32
}

const (
	pciNVIDIA = 0x10DE
	pciAMD    = 0x1002
	pciAMD2   = 0x1022
	pciIntel  = 0x8086

	dxgiAdapterFlagSoftware = 2
)

// vendorBackend is the Backend ID of a PCI vendor, "" for a vendor this client has no name for.
func vendorBackend(pci uint32) string {
	switch pci {
	case pciNVIDIA:
		return NVIDIA
	case pciAMD, pciAMD2:
		return AMD
	case pciIntel:
		return Intel
	}
	return ""
}

// winAdapter is one hardware graphics adapter.
type winAdapter struct {
	index    int
	pci      uint32
	name     string
	dedicate uintptr
	decodes  bool
}

// winAdapters lists the hardware adapters, with whether each decodes H.264 in hardware. The adapters, best first: the
// ones with the most video memory.
func winAdapters() []winAdapter {
	var list []winAdapter
	factory := new(uintptr)
	if hr := callProc(procCreateDXGIFactory1, iidIDXGIFactory1.p(), uintptr(unsafe.Pointer(factory))); hr.failed() {
		return nil
	}
	f := com(*factory)
	defer f.release()
	for i := 0; ; i++ {
		var ad uintptr
		if hr := f.call(12, uintptr(i), uintptr(unsafe.Pointer(&ad))); hr.failed() { // IDXGIFactory1::EnumAdapters1
			break
		}
		a := com(ad)
		var desc dxgiAdapterDesc1
		if hr := a.call(10, uintptr(unsafe.Pointer(&desc))); hr >= 0 && desc.flags&dxgiAdapterFlagSoftware == 0 { // GetDesc1
			wa := winAdapter{index: i, pci: desc.vendorID, name: syscall.UTF16ToString(desc.description[:]), dedicate: desc.dedicatedVideo}
			if dev, err := winD3DDevice(a); err == nil {
				wa.decodes = deviceDecodesH264(dev)
				dev.release()
			}
			list = append(list, wa)
		}
		a.release()
	}
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && list[j].dedicate > list[j-1].dedicate; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
	return list
}

// winD3DDevice makes a Direct3D 11 device on the adapter (0 is the default one), with video support and the protection a
// device that Media Foundation shares with its own threads needs.
func winD3DDevice(adapter com) (com, error) {
	const (
		driverHardware = 1
		driverUnknown  = 0
		flagBGRA       = 0x20
		flagVideo      = 0x800
		sdkVersion     = 7
	)
	driver := uintptr(driverHardware)
	if adapter != 0 {
		driver = driverUnknown
	}
	var dev uintptr
	if hr := callProc(procD3D11CreateDevice, uintptr(adapter), driver, 0, flagBGRA|flagVideo, 0, 0, sdkVersion,
		uintptr(unsafe.Pointer(&dev)), 0, 0); hr.failed() {
		return 0, hr.err("D3D11CreateDevice")
	}
	d := com(dev)
	if mt, err := d.queryInterface(&iidID3D11Multithread); err == nil {
		mt.call(5, 1) // SetMultithreadProtected(TRUE)
		mt.release()
	}
	return d, nil
}

// deviceDecodesH264 asks the device's video decoder for its profiles and looks for H.264 (VLD, no film grain).
func deviceDecodesH264(dev com) bool {
	vd, err := dev.queryInterface(&iidID3D11VideoDevice)
	if err != nil {
		return false
	}
	defer vd.release()
	var count uint32
	if hr := vd.call(11, uintptr(unsafe.Pointer(&count))); hr.failed() {
		return false
	}
	for i := uint32(0); i < count; i++ {
		var g guid
		if hr := vd.call(12, uintptr(i), uintptr(unsafe.Pointer(&g))); hr >= 0 && g == guidDecoderProfileH264NF {
			return true
		}
	}
	return false
}

// winDeviceFor makes the Direct3D device of the best H.264 decoding adapter of a vendor (a Backend ID), or of the default
// adapter when backend is "".
func winDeviceFor(backend string) (com, error) {
	if backend == "" {
		return winD3DDevice(0)
	}
	factory := new(uintptr)
	if hr := callProc(procCreateDXGIFactory1, iidIDXGIFactory1.p(), uintptr(unsafe.Pointer(factory))); hr.failed() {
		return 0, hr.err("CreateDXGIFactory1")
	}
	f := com(*factory)
	defer f.release()
	want := -1
	for _, a := range winAdapters() {
		if vendorBackend(a.pci) == backend && a.decodes {
			want = a.index
			break
		}
	}
	if want < 0 {
		return 0, ErrUnsupported
	}
	var ad uintptr
	if hr := f.call(12, uintptr(want), uintptr(unsafe.Pointer(&ad))); hr.failed() {
		return 0, hr.err("EnumAdapters1")
	}
	a := com(ad)
	defer a.release()
	return winD3DDevice(a)
}
