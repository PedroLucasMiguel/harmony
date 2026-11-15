package settings

import (
	"slices"
	"strconv"
	"strings"

	"harmony/v2/internal/audio"
	"harmony/v2/internal/ui/widget"
	"harmony/v2/internal/video"
)

const (
	deviceMinCell = 128
	deviceGap     = 12
	deviceTop     = 8
	volumeMax     = 200
	cameraDefault = "Default camera"
	// Video encoder and decoder choices are v2-only labels, with no Electron translation.
	codecAutomatic = "Automatic (graphics card)"
	codecTitle     = "Video codecs"
	codecEncoder   = "Video encoder"
	codecDecoder   = "Video decoder"
)

// CameraSize and CameraRate of 0 are Native: the camera's biggest picture that holds 30 fps, and the camera's own rate.
var (
	cameraSizes = []int{360, 480, 720, 1080, 0}
	cameraRates = []int{24, 30, 60, 0}
)

// CameraChoice is the camera as the settings name it.
type CameraChoice struct {
	Device string
	Size   int
	Rate   int
}

type voice struct {
	d *Dialog

	microphone, output, camera widget.Dropdown
	size, rate                 widget.Dropdown
	encoder, decoder           widget.Dropdown
	gain                       widget.Slider
	mic                        *micTuning
	black                      widget.Button
	blackNote                  feedback
	autoWatch, pauseHidden     widget.Switch
	gpu                        widget.Switch

	note            string
	inputs, outputs []widget.Option
	cameras         []video.Camera
	encoders        []widget.Option
	decoders        []widget.Option
	probed          bool
	listed          bool
}

func newVoice(d *Dialog) *voice {
	v := &voice{d: d}
	v.gain = widget.Slider{Min: 0, Max: volumeMax, Step: 1, Value: d.Settings.MicGain}
	v.mic = newMicTuning(d, &v.gain)
	v.black = widget.Button{Variant: widget.Ghost, Small: true, OnClick: func() {
		d.Session.ReopenStreams()
		v.blackNote.set(d.ctx.T("settings.voice.video_fixed"), false)
		d.invalidate()
	}}

	v.microphone.OnChange = func(id string) {
		d.Settings.InputDevice = id
		d.Settings.Save()
		go d.Devices.SetInput(id)
	}
	v.output.OnChange = func(id string) {
		d.Settings.OutputDevice = id
		d.Settings.Save()
		go d.Devices.SetOutput(id)
	}
	v.camera.OnChange = func(id string) { v.cameraChanged(func() { d.Settings.CameraDevice = id }) }
	v.size.OnChange = func(value string) { v.cameraChanged(func() { d.Settings.CameraSize, _ = strconv.Atoi(value) }) }
	v.rate.OnChange = func(value string) { v.cameraChanged(func() { d.Settings.CameraRate, _ = strconv.Atoi(value) }) }

	v.encoder.OnChange = func(id string) {
		d.Settings.VideoEncoder = id
		d.Settings.Save()
		if d.EncoderChanged != nil {
			d.EncoderChanged()
		}
		d.invalidate()
	}
	v.decoder.OnChange = func(id string) {
		d.Settings.VideoDecoder = id
		d.Settings.Save()
		d.Session.SetVideoDecoder(id)
		d.invalidate()
	}

	v.autoWatch.On, v.pauseHidden.On, v.gpu.On = d.Settings.AutoWatchStreams, d.Settings.PauseHiddenCameras, d.Settings.GPUEncoding
	v.autoWatch.OnChange = func(on bool) {
		d.Settings.AutoWatchStreams = on
		d.Session.SetAutoWatch(on, on)
		d.save()
	}
	v.pauseHidden.OnChange = func(on bool) { d.Settings.PauseHiddenCameras = on; d.save() }
	v.gpu.OnChange = func(on bool) {
		d.Settings.GPUEncoding = on
		d.save()
		if d.EncoderChanged != nil {
			d.EncoderChanged()
		}
	}
	return v
}

func (v *voice) icon() string                   { return "microphone" }
func (v *voice) label(c *widget.Context) string { return c.T("settings.voice_video") }

