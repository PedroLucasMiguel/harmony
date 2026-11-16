// Package shell owns the window, the frame loop and which screen is showing.
package shell

import (
	"context"
	"os"
	"sync/atomic"
	"time"
	"unsafe"

	rl "github.com/gen2brain/raylib-go/raylib"

	"harmony/v2/internal/app"
	"harmony/v2/internal/audio"
	"harmony/v2/internal/desktop"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/i18n"
	"harmony/v2/internal/platform"
	"harmony/v2/internal/screens/channels"
	"harmony/v2/internal/screens/connect"
	"harmony/v2/internal/screens/connectiontest"
	"harmony/v2/internal/screens/recovery"
	"harmony/v2/internal/screens/serveradmin"
	"harmony/v2/internal/screens/settings"
	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/input"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/raw"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
	"harmony/v2/internal/video"
)

const (
	windowWidth     = 1180
	windowHeight    = 800
	minWindowWidth  = 560
	minWindowHeight = 420
	title           = "Harmony"

	// The longest the window waits for an event when nothing is due, so a lost wake cannot freeze it for long.
	longestWait = time.Second
	// A change made while drawing shows only on the next frame: one follows a click or a key, and one follows a
	// mouse move or a wheel turn once that has been quiet for settleDelay.
	settleFrames = 2
	settleDelay  = 40 * time.Millisecond
)

type Screen interface {
	Draw(c *widget.Context, bounds geom.Rect)
}

type Options struct {
	Server     string
	Screenshot string
	Width      int
	Height     int
	// Tone, when set, is sent as the microphone: a sine of that many Hz, for trying calls without a microphone.
	Tone float64
}

type Shell struct {
	settings *store.Settings
	context  *widget.Context
	screen   Screen
	channels *channels.Screen
	mixer    *audio.Mixer
	session  *app.Session
	rail     *widget.ServerRail
	devices  *audio.Devices
	open     string
	resume   connect.Resume
	options  Options
	frames   int
	in       input.State
	settle   int
	width    int
	height   int
	active   bool
	settleAt time.Time
	window   unsafe.Pointer
	desktop  *desktop.Desktop
	servers  serverSet
	quit     atomic.Bool
	focused  atomic.Bool
	chrome   chrome
}

func Run(options Options) {
	settings := store.Load()
	one := single(options)
	if one == nil {
		return
	}
	defer one.Close()
	openWindow(or(options.Width, windowWidth), or(options.Height, windowHeight))
	defer rl.CloseWindow()
	rl.SetExitKey(0)
	platform.UseSRGB(rl.GetWindowHandle())
	applyFrame(rl.GetWindowHandle())
	zoom := float32(settings.UIScale) / 100
	rl.SetWindowMinSize(int(minWindowWidth*zoom), int(minWindowHeight*zoom))

	painter, err := paint.New(zoom)
	if err != nil {
		panic(err)
	}
	defer painter.Close()

	sh := &Shell{settings: settings, options: options, mixer: audio.NewMixer()}
	sh.devices, _ = audio.OpenDevices()
	_ = sh.devices.SetInput(settings.InputDevice)
	_ = sh.devices.SetOutput(settings.OutputDevice)
	_ = sh.devices.SetEchoCancellation(settings.MicEchoCancellation)
	sh.mixer.SetVolume(float64(settings.MasterVolume) / 100)
	painter.TextScale = float32(settings.TextScale) / 100
	sh.context = &widget.Context{
		Paint:   painter,
		Theme:   paletteOf(settings),
		Strings: i18n.Load(i18n.Resolve(settings.Language, i18n.SystemLanguages())),
	}
	sh.rail = &widget.ServerRail{HomeDisabled: true, OnHome: sh.togglePrivate, OnAdd: sh.addServer, OnSelect: sh.selectServer}
	if options.Server != "" {
		settings.RememberServer(store.Server{URL: options.Server})
	}
	sh.resume = connect.Launch
	sh.showConnect(settings.LastServer())
	sh.window = rl.GetWindowHandle()
	sh.startDesktop()
	sh.startServers()
	one.Serve(func() { sh.context.Post(showWindow) })
	redraw.SetWaker(func() { platform.WakeEvents(sh.window) })
	rl.PollInputEvents()
	sh.in = input.Poll(input.State{})
	for !sh.closing() {
		if sh.needsFrame() {
			sh.frame()
		} else {
			sh.sleep()
		}
		sh.in = input.Poll(sh.in)
		sh.chromeInput()
		sh.shortcuts()
	}
	sh.close()
}

// sleep waits for the window system to have something to say, until the next frame that is due.
func (sh *Shell) sleep() {
	redraw.Sleep(func(until time.Duration) {
		if left := time.Until(sh.settleAt); !sh.settleAt.IsZero() && (until <= 0 || left < until) {
			until = max(left, time.Millisecond)
		}
		if until <= 0 || until > longestWait {
			until = longestWait
		}
		platform.WaitEvents(sh.window, until)
	})
	rl.PollInputEvents()
}

