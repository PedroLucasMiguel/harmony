package paint

import (
	"bytes"
	"image"
	"image/png"
	"strings"

	rl "github.com/gen2brain/raylib-go/raylib"
	"github.com/srwiley/oksvg"
	"github.com/srwiley/rasterx"

	"harmony/v2/assets"
)

type maskKey struct {
	name string
	icon bool
	w, h int
}

type masks struct {
	textures map[maskKey]rl.Texture2D
}

func newMasks() *masks { return &masks{textures: map[maskKey]rl.Texture2D{}} }

func (m *masks) texture(name string, icon bool, w, h int) (rl.Texture2D, bool) {
	key := maskKey{name, icon, w, h}
	if t, ok := m.textures[key]; ok {
		return t, t.ID != 0
	}
	file := name
	if icon {
		file = "icons/" + name + ".svg"
	}
	img, err := load(file, w, h)
	if err != nil {
		m.textures[key] = rl.Texture2D{}
		return rl.Texture2D{}, false
	}
	t := rl.LoadTextureFromImage(img)
	rl.UnloadImage(img)
	rl.SetTextureFilter(t, rl.FilterBilinear)
	m.textures[key] = t
	return t, true
}

func (m *masks) close() {
	for _, t := range m.textures {
		if t.ID != 0 {
			rl.UnloadTexture(t)
		}
	}
}

func load(name string, w, h int) (*rl.Image, error) {
	data, err := assets.FS.ReadFile(name)
	if err != nil {
		return nil, err
	}
	if strings.HasSuffix(name, ".png") {
		decoded, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		img := rl.NewImageFromImage(decoded)
		rl.ImageResize(img, int32(w), int32(h))
		return img, nil
	}
	source := absolutePaths(bytes.ReplaceAll(data, []byte("currentColor"), []byte("#ffffff")))
	source = bytes.ReplaceAll(source, []byte("<path "), []byte(`<path fill-rule="evenodd" `))
	icon, err := oksvg.ReadIconStream(bytes.NewReader(source))
	if err != nil {
		return nil, err
	}
	icon.SetTarget(0, 0, float64(w), float64(h))
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	icon.Draw(rasterx.NewDasher(w, h, rasterx.NewScannerGV(w, h, out, out.Bounds())), 1)
	return rl.NewImageFromImage(out), nil
}
