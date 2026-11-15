package clipboard

import (
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

var (
	classPasteboard, classPool, classURL, classArray, classDictionary, classNumber, classString, classBitmapRep objc.Class
	loaded                                                                                                      sync.Once
	selAlloc                                                                                                    = objc.RegisterName("alloc")
	selInit                                                                                                     = objc.RegisterName("init")
	selDrain                                                                                                    = objc.RegisterName("drain")
	selGeneral                                                                                                  = objc.RegisterName("generalPasteboard")
	selRead                                                                                                     = objc.RegisterName("readObjectsForClasses:options:")
	selArrayOf                                                                                                  = objc.RegisterName("arrayWithObject:")
	selDictOf                                                                                                   = objc.RegisterName("dictionaryWithObject:forKey:")
	selDict                                                                                                     = objc.RegisterName("dictionary")
	selBool                                                                                                     = objc.RegisterName("numberWithBool:")
	selString                                                                                                   = objc.RegisterName("stringWithUTF8String:")
	selCount                                                                                                    = objc.RegisterName("count")
	selAt                                                                                                       = objc.RegisterName("objectAtIndex:")
	selPath                                                                                                     = objc.RegisterName("path")
	selUTF8                                                                                                     = objc.RegisterName("UTF8String")
	selData                                                                                                     = objc.RegisterName("dataForType:")
	selBytes                                                                                                    = objc.RegisterName("bytes")
	selLength                                                                                                   = objc.RegisterName("length")
	selRepWith                                                                                                  = objc.RegisterName("imageRepWithData:")
	selRepresents                                                                                               = objc.RegisterName("representationUsingType:properties:")
)

const bitmapFilePNG = 4

func load() {
	loaded.Do(func() {
		if _, err := purego.Dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", purego.RTLD_LAZY|purego.RTLD_GLOBAL); err != nil {
			return
		}
		classPasteboard, classPool, classURL = objc.GetClass("NSPasteboard"), objc.GetClass("NSAutoreleasePool"), objc.GetClass("NSURL")
		classArray, classDictionary, classNumber = objc.GetClass("NSArray"), objc.GetClass("NSDictionary"), objc.GetClass("NSNumber")
		classString, classBitmapRep = objc.GetClass("NSString"), objc.GetClass("NSBitmapImageRep")
	})
}

func pasteboard() objc.ID { return objc.ID(classPasteboard).Send(selGeneral) }

func nsString(s string) objc.ID { return objc.ID(classString).Send(selString, s) }

// Files is the paths of the files on the clipboard.
func Files() []string {
	load()
	if classPasteboard == 0 {
		return nil
	}
	pool := objc.ID(classPool).Send(selAlloc).Send(selInit)
	defer pool.Send(selDrain)
	only := objc.ID(classDictionary).Send(selDictOf, objc.ID(classNumber).Send(selBool, true), nsString("NSPasteboardURLReadingFileURLsOnlyKey"))
	urls := pasteboard().Send(selRead, objc.ID(classArray).Send(selArrayOf, objc.ID(classURL)), only)
	if urls == 0 {
		return nil
	}
	var paths []string
	for i := uint(0); i < objc.Send[uint](urls, selCount); i++ {
		path := objc.Send[unsafe.Pointer](objc.ID(urls).Send(selAt, i).Send(selPath), selUTF8)
		if path != nil {
			paths = append(paths, cString(path))
		}
	}
	return paths
}

// Image is a picture on the clipboard as PNG, or nil.
func Image() []byte {
	load()
	if classPasteboard == 0 {
		return nil
	}
	pool := objc.ID(classPool).Send(selAlloc).Send(selInit)
	defer pool.Send(selDrain)
	board := pasteboard()
	if data := board.Send(selData, nsString("public.png")); data != 0 {
		return bytesOf(data)
	}
	tiff := board.Send(selData, nsString("public.tiff"))
	if tiff == 0 {
		return nil
	}
	rep := objc.ID(classBitmapRep).Send(selRepWith, tiff)
	if rep == 0 {
		return nil
	}
	if png := rep.Send(selRepresents, uint(bitmapFilePNG), objc.ID(classDictionary).Send(selDict)); png != 0 {
		return bytesOf(png)
	}
	return nil
}

func bytesOf(data objc.ID) []byte {
	n := objc.Send[uint](data, selLength)
	p := objc.Send[unsafe.Pointer](data, selBytes)
	if n == 0 || p == nil {
		return nil
	}
	return append([]byte(nil), unsafe.Slice((*byte)(p), n)...)
}

func cString(p unsafe.Pointer) string {
	n := 0
	for *(*byte)(unsafe.Add(p, n)) != 0 {
		n++
	}
	return string(unsafe.Slice((*byte)(p), n))
}
