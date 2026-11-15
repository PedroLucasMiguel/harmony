// Package rnnoise is RNNoise 0.2 (Jean-Marc Valin, Xiph.Org, BSD-3-Clause) in Go: a recurrent network that tells a voice from the rest of the sound and
// takes the rest out. It is the build the Electron client ships (xiph/rnnoise commit 372f7b4, model rnnoise_data-0b50c45), frame by frame: 480 samples of
// 48 kHz sound, scaled as 16-bit integers, in and out. model.bin holds its weights (dev/rnnoise-model.go writes it), the big matrices as 16-bit floats.
package rnnoise

import (
	_ "embed"
	"encoding/binary"
	"math"
	"sync"
)

const (
	FrameSize  = 480
	windowSize = 2 * FrameSize
	freqSize   = FrameSize + 1
	numBands   = 32
	numFeat    = 2*numBands + 1
	hidden     = 384
)

//go:embed model.bin
var modelBytes []byte

type linear struct {
	weights []float32
	idx     []int32
	bias    []float32
	diag    []float32
	in, out int
}

type weights struct {
	conv1, conv2       linear
	gruIn, gruRec      [3]linear
	denseOut, vadDense linear
	halfWindow         [FrameSize]float32
	dct                [numBands * numBands]float32
}

var (
	modelMu    sync.Mutex
	modelUsers int
	modelData  *weights
)

// acquire loads the weights when the first stream wants them; release drops them when the last one is done.
func acquire() *weights {
	modelMu.Lock()
	defer modelMu.Unlock()
	if modelUsers == 0 {
		modelData = loadModel()
	}
	modelUsers++
	return modelData
}

func release() {
	modelMu.Lock()
	defer modelMu.Unlock()
	if modelUsers--; modelUsers == 0 {
		modelData = nil
	}
}

func loadModel() *weights {
	r := reader{data: modelBytes}
	m := &weights{}
	m.conv1 = linear{weights: r.halves(24960), bias: r.floats(128), in: 195, out: 128}
	m.conv2 = linear{weights: r.halves(147456), bias: r.floats(384), in: 384, out: 384}
	for g := range 3 {
		m.gruIn[g] = linear{weights: r.halves(147456), idx: r.ints(4752), bias: r.floats(1152), in: hidden, out: 3 * hidden}
		m.gruRec[g] = linear{weights: r.halves(147456), idx: r.ints(4752), bias: r.floats(1152), diag: r.floats(1152), in: hidden, out: 3 * hidden}
	}
	m.denseOut = linear{weights: r.floats(12288), bias: r.floats(32), in: hidden, out: numBands}
	m.vadDense = linear{weights: r.floats(384), bias: r.floats(1), in: hidden, out: 1}
	copy(m.halfWindow[:], r.floats(FrameSize))
	copy(m.dct[:], r.floats(numBands*numBands))
	return m
}

type reader struct {
	data []byte
	at   int
}

func (r *reader) floats(n int) []float32 {
	out := make([]float32, n)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(r.data[r.at:]))
		r.at += 4
	}
	return out
}

func (r *reader) halves(n int) []float32 {
	out := make([]float32, n)
	for i := range out {
		out[i] = half(binary.LittleEndian.Uint16(r.data[r.at:]))
		r.at += 2
	}
	return out
}

// half is a 16-bit float widened to 32 bits.
func half(h uint16) float32 {
	sign := uint32(h&0x8000) << 16
	exp := uint32(h >> 10 & 0x1f)
	mant := uint32(h & 0x3ff)
	switch {
	case exp == 0 && mant == 0:
		return math.Float32frombits(sign)
	case exp == 0:
		v := float32(mant) / (1 << 24)
		if sign != 0 {
			v = -v
		}
		return v
	case exp == 31:
		return math.Float32frombits(sign | 0x7f800000 | mant<<13)
	}
	return math.Float32frombits(sign | (exp+127-15)<<23 | mant<<13)
}

func (r *reader) ints(n int) []int32 {
	out := make([]int32, n)
	for i := range out {
		out[i] = int32(binary.LittleEndian.Uint32(r.data[r.at:]))
		r.at += 4
	}
	return out
}