func (sh *Shell) needsFrame() bool {
	width, height := raw.GetScreenWidth(), raw.GetScreenHeight()
	active := raw.IsWindowFocused() && !raw.IsWindowMinimized()
	sh.focused.Store(active)
	changed := width != sh.width || height != sh.height || active != sh.active
	sh.width, sh.height, sh.active = width, height, active
	asked := redraw.Take()
	switch {
	case changed || sh.in.Active() && !sh.in.Continuous():
		sh.settle = settleFrames
	case sh.in.Active():
		sh.settleAt = time.Now().Add(settleDelay)
		return true
	}
	if !sh.settleAt.IsZero() && !time.Now().Before(sh.settleAt) {
		sh.settleAt, sh.settle = time.Time{}, 1
	}
	return sh.settle > 0 || asked || sh.options.Screenshot != ""
}

func (sh *Shell) frame() {
	sh.settle = max(sh.settle-1, 0)
	sh.syncFrame()
	c := sh.context
	c.SetWindowActive(sh.active)
	c.BeginFrame(sh.in)
	c.Viewport = geom.Size{W: c.Paint.ToCSS(float32(sh.width)), H: c.Paint.ToCSS(float32(sh.height))}
	raw.BeginDrawing()
	raw.ClearBackground(c.Theme.Bg)
	bounds := geom.Rect{W: c.Paint.ToCSS(float32(raw.GetScreenWidth())), H: c.Paint.ToCSS(float32(raw.GetScreenHeight()))}
	if modal := c.Modal(); modal != nil {
		c.Frozen(func() { sh.drawLayout(c, bounds) })
		if frame == frameApp {
			modal.Draw(c, bounds.Inset(0, widget.TitleBarHeight, 0, 0))
			sh.drawBar(c, bounds)
		} else {
			modal.Draw(c, bounds)
		}
	} else {
		sh.drawLayout(c, bounds)
	}
	sh.drawOutline(c, bounds)
	c.EndFrame()
	raw.EndDrawing()

	sh.desktop.Update()
	sh.frames++
	if sh.options.Screenshot != "" && sh.frames == 60 {
		capture(sh.options.Screenshot)
		os.Exit(0)
	}
}

func capture(path string) {
	img := rl.LoadImageFromScreen()
	rl.ExportImage(*img, path)
	rl.UnloadImage(img)
}

func (sh *Shell) strings() *i18n.Bundle { return sh.context.Strings }

func (sh *Shell) setLanguage(preference string) {
	sh.context.Strings = i18n.Load(i18n.Resolve(preference, i18n.SystemLanguages()))
}

func (sh *Shell) drawLayout(c *widget.Context, full geom.Rect) {
	sh.drawBar(c, full)
	bounds := full.Inset(0, widget.TitleBarHeight, 0, 0)
	if len(sh.settings.Servers) == 0 {
		sh.screen.Draw(c, bounds)
		return
	}
	if c.In.Jump != 0 {
		sh.serverJump(c.In.Jump)
	}
	sh.syncRail()
	sh.rail.Draw(c, geom.Rect{Y: bounds.Y, W: widget.RailWidth, H: bounds.H})
	rest := sh.drawCallBar(c, geom.Rect{X: widget.RailWidth, Y: bounds.Y, W: bounds.W - widget.RailWidth, H: bounds.H})
	sh.screen.Draw(c, rest)
	sh.servers.menu.Show(c)
}

func (sh *Shell) addServer() {
	back := sh.open
	if back == "" {
		back = sh.settings.LastServer()
	}
	sh.demote()
	sh.showConnect("").AddServer(back)
}

func (sh *Shell) selectServer(url string) {
	if url == sh.open {
		if sh.channels != nil && sh.channels.PrivateOpen() {
			sh.channels.TogglePrivate()
		}
		return
	}
	if h := sh.servers.held; h != nil && h.url == url {
		sh.swapHeld()
		return
	}
	sh.demote()
	sh.resume = connect.Pick
	sh.showConnect(url)
}

// showConnect starts the sign-in screen on that server, or empty to add a new one.
func (sh *Shell) showConnect(server string) *connect.Screen {
	screen := connect.New(sh.settings, connect.Hooks{
		Strings:     sh.strings,
		SetLanguage: sh.setLanguage,
		Connect:     sh.connectSession,
		Resume:      sh.resumeSession,
		OnSignedIn:  sh.showSignedIn,
		TestServer:  func(client *hclient.Client) { connectiontest.Start(sh.context, client) },
		Recover: func(client *hclient.Client, typed string, onDone func(string, string)) {
			recovery.Start(sh.context, client, typed, func(nickname, password string) {
				sh.context.Post(func() { onDone(nickname, password) })
			})
		},
	})
	sh.screen = screen
	if server != "" {
		screen.OpenSaved(server, sh.resume)
	}
	sh.resume = connect.Manual
	return screen
}