// cameraChanged applies a change of camera, size or rate and, when the camera is on, moves it there; one that will not do it
// is put back and the note under the devices says so.
func (v *voice) cameraChanged(apply func()) {
	s := v.d.Settings
	prev := CameraChoice{Device: s.CameraDevice, Size: s.CameraSize, Rate: s.CameraRate}
	apply()
	s.Save()
	v.note = ""
	if v.d.CameraChanged != nil {
		v.d.CameraChanged(prev, func(note string) {
			v.note = note
			v.d.invalidate()
		})
	}
	v.d.invalidate()
}

// deviceNote is what is said under the devices: the last thing done about the camera, or which chosen devices are gone.
func (v *voice) deviceNote(c *widget.Context) string {
	if v.note != "" {
		return c.T(v.note)
	}
	s := v.d.Settings
	var missing []string
	if s.InputDevice != "" && known(v.inputs, s.InputDevice) == "" {
		missing = append(missing, c.T("devices.microphone"))
	}
	if s.OutputDevice != "" && known(v.outputs, s.OutputDevice) == "" {
		missing = append(missing, c.T("devices.output"))
	}
	if v.listed && s.CameraDevice != "" && !slices.ContainsFunc(v.cameras, func(cam video.Camera) bool { return cam.ID == s.CameraDevice }) {
		missing = append(missing, c.T("devices.camera"))
	}
	if len(missing) == 0 {
		return ""
	}
	return c.Strings.Plural("devices.unplugged", len(missing), "what", joinList(missing))
}

func joinList(items []string) string {
	return strings.Join(items, ", ")
}

func (v *voice) probeCameras() {
	v.probed = true
	c := v.d.ctx
	go func() {
		cameras, encoders, decoders := video.Cameras(), video.Encoders(), video.Decoders()
		c.Post(func() {
			v.cameras, v.encoders, v.decoders = cameras, backendOptions(encoders), backendOptions(decoders)
			v.listed = true
			v.d.invalidate()
		})
	}()
}

// backendOptions is the automatic choice followed by what the system has, by name.
func backendOptions(list []video.Backend) []widget.Option {
	options := []widget.Option{{Label: codecAutomatic}}
	for _, b := range list {
		options = append(options, widget.Option{Value: b.ID, Label: b.Name})
	}
	return options
}

func deviceOptions(c *widget.Context, devices []audio.Device) []widget.Option {
	options := []widget.Option{{Label: c.T("audio_menu.system_default")}}
	for _, device := range devices {
		options = append(options, widget.Option{Value: device.ID, Label: device.Name})
	}
	return options
}

func known(options []widget.Option, id string) string {
	for _, o := range options {
		if o.Value == id {
			return id
		}
	}
	return ""
}

func (v *voice) cameraOptions() []widget.Option {
	options := []widget.Option{{Label: cameraDefault}}
	for _, camera := range v.cameras {
		options = append(options, widget.Option{Value: camera.ID, Label: camera.Name})
	}
	return options
}

