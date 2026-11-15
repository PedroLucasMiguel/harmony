//go:build linux

package native

import (
	"testing"
	"unsafe"
)

// The numbers are what a C compiler gives for the NVIDIA headers (nvEncodeAPI.h of Video Codec SDK 11.1, nvcuvid.h and
// cuviddec.h, cuda.h) on a 64 bit machine; a struct that differs makes the driver read the wrong fields.
func TestNVLayouts(t *testing.T) {
	for _, c := range []struct {
		name      string
		got, want uintptr
	}{
		{"GUID", unsafe.Sizeof(nvGUID{}), 16},
		{"NV_ENC_CAPS_PARAM", unsafe.Sizeof(nvEncCapsParam{}), 256},
		{"NV_ENC_CREATE_INPUT_BUFFER", unsafe.Sizeof(nvEncCreateInput{}), 776},
		{"NV_ENC_CREATE_INPUT_BUFFER.inputBuffer", unsafe.Offsetof(nvEncCreateInput{}.inputBuffer), 24},
		{"NV_ENC_CREATE_BITSTREAM_BUFFER", unsafe.Sizeof(nvEncCreateBitstream{}), 776},
		{"NV_ENC_CREATE_BITSTREAM_BUFFER.bitstreamBuffer", unsafe.Offsetof(nvEncCreateBitstream{}.bitstreamBuffer), 16},
		{"NV_ENC_RC_PARAMS", unsafe.Sizeof(nvEncRCParams{}), 128},
		{"NV_ENC_RC_PARAMS.averageBitRate", unsafe.Offsetof(nvEncRCParams{}.averageBitRate), 20},
		{"NV_ENC_RC_PARAMS.vbvBufferSize", unsafe.Offsetof(nvEncRCParams{}.vbvBufferSize), 28},
		{"NV_ENC_RC_PARAMS.minQP", unsafe.Offsetof(nvEncRCParams{}.minQP), 40},
		{"NV_ENC_RC_PARAMS.lowDelayKeyFrameScale", unsafe.Offsetof(nvEncRCParams{}.lowDelayKeyScal), 92},
		{"NV_ENC_RC_PARAMS.multiPass", unsafe.Offsetof(nvEncRCParams{}.multiPass), 100},
		{"NV_ENC_CONFIG_H264_VUI_PARAMETERS", unsafe.Sizeof(nvEncH264VUI{}), 112},
		{"NV_ENC_CONFIG_H264", unsafe.Sizeof(nvEncH264Config{}), 1792},
		{"NV_ENC_CONFIG_H264.idrPeriod", unsafe.Offsetof(nvEncH264Config{}.idrPeriod), 8},
		{"NV_ENC_CONFIG_H264.entropyCodingMode", unsafe.Offsetof(nvEncH264Config{}.entropyCodingMode), 44},
		{"NV_ENC_CONFIG_H264.maxNumRefFrames", unsafe.Offsetof(nvEncH264Config{}.maxNumRefFrames), 60},
		{"NV_ENC_CONFIG_H264.h264VUIParameters", unsafe.Offsetof(nvEncH264Config{}.vui), 72},
		{"NV_ENC_CONFIG_H264.chromaFormatIDC", unsafe.Offsetof(nvEncH264Config{}.chromaFormatIDC), 192},
		{"NV_ENC_CONFIG_H264.numRefL1", unsafe.Offsetof(nvEncH264Config{}.numRefL1), 208},
		{"NV_ENC_CONFIG", unsafe.Sizeof(nvEncConfig{}), 3584},
		{"NV_ENC_CONFIG.profileGUID", unsafe.Offsetof(nvEncConfig{}.profileGUID), 4},
		{"NV_ENC_CONFIG.gopLength", unsafe.Offsetof(nvEncConfig{}.gopLength), 20},
		{"NV_ENC_CONFIG.rcParams", unsafe.Offsetof(nvEncConfig{}.rc), 40},
		{"NV_ENC_CONFIG.encodeCodecConfig", unsafe.Offsetof(nvEncConfig{}.h264), 168},
		{"NV_ENC_INITIALIZE_PARAMS", unsafe.Sizeof(nvEncInitParams{}), 1808},
		{"NV_ENC_INITIALIZE_PARAMS.presetGUID", unsafe.Offsetof(nvEncInitParams{}.presetGUID), 20},
		{"NV_ENC_INITIALIZE_PARAMS.encodeWidth", unsafe.Offsetof(nvEncInitParams{}.encodeWidth), 36},
		{"NV_ENC_INITIALIZE_PARAMS.frameRateNum", unsafe.Offsetof(nvEncInitParams{}.frameRateNum), 52},
		{"NV_ENC_INITIALIZE_PARAMS.enablePTD", unsafe.Offsetof(nvEncInitParams{}.enablePTD), 64},
		{"NV_ENC_INITIALIZE_PARAMS.privDataSize", unsafe.Offsetof(nvEncInitParams{}.privDataSize), 72},
		{"NV_ENC_INITIALIZE_PARAMS.encodeConfig", unsafe.Offsetof(nvEncInitParams{}.encodeConfig), 88},
		{"NV_ENC_INITIALIZE_PARAMS.maxEncodeWidth", unsafe.Offsetof(nvEncInitParams{}.maxEncodeWidth), 96},
		{"NV_ENC_INITIALIZE_PARAMS.tuningInfo", unsafe.Offsetof(nvEncInitParams{}.tuningInfo), 136},
		{"NV_ENC_INITIALIZE_PARAMS.bufferFormat", unsafe.Offsetof(nvEncInitParams{}.bufferFormat), 140},
		{"NV_ENC_PRESET_CONFIG", unsafe.Sizeof(nvEncPresetConfig{}), 5128},
		{"NV_ENC_PRESET_CONFIG.presetCfg", unsafe.Offsetof(nvEncPresetConfig{}.preset), 8},
		{"NV_ENC_PIC_PARAMS", unsafe.Sizeof(nvEncPicParams{}), 3344},
		{"NV_ENC_PIC_PARAMS.inputPitch", unsafe.Offsetof(nvEncPicParams{}.inputPitch), 12},
		{"NV_ENC_PIC_PARAMS.encodePicFlags", unsafe.Offsetof(nvEncPicParams{}.encodePicFlags), 16},
		{"NV_ENC_PIC_PARAMS.inputTimeStamp", unsafe.Offsetof(nvEncPicParams{}.inputTimeStamp), 24},
		{"NV_ENC_PIC_PARAMS.inputBuffer", unsafe.Offsetof(nvEncPicParams{}.inputBuffer), 40},
		{"NV_ENC_PIC_PARAMS.outputBitstream", unsafe.Offsetof(nvEncPicParams{}.outputBitstream), 48},
		{"NV_ENC_PIC_PARAMS.bufferFmt", unsafe.Offsetof(nvEncPicParams{}.bufferFmt), 64},
		{"NV_ENC_PIC_PARAMS.pictureStruct", unsafe.Offsetof(nvEncPicParams{}.pictureStruct), 68},
		{"NV_ENC_PIC_PARAMS.codecPicParams", unsafe.Offsetof(nvEncPicParams{}.codecPicParams), 80},
		{"NV_ENC_LOCK_BITSTREAM", unsafe.Sizeof(nvEncLockBitstream{}), 1544},
		{"NV_ENC_LOCK_BITSTREAM.outputBitstream", unsafe.Offsetof(nvEncLockBitstream{}.outputBitstream), 8},
		{"NV_ENC_LOCK_BITSTREAM.bitstreamSizeInBytes", unsafe.Offsetof(nvEncLockBitstream{}.bitstreamSizeInBytes), 36},
		{"NV_ENC_LOCK_BITSTREAM.bitstreamBufferPtr", unsafe.Offsetof(nvEncLockBitstream{}.bitstreamBufferPtr), 56},
		{"NV_ENC_LOCK_BITSTREAM.pictureType", unsafe.Offsetof(nvEncLockBitstream{}.pictureType), 64},
		{"NV_ENC_LOCK_INPUT_BUFFER", unsafe.Sizeof(nvEncLockInput{}), 1544},
		{"NV_ENC_LOCK_INPUT_BUFFER.bufferDataPtr", unsafe.Offsetof(nvEncLockInput{}.bufferDataPtr), 16},
		{"NV_ENC_LOCK_INPUT_BUFFER.pitch", unsafe.Offsetof(nvEncLockInput{}.pitch), 24},
		{"NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS", unsafe.Sizeof(nvEncOpenSession{}), 1552},
		{"NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS.device", unsafe.Offsetof(nvEncOpenSession{}.device), 8},
		{"NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS.apiVersion", unsafe.Offsetof(nvEncOpenSession{}.apiVersion), 24},
		{"NV_ENCODE_API_FUNCTION_LIST", unsafe.Sizeof(nvEncFunctions{}), 2552},
		{"NV_ENCODE_API_FUNCTION_LIST.nvEncOpenEncodeSession", unsafe.Offsetof(nvEncFunctions{}.openEncodeSession), 8},
		{"NV_ENCODE_API_FUNCTION_LIST.nvEncGetEncodeGUIDs", unsafe.Offsetof(nvEncFunctions{}.getEncodeGUIDs), 40},
		{"NV_ENCODE_API_FUNCTION_LIST.nvEncGetEncodeCaps", unsafe.Offsetof(nvEncFunctions{}.getEncodeCaps), 64},
		{"NV_ENCODE_API_FUNCTION_LIST.nvEncGetEncodePresetConfig", unsafe.Offsetof(nvEncFunctions{}.getEncodePresetConfig), 88},
		{"NV_ENCODE_API_FUNCTION_LIST.nvEncInitializeEncoder", unsafe.Offsetof(nvEncFunctions{}.initializeEncoder), 96},
		{"NV_ENCODE_API_FUNCTION_LIST.nvEncEncodePicture", unsafe.Offsetof(nvEncFunctions{}.encodePicture), 136},
		{"NV_ENCODE_API_FUNCTION_LIST.nvEncDestroyEncoder", unsafe.Offsetof(nvEncFunctions{}.destroyEncoder), 224},
		{"NV_ENCODE_API_FUNCTION_LIST.nvEncOpenEncodeSessionEx", unsafe.Offsetof(nvEncFunctions{}.openEncodeSessionEx), 240},
		{"NV_ENCODE_API_FUNCTION_LIST.nvEncGetLastErrorString", unsafe.Offsetof(nvEncFunctions{}.getLastErrorString), 304},
		{"NV_ENCODE_API_FUNCTION_LIST.nvEncGetEncodePresetConfigEx", unsafe.Offsetof(nvEncFunctions{}.getEncodePresetConfigEx), 320},
		{"NV_ENCODE_API_FUNCTION_LIST.reserved2", unsafe.Offsetof(nvEncFunctions{}.reserved2), 336},

		{"CUVIDDECODECAPS", unsafe.Sizeof(cuvidDecodeCaps{}), 88},
		{"CUVIDDECODECAPS.bIsSupported", unsafe.Offsetof(cuvidDecodeCaps{}.isSupported), 24},
		{"CUVIDDECODECAPS.nOutputFormatMask", unsafe.Offsetof(cuvidDecodeCaps{}.outputFormatMask), 26},
		{"CUVIDDECODECAPS.nMaxWidth", unsafe.Offsetof(cuvidDecodeCaps{}.maxWidth), 28},
		{"CUVIDDECODECAPS.nMinWidth", unsafe.Offsetof(cuvidDecodeCaps{}.minWidth), 40},
		{"CUVIDDECODECREATEINFO", unsafe.Sizeof(cuvidCreateInfo{}), 176},
		{"CUVIDDECODECREATEINFO.ulNumDecodeSurfaces", unsafe.Offsetof(cuvidCreateInfo{}.numDecodeSurfaces), 16},
		{"CUVIDDECODECREATEINFO.CodecType", unsafe.Offsetof(cuvidCreateInfo{}.codecType), 24},
		{"CUVIDDECODECREATEINFO.ulCreationFlags", unsafe.Offsetof(cuvidCreateInfo{}.creationFlags), 32},
		{"CUVIDDECODECREATEINFO.ulMaxWidth", unsafe.Offsetof(cuvidCreateInfo{}.maxWidth), 56},
		{"CUVIDDECODECREATEINFO.display_area", unsafe.Offsetof(cuvidCreateInfo{}.displayArea), 80},
		{"CUVIDDECODECREATEINFO.OutputFormat", unsafe.Offsetof(cuvidCreateInfo{}.outputFormat), 88},
		{"CUVIDDECODECREATEINFO.ulTargetWidth", unsafe.Offsetof(cuvidCreateInfo{}.targetWidth), 96},
		{"CUVIDDECODECREATEINFO.ulNumOutputSurfaces", unsafe.Offsetof(cuvidCreateInfo{}.numOutputSurfaces), 112},
		{"CUVIDDECODECREATEINFO.vidLock", unsafe.Offsetof(cuvidCreateInfo{}.vidLock), 120},
		{"CUVIDDECODECREATEINFO.target_rect", unsafe.Offsetof(cuvidCreateInfo{}.targetRect), 128},
		{"CUVIDEOFORMAT", unsafe.Sizeof(cuvidVideoFormat{}), 64},
		{"CUVIDEOFORMAT.min_num_decode_surfaces", unsafe.Offsetof(cuvidVideoFormat{}.minNumDecodeSurfaces), 15},
		{"CUVIDEOFORMAT.coded_width", unsafe.Offsetof(cuvidVideoFormat{}.codedWidth), 16},
		{"CUVIDEOFORMAT.display_area", unsafe.Offsetof(cuvidVideoFormat{}.displayArea), 24},
		{"CUVIDEOFORMAT.chroma_format", unsafe.Offsetof(cuvidVideoFormat{}.chromaFormat), 40},
		{"CUVIDEOFORMAT.video_signal_description", unsafe.Offsetof(cuvidVideoFormat{}.signal), 56},
		{"CUVIDEOFORMAT.matrix_coefficients", unsafe.Offsetof(cuvidVideoFormat{}.matrix), 59},
		{"CUVIDPARSERDISPINFO", unsafe.Sizeof(cuvidDispInfo{}), 24},
		{"CUVIDPARSERDISPINFO.timestamp", unsafe.Offsetof(cuvidDispInfo{}.timestamp), 16},
		{"CUVIDPARSERPARAMS", unsafe.Sizeof(cuvidParserParams{}), 136},
		{"CUVIDPARSERPARAMS.ulMaxDisplayDelay", unsafe.Offsetof(cuvidParserParams{}.maxDisplayDelay), 16},
		{"CUVIDPARSERPARAMS.pUserData", unsafe.Offsetof(cuvidParserParams{}.userData), 40},
		{"CUVIDPARSERPARAMS.pfnSequenceCallback", unsafe.Offsetof(cuvidParserParams{}.sequenceCallback), 48},
		{"CUVIDPARSERPARAMS.pfnDisplayPicture", unsafe.Offsetof(cuvidParserParams{}.displayCallback), 64},
		{"CUVIDPARSERPARAMS.pExtVideoInfo", unsafe.Offsetof(cuvidParserParams{}.extVideoInfo), 128},
		{"CUVIDSOURCEDATAPACKET", unsafe.Sizeof(cuvidSourcePacket{}), 32},
		{"CUVIDSOURCEDATAPACKET.payload", unsafe.Offsetof(cuvidSourcePacket{}.payload), 16},
		{"CUVIDPROCPARAMS", unsafe.Sizeof(cuvidProcParams{}), 264},
		{"CUVIDPROCPARAMS.output_stream", unsafe.Offsetof(cuvidProcParams{}.outputStream), 56},
		{"CUDA_MEMCPY2D", unsafe.Sizeof(cudaMemcpy2D{}), 128},
		{"CUDA_MEMCPY2D.srcDevice", unsafe.Offsetof(cudaMemcpy2D{}.srcDevice), 32},
		{"CUDA_MEMCPY2D.srcPitch", unsafe.Offsetof(cudaMemcpy2D{}.srcPitch), 48},
		{"CUDA_MEMCPY2D.dstMemoryType", unsafe.Offsetof(cudaMemcpy2D{}.dstMemoryType), 72},
		{"CUDA_MEMCPY2D.dstHost", unsafe.Offsetof(cudaMemcpy2D{}.dstHost), 80},
		{"CUDA_MEMCPY2D.dstPitch", unsafe.Offsetof(cudaMemcpy2D{}.dstPitch), 104},
		{"CUDA_MEMCPY2D.Height", unsafe.Offsetof(cudaMemcpy2D{}.height), 120},
	} {
		if c.got != c.want {
			t.Errorf("%s is %d, the header says %d", c.name, c.got, c.want)
		}
	}
}

