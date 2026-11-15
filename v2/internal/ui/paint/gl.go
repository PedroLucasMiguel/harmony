package paint

import "harmony/v2/internal/ui/raw"

// The frame is submitted through the library's rlgl entry points directly: raylib's own binding boxes every argument of
// every call (6 allocations for one textured quad).
var gl struct {
	loadVertexArray, loadVertexBuffer, loadVertexBufferElement, unloadVertexArray, unloadVertexBuffer raw.Entry
	setVertexAttribute, enableVertexAttribute, enableVertexArray, disableVertexArray                  raw.Entry
	updateVertexBuffer, updateVertexBufferElements, drawVertexArrayElements                           raw.Entry
	enableShader, disableShader, enableTexture, enableScissorTest, disableScissorTest, scissor        raw.Entry
	setUniformMatrices, setUniform, shaderID, locationUniform, locationAttrib                         raw.Entry
}

func init() {
	gl.loadVertexArray = raw.Lookup("rlLoadVertexArray")
	gl.loadVertexBuffer = raw.Lookup("rlLoadVertexBuffer")
	gl.loadVertexBufferElement = raw.Lookup("rlLoadVertexBufferElement")
	gl.unloadVertexArray = raw.Lookup("rlUnloadVertexArray")
	gl.unloadVertexBuffer = raw.Lookup("rlUnloadVertexBuffer")
	gl.setVertexAttribute = raw.Lookup("rlSetVertexAttribute")
	gl.enableVertexAttribute = raw.Lookup("rlEnableVertexAttribute")
	gl.enableVertexArray = raw.Lookup("rlEnableVertexArray")
	gl.disableVertexArray = raw.Lookup("rlDisableVertexArray")
	gl.updateVertexBuffer = raw.Lookup("rlUpdateVertexBuffer")
	gl.updateVertexBufferElements = raw.Lookup("rlUpdateVertexBufferElements")
	gl.drawVertexArrayElements = raw.Lookup("rlDrawVertexArrayElements")
	gl.enableShader = raw.Lookup("rlEnableShader")
	gl.disableShader = raw.Lookup("rlDisableShader")
	gl.enableTexture = raw.Lookup("rlEnableTexture")
	gl.enableScissorTest = raw.Lookup("rlEnableScissorTest")
	gl.disableScissorTest = raw.Lookup("rlDisableScissorTest")
	gl.scissor = raw.Lookup("rlScissor")
	gl.setUniformMatrices = raw.Lookup("rlSetUniformMatrices")
	gl.setUniform = raw.Lookup("rlSetUniform")
	gl.shaderID = raw.Lookup("rlGetShaderIdDefault")
	gl.locationUniform = raw.Lookup("rlGetLocationUniform")
	gl.locationAttrib = raw.Lookup("rlGetLocationAttrib")
}
