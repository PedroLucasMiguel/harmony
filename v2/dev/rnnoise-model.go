//go:build ignore

// rnnoise-model writes internal/rnnoise/model.bin from the C sources of RNNoise 0.2 (xiph/rnnoise commit 372f7b4 with
// the model rnnoise_data-0b50c45, the version the Electron client's Jitsi build ships):
//
//	go run dev/rnnoise-model.go <rnnoise>/src internal/rnnoise/model.bin
//
// The file is the arrays the network uses, in the order internal/rnnoise/model.go reads them: the big weight matrices as 16-bit floats (half the
// size, and the network does not feel it), the rest as 32-bit floats.
package main

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: rnnoise-model <rnnoise>/src out.bin")
		os.Exit(2)
	}
	src := os.Args[1]
	data := read(filepath.Join(src, "rnnoise_data.c"))
	tables := read(filepath.Join(src, "rnnoise_tables.c"))

	var out []byte
	put := func(text, name string, ints bool, want int) {
		values := array(text, name)
		if len(values) != want {
			panic(fmt.Sprintf("%s: %d values, want %d", name, len(values), want))
		}
		for _, v := range values {
			switch {
			case ints:
				out = binary.LittleEndian.AppendUint32(out, uint32(int32(v)))
			case want >= 24960:
				out = binary.LittleEndian.AppendUint16(out, half(float32(v)))
			default:
				out = binary.LittleEndian.AppendUint32(out, math.Float32bits(float32(v)))
			}
		}
	}
	put(data, "conv1_weights_float", false, 24960)
	put(data, "conv1_bias", false, 128)
	put(data, "conv2_weights_float", false, 147456)
	put(data, "conv2_bias", false, 384)
	for g := 1; g <= 3; g++ {
		in, rec := fmt.Sprintf("gru%d_input_", g), fmt.Sprintf("gru%d_recurrent_", g)
		put(data, in+"weights_float", false, 147456)
		put(data, in+"weights_idx", true, 4752)
		put(data, in+"bias", false, 1152)
		put(data, rec+"weights_float", false, 147456)
		put(data, rec+"weights_idx", true, 4752)
		put(data, rec+"bias", false, 1152)
		put(data, rec+"weights_diag", false, 1152)
	}
	put(data, "dense_out_weights_float", false, 12288)
	put(data, "dense_out_bias", false, 32)
	put(data, "vad_dense_weights_float", false, 384)
	put(data, "vad_dense_bias", false, 1)
	put(tables, "rnn_half_window", false, 480)
	put(tables, "rnn_dct_table", false, 1024)
	if err := os.WriteFile(os.Args[2], out, 0o644); err != nil {
		panic(err)
	}
	fmt.Println(len(out), "bytes")
}

func read(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func array(text, name string) []float64 {
	re := regexp.MustCompile(`(?s)\b` + regexp.QuoteMeta(name) + `\[[0-9]*\]\s*=\s*\{(.*?)\};`)
	m := re.FindStringSubmatch(text)
	if m == nil {
		panic("missing " + name)
	}
	var values []float64
	for _, field := range strings.FieldsFunc(m[1], func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\t' || r == '\r' }) {
		v, err := strconv.ParseFloat(strings.TrimSuffix(field, "f"), 64)
		if err != nil {
			panic(name + ": " + field)
		}
		values = append(values, v)
	}
	return values
}

// half is x as an IEEE 16-bit float, rounded to nearest even.
func half(x float32) uint16 {
	b := math.Float32bits(x)
	sign := uint16(b>>16) & 0x8000
	exp := int(b>>23&0xff) - 127 + 15
	mant := b & 0x7fffff
	switch {
	case exp >= 31:
		return sign | 0x7c00
	case exp <= 0:
		if exp < -10 {
			return sign
		}
		mant |= 0x800000
		shift := uint(14 - exp)
		r := mant >> shift
		if rem := mant & (1<<shift - 1); rem > 1<<(shift-1) || rem == 1<<(shift-1) && r&1 == 1 {
			r++
		}
		return sign | uint16(r)
	}
	r := uint32(exp)<<10 | mant>>13
	if rem := mant & 0x1fff; rem > 0x1000 || rem == 0x1000 && r&1 == 1 {
		r++
	}
	return sign | uint16(r)
}
