//go:build windows

package native

import (
	"testing"
	"unsafe"
)

func TestWinStructLayouts(t *testing.T) {
	check := func(name string, got, want uintptr) {
		if got != want {
			t.Errorf("%s: %d, want %d", name, got, want)
		}
	}
	check("guid", unsafe.Sizeof(guid{}), 16)
	check("MFT_REGISTER_TYPE_INFO", unsafe.Sizeof(mftRegisterTypeInfo{}), 32)
	check("MFT_OUTPUT_STREAM_INFO", unsafe.Sizeof(mftOutputStreamInfo{}), 12)
	check("MFVideoArea", unsafe.Sizeof(mfVideoArea{}), 16)
	var out mftOutputDataBuffer
	check("MFT_OUTPUT_DATA_BUFFER", unsafe.Sizeof(out), 4*ptrSize)
	check("MFT_OUTPUT_DATA_BUFFER.pSample", unsafe.Offsetof(out.sample), ptrSize)
	check("MFT_OUTPUT_DATA_BUFFER.dwStatus", unsafe.Offsetof(out.status), 2*ptrSize)
	check("MFT_OUTPUT_DATA_BUFFER.pEvents", unsafe.Offsetof(out.events), 3*ptrSize)
	var d dxgiAdapterDesc1
	check("DXGI_ADAPTER_DESC1", unsafe.Sizeof(d), 312)
	check("DXGI_ADAPTER_DESC1.VendorId", unsafe.Offsetof(d.vendorID), 256)
	check("DXGI_ADAPTER_DESC1.DedicatedVideoMemory", unsafe.Offsetof(d.dedicatedVideo), 272)
	check("DXGI_ADAPTER_DESC1.Flags", unsafe.Offsetof(d.flags), 304)
}

func TestWinGUIDMemoryLayout(t *testing.T) {
	g := mustGUID("bf94c121-5b05-4e6f-8000-ba598961414d") // IID_IMFTransform
	want := [16]byte{0x21, 0xc1, 0x94, 0xbf, 0x05, 0x5b, 0x6f, 0x4e, 0x80, 0x00, 0xba, 0x59, 0x89, 0x61, 0x41, 0x4d}
	if *(*[16]byte)(unsafe.Pointer(&g)) != want {
		t.Fatalf("GUID bytes % x", *(*[16]byte)(unsafe.Pointer(&g)))
	}
	if iidIUnknown.d4[0] != 0xc0 || iidIUnknown.d4[7] != 0x46 {
		t.Fatal("IID_IUnknown")
	}
	if guidVideoH264 != mustGUID("34363248-0000-0010-8000-00AA00389B71") {
		t.Fatal("upper case hex")
	}
}

func TestWinHRESULTCodes(t *testing.T) {
	for hr, code := range map[hresult]uint32{
		hrNeedMoreInput: 0xC00D6D72, hrStreamChange: 0xC00D6D61, hrTypeNotSet: 0xC00D6D60, hrNotAccepting: 0xC00D36B5,
		hrNoMoreTypes: 0xC00D36B9, hrAttrNotFound: 0xC00D36E6, hrShutdown: 0xC00D3E85, hrNoEvents: 0xC00D3E80,
		hrNotImpl: 0x80004001, hrNoInterface: 0x80004002, hrChangedMode: 0x80010106,
	} {
		if uint32(hr) != code {
			t.Errorf("%v is %#x, want %#x", hr, uint32(hr), code)
		}
	}
}
