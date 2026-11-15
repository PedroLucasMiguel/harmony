package native

import (
	"testing"
	"unsafe"
)

func TestD3DLayouts(t *testing.T) {
	for _, c := range []struct {
		name      string
		got, want uintptr
	}{
		{"D3D11_TEXTURE2D_DESC", unsafe.Sizeof(d3dTexture2DDesc{}), 44},
		{"D3D11_MAPPED_SUBRESOURCE", unsafe.Sizeof(d3dMappedSubresource{}), 16},
		{"DXGI_OUTDUPL_DESC", unsafe.Sizeof(dxgiOutDuplDesc{}), 36},
		{"DXGI_OUTDUPL_FRAME_INFO", unsafe.Sizeof(dxgiOutDuplFrameInfo{}), 48},
		{"DXGI_OUTPUT_DESC", unsafe.Sizeof(dxgiOutputDesc{}), 96},
		{"D3D11_VIDEO_PROCESSOR_CONTENT_DESC", unsafe.Sizeof(vpContentDesc{}), 40},
		{"D3D11_VIDEO_PROCESSOR_STREAM", unsafe.Sizeof(vpStream{}), 72},
		{"D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC", unsafe.Sizeof(vpInputViewDesc{}), 16},
		{"D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC", unsafe.Sizeof(vpOutputViewDesc{}), 16},
		{"vpStream.inputSurface offset", unsafe.Offsetof(vpStream{}.inputSurface), 32},
		{"DXGI_OUTPUT_DESC.monitor offset", unsafe.Offsetof(dxgiOutputDesc{}.monitor), 88},
		{"DXGI_OUTDUPL_FRAME_INFO.accumulatedFrames offset", unsafe.Offsetof(dxgiOutDuplFrameInfo{}.accumulatedFrames), 16},
	} {
		if c.got != c.want {
			t.Errorf("%s: %d bytes, the headers say %d", c.name, c.got, c.want)
		}
	}
}
