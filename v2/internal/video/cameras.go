package video

import "harmony/v2/internal/video/native"

// Camera is a video input; ID is what a saved choice is kept by, as the system names it.
type Camera = native.CameraInfo

// Cameras lists the video inputs this computer has, the default one first.
func Cameras() []Camera { return native.Cameras() }
