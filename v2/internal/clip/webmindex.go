package clip

import (
	"bufio"
	"io"
)

// OpusPacket says where one Opus packet of a WebM file lies and how many samples at Rate it decodes to.
type OpusPacket struct {
	Off     int64
	Size    uint32
	Samples uint32
}

const indexHeader = 16

// IndexWebMOpus reads a WebM file as a stream and lists its Opus packets without holding any of it, so a long track can be played from disk.
func IndexWebMOpus(r io.Reader) (packets []OpusPacket, preSkip int, err error) {
	br := bufio.NewReaderSize(r, 64<<10)
	var pos int64
	var head []byte
	var number, track uint64
	var codecOpus bool
	for {
		peek, _ := br.Peek(indexHeader)
		id, n := readID(peek)
		if n == 0 {
			break
		}
		size, m, unknown := readVint(peek[n:])
		if m == 0 {
			break
		}
		_, _ = br.Discard(n + m)
		pos += int64(n + m)
		switch id {
		case idSegment, idCluster, idBlockGroup, idTracks:
			continue
		case idTrackEntry:
			number, codecOpus, head = 0, false, nil
			continue
		}
		if unknown {
			return nil, 0, errBadWebM
		}
		body := int64(size)
		switch id {
		case idTrackNumber, idCodecID, idCodecPriv:
			if body > 1<<16 {
				return nil, 0, errBadWebM
			}
			data := make([]byte, body)
			if _, err := io.ReadFull(br, data); err != nil {
				return nil, 0, errBadWebM
			}
			pos += body
			switch id {
			case idTrackNumber:
				number = readUint(data)
			case idCodecID:
				codecOpus = string(data) == "A_OPUS"
			default:
				head = data
			}
			if codecOpus && number != 0 && track == 0 {
				track = number
			}
			continue
		case idSimpleBlock, idBlock:
			if track != 0 {
				peek, _ := br.Peek(int(min(body, indexHeader)))
				if p, ok := indexedPacket(peek, track, pos, body); ok {
					packets = append(packets, p)
				}
			}
		}
		if _, err := br.Discard(int(body)); err != nil {
			break
		}
		pos += body
	}
	if track == 0 {
		return nil, 0, ErrUnsupported
	}
	preSkip, err = opusPreSkip(head)
	return packets, preSkip, err
}

// indexedPacket reads a block's first bytes: its track, and the packet's table of contents, which gives the length.
func indexedPacket(b []byte, track uint64, pos, size int64) (OpusPacket, bool) {
	num, n, _ := readVint(b)
	if n == 0 || len(b) < n+4 || num != track || b[n+2]&0x06 != 0 {
		return OpusPacket{}, false
	}
	samples := opusPacketSamples(b[n+3:])
	if samples == 0 {
		return OpusPacket{}, false
	}
	return OpusPacket{Off: pos + int64(n+3), Size: uint32(size - int64(n+3)), Samples: uint32(samples)}, true
}

// opusPacketSamples is how many samples at 48 kHz an Opus packet decodes to, read from its table of contents.
func opusPacketSamples(p []byte) int {
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