func (sh *Shell) sessionOptions(address, serverPassword string) app.Options {
	opt := app.Options{
		Server: address, ServerPassword: serverPassword, Mixer: sh.mixer, OnChange: redraw.Request, OnFrame: redraw.Request, OnNotice: sh.desktop.Notice,
		Relogin: sh.relogin(address),
		OnEnded: func(end app.Ended) { sh.context.Post(func() { sh.sessionEnded(address, end) }) },
	}
	if sh.devices != nil {
		opt.StartSpeakers = func() error { return sh.devices.StartSpeakers(sh.mixer) }
		opt.StopSpeakers = sh.devices.StopSpeakers
		opt.Mic = app.DeviceMic{Devices: sh.devices}
	}
	if sh.options.Tone > 0 {
		opt.Mic = &app.ToneMic{Freq: sh.options.Tone, Amp: 0.3}
	}
	return opt
}

// configure puts the saved settings into a session that has just come up.
func (sh *Shell) configure(session *app.Session) {
	session.SetVideoDecoder(sh.settings.VideoDecoder)
	session.ApplyAudioSettings(sh.settings)
	session.SetAutoWatch(sh.settings.AutoWatchStreams, sh.settings.AutoWatchStreams)
}

func (sh *Shell) connectSession(ctx context.Context, address, serverPassword, nickname, password string) (*app.Session, error) {
	session, err := app.Connect(ctx, sh.sessionOptions(address, serverPassword), nickname, password)
	if err == nil {
		sh.configure(session)
	}
	return session, err
}

func (sh *Shell) showSignedIn(session *app.Session, server string) {
	redraw.Request()
	if h := sh.servers.held; h != nil && h.url == server {
		sh.dropHeld()
	}
	sh.session, sh.open = session, server
	sh.context.People, sh.context.Faces = session.People(), session.Faces()
	saved, _ := sh.settings.Server(server)
	sh.channels = &channels.Screen{
		Session: session, Settings: sh.settings, Server: saved, Devices: sh.devices,
		OnSignOut:      sh.leave,
		OnSettings:     func() { sh.openSettings(session) },
		OnServerDialog: func(t serveradmin.Target) { sh.context.OpenModal(serveradmin.New(session, t)) },
		ClipKeys:       clipKeys{sh.desktop},
		ShareHooks:     channels.ShareHooks{Start: func() error { return sh.startShare(session) }, StartCamera: func() error { return sh.startCamera(session) }, Change: func() { sh.openShareChoice(session, true) }},
	}
	sh.screen = sh.channels
	sh.syncLead()
	sh.refreshSignIns()
}

func (sh *Shell) togglePrivate() {
	if sh.channels != nil {
		sh.channels.TogglePrivate()
	}
}

func (sh *Shell) leave() {
	sh.forgetSession(sh.session, sh.open)
	sh.signOut()
	sh.showConnect(sh.settings.LastServer())
}

func (sh *Shell) openSettings(session *app.Session) {
	dialog := settings.New(session, sh.settings, sh.devices, settings.Hooks{Apply: sh.applySettings, SignOut: sh.leave, CameraChanged: func(prev settings.CameraChoice, done func(string)) { sh.changeCamera(session, prev, done) }, EncoderChanged: func() { sh.restartVideo(session) }})
	dialog.Desktop = sh.desktop
	sh.context.OpenModal(dialog)
}

// applySettings puts the theme, interface size and language in the saved settings into use.
func (sh *Shell) applySettings() {
	c := sh.context
	c.Theme = paletteOf(sh.settings)
	c.Paint.TextScale = float32(sh.settings.TextScale) / 100
	if zoom := float32(sh.settings.UIScale) / 100; zoom != c.Paint.Zoom {
		c.Paint.Zoom = zoom
		rl.SetWindowMinSize(int(minWindowWidth*zoom), int(minWindowHeight*zoom))
	}
	if i18n.Resolve(sh.settings.Language, i18n.SystemLanguages()) != c.Strings.Code() {
		sh.setLanguage(sh.settings.Language)
	}
	redraw.Request()
}

// encoder is the codec backend to send with: the software one when "Encode on the GPU" is off, else the one chosen.
func (sh *Shell) encoder() string {
	if !sh.settings.GPUEncoding {
		return video.SoftwareBackend
	}
	return video.EncoderChoice(sh.settings.VideoEncoder)
}

func (sh *Shell) startShare(session *app.Session) error {
	sh.openShareChoice(session, false)
	return nil
}

// restartVideo moves a camera and a share that are on to the encoder now chosen.
func (sh *Shell) restartVideo(session *app.Session) {
	sh.restartCamera(session)
	if cfg, on := session.ShareConfig(); on {
		cfg.Encoder = sh.encoder()
		go func() { _ = session.UpdateShare(cfg) }()
	}
}

func (sh *Shell) signOut() {
	if sh.session != nil {
		sh.session.Close()
	}
	sh.session, sh.open, sh.channels = nil, "", nil
	sh.syncLead()
}

func (sh *Shell) close() {
	sh.signOut()
	sh.closeServers()
	sh.desktop.Close()
	if sh.devices != nil {
		sh.devices.Close()
	}
}

func or(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}
