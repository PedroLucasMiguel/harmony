package paint

import (
	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/ui/geom"
)

// Texture draws a whole texture stretched over r, turned back to front when mirror is set.
func (p *Painter) Texture(tex rl.Texture2D, r geom.Rect, mirror bool) {
	p.textureRect(tex.ID, p.rect(r), 0, 0, 1, 1, mirror, rl.White)
}
