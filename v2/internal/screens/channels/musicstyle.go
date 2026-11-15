package channels

import "harmony/v2/internal/ui/paint"

const (
	musicStripTitleSize   = 13.12
	musicStripTitleLine   = 19.68
	musicStripArtistSize  = 11.52
	musicStripArtistLine  = 17.28
	musicRowTitleSize     = 13.44
	musicRowTitleLine     = 20.16
	musicRowArtistSize    = 11.84
	musicRowArtistLine    = 17.76
	musicTrackTextHeight  = musicRowTitleLine + musicRowArtistLine
	musicMinimumQueueRows = 48
)

func musicSmallStyle(size float32) paint.TextStyle {
	return paint.TextStyle{Size: size, Weight: paint.Regular}
}

func musicBoldStyle(size float32) paint.TextStyle {
	return paint.TextStyle{Size: size, Weight: paint.Bold}
}
