package i18n

import (
	"syscall"
	"unsafe"
)

func platformLanguages() []string {
	proc := syscall.NewLazyDLL("kernel32.dll").NewProc("GetUserDefaultLocaleName")
	buf := make([]uint16, 85)
	if n, _, _ := proc.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf))); n == 0 {
		return nil
	}
	return []string{syscall.UTF16ToString(buf)}
}
