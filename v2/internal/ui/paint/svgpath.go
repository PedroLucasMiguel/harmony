package paint

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var (
	pathAttr = regexp.MustCompile(`\bd="([^"]*)"`)
	pathTok  = regexp.MustCompile(`[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?`)
	argCount = map[byte]int{'M': 2, 'L': 2, 'H': 1, 'V': 1, 'C': 6, 'S': 4, 'Q': 4, 'T': 2, 'A': 7, 'Z': 0}
)

func absolutePaths(svg []byte) []byte {
	return pathAttr.ReplaceAllFunc(svg, func(attr []byte) []byte {
		d := pathAttr.FindSubmatch(attr)[1]
		return []byte(`d="` + absolutePath(string(d)) + `"`)
	})
}

func absolutePath(d string) string {
	var out strings.Builder
	var cx, cy, sx, sy float64
	cmd := byte(0)
	tokens := pathTok.FindAllString(d, -1)
	for i := 0; i < len(tokens); {
		if len(tokens[i]) == 1 && strings.ContainsAny(tokens[i], "MmLlHhVvCcSsQqTtAaZz") {
			cmd = tokens[i][0]
			i++
			if cmd == 'Z' || cmd == 'z' {
				out.WriteString("Z ")
				cx, cy = sx, sy
				continue
			}
		}
		upper := cmd &^ 0x20
		n := argCount[upper]
		if n == 0 || i+n > len(tokens) {
			break
		}
		args := make([]float64, n)
		for j := range args {
			args[j], _ = strconv.ParseFloat(tokens[i+j], 64)
		}
		i += n
		relative := cmd >= 'a'
		if relative {
			shift(upper, args, cx, cy)
		}
		cx, cy = emit(&out, upper, args, cx, cy)
		if upper == 'M' {
			sx, sy = cx, cy
			cmd = map[bool]byte{true: 'l', false: 'L'}[relative]
		}
	}
	return out.String()
}

func shift(cmd byte, args []float64, cx, cy float64) {
	switch cmd {
	case 'H':
		args[0] += cx
	case 'V':
		args[0] += cy
	case 'A':
		args[5] += cx
		args[6] += cy
	default:
		for j := range args {
			if j%2 == 0 {
				args[j] += cx
			} else {
				args[j] += cy
			}
		}
	}
}

func emit(out *strings.Builder, cmd byte, args []float64, cx, cy float64) (float64, float64) {
	switch cmd {
	case 'H':
		fmt.Fprintf(out, "L%g %g ", args[0], cy)
		return args[0], cy
	case 'V':
		fmt.Fprintf(out, "L%g %g ", cx, args[0])
		return cx, args[0]
	}
	fmt.Fprintf(out, "%c", cmd)
	for _, a := range args {
		fmt.Fprintf(out, "%g ", a)
	}
	return args[len(args)-2], args[len(args)-1]
}
