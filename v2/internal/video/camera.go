package video

import "harmony/v2/internal/video/native"

const (
	cameraBitsPerPixel = 0.075
	cameraMinKbps      = 300
	cameraMaxKbps      = 8000
)

// CameraBitrateKbps is the send rate for a camera picture of this size, in line with the Electron client: 640x360 at 24 fps is 400 kbps.
func CameraBitrateKbps(height, fps int) int {
	kbps := int(float64(height*16/9*height*fps) * cameraBitsPerPixel / 1000)
	return min(max(kbps, cameraMinKbps), cameraMaxKbps)
}

const (
	nativeFallbackHeight = 720
	nativeFallbackFPS    = 30
	nativeMaxFPS         = 60
	nativeMinFPS         = 15
	nativeFloorFPS       = 30
)

// CameraFormat is a size a camera offers and the most frames a second it keeps there.
type CameraFormat = native.CameraFormat

// CameraMode turns the chosen size and rate, where 0 is Native, into the height and frame rate to capture at. A fixed
// size and rate need no question; Native asks the camera what it can do.
func CameraMode(id string, size, rate int) (height, fps int) {
	if size > 0 && rate > 0 {
		return size, rate
	}
	return resolveMode(native.CameraFormats(id), size, rate)
}

func resolveMode(formats []CameraFormat, size, rate int) (height, fps int) {
	if size == 0 {
		if h, f, ok := bestMode(formats, rate); ok {
			return h, f
		}
		return nativeFallbackHeight, max(rate, nativeFallbackFPS)
	}
	best := 0.0
	for _, f := range formats {
		if f.H >= size {
			best = max(best, f.MaxFPS)
		}
	}
	return size, nativeRate(best)
}

// nativeRate is the camera's own rate as a whole number of frames, kept within what a call can carry.
func nativeRate(maxFPS float64) int {
	if maxFPS <= 0 {
		return nativeFallbackFPS
	}
	return min(max(int(maxFPS+0.5), nativeMinFPS), nativeMaxFPS)
}

// bestMode is the biggest picture the camera still holds at the rate wanted (30 when the camera's own is wanted), the rate
// lowered to 30 and then 15 only when no size will do. A rate of 0 in the answer follows the format found.
func bestMode(formats []CameraFormat, rate int) (height, fps int, ok bool) {
	if len(formats) == 0 {
		return 0, 0, false
	}
	wanted := rate
	if wanted == 0 {
		wanted = nativeFloorFPS
	}
	floors := []int{wanted}
	for _, f := range []int{nativeFloorFPS, nativeMinFPS} {
		if f < wanted {
			floors = append(floors, f)
		}
	}
	biggest := func(floor float64) (best CameraFormat, found bool) {
		for _, f := range formats {
			if f.MaxFPS < floor {
				continue
			}
			if !found || f.W*f.H > best.W*best.H || f.W*f.H == best.W*best.H && f.MaxFPS > best.MaxFPS {
				best, found = f, true
			}
		}
		return best, found
	}
	for _, floor := range floors {
		if best, found := biggest(float64(floor)); found {
			if rate == 0 {
				return best.H, nativeRate(best.MaxFPS), true
			}
			return best.H, min(rate, nativeRate(best.MaxFPS)), true
		}
	}
	best, _ := biggest(0)
	return best.H, nativeRate(best.MaxFPS), true
}
