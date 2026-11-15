package video

// What a screen share is sent at, as the Electron client's picker offers it: a resolution and a frame rate chosen
// separately, the bit rate following from the pair.

// Share resolutions, as the settings file and the picker name them.
const (
	Res480    = "480"
	Res720    = "720"
	Res1080   = "1080"
	ResNative = "native"
)

// ShareResolutions and ShareFramerates are the choices in the order they are listed. A frame rate of 0 is Native: as fast
// as the screen goes, up to nativeShareFPS.
var (
	ShareResolutions = []string{Res480, Res720, Res1080, ResNative}
	ShareFramerates  = []int{30, 60, 120, 0}
)

const (
	nativeShareFPS     = 120
	nativeBitrateRatio = 1.25
	nativeShareHeight  = 1080
)

// bitrateMbps are the ceilings, one row per resolution and a column per frame rate in ShareFramerates (30, 60, 120); the
// encoder spends less on a still desktop.
var bitrateMbps = map[string][3]float64{
	Res480:    {1.5, 2.5, 4},
	Res720:    {3, 5, 8},
	Res1080:   {8, 12, 18},
	ResNative: {15, 20, 28},
}

// ShareQuality is what a share is asked to be.
type ShareQuality struct {
	Resolution string
	// FPS is one of ShareFramerates; 0 is Native.
	FPS int
	// Sharp keeps the size and lowers the frame rate first when the computer cannot keep up; otherwise (Smooth) the frame rate
	// is kept and the picture is made smaller first.
	Sharp bool
}

// DefaultShareQuality is what a fresh settings file means.
var DefaultShareQuality = ShareQuality{Resolution: Res1080, FPS: 30, Sharp: true}

// Valid puts anything unknown to the default.
func (q ShareQuality) Valid() ShareQuality {
	ok := false
	for _, r := range ShareResolutions {
		ok = ok || r == q.Resolution
	}
	if !ok {
		q.Resolution = DefaultShareQuality.Resolution
	}
	ok = false
	for _, f := range ShareFramerates {
		ok = ok || f == q.FPS
	}
	if !ok {
		q.FPS = DefaultShareQuality.FPS
	}
	return q
}

// Height is the stream's height in lines; for Native, 1080 where the system cannot say the source's own.
func (q ShareQuality) Height() int {
	switch q.Resolution {
	case Res480:
		return 480
	case Res720:
		return 720
	}
	return nativeShareHeight
}

// Native says the source's own size is wanted.
func (q ShareQuality) Native() bool { return q.Resolution == ResNative }

// Rate is the frame rate asked of the capture.
func (q ShareQuality) Rate() int {
	if q.FPS == 0 {
		return nativeShareFPS
	}
	return q.FPS
}

// BitrateKbps is the ceiling for the pair.
func (q ShareQuality) BitrateKbps() int {
	q = q.Valid()
	column := 2
	switch q.FPS {
	case 30:
		column = 0
	case 60:
		column = 1
	}
	mbps := bitrateMbps[q.Resolution][column]
	if q.FPS == 0 {
		mbps *= nativeBitrateRatio
	}
	return int(mbps * 1000)
}
