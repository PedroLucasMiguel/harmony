package native

// appendVideoNALs copies the NAL units of an Annex B buffer that carry the picture, leaving out the ones the encoder
// writes itself or does not want: SEI, parameter sets and access unit delimiters.
func appendVideoNALs(dst, annexB []byte) []byte {
	i := nextStartCode(annexB, 0)
	for i >= 0 {
		body := i + 3
		next := nextStartCode(annexB, body)
		end := len(annexB)
		if next >= 0 {
			end = next
		}
		for end > body && annexB[end-1] == 0 {
			end--
		}
		if body < end {
			switch annexB[body] & 0x1f {
			case 6, 7, 8, 9:
			default:
				dst = append(append(dst, 0, 0, 0, 1), annexB[body:end]...)
			}
		}
		i = next
	}
	return dst
}

// nextStartCode is the index of the next 00 00 01 at or after from, or -1.
func nextStartCode(b []byte, from int) int {
	for i := from; i+2 < len(b); i++ {
		if b[i+2] > 1 {
			i += 2
			continue
		}
		if b[i] == 0 && b[i+1] == 0 && b[i+2] == 1 {
			return i
		}
	}
	return -1
}
