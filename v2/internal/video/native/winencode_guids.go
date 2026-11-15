//go:build windows

// The GUIDs and constants the Windows encoder and capture code needs beyond the shared COM layer (wincom_*.go), written
// from the Windows SDK headers (mfapi.h, codecapi.h, d3d11.h, dxgi.h).
package native

var (
	clsidMSH264EncoderMFT = mustGUID("6ca50344-051a-4ded-9779-a43305165e35")
	iidICodecAPI          = mustGUID("901db4c7-31ce-41a2-85dc-8fa0bf41b8da")
	iidIMFMediaSource     = mustGUID("279a808d-aec7-40c8-9c6b-a6b492c78a66")

	guidVideoYUY2 = mustGUID("32595559-0000-0010-8000-00aa00389b71")
	guidVideoMJPG = mustGUID("47504a4d-0000-0010-8000-00aa00389b71")

	weMTAvgBitrate     = mustGUID("20332624-fb0d-4d9e-bd0d-cbf6786c102e")
	weMTPixelAspect    = mustGUID("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6")
	weMTMPEG2Profile   = mustGUID("ad76a80b-2d5c-4e0b-b375-64e520137036")
	weMTVideoPrimaries = mustGUID("dbfbe4d7-0740-4ee0-8192-850ab0e21935")
	weMTTransferFunc   = mustGUID("5fb0fce9-be5c-4935-a811-ec838f8eed93")

	codecRateControlMode = mustGUID("1c0608e9-370c-4710-8a58-cb6181c42423")
	codecMeanBitRate     = mustGUID("f7222374-2144-4815-b550-a37f8e12ee52")
	codecLowLatency      = mustGUID("9c27891a-ed7a-40e1-88e8-b22727a024ee")
	codecGOPSize         = mustGUID("95f31b26-95a4-41aa-9303-246a7fc6eef1")
	codecBPictureCount   = mustGUID("8d390aac-dc5c-4200-b57f-814d04babab2")
	codecForceKeyFrame   = mustGUID("398c1b98-8353-475a-9ef2-8f265d260345")
	codecProfile         = mustGUID("dabb534a-1d99-4284-975a-d90e2239baa1")
	codecRealTime        = mustGUID("143a0ff6-a131-43da-b81e-98fbb8ec378e")

	weMFDevSourceType    = mustGUID("c60ac5fe-252a-478f-a0ef-bc8fa5f7cad3")
	weMFDevSourceVidcap  = mustGUID("8ac3587a-4ae7-42d8-99e0-0a6013eef90f")
	weMFDevFriendlyName  = mustGUID("60d0e559-52f8-4fa2-bbce-acdb34a8ec01")
	weMFDevSymbolicLink  = mustGUID("58f0aad8-22bf-4f8a-bb3d-d2c4978c6e2f")
	weMFReaderVideoProc  = mustGUID("fb394f3d-ccf1-42ee-bbb3-f9b845d5681d")
	weMFReaderDisconnect = mustGUID("56b67165-219e-456d-a22e-2d3004c7fe56")

	iidIDXGIOutput1       = mustGUID("00cddea8-939b-4b83-a340-a685226666cc")
	iidID3D11VideoContext = mustGUID("61f21c45-3c0e-4a74-9cea-67100d9ad5e4")
	iidIDXGIOutputDupl    = mustGUID("191cfac3-a341-470d-b26e-a864f428319c")
)

// Media Foundation numbers: MFVideoInterlace_Progressive, the colour description values and the rate control mode.
const (
	mfInterlaceProgressive = 2
	mfPrimariesBT709       = 2
	mfPrimariesSMPTE170M   = 5
	mfTransferBT709        = 5
	mfMatrixBT709          = 1
	mfMatrixBT601          = 2
	mfRange16To235         = 2
	rateControlCBR         = 0

	mfSourceReaderFirstVideo = 0xFFFFFFFC
	mfSourceReaderAnyStream  = 0xFFFFFFFE
)
