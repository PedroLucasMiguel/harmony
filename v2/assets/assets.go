// Package assets embeds the icons, the logo and the translations into the binary.
package assets

import "embed"

//go:embed icons/*.svg logo.png locales/*.json namefonts/*.ttf
var FS embed.FS