// The versions the driver checks, from NVENCAPI_STRUCT_VERSION with API 11.1.
func TestNVEncVersions(t *testing.T) {
	for _, c := range []struct {
		name      string
		got, want uint32
	}{
		{"NVENCAPI_VERSION", nvEncAPIVersion, 0x0100000b},
		{"NV_ENCODE_API_FUNCTION_LIST_VER", nvEncFunctionListVer, 0x7102000b},
		{"NV_ENC_CONFIG_VER", nvEncConfigVer, 0xf107000b},
		{"NV_ENC_INITIALIZE_PARAMS_VER", nvEncInitParamsVer, 0xf105000b},
		{"NV_ENC_PRESET_CONFIG_VER", nvEncPresetConfigVer, 0xf104000b},
		{"NV_ENC_PIC_PARAMS_VER", nvEncPicParamsVer, 0xf104000b},
		{"NV_ENC_LOCK_BITSTREAM_VER", nvEncLockBitstreamVer, 0x7101000b},
		{"NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER", nvEncOpenSessionVer, 0x7101000b},
	} {
		if c.got != c.want {
			t.Errorf("%s is %#x, the header says %#x", c.name, c.got, c.want)
		}
	}
}

// A GUID travels in two integer registers: the first 8 bytes, then the last 8, as a little endian machine reads them.
func TestNVGUIDWords(t *testing.T) {
	lo, hi := nvEncCodecH264.words()
	if lo != 0x4ca44e636bc82762 || hi != 0xbff621f3501e85aa {
		t.Errorf("H.264 GUID words %#x %#x", lo, hi)
	}
}

func TestNVHasIDR(t *testing.T) {
	idr := []byte{0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x68, 3, 0, 0, 1, 0x65, 9}
	p := []byte{0, 0, 0, 1, 0x41, 1, 2, 3}
	if !nvHasIDR(idr) || nvHasIDR(p) || nvHasIDR(nil) {
		t.Error("IDR detection")
	}
}
