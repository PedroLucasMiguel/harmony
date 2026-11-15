package native

// Memory layouts of the Direct3D 11 and DXGI structures the Windows screen capture passes to the system, written from d3d11.h
// and dxgi1_2.h for 64-bit Windows. The sizes are checked by a test that runs everywhere.

// d3dTexture2DDesc is D3D11_TEXTURE2D_DESC (44 bytes).
type d3dTexture2DDesc struct {
	width, height, mipLevels, arraySize uint32
	format                              uint32
	sampleCount, sampleQuality          uint32
	usage, bindFlags, cpuAccess, misc   uint32
}

// d3dMappedSubresource is D3D11_MAPPED_SUBRESOURCE (16 bytes).
type d3dMappedSubresource struct {
	data                 uintptr
	rowPitch, depthPitch uint32
}

// dxgiOutDuplDesc is DXGI_OUTDUPL_DESC (36 bytes): DXGI_MODE_DESC, rotation, and whether the image is in system memory.
type dxgiOutDuplDesc struct {
	width, height                  uint32
	refreshNum, refreshDen         uint32
	format, scanlineOrder, scaling uint32
	rotation                       uint32
	inSystemMemory                 int32
}

// dxgiOutDuplFrameInfo is DXGI_OUTDUPL_FRAME_INFO (48 bytes).
type dxgiOutDuplFrameInfo struct {
	lastPresentTime, lastMouseUpdateTime int64
	accumulatedFrames                    uint32
	rectsCoalesced, protectedMasked      int32
	pointerX, pointerY                   int32
	pointerVisible                       int32
	totalMetadataSize                    uint32
	pointerShapeSize                     uint32
}

// dxgiOutputDesc is DXGI_OUTPUT_DESC (96 bytes).
type dxgiOutputDesc struct {
	deviceName               [32]uint16
	left, top, right, bottom int32
	attached                 int32
	rotation                 uint32
	monitor                  uintptr
}

// vpContentDesc is D3D11_VIDEO_PROCESSOR_CONTENT_DESC (40 bytes).
type vpContentDesc struct {
	inputFrameFormat       uint32
	inRateNum, inRateDen   uint32
	inWidth, inHeight      uint32
	outRateNum, outRateDen uint32
	outWidth, outHeight    uint32
	usage                  uint32
}

// vpStream is D3D11_VIDEO_PROCESSOR_STREAM (72 bytes).
type vpStream struct {
	enable                                         int32
	outputIndex, inputFrameOrField                 uint32
	pastFrames, futureFrames                       uint32
	pastSurfaces, inputSurface, futureSurfaces     uintptr
	pastSurfacesRight, inputSurfaceRight, futureRt uintptr
}

// vpInputViewDesc is D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC for a 2D texture (16 bytes).
type vpInputViewDesc struct {
	fourCC, viewDimension, mipSlice, arraySlice uint32
}

// vpOutputViewDesc is D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC for a 2D texture (16 bytes).
type vpOutputViewDesc struct {
	viewDimension, mipSlice, firstArraySlice, arraySize uint32
}
