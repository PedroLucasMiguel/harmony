package paint

import (
	"bytes"
	"fmt"
	"os"
	"runtime"

	"github.com/go-text/typesetting/font"
	"github.com/go-text/typesetting/font/opentype"

	"harmony/v2/assets"
)

type Weight int

const (
	Regular  Weight = 400
	Medium   Weight = 500
	Semibold Weight = 600
	Bold     Weight = 700
)

type TextStyle struct {
	Size    float32
	Weight  Weight
	Spacing float32
	Mono    bool
	Italic  bool
	Family  Family
}

// The optical-size range Chromium clamps SF to.
const (
	opticalSizeMin = 17
	opticalSizeMax = 30
)

var systemFaces = map[string]map[Weight][]string{
	"darwin": {
		Regular:  {"/System/Library/Fonts/SFNS.ttf"},
		Medium:   {"/System/Library/Fonts/SFNS.ttf"},
		Semibold: {"/System/Library/Fonts/SFNS.ttf"},
		Bold:     {"/System/Library/Fonts/SFNS.ttf"},
	},
	"windows": {
		Regular:  {`C:\Windows\Fonts\segoeui.ttf`},
		Medium:   {`C:\Windows\Fonts\segoeui.ttf`},
		Semibold: {`C:\Windows\Fonts\seguisb.ttf`, `C:\Windows\Fonts\segoeuib.ttf`},
		Bold:     {`C:\Windows\Fonts\segoeuib.ttf`},
	},
	"linux": {
		Regular:  {"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf"},
		Medium:   {"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf"},
		Semibold: {"/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"},
		Bold:     {"/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"},
	},
}

// italicFaces are the system's own italic of each face: a true italic, as the browser picks, not a slanted copy.
var italicFaces = map[string]map[Weight][]string{
	"darwin": {
		Regular:  {"/System/Library/Fonts/SFNSItalic.ttf"},
		Medium:   {"/System/Library/Fonts/SFNSItalic.ttf"},
		Semibold: {"/System/Library/Fonts/SFNSItalic.ttf"},
		Bold:     {"/System/Library/Fonts/SFNSItalic.ttf"},
	},
	"windows": {
		Regular:  {`C:\Windows\Fonts\segoeuii.ttf`},
		Medium:   {`C:\Windows\Fonts\segoeuii.ttf`},
		Semibold: {`C:\Windows\Fonts\seguisbi.ttf`, `C:\Windows\Fonts\segoeuiz.ttf`},
		Bold:     {`C:\Windows\Fonts\segoeuiz.ttf`},
	},
	"linux": {
		Regular:  {"/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf", "/usr/share/fonts/TTF/DejaVuSans-Oblique.ttf"},
		Medium:   {"/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf", "/usr/share/fonts/TTF/DejaVuSans-Oblique.ttf"},
		Semibold: {"/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf", "/usr/share/fonts/TTF/DejaVuSans-BoldOblique.ttf"},
		Bold:     {"/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf", "/usr/share/fonts/TTF/DejaVuSans-BoldOblique.ttf"},
	},
}

var monoFaces = map[string][]string{
	"darwin":  {"/System/Library/Fonts/SFNSMono.ttf", "/System/Library/Fonts/Menlo.ttc"},
	"windows": {`C:\Windows\Fonts\consola.ttf`},
	"linux":   {"/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/TTF/DejaVuSansMono.ttf"},
}

func loadMono() *typeface {
	for _, path := range monoFaces[runtime.GOOS] {
		if tf, err := openTypeface(path); err == nil {
			return tf
		}
	}
	return nil
}

// loadItalic opens the italic face for a weight, or returns nil when the system has none.
func loadItalic(weight Weight, byPath map[string]*typeface) *typeface {
	for _, path := range italicFaces[runtime.GOOS][weight] {
		if tf, ok := byPath[path]; ok {
			return tf
		}
		if tf, err := openTypeface(path); err == nil {
			byPath[path] = tf
			return tf
		}
	}
	return nil
}

type variantKey struct {
	weight Weight
	opsz   float32
}

type typeface struct {
	face     *font.Face
	upem     float32
	tracking tracking
	variants map[variantKey]*font.Face
}

type typefaces map[Weight]*typeface

func loadTypefaces() (typefaces, error) {
	byPath := map[string]*typeface{}
	out := typefaces{}
	for _, weight := range []Weight{Regular, Medium, Semibold, Bold} {
		var last error
		for _, path := range systemFaces[runtime.GOOS][weight] {
			if tf, ok := byPath[path]; ok {
				out[weight] = tf
				break
			}
			tf, err := openTypeface(path)
			if err != nil {
				last = err
				continue
			}
			byPath[path] = tf
			out[weight] = tf
			break
		}
		if out[weight] == nil {
			tf, err := openEmbedded(weight, byPath)
			if err != nil {
				return nil, fmt.Errorf("no system font for weight %d: %v, and the built-in one: %v", weight, last, err)
			}
			out[weight] = tf
		}
	}
	return out, nil
}

func openTypeface(path string) (*typeface, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	// the file stays open: the faces read parts of it when a glyph is first drawn
	return parseTypeface(file)
}

// embeddedFaces is the font that is in the program for a system that has none of the ones above: Microsoft's Selawik, the
// open-licence font made to stand in for Segoe UI with the same widths, so that the text breaks where the Electron
// client's does. A system that has its own font never reads these.
var embeddedFaces = map[Weight]string{
	Regular:  "fonts/selawik.ttf",
	Medium:   "fonts/selawik.ttf",
	Semibold: "fonts/selawik-semibold.ttf",
	Bold:     "fonts/selawik-bold.ttf",
}

func openEmbedded(weight Weight, byPath map[string]*typeface) (*typeface, error) {
	name := embeddedFaces[weight]
	if tf, ok := byPath[name]; ok {
		return tf, nil
	}
	data, err := assets.FS.ReadFile(name)
	if err != nil {
		return nil, err
	}
	tf, err := parseTypeface(bytes.NewReader(data))
	if err == nil {
		byPath[name] = tf
	}
	return tf, err
}

func parseTypeface(file font.Resource) (*typeface, error) {
	face, err := font.ParseTTF(file)
	if err != nil {
		return nil, err
	}
	tf := &typeface{face: face, upem: float32(face.Upem()), variants: map[variantKey]*font.Face{}}
	if loader, err := opentype.NewLoader(file); err == nil {
		tf.tracking = readTracking(loader, tf.upem)
	}
	return tf, nil
}

func (tf *typeface) variant(weight Weight, size float32) *font.Face {
	key := variantKey{weight, min(max(size, opticalSizeMin), opticalSizeMax)}
	if face, ok := tf.variants[key]; ok {
		return face
	}
	face := font.NewFace(tf.face.Font)
	face.SetVariations([]font.Variation{
		{Tag: opentype.MustNewTag("wght"), Value: float32(weight)},
		{Tag: opentype.MustNewTag("opsz"), Value: key.opsz},
	})
	tf.variants[key] = face
	return face
}
