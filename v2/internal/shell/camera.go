package shell

import (
	"os"

	"harmony/v2/internal/app"
	"harmony/v2/internal/screens/settings"
)

// cameraRequest is the camera as the settings say it, or as a choice not yet saved says it.
func (sh *Shell) cameraRequest(c settings.CameraChoice) app.CameraRequest {
	source := "camera"
	switch kind := os.Getenv("HARMONY2_TEST_CAMERA"); kind {
	case "":
	case "black", "bars":
		source = kind
	default:
		source = "test"
	}
	return app.CameraRequest{Source: source, Device: c.Device, Size: c.Size, Rate: c.Rate, Encoder: sh.encoder()}
}

func (sh *Shell) cameraChoice() settings.CameraChoice {
	return settings.CameraChoice{Device: sh.settings.CameraDevice, Size: sh.settings.CameraSize, Rate: sh.settings.CameraRate}
}

func (sh *Shell) startCamera(session *app.Session) error {
	return session.StartCamera(sh.cameraRequest(sh.cameraChoice()))
}

// restartCamera moves a camera that is on to the encoder now chosen.
func (sh *Shell) restartCamera(session *app.Session) {
	if !session.State().Camera {
		return
	}
	session.StopCamera()
	go func() { _ = sh.startCamera(session) }()
}

// changeCamera moves a camera that is on to the camera and quality now chosen. One that will not do it is put back as it
// was, the settings with it, and done is told what to say, on the interface's thread.
func (sh *Shell) changeCamera(session *app.Session, prev settings.CameraChoice, done func(string)) {
	if !session.State().Camera {
		done("")
		return
	}
	next := sh.cameraChoice()
	quality := next.Device == prev.Device
	go func() {
		note, reverted := session.ChangeCamera(sh.cameraRequest(next), sh.cameraRequest(prev), quality)
		sh.context.Post(func() {
			if reverted {
				sh.settings.CameraDevice, sh.settings.CameraSize, sh.settings.CameraRate = prev.Device, prev.Size, prev.Rate
				sh.settings.Save()
			}
			done(note)
		})
	}()
}
