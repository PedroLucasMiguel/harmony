//go:build linux

package native

// What a camera offers: every discrete size of every format this package reads, with the highest rate at that size.

import (
	"os"
	"unsafe"
)

func listCameraFormats(id string) []CameraFormat {
	nodes := v4l2Nodes()
	if id != "" {
		nodes = []string{id}
	}
	for _, node := range nodes {
		f, err := os.OpenFile(node, os.O_RDWR, 0)
		if err != nil {
			continue
		}
		fd := int(f.Fd())
		_, ok := v4l2Query(fd)
		var out []CameraFormat
		if ok {
			out = v4l2Sizes(fd)
		}
		f.Close()
		if len(out) > 0 {
			return out
		}
	}
	return nil
}

func v4l2Sizes(fd int) []CameraFormat {
	var out []CameraFormat
	for _, fourcc := range v4l2Formats(fd) {
		for i := uint32(0); i < 128; i++ {
			e := v4l2FrmSizeEnum{Index: i, PixelFormat: fourcc}
			if v4l2Ioctl(fd, vidiocEnumFrameSizes, unsafe.Pointer(&e)) != nil || e.Type != v4l2FrmSizeDiscrete {
				break
			}
			w, h := int(e.Union[0]), int(e.Union[1])
			fps := v4l2MaxFPS(fd, fourcc, w, h)
			if fps == 0 {
				fps = 30
			}
			out = append(out, CameraFormat{W: w, H: h, MaxFPS: fps})
		}
	}
	return out
}
