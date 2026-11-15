package raw

import rl "github.com/gen2brain/raylib-go/raylib"

var updateTexture = Lookup("rlUpdateTexture")

// UpdateTexture replaces all of a texture's pixels.
func UpdateTexture(tex rl.Texture2D, pixels []byte) {
	updateTexture.Call(uintptr(tex.ID), 0, 0, uintptr(tex.Width), uintptr(tex.Height), uintptr(tex.Format), Ptr(&pixels[0]))
}
