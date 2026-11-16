package paint

import (
	"image/color"
	"os"
	"unsafe"

	rl "github.com/gen2brain/raylib-go/raylib"
	"github.com/go-text/typesetting/font"
	"github.com/go-text/typesetting/font/opentype"
)

// Glyphs are rasterised by the graphics card: the outline goes up as a handful of curves and a shader works out, for every
// pixel of the glyph's box in the atlas, how much of it the outline covers. The coverage is exact across the pixel and sampled
// in 12 rows down it, so edges are as smooth as the CPU rasteriser's, at any position inside a pixel. The glyphs asked for
// during a frame are drawn in one pass before the frame's batch is.

const (
	curveTexels = 2048
	curveRows   = 4
	cubicPieces = 4
)

// coverageShader sums, for 12 rows of each pixel, the signed coverage of every curve that crosses the row: a crossing at x
// covers the part of the pixel to its right. The first and count of the glyph's curves arrive in the vertex colour.
const coverageShader = `#version 330
in vec2 fragTexCoord;
in vec4 fragColor;
uniform sampler2D curves;
uniform float gamma;
out vec4 finalColor;
const int ROWS = 12;
const int WIDTH = 2048;
vec4 texel(int i) { return texelFetch(curves, ivec2(i % WIDTH, i / WIDTH), 0); }
void main() {
	ivec4 bits = ivec4(fragColor * 255.0 + 0.5);
	int first = bits.r | (bits.g << 8);
	int count = bits.b | (bits.a << 8);
	float right = floor(fragTexCoord.x) + 1.0;
	float row = floor(fragTexCoord.y);
	float total = 0.0;
	for (int s = 0; s < ROWS; s++) {
		float y = row + (float(s) + 0.5) / float(ROWS);
		float winding = 0.0;
		for (int i = 0; i < count; i++) {
			vec4 a = texel(first + 2 * i);
			vec4 b = texel(first + 2 * i + 1);
			vec2 p0 = a.xy, p1 = a.zw, p2 = b.xy;
			if (y < min(p0.y, min(p1.y, p2.y)) || y >= max(p0.y, max(p1.y, p2.y))) continue;
			float qa = p0.y - 2.0 * p1.y + p2.y;
			float qb = 2.0 * (p1.y - p0.y);
			float qc = p0.y - y;
			float ts[2];
			int n = 0;
			if (abs(qa) < 1e-5) {
				if (abs(qb) > 1e-9) { ts[0] = -qc / qb; n = 1; }
			} else {
				float d = qb * qb - 4.0 * qa * qc;
				if (d >= 0.0) {
					float root = sqrt(d);
					ts[0] = (-qb - root) / (2.0 * qa);
					ts[1] = (-qb + root) / (2.0 * qa);
					n = 2;
				}
			}
			for (int k = 0; k < n; k++) {
				float t = ts[k];
				if (t < 0.0 || t >= 1.0) continue;
				float u = 1.0 - t;
				float x = u * u * p0.x + 2.0 * u * t * p1.x + t * t * p2.x;
				float slope = 2.0 * qa * t + qb;
				winding += (slope > 0.0 ? 1.0 : -1.0) * clamp(right - x, 0.0, 1.0);
			}
		}
		total += clamp(abs(winding), 0.0, 1.0);
	}
	finalColor = vec4(1.0, 1.0, 1.0, pow(total / float(ROWS), gamma));
}
`

type rasterJob struct {
	page, x, y, w, h int
	first, count     int
}

// gpuRaster is the shader, the texture the curves go up in, and the glyphs waiting for the next pass.
type gpuRaster struct {
	shader rl.Shader
	tex    rl.Texture2D
	gamma  int32
	// sampler is where the curves are read from, which has to be named again for every pass: the library forgets it after each draw.
	sampler int32
	pixels  []float32
	used    int
	jobs    []rasterJob
}

// newGPURaster is nil where the shader does not build or the program was told to rasterise on the processor.
func newGPURaster() *gpuRaster {
	if os.Getenv("HARMONY_CPU_GLYPHS") == "1" {
		return nil
	}
	shader := rl.LoadShaderFromMemory("", coverageShader)
	if !rl.IsShaderValid(shader) || shader.ID == rl.GetShaderIdDefault() {
		return nil
	}
	g := &gpuRaster{shader: shader, pixels: make([]float32, curveTexels*curveRows*4)}
	g.gamma = rl.GetShaderLocation(shader, "gamma")
	img := &rl.Image{Data: unsafe.Pointer(&g.pixels[0]), Width: curveTexels, Height: curveRows, Mipmaps: 1, Format: rl.UncompressedR32g32b32a32}
	g.tex = rl.LoadTextureFromImage(img)
	if g.tex.ID == 0 {
		rl.UnloadShader(shader)
		return nil
	}
	rl.SetTextureFilter(g.tex, rl.FilterPoint)
	rl.SetShaderValue(shader, g.gamma, []float32{coverageGamma}, rl.ShaderUniformFloat)
	g.sampler = rl.GetShaderLocation(shader, "curves")
	return g
}

func (g *gpuRaster) close() {
	rl.UnloadTexture(g.tex)
	rl.UnloadShader(g.shader)
}

