// Package assets embeds the icons, the logo, the translations and the fonts into the binary.
package assets

import "embed"

//go:embed icons/*.svg logo.png locales/*.json namefonts/*.ttf fonts/*.ttf
var FS embed.FS
