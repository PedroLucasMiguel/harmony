package paint

import (
	"image/color"

	"harmony/v2/internal/ui/raw"
)

const (
	maxVertices = 1 << 15
	maxIndices  = 3 * maxVertices
	vertexSize  = 20

	glFloat        = 0x1406
	glUnsignedByte = 0x1401
	uniformVec4    = 3
)

type vertex struct {
	x, y, u, v float32
	c          color.RGBA
}

type scissor struct {
	on         bool
	x, y, w, h int32
}

type drawCall struct {
	texture uint32
	clip    scissor
	first   int
}

// batch gathers a frame's triangles, in the order they are drawn, and sends them to the GPU in one buffer upload and one draw call per texture or clip change.
type batch struct {
	vertices []vertex
	indices  []uint16
	nv, ni   int
	runs     []drawCall
	clip     scissor

	vao, vbo, ebo uint32
	shader        uint32
	mvp, diffuse  int32
	white         [4]float32
	projection    [16]float32

	dpi                       float32
	screenH, renderW, renderH float32
}

func newBatch(dpi float32) *batch {
	b := &batch{dpi: dpi, vertices: make([]vertex, maxVertices), indices: make([]uint16, maxIndices), runs: make([]drawCall, 0, 256)}
	b.shader = uint32(gl.shaderID.Call())
	b.mvp = int32(gl.locationUniform.Call(uintptr(b.shader), raw.CString("mvp")))
	b.diffuse = int32(gl.locationUniform.Call(uintptr(b.shader), raw.CString("colDiffuse")))
	position := gl.locationAttrib.Call(uintptr(b.shader), raw.CString("vertexPosition"))
	texcoord := gl.locationAttrib.Call(uintptr(b.shader), raw.CString("vertexTexCoord"))
	colour := gl.locationAttrib.Call(uintptr(b.shader), raw.CString("vertexColor"))

	b.vao = uint32(gl.loadVertexArray.Call())
	gl.enableVertexArray.Call(uintptr(b.vao))
	b.vbo = uint32(gl.loadVertexBuffer.Call(0, maxVertices*vertexSize, 1))
	gl.setVertexAttribute.Call(position, 2, glFloat, 0, vertexSize, 0)
	gl.enableVertexAttribute.Call(position)
	gl.setVertexAttribute.Call(texcoord, 2, glFloat, 0, vertexSize, 8)
	gl.enableVertexAttribute.Call(texcoord)
	gl.setVertexAttribute.Call(colour, 4, glUnsignedByte, 1, vertexSize, 16)
	gl.enableVertexAttribute.Call(colour)
	b.ebo = uint32(gl.loadVertexBufferElement.Call(0, maxIndices*2, 1))
	gl.disableVertexArray.Call()

	b.white = [4]float32{1, 1, 1, 1}
	gl.enableShader.Call(uintptr(b.shader))
	gl.setUniform.Call(uintptr(b.diffuse), raw.Ptr(&b.white[0]), uniformVec4, 1)
	gl.disableShader.Call()
	return b
}

func (b *batch) close() {
	gl.unloadVertexArray.Call(uintptr(b.vao))
	gl.unloadVertexBuffer.Call(uintptr(b.vbo))
	gl.unloadVertexBuffer.Call(uintptr(b.ebo))
}

// reserve makes room for nv vertices and ni indices drawn with texture, and returns the slices to fill and the first vertex's index.
func (b *batch) reserve(texture uint32, nv, ni int) (v []vertex, ix []uint16, base uint16) {
	if b.nv+nv > maxVertices || b.ni+ni > maxIndices {
		b.flush()
	}
	if n := len(b.runs); n == 0 || b.runs[n-1].texture != texture || b.runs[n-1].clip != b.clip {
		if n == 0 {
			b.screenH = float32(raw.GetScreenHeight())
			b.renderW, b.renderH = float32(raw.GetRenderWidth()), float32(raw.GetRenderHeight())
		}
		b.runs = append(b.runs, drawCall{texture: texture, clip: b.clip, first: b.ni})
	}
	base = uint16(b.nv)
	v, ix = b.vertices[b.nv:b.nv+nv], b.indices[b.ni:b.ni+ni]
	b.nv += nv
	b.ni += ni
	return v, ix, base
}

// current is the texture the last primitive was drawn with, or 0 when the frame has none yet.
func (b *batch) current() uint32 {
	if n := len(b.runs); n > 0 {
		return b.runs[n-1].texture
	}
	return 0
}

// flush draws everything gathered so far; it runs when the frame ends and when the buffers are full.
func (b *batch) flush() {
	if b.ni == 0 {
		return
	}
	dpi := b.dpi
	b.projection = [16]float32{
		2 * dpi / b.renderW, 0, 0, -1,
		0, -2 * dpi / b.renderH, 0, 1,
		0, 0, 0, 0,
		0, 0, 0, 1,
	}
	gl.enableShader.Call(uintptr(b.shader))
	gl.setUniformMatrices.Call(uintptr(b.mvp), raw.Ptr(&b.projection[0]), 1)
	gl.enableVertexArray.Call(uintptr(b.vao))
	gl.updateVertexBuffer.Call(uintptr(b.vbo), raw.Ptr(&b.vertices[0]), uintptr(b.nv*vertexSize), 0)
	gl.updateVertexBufferElements.Call(uintptr(b.ebo), raw.Ptr(&b.indices[0]), uintptr(b.ni*2), 0)
	var bound uint32 = 1<<32 - 1
	var clip scissor
	for i, r := range b.runs {
		end := b.ni
		if i+1 < len(b.runs) {
			end = b.runs[i+1].first
		}
		if r.texture != bound {
			gl.enableTexture.Call(uintptr(r.texture))
			bound = r.texture
		}
		if r.clip != clip {
			b.setScissor(r.clip, dpi)
			clip = r.clip
		}
		gl.drawVertexArrayElements.Call(uintptr(r.first), uintptr(end-r.first), 0)
	}
	if clip.on {
		gl.disableScissorTest.Call()
	}
	gl.enableTexture.Call(0)
	gl.disableVertexArray.Call()
	gl.disableShader.Call()
	b.nv, b.ni = 0, 0
	b.runs = b.runs[:0]
}

func (b *batch) setScissor(s scissor, dpi float32) {
	if !s.on {
		gl.disableScissorTest.Call()
		return
	}
	gl.enableScissorTest.Call()
	x := int32(float32(s.x) * dpi)
	y := int32(b.screenH*dpi - float32(s.y+s.h)*dpi)
	w, h := int32(float32(s.w)*dpi), int32(float32(s.h)*dpi)
	gl.scissor.Call(uintptr(x), uintptr(y), uintptr(w), uintptr(h))
}
