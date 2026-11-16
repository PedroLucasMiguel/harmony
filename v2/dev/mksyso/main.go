// mksyso writes the Windows resource object that gives the program its icon: linked into harmony2.exe it is the icon
// Explorer shows, and, under the name GLFW_ICON, the one the window class (taskbar, Alt+Tab, title) takes. It needs nothing
// but the standard library and golang.org/x/image.
//
//	go run ./dev/mksyso -icon assets/logo.png -arch amd64 -o cmd/harmony2/rsrc_windows_amd64.syso
package main

import (
	"bytes"
	"encoding/binary"
	"flag"
	"fmt"
	"image"
	"image/png"
	"os"
	"unicode/utf16"

	"golang.org/x/image/draw"
)

const (
	rtIcon      = 3
	rtGroupIcon = 14
	groupName   = "GLFW_ICON"
	highBit     = 0x80000000
)

// sizes are the icon sizes made: the small ones as bitmaps, as every Windows reads them, and the large one as a PNG.
var sizes = []int{16, 24, 32, 48, 256}

func main() {
	iconPath := flag.String("icon", "assets/logo.png", "PNG of the icon, square")
	arch := flag.String("arch", "amd64", "amd64 or arm64")
	out := flag.String("o", "", "the .syso file to write")
	flag.Parse()
	if *out == "" {
		fmt.Fprintln(os.Stderr, "mksyso: -o is needed")
		os.Exit(2)
	}
	if err := run(*iconPath, *arch, *out); err != nil {
		fmt.Fprintln(os.Stderr, "mksyso:", err)
		os.Exit(1)
	}
}

func run(iconPath, arch, out string) error {
	machine, reloc := uint16(0x8664), uint16(0x0003) // IMAGE_FILE_MACHINE_AMD64, IMAGE_REL_AMD64_ADDR32NB
	switch arch {
	case "amd64":
	case "arm64":
		machine, reloc = 0xAA64, 0x0002 // IMAGE_FILE_MACHINE_ARM64, IMAGE_REL_ARM64_ADDR32NB
	default:
		return fmt.Errorf("unknown arch %q", arch)
	}
	file, err := os.Open(iconPath)
	if err != nil {
		return err
	}
	src, err := png.Decode(file)
	file.Close()
	if err != nil {
		return err
	}
	if b := src.Bounds(); b.Dx() != b.Dy() || b.Dx() < sizes[len(sizes)-1] {
		return fmt.Errorf("the icon must be square and at least %d pixels", sizes[len(sizes)-1])
	}
	var images [][]byte
	for _, n := range sizes {
		data, err := encode(src, n)
		if err != nil {
			return err
		}
		images = append(images, data)
	}
	section, relocs := resources(images)
	return os.WriteFile(out, object(machine, reloc, section, relocs), 0o644)
}

// encode makes the image of one size: a 32-bit bitmap with its mask, or the PNG for the biggest.
func encode(src image.Image, n int) ([]byte, error) {
	scaled := image.NewNRGBA(image.Rect(0, 0, n, n))
	draw.CatmullRom.Scale(scaled, scaled.Bounds(), src, src.Bounds(), draw.Over, nil)
	var b bytes.Buffer
	if n >= 256 {
		if err := png.Encode(&b, scaled); err != nil {
			return nil, err
		}
		return b.Bytes(), nil
	}
	le := binary.LittleEndian
	binary.Write(&b, le, struct {
		Size                          uint32
		Width, Height                 int32
		Planes, Bits                  uint16
		Compression, ImageSize        uint32
		XPels, YPels                  int32
		ColoursUsed, ColoursImportant uint32
	}{40, int32(n), int32(2 * n), 1, 32, 0, 0, 0, 0, 0, 0})
	for y := n - 1; y >= 0; y-- {
		for x := 0; x < n; x++ {
			c := scaled.NRGBAAt(x, y)
			b.Write([]byte{c.B, c.G, c.R, c.A})
		}
	}
	b.Write(make([]byte, (n+31)/32*4*n)) // the AND mask: all zero, the alpha channel says what shows
	return b.Bytes(), nil
}