// curves adds the outline, moved by the glyph's box and the position inside the pixel, as quadratic curves and returns where
// they start; ok is false when they do not fit, or the outline is too big to be worth sending.
func (g *gpuRaster) curves(outline font.GlyphOutline, scale, left, top, shift float32) (first, count int, ok bool) {
	first = g.used
	var start, at [2]float32
	open := false
	put := func(c [6]float32) bool {
		if g.used+2 > curveTexels*curveRows {
			return false
		}
		copy(g.pixels[g.used*4:], c[:4])
		g.pixels[g.used*4+4], g.pixels[g.used*4+5], g.pixels[g.used*4+6], g.pixels[g.used*4+7] = c[4], c[5], 0, 0
		g.used += 2
		count++
		return true
	}
	point := func(p opentype.SegmentPoint) [2]float32 {
		return [2]float32{p.X*scale - left + shift, -p.Y*scale - top}
	}
	line := func(to [2]float32) bool {
		mid := [2]float32{(at[0] + to[0]) / 2, (at[1] + to[1]) / 2}
		done := put([6]float32{at[0], at[1], mid[0], mid[1], to[0], to[1]})
		at = to
		return done
	}
	for _, seg := range outline.Segments {
		switch seg.Op {
		case opentype.SegmentOpMoveTo:
			if open && at != start && !line(start) {
				return first, 0, false
			}
			start = point(seg.Args[0])
			at, open = start, true
		case opentype.SegmentOpLineTo:
			if !line(point(seg.Args[0])) {
				return first, 0, false
			}
		case opentype.SegmentOpQuadTo:
			c, to := point(seg.Args[0]), point(seg.Args[1])
			if !put([6]float32{at[0], at[1], c[0], c[1], to[0], to[1]}) {
				return first, 0, false
			}
			at = to
		case opentype.SegmentOpCubeTo:
			if !g.cubic(&at, point(seg.Args[0]), point(seg.Args[1]), point(seg.Args[2]), put) {
				return first, 0, false
			}
		}
	}
	if open && at != start && !line(start) {
		return first, 0, false
	}
	return first, count, count > 0
}

// cubic adds a cubic curve as a few quadratic ones, each with the control point that fits its end tangents.
func (g *gpuRaster) cubic(at *[2]float32, c1, c2, to [2]float32, put func([6]float32) bool) bool {
	p := [4][2]float32{*at, c1, c2, to}
	for i := 0; i < cubicPieces; i++ {
		a, b := float32(i)/cubicPieces, float32(i+1)/cubicPieces
		q := [4][2]float32{cubicAt(p, a), {}, {}, cubicAt(p, b)}
		for k := 0; k < 2; k++ {
			d0, d1 := cubicSlope(p, a)[k]*(b-a)/3, cubicSlope(p, b)[k]*(b-a)/3
			q[1][k], q[2][k] = q[0][k]+d0, q[3][k]-d1
		}
		ctrl := [2]float32{(3*q[1][0] + 3*q[2][0] - q[0][0] - q[3][0]) / 4, (3*q[1][1] + 3*q[2][1] - q[0][1] - q[3][1]) / 4}
		if !put([6]float32{q[0][0], q[0][1], ctrl[0], ctrl[1], q[3][0], q[3][1]}) {
			return false
		}
	}
	*at = to
	return true
}

func cubicAt(p [4][2]float32, t float32) (r [2]float32) {
	u := 1 - t
	for k := range r {
		r[k] = u*u*u*p[0][k] + 3*u*u*t*p[1][k] + 3*u*t*t*p[2][k] + t*t*t*p[3][k]
	}
	return r
}

func cubicSlope(p [4][2]float32, t float32) (r [2]float32) {
	u := 1 - t
	for k := range r {
		r[k] = 3*u*u*(p[1][k]-p[0][k]) + 6*u*t*(p[2][k]-p[1][k]) + 3*t*t*(p[3][k]-p[2][k])
	}
	return r
}

// run draws every waiting glyph into its page of the atlas, one page after the other.
func (a *atlas) run() {
	g := a.gpu
	if g == nil || len(g.jobs) == 0 {
		return
	}
	rows := (g.used + curveTexels - 1) / curveTexels
	rl.UpdateTextureRec(g.tex, rl.Rectangle{Width: curveTexels, Height: float32(rows)}, unsafe.Slice((*color.RGBA)(unsafe.Pointer(&g.pixels[0])), curveTexels*rows*4))
	for page := range a.pages {
		var any bool
		for _, j := range g.jobs {
			any = any || j.page == page
		}
		if !any {
			continue
		}
		rl.BeginTextureMode(rl.RenderTexture2D{ID: a.frames[page], Texture: a.pages[page]})
		rl.BeginShaderMode(g.shader)
		rl.SetShaderValueTexture(g.shader, g.sampler, g.tex)
		rl.DisableColorBlend()
		rl.Begin(rl.Quads)
		for _, j := range g.jobs {
			if j.page != page {
				continue
			}
			top := float32(atlasSize - j.y - j.h)
			rl.Color4ub(uint8(j.first), uint8(j.first>>8), uint8(j.count), uint8(j.count>>8))
			rl.TexCoord2f(0, float32(j.h))
			rl.Vertex2f(float32(j.x), top)
			rl.TexCoord2f(0, 0)
			rl.Vertex2f(float32(j.x), top+float32(j.h))
			rl.TexCoord2f(float32(j.w), 0)
			rl.Vertex2f(float32(j.x+j.w), top+float32(j.h))
			rl.TexCoord2f(float32(j.w), float32(j.h))
			rl.Vertex2f(float32(j.x+j.w), top)
		}
		rl.End()
		rl.EndShaderMode()
		rl.EnableColorBlend()
		rl.EndTextureMode()
	}
	g.jobs, g.used = g.jobs[:0], 0
}
