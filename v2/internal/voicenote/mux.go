package voicenote

import (
	"encoding/binary"
	"math"
)

const (
	rate        = 48000
	clusterMs   = 1000
	seekPreRoll = 80_000_000
)

// EBML element ids as they are written in the file.
const (
	idEBML         = 0x1A45DFA3
	idEBMLVersion  = 0x4286
	idEBMLReadVer  = 0x42F7
	idEBMLMaxID    = 0x42F2
	idEBMLMaxSize  = 0x42F3
	idDocType      = 0x4282
	idDocVersion   = 0x4287
	idDocReadVer   = 0x4285
	idSegment      = 0x18538067
	idInfo         = 0x1549A966
	idTimeScale    = 0x2AD7B1
	idDuration     = 0x4489
	idMuxingApp    = 0x4D80
	idWritingApp   = 0x5741
	idTracks       = 0x1654AE6B
	idTrackEntry   = 0xAE
	idTrackNumber  = 0xD7
	idTrackUID     = 0x73C5
	idTrackType    = 0x83
	idFlagLacing   = 0x9C
	idCodecID      = 0x86
	idCodecDelay   = 0x56AA
	idSeekPreRoll  = 0x56BB
	idCodecPrivate = 0x63A2
	idAudio        = 0xE1
	idSampleRate   = 0xB5
	idChannels     = 0x9F
	idCluster      = 0x1F43B675
	idTimecode     = 0xE7
	idSimpleBlock  = 0xA3
)

// Muxer builds a WebM file out of Opus packets, in memory; it knows every size and the duration, which a recorder cannot until it stops.
type Muxer struct {
	preSkip  int
	samples  int64
	clusters []byte
	cluster  []byte
	start    int64
}

// NewMuxer starts a file whose Opus stream has that many samples of decoder warm-up at its start.
func NewMuxer(preSkip int) *Muxer { return &Muxer{preSkip: preSkip, start: -1} }

// Add appends one packet that decodes to that many samples at 48 kHz.
func (m *Muxer) Add(packet []byte, samples int) {
	ms := m.samples * 1000 / rate
	if m.start < 0 || ms-m.start >= clusterMs {
		m.flush()
		m.start = ms
		m.cluster = appendUint(m.cluster, idTimecode, uint64(ms))
	}
	body := make([]byte, 0, len(packet)+4)
	body = append(body, 0x81)
	body = binary.BigEndian.AppendUint16(body, uint16(ms-m.start))
	body = append(body, 0x80)
	body = append(body, packet...)
	m.cluster = appendElement(m.cluster, idSimpleBlock, body)
	m.samples += int64(samples)
}

func (m *Muxer) flush() {
	if len(m.cluster) > 0 {
		m.clusters = appendElement(m.clusters, idCluster, m.cluster)
		m.cluster = m.cluster[:0]
	}
}

// Bytes finishes the file.
func (m *Muxer) Bytes() []byte {
	m.flush()
	var header []byte
	header = appendUint(header, idEBMLVersion, 1)
	header = appendUint(header, idEBMLReadVer, 1)
	header = appendUint(header, idEBMLMaxID, 4)
	header = appendUint(header, idEBMLMaxSize, 8)
	header = appendElement(header, idDocType, []byte("webm"))
	header = appendUint(header, idDocVersion, 4)
	header = appendUint(header, idDocReadVer, 2)

	var info []byte
	info = appendUint(info, idTimeScale, 1_000_000)
	info = appendElement(info, idMuxingApp, []byte("harmony"))
	info = appendElement(info, idWritingApp, []byte("harmony"))
	info = appendFloat(info, idDuration, float64(m.samples)*1000/rate)

	var audio []byte
	audio = appendFloat(audio, idSampleRate, rate)
	audio = appendUint(audio, idChannels, 1)
	var track []byte
	track = appendUint(track, idTrackNumber, 1)
	track = appendUint(track, idTrackUID, 1)
	track = appendUint(track, idTrackType, 2)
	track = appendUint(track, idFlagLacing, 0)
	track = appendElement(track, idCodecID, []byte("A_OPUS"))
	track = appendUint(track, idCodecDelay, uint64(m.preSkip)*1_000_000_000/rate)
	track = appendUint(track, idSeekPreRoll, seekPreRoll)
	track = appendElement(track, idCodecPrivate, opusHead(m.preSkip))
	track = appendElement(track, idAudio, audio)

	segment := appendElement(nil, idInfo, info)
	segment = appendElement(segment, idTracks, appendElement(nil, idTrackEntry, track))
	segment = append(segment, m.clusters...)

	out := appendElement(nil, idEBML, header)
	return appendElement(out, idSegment, segment)
}

func opusHead(preSkip int) []byte {
	head := []byte("OpusHead")
	head = append(head, 1, 1)
	head = binary.LittleEndian.AppendUint16(head, uint16(preSkip))
	head = binary.LittleEndian.AppendUint32(head, rate)
	return append(head, 0, 0, 0)
}

func appendElement(dst []byte, id uint32, body []byte) []byte {
	for shift := 24; shift >= 0; shift -= 8 {
		if b := byte(id >> shift); b != 0 || id>>(shift+8) != 0 {
			dst = append(dst, b)
		}
	}
	dst = appendSize(dst, uint64(len(body)))
	return append(dst, body...)
}

// appendSize writes a length in as few bytes as a variable-length integer allows.
func appendSize(dst []byte, n uint64) []byte {
	length := 1
	for n >= 1<<(7*length)-1 {
		length++
	}
	for i := length - 1; i >= 0; i-- {
		b := byte(n >> (8 * i))
		if i == length-1 {
			b |= 0x80 >> (length - 1)
		}
		dst = append(dst, b)
	}
	return dst
}

func appendUint(dst []byte, id uint32, v uint64) []byte {
	var body []byte
	for shift := 56; shift >= 0; shift -= 8 {
		if b := byte(v >> shift); b != 0 || len(body) > 0 || shift == 0 {
			body = append(body, b)
		}
	}
	return appendElement(dst, id, body)
}

func appendFloat(dst []byte, id uint32, v float64) []byte {
	return appendElement(dst, id, binary.BigEndian.AppendUint64(nil, math.Float64bits(v)))
}