// resources lays out the resource tree of the .rsrc section and returns it with the places that hold an offset of a data
// blob, which the linker turns into an address.
func resources(images [][]byte) (section []byte, relocs []uint32) {
	le := binary.LittleEndian
	n := len(images)
	// directories: root, icons, group, one language directory for each icon and one for the group
	rootOff := 0
	iconsOff := rootOff + 16 + 2*8
	groupOff := iconsOff + 16 + n*8
	langOff := groupOff + 16 + 8
	namesOff := langOff + (n+1)*(16+8)
	name := utf16.Encode([]rune(groupName))
	entriesOff := namesOff + (2+2*len(name)+3)&^3
	blobsOff := entriesOff + (n+1)*16

	group := new(bytes.Buffer)
	binary.Write(group, le, [3]uint16{0, 1, uint16(n)})
	offsets := make([]int, n+1)
	off := blobsOff
	for i, data := range images {
		offsets[i] = off
		off += (len(data) + 3) &^ 3
	}
	for i, size := range sizes {
		w := byte(size)
		if size >= 256 {
			w = 0
		}
		binary.Write(group, le, struct {
			W, H, Colours, Reserved byte
			Planes, Bits            uint16
			Bytes                   uint32
			ID                      uint16
		}{w, w, 0, 0, 1, 32, uint32(len(images[i])), uint16(i + 1)})
	}
	offsets[n] = off
	end := off + (group.Len()+3)&^3

	section = make([]byte, end)
	dir := func(at int, named, ids int) {
		le.PutUint16(section[at+12:], uint16(named))
		le.PutUint16(section[at+14:], uint16(ids))
	}
	entry := func(at int, name, target uint32) {
		le.PutUint32(section[at:], name)
		le.PutUint32(section[at+4:], target)
	}
	dir(rootOff, 0, 2)
	entry(rootOff+16, rtIcon, highBit|uint32(iconsOff))
	entry(rootOff+24, rtGroupIcon, highBit|uint32(groupOff))
	dir(iconsOff, 0, n)
	for i := 0; i < n; i++ {
		entry(iconsOff+16+8*i, uint32(i+1), highBit|uint32(langOff+i*24))
	}
	dir(groupOff, 1, 0)
	entry(groupOff+16, highBit|uint32(namesOff), highBit|uint32(langOff+n*24))
	for i := 0; i <= n; i++ {
		at := langOff + i*24
		dir(at, 0, 1)
		entry(at+16, 0, uint32(entriesOff+i*16)) // language 0: whatever the system language is
	}
	le.PutUint16(section[namesOff:], uint16(len(name)))
	for i, u := range name {
		le.PutUint16(section[namesOff+2+2*i:], u)
	}
	for i := 0; i <= n; i++ {
		at := entriesOff + i*16
		size := group.Len()
		if i < n {
			size = len(images[i])
		}
		le.PutUint32(section[at:], uint32(offsets[i]))
		le.PutUint32(section[at+4:], uint32(size))
		relocs = append(relocs, uint32(at))
	}
	for i, data := range images {
		copy(section[offsets[i]:], data)
	}
	copy(section[offsets[n]:], group.Bytes())
	return section, relocs
}

// object wraps the section in a COFF file with the one symbol and the relocations the linker needs.
func object(machine, reloc uint16, section []byte, relocs []uint32) []byte {
	le := binary.LittleEndian
	const headers = 20 + 40
	relocAt := headers + len(section)
	symbolAt := relocAt + 10*len(relocs)
	var b bytes.Buffer
	binary.Write(&b, le, struct {
		Machine, Sections               uint16
		Stamp, SymbolTable, Symbols     uint32
		OptionalHeader, Characteristics uint16
	}{machine, 1, 0, uint32(symbolAt), 2, 0, 0})
	var name [8]byte
	copy(name[:], ".rsrc")
	binary.Write(&b, le, struct {
		Name                                 [8]byte
		VirtualSize, VirtualAddress, RawSize uint32
		RawAt, RelocAt, LinesAt              uint32
		Relocs, Lines                        uint16
		Characteristics                      uint32
	}{name, 0, 0, uint32(len(section)), headers, uint32(relocAt), 0, uint16(len(relocs)), 0, 0xC0000040})
	b.Write(section)
	for _, at := range relocs {
		binary.Write(&b, le, struct {
			At, Symbol uint32
			Type       uint16
		}{at, 0, reloc})
	}
	binary.Write(&b, le, struct { // the symbol of the section
		Name       [8]byte
		Value      uint32
		Section    int16
		Type       uint16
		Class, Aux uint8
	}{name, 0, 1, 0, 3, 1})
	binary.Write(&b, le, struct { // its auxiliary record: the length and the number of relocations
		Length        uint32
		Relocs, Lines uint16
		Check         uint32
		Number        uint16
		Selection     uint8
		_             [3]byte
	}{uint32(len(section)), uint16(len(relocs)), 0, 0, 0, 0, [3]byte{}})
	binary.Write(&b, le, uint32(4)) // an empty string table
	return b.Bytes()
}
