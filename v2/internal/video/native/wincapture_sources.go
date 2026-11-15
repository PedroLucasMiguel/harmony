//go:build windows

package native

import (
	"fmt"
	"unsafe"
)

// listSources lists the monitors DXGI has, the primary one first, as "screen:<index>" (the index CaptureParams.Display takes).
// Windows are not listed: capturing one needs Windows.Graphics.Capture, which this client does not have yet.
func listSources() []SourceInfo {
	factory := new(uintptr)
	if hr := callProc(procCreateDXGIFactory1, iidIDXGIFactory1.p(), uintptr(unsafe.Pointer(factory))); hr.failed() {
		return nil
	}
	f := com(*factory)
	defer f.release()
	var list []SourceInfo
	for i := 0; ; i++ {
		var ad uintptr
		if hr := f.call(12, uintptr(i), uintptr(unsafe.Pointer(&ad))); hr.failed() {
			break
		}
		for j := 0; ; j++ {
			var out uintptr
			if hr := com(ad).call(7, uintptr(j), uintptr(unsafe.Pointer(&out))); hr.failed() {
				break
			}
			var desc dxgiOutputDesc
			if hr := com(out).call(7, uintptr(unsafe.Pointer(&desc))); !hr.failed() && desc.attached != 0 {
				info := SourceInfo{Kind: KindScreen, W: int(desc.right - desc.left), H: int(desc.bottom - desc.top)}
				if desc.left == 0 && desc.top == 0 {
					list = append([]SourceInfo{info}, list...)
				} else {
					list = append(list, info)
				}
			}
			com(out).release()
		}
		com(ad).release()
	}
	for i := range list {
		list[i].ID = fmt.Sprintf("screen:%d", i)
		list[i].Name = fmt.Sprintf("Screen %d", i+1)
	}
	return list
}

func sourceThumbnail(string, int) ([]byte, int, int, bool) { return nil, 0, 0, false }

func screenAccess() bool { return true }

func openScreenSettings() {}
