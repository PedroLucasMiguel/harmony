package clipboard

import (
	"bytes"
	"encoding/binary"
	"image/png"
	"time"
	"unsafe"

	"golang.org/x/image/bmp"
	"golang.org/x/sys/windows"
)

const (
	formatDIB  = 8
	formatDrop = 15
	allFiles   = 0xFFFFFFFF
	bmpFileHdr = 14
)

var (
	user32           = windows.NewLazySystemDLL("user32.dll")
	kernel32         = windows.NewLazySystemDLL("kernel32.dll")
	shell32          = windows.NewLazySystemDLL("shell32.dll")
	openClipboard    = user32.NewProc("OpenClipboard")
	closeClipboard   = user32.NewProc("CloseClipboard")
	getClipboardData = user32.NewProc("GetClipboardData")
	isAvailable      = user32.NewProc("IsClipboardFormatAvailable")
	registerFormat   = user32.NewProc("RegisterClipboardFormatW")
	globalLock       = kernel32.NewProc("GlobalLock")
	globalUnlock     = kernel32.NewProc("GlobalUnlock")
	globalSize       = kernel32.NewProc("GlobalSize")
	dragQueryFile    = shell32.NewProc("DragQueryFileW")
)

func open() bool {
	for range 5 {
		if r, _, _ := openClipboard.Call(0); r != 0 {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

// Files is the paths of the files on the clipboard.
func Files() []string {
	if r, _, _ := isAvailable.Call(formatDrop); r == 0 || !open() {
		return nil
	}
	defer closeClipboard.Call()
	drop, _, _ := getClipboardData.Call(formatDrop)
	if drop == 0 {
		return nil
	}
	count, _, _ := dragQueryFile.Call(drop, allFiles, 0, 0)
	var paths []string
	for i := uintptr(0); i < count; i++ {
		n, _, _ := dragQueryFile.Call(drop, i, 0, 0)
		buf := make([]uint16, n+1)
		dragQueryFile.Call(drop, i, uintptr(unsafe.Pointer(&buf[0])), n+1)
		paths = append(paths, windows.UTF16ToString(buf))
	}
	return paths
}

// Image is a picture on the clipboard as PNG, or nil.
func Image() []byte {
	if !open() {
		return nil
	}
	defer closeClipboard.Call()
	name, _ := windows.UTF16PtrFromString("PNG")
	if format, _, _ := registerFormat.Call(uintptr(unsafe.Pointer(name))); format != 0 {
		if r, _, _ := isAvailable.Call(format); r != 0 {
			if data := block(format); data != nil {
				return data
			}
		}
	}
	if r, _, _ := isAvailable.Call(formatDIB); r == 0 {
		return nil
	}
	dib := block(formatDIB)
	if len(dib) < 40 {
		return nil
	}
	header := binary.LittleEndian.Uint32(dib)
	bits := binary.LittleEndian.Uint16(dib[14:])
	colours := binary.LittleEndian.Uint32(dib[32:])
	compression := binary.LittleEndian.Uint32(dib[16:])
	offset := bmpFileHdr + header + colours*4
	if colours == 0 && bits <= 8 {
		offset += (1 << bits) * 4
	}
	if compression == 3 && header == 40 {
		offset += 12
	}
	file := make([]byte, bmpFileHdr, bmpFileHdr+len(dib))
	copy(file, "BM")
	binary.LittleEndian.PutUint32(file[2:], uint32(bmpFileHdr+len(dib)))
	binary.LittleEndian.PutUint32(file[10:], offset)
	img, err := bmp.Decode(bytes.NewReader(append(file, dib...)))
	if err != nil {
		return nil
	}
	var out bytes.Buffer
	if png.Encode(&out, img) != nil {
		return nil
	}
	return out.Bytes()
}

func block(format uintptr) []byte {
	handle, _, _ := getClipboardData.Call(format)
	if handle == 0 {
		return nil
	}
	size, _, _ := globalSize.Call(handle)
	p, _, _ := globalLock.Call(handle)
	if p == 0 || size == 0 {
		return nil
	}
	defer globalUnlock.Call(handle)
	return append([]byte(nil), unsafe.Slice(*(**byte)(unsafe.Pointer(&p)), size)...)
}
