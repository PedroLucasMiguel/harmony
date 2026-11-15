package clip

import "errors"

// EBML element ids, with their length marker bits kept as they are written in the file.
const (
	idSegment     = 0x18538067
	idCluster     = 0x1F43B675
	idBlockGroup  = 0xA0
	idBlock       = 0xA1
	idSimpleBlock = 0xA3
	idTracks      = 0x1654AE6B
	idTrackEntry  = 0xAE
	idTrackNumber = 0xD7
	idCodecID     = 0x86
	idCodecPriv   = 0x63A2
)

var errBadWebM = errors.New("the WebM file is damaged")

func decodeWebM(data []byte) ([]int16, error) {
	packets, skip, err := WebMOpus(data)
	if err != nil {
		return nil, err
	}
	return decodeOpus(packets, skip)
}

// WebMOpus returns the Opus packets of a WebM file, in order, and the samples at the start that are decoder warm-up. It walks the file flat: containers are entered rather than skipped, which also handles the unknown sizes a recorder leaves. The packets point into data.
func WebMOpus(data []byte) (packets [][]byte, preSkip int, err error) {
	var head []byte
	var number, track uint64
	var codecOpus bool
	for pos := 0; pos < len(data); {
		id, n := readID(data[pos:])
		if n == 0 {
			break
		}
		size, m, unknown := readVint(data[pos+n:])
		if m == 0 {
			break
		}
		pos += n + m
		switch id {
		case idSegment, idCluster, idBlockGroup, idTracks:
			continue
		case idTrackEntry:
			number, codecOpus, head = 0, false, nil
			continue
		}
		if unknown || size > uint64(len(data)-pos) {
			return nil, 0, errBadWebM
		}
		body := data[pos : pos+int(size)]
		pos += int(size)
		switch id {
		case idTrackNumber:
			number = readUint(body)
		case idCodecID:
			codecOpus = string(body) == "A_OPUS"
		case idCodecPriv:
			head = body
		case idSimpleBlock, idBlock:
			if track == 0 {
				continue
			}
			if num, payload := blockPayload(body); num == track {
				packets = append(packets, payload)
			}
		}
		if codecOpus && number != 0 && track == 0 {
			track = number
		}
	}
	if track == 0 {
		return nil, 0, ErrUnsupported
	}
	preSkip, err = opusPreSkip(head)
	return packets, preSkip, err
}

// blockPayload splits a block into its track number and frame; blocks that use lacing are not Opus as recorders write it.
func blockPayload(b []byte) (uint64, []byte) {
	num, n, _ := readVint(b)
	if n == 0 || len(b) < n+3 || b[n+2]&0x06 != 0 {
		return 0, nil
	}
	return num, b[n+3:]
}

func readID(b []byte) (id uint64, n int) {
	if len(b) == 0 || b[0] == 0 {
		return 0, 0
	}
	n = 1
	for mask := byte(0x80); b[0]&mask == 0; mask >>= 1 {
		n++
	}
	if n > 4 || len(b) < n {
		return 0, 0
	}
	for _, v := range b[:n] {
		id = id<<8 | uint64(v)
	}
	return id, n
}

// readVint reads a variable-length integer; unknown is set when every value bit is one.
func readVint(b []byte) (value uint64, n int, unknown bool) {
	if len(b) == 0 || b[0] == 0 {
		return 0, 0, false
	}
	n = 1
	mask := byte(0x80)
	for b[0]&mask == 0 {
		n++
		mask >>= 1
	}
	if len(b) < n {
		return 0, 0, false
	}
	value = uint64(b[0] & (mask - 1))
	ones := b[0]&(mask-1) == mask-1
	for _, v := range b[1:n] {
		value = value<<8 | uint64(v)
		ones = ones && v == 0xFF
	}
	return value, n, ones
}

func readUint(b []byte) (v uint64) {
	for _, x := range b {
		v = v<<8 | uint64(x)
	}
	return v
}
