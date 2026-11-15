package voicenote

// packetSamples is how many samples at 48 kHz an Opus packet decodes to, read from its table of contents.
func packetSamples(p []byte) int {
	if len(p) == 0 {
		return 0
	}
	config := int(p[0] >> 3)
	var size int
	switch {
	case config < 12:
		size = [4]int{480, 960, 1920, 2880}[config&3]
	case config < 16:
		size = [2]int{480, 960}[config&1]
	default:
		size = [4]int{120, 240, 480, 960}[config&3]
	}
	switch p[0] & 3 {
	case 0:
		return size
	case 3:
		if len(p) < 2 {
			return 0
		}
		return size * int(p[1]&0x3F)
	}
	return size * 2
}
