package paint

import (
	"bytes"

	"github.com/go-text/typesetting/font"
	"github.com/go-text/typesetting/font/opentype"

	"harmony/v2/assets"
)

// Family is a typeface other than the system's, for display names; 0 is the system's.
type Family uint8

const (
	FamilySystem Family = iota
	Pacifico
	PressStart
	Orbitron
	Playfair
	Bebas
	Caveat
	Fredoka
	Cinzel
	Typewriter
	Marker
	familyCount
)

var families = [familyCount]struct {
	id    string
	scale float32
}{
	Pacifico: {"pacifico", 0.91}, PressStart: {"press-start", 0.7}, Orbitron: {"orbitron", 0.94}, Playfair: {"playfair", 1},
	Bebas: {"bebas", 0.87}, Caveat: {"caveat", 1.16}, Fredoka: {"fredoka", 1.04}, Cinzel: {"cinzel", 0.94},
	Typewriter: {"typewriter", 1.04}, Marker: {"marker", 0.92},
}

// FamilyOf is the family the server names by id, or FamilySystem for an id this build does not know.
func FamilyOf(id string) Family {
	for f := Pacifico; f < familyCount; f++ {
		if families[f].id == id {
			return f
		}
	}
	return FamilySystem
}

// Scale is how much to scale a size so this family's letters match the system font's at the same size.
func (f Family) Scale() float32 {
	if f == FamilySystem || f >= familyCount {
		return 1
	}
	return families[f].scale
}

// Styled is st in this family, its size adjusted to the family's scale.
func (f Family) Styled(st TextStyle) TextStyle {
	st.Family = f
	st.Size *= f.Scale()
	return st
}

func openFamily(f Family) *typeface {
	data, err := assets.FS.ReadFile("namefonts/" + families[f].id + ".ttf")
	if err != nil {
		return nil
	}
	face, err := font.ParseTTF(bytes.NewReader(data))
	if err != nil {
		return nil
	}
	tf := &typeface{face: face, upem: float32(face.Upem()), variants: map[variantKey]*font.Face{}}
	if loader, err := opentype.NewLoader(bytes.NewReader(data)); err == nil {
		tf.tracking = readTracking(loader, tf.upem)
	}
	return tf
}
