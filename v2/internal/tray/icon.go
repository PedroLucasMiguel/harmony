package tray

import (
	"bytes"
	_ "embed"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"sync"

	xdraw "golang.org/x/image/draw"
)

//go:embed appicon.png
var appIconPNG []byte

// Look is what the icon shows: the app's own tile, or the tile recoloured for what is happening in a call, as the Electron client's tray does.
type Look int

const (
	LookApp Look = iota
	LookUnread
	LookVoice
	LookSpeaking
	LookMuted
	LookDeafened
)

var (
	grey  = color.RGBA{0x80, 0x84, 0x8e, 0xff}
	green = color.RGBA{0x23, 0xa5, 0x5a, 0xff}
	red   = color.RGBA{0xf2, 0x3f, 0x43, 0xff}
)

var pictures struct {
	sync.Mutex
	source image.Image
	cache  map[[2]int][]byte
}

// Picture is the icon for a look at a size in pixels, as PNG; it is drawn once and kept.
func Picture(look Look, size int) []byte {
	pictures.Lock()
	defer pictures.Unlock()
	key := [2]int{int(look), size}
	if data, ok := pictures.cache[key]; ok {
		return data
	}
	if pictures.source == nil {
		pictures.source, _ = png.Decode(bytes.NewReader(appIconPNG))
		pictures.cache = map[[2]int][]byte{}
	}
	var out bytes.Buffer
	_ = png.Encode(&out, compose(look, size, pictures.source))
	pictures.cache[key] = out.Bytes()
	return out.Bytes()
}

func compose(look Look, size int, source image.Image) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	xdraw.CatmullRom.Scale(img, img.Bounds(), source, source.Bounds(), xdraw.Src, nil)
	switch look {
	case LookVoice, LookSpeaking, LookMuted, LookDeafened:
		tile := grey
		if look == LookSpeaking {
			tile = green
		}
		recolour(img, tile)
	}
	switch look {
	case LookUnread:
		badge(img, size, size*7/10, size*3/10, size*3/10, false)
	case LookMuted, LookDeafened:
		badge(img, size, size*7/10, size*7/10, size*3/10, true)
	}
	return img
}

// recolour keeps the logo's shape (the bright pixels of the tile) and gives the tile a flat colour.
func recolour(img *image.RGBA, tile color.RGBA) {
	for i := 0; i < len(img.Pix); i += 4 {
		r, g, b, a := img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3]
		if a == 0 {
			continue
		}
		white := min(r, g, b) // how much of the pixel is white: the logo is white, the tile is blue-violet
		mix := func(base uint8, w uint8) uint8 { return uint8((int(base)*(255-int(w)) + 255*int(w)) / 255) }
		w := uint8(max(0, int(white)-96) * 255 / 159)
		img.Pix[i], img.Pix[i+1], img.Pix[i+2] = mix(tile.R, w), mix(tile.G, w), mix(tile.B, w)
	}
}

// badge puts a round red mark with a clear ring round it in a corner; slash crosses it, for a muted or deafened call.
func badge(img *image.RGBA, size, cx, cy, r int, slash bool) {
	ring := max(1, size/14)
	for y := range size {
		for x := range size {
			dx, dy := x-cx-r/2, y-cy-r/2
			d2 := dx*dx + dy*dy
			switch {
			case d2 <= r*r:
				img.SetRGBA(x, y, red)
			case d2 <= (r+ring)*(r+ring):
				img.SetRGBA(x, y, color.RGBA{})
			}
		}
	}
	if slash {
		bar := image.Rect(cx+r/2-r*3/5, cy+r/2-max(1, size/22), cx+r/2+r*3/5, cy+r/2+max(1, size/22))
		draw2(img, bar)
	}
}

func draw2(img *image.RGBA, r image.Rectangle) {
	draw.Draw(img, r, image.NewUniform(color.White), image.Point{}, draw.Src)
}