func (v *voice) build(c *widget.Context) widget.Component {
	if !v.probed {
		v.inputs, v.outputs = deviceOptions(c, v.d.Devices.Inputs()), deviceOptions(c, v.d.Devices.Outputs())
		v.probeCameras()
	}
	s := v.d.Settings
	v.microphone.Options, v.output.Options, v.camera.Options = v.inputs, v.outputs, v.cameraOptions()
	v.microphone.Value = known(v.inputs, s.InputDevice)
	v.output.Value = known(v.outputs, s.OutputDevice)
	v.camera.Value = known(v.camera.Options, s.CameraDevice)
	v.encoder.Options, v.decoder.Options = orAutomatic(v.encoders), orAutomatic(v.decoders)
	v.encoder.Value, v.decoder.Value = known(v.encoder.Options, s.VideoEncoder), known(v.decoder.Options, s.VideoDecoder)
	v.encoder.Disabled = !s.GPUEncoding
	v.size.Options, v.rate.Options = sizeOptions(c), rateOptions(c)
	v.size.Value, v.rate.Value = strconv.Itoa(s.CameraSize), strconv.Itoa(s.CameraRate)
	v.gain.Value = s.MicGain

	native := s.CameraSize == 0 || s.CameraRate == 0
	note := c.T("quality.note_live")
	if native || s.CameraSize == 1080 || s.CameraRate == 60 {
		note = c.T("quality.note_heavy")
	}
	if native {
		note = c.T("quality.note_native") + " " + note
	}
	return widget.Col(0,
		widget.PageTitle(c.T("settings.voice.voice_video")),
		&widget.SettingCard{Title: c.T("settings.voice.devices"), Children: []widget.Component{
			widget.Padded{Top: deviceTop, Child: &widget.Grid{MinCell: deviceMinCell, Gap: deviceGap, Children: []widget.Component{
				widget.DialogField(c.T("settings.voice.microphone"), &v.microphone),
				widget.DialogField(c.T("settings.voice.output"), &v.output),
				widget.DialogField(c.T("settings.voice.camera"), &v.camera),
			}}},
			widget.SettingWarn{Content: v.deviceNote(c), Top: deviceTop},
		}},
		&widget.SettingCard{Title: c.T("settings.voice.black_video"), Tools: v.fixButton(c), Children: append([]widget.Component{
			widget.SettingNote{Content: c.T("settings.voice.black_video_note")},
		}, v.blackNote.note()...)},
		&widget.SettingCard{Title: c.T("settings.voice.camera_quality"), Children: []widget.Component{
			widget.Padded{Top: deviceTop, Child: &widget.Grid{MinCell: deviceMinCell, Gap: deviceGap, Children: []widget.Component{
				widget.DialogField(c.T("settings.voice.resolution"), &v.size),
				widget.DialogField(c.T("settings.voice.frame_rate"), &v.rate),
			}}},
			widget.SettingNote{Content: note},
		}},
		&widget.SettingCard{Title: codecTitle, Children: []widget.Component{
			widget.Padded{Top: deviceTop, Child: &widget.Grid{MinCell: deviceMinCell, Gap: deviceGap, Children: []widget.Component{
				widget.DialogField(codecEncoder, &v.encoder),
				widget.DialogField(codecDecoder, &v.decoder),
			}}},
		}},
		v.mic.volumeCard(c, &v.gain),
		v.mic.processingCard(c),
		v.mic.pushToTalkCard(c),
		&widget.SettingCard{Children: []widget.Component{
			widget.ToggleList{
				{Title: c.T("settings.voice.auto_watch_streams"), Hint: c.T("settings.voice.auto_watch_streams_hint"), Switch: &v.autoWatch},
				{Title: c.T("settings.voice.pause_hidden_cameras"), Hint: c.T("settings.voice.pause_hidden_cameras_hint"), Switch: &v.pauseHidden},
			},
		}},
		&widget.SettingCard{Children: []widget.Component{
			widget.ToggleRow{Title: c.T("view.connect.encode_on_the_gpu"), Hint: gpuHint(c, s.GPUEncoding), Switch: &v.gpu},
		}},
	)
}

func (v *voice) fixButton(c *widget.Context) widget.Component {
	v.black.Label = c.T("settings.voice.fix_video")
	return &v.black
}

func orAutomatic(options []widget.Option) []widget.Option {
	if options == nil {
		return []widget.Option{{Label: codecAutomatic}}
	}
	return options
}

func gpuHint(c *widget.Context, on bool) string {
	if on {
		return c.T("gpu.on_encode")
	}
	return c.T("app.off_encoding_on_the_cpu")
}

func sizeOptions(c *widget.Context) []widget.Option {
	options := make([]widget.Option, len(cameraSizes))
	for i, size := range cameraSizes {
		options[i] = widget.Option{Value: strconv.Itoa(size), Label: strconv.Itoa(size) + "p"}
		if size == 0 {
			options[i].Label = c.T("quality.native")
		}
	}
	return options
}

func rateOptions(c *widget.Context) []widget.Option {
	options := make([]widget.Option, len(cameraRates))
	for i, rate := range cameraRates {
		options[i] = widget.Option{Value: strconv.Itoa(rate), Label: c.T("quality.fps", "fps", strconv.Itoa(rate))}
		if rate == 0 {
			options[i].Label = c.T("quality.native")
		}
	}
	return options
}
