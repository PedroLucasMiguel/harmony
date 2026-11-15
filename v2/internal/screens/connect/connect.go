// Package connect is the sign-in screen: first the server's address, then who you are on it.
package connect

import (
	"context"
	"strings"
	"sync"

	"harmony/v2/internal/app"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/i18n"
	"harmony/v2/internal/store"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

type step int

const (
	stepServer step = iota
	stepAccount
)

const (
	cardWidth       = 480
	layoutPadding   = 24
	cardPadding     = 4
	topMarginRatio  = 0.08
	topMarginMax    = 72
	cardGap         = 12
	logoSize        = 44
	titleSize       = 30
	titleLine       = 45
	hintSize        = 12.8
	hintLift        = -3.2
	switchAuthSize  = 13.6
	switchAuthTop   = 8
	forgotTop       = 3.2
	switchAuthAlpha = 0.85
	usernameMax     = 24
)

type Screen struct {
	Settings *store.Settings
	Hooks

	step        step
	registering bool

	serverURL      widget.TextField
	serverPassword widget.TextField
	username       widget.TextField
	password       widget.TextField
	confirm        widget.TextField
	ownerKey       widget.TextField
	remember       widget.Check
	language       widget.Dropdown
	scroll         widget.Scroll
	servers        widget.ServerMenu
	status         map[string]widget.ServerStatus
	backTo         string
	options        widget.Disclosure
	gpuEncoding    widget.Check

	mu            sync.Mutex
	busy          bool
	errText       string
	address       string
	serverName    string
	needsPassword bool
	needsOwner    bool
	serverUp      widget.ServerStatus
	viewportH     float32
	saved         savedSignIn

	built        widget.Component
	builtFor     cardKey
	languagesFor *i18n.Bundle
}

type Hooks struct {
	Strings     func() *i18n.Bundle
	SetLanguage func(preference string)
	Connect     func(ctx context.Context, address, serverPassword, nickname, password string) (*app.Session, error)
	Resume      func(ctx context.Context, address, serverPassword, token string) (*app.Session, error)
	OnSignedIn  func(session *app.Session, server string)
	TestServer  func(client *hclient.Client)
	Recover     func(client *hclient.Client, typed string, onDone func(nickname, password string))
}

func New(settings *store.Settings, hooks Hooks) *Screen {
	s := &Screen{Settings: settings, Hooks: hooks}
	s.serverPassword.Password = true
	s.password.Password = true
	s.confirm.Password = true
	s.username.MaxLength = usernameMax
	s.remember.Checked = true
	s.gpuEncoding.Checked = settings.GPUEncoding
	s.gpuEncoding.OnChange = func(on bool) {
		s.Settings.GPUEncoding = on
		s.Settings.Save()
	}
	s.language.Icon = "globe"
	s.language.OnChange = func(code string) {
		s.Settings.Language = code
		s.Settings.Save()
		s.SetLanguage(code)
	}
	s.scroll.Child = page{s}
	return s
}

// Open fills in a saved server's address and goes on to its account step.
func (s *Screen) Open(url string) {
	s.serverURL.Value = url
	s.probe()
}

func (s *Screen) Draw(c *widget.Context, bounds geom.Rect) {
	s.viewportH = bounds.H
	s.syncLanguages(c)
	s.syncPrivacy()
	s.scroll.Draw(c, bounds)
}

func (s *Screen) syncPrivacy() {
	hide := s.Settings.HideDetails
	s.serverURL.Password = hide
	s.username.Password = hide
}

func (s *Screen) syncLanguages(c *widget.Context) {
	s.language.Value = s.Settings.Language
	if s.languagesFor == c.Strings {
		return
	}
	s.languagesFor = c.Strings
	resolved := i18n.Resolve("auto", i18n.SystemLanguages())
	options := []widget.Option{{Value: "auto", Label: c.T("settings.language.auto", "language", languageName(resolved))}}
	for _, l := range i18n.Languages() {
		options = append(options, widget.Option{Value: l.Code, Label: l.Name})
	}
	s.language.Options = options
	s.language.Value = s.Settings.Language
}

func languageName(code string) string {
	for _, l := range i18n.Languages() {
		if l.Code == code {
			return l.Name
		}
	}
	return code
}

type page struct{ s *Screen }

func (p page) cardWidth(viewport float32) float32 {
	return min(cardWidth, viewport-2*layoutPadding)
}

func (p page) topMargin() float32 { return min(topMarginMax, topMarginRatio*p.s.viewportH) }

func (p page) Measure(c *widget.Context, maxWidth float32) geom.Size {
	inner := p.cardWidth(maxWidth) - cardPadding
	height := p.s.card(c).Measure(c, inner).H
	return geom.Size{W: maxWidth, H: p.topMargin() + 2*layoutPadding + 2*cardPadding + height}
}

func (p page) Draw(c *widget.Context, r geom.Rect) {
	width := p.cardWidth(r.W)
	inner := width - cardPadding
	card := p.s.card(c)
	card.Draw(c, geom.Rect{
		X: r.X + (r.W-width)/2,
		Y: r.Y + p.topMargin() + layoutPadding + cardPadding,
		W: inner,
		H: card.Measure(c, inner).H,
	})
}

// cardKey is everything the card is built from; the card is built again only when it changes, since building it makes
// dozens of small components.
type cardKey struct {
	strings                                                 *i18n.Bundle
	step                                                    step
	registering, busy, needsOwner, needsPassword, hide, gpu bool
	canGoBack                                               bool
	status                                                  widget.ServerStatus
	err, name, address, signedAs                            string
}

func (s *Screen) card(c *widget.Context) widget.Component {
	s.mu.Lock()
	key := cardKey{
		strings: c.Strings, step: s.step, registering: s.registering, busy: s.busy, needsOwner: s.needsOwner, needsPassword: s.needsPassword,
		hide: s.Settings.HideDetails, gpu: s.gpuEncoding.Checked, canGoBack: s.backTo != "", status: s.serverUp,
		err: s.errText, name: s.serverName, address: s.address,
	}
	if s.saved.user != nil {
		key.signedAs = s.saved.user.Nickname + "/" + s.saved.user.DisplayName
	}
	s.mu.Unlock()
	s.syncServers(c)
	if s.built == nil || key != s.builtFor {
		s.built, s.builtFor = s.buildCard(c, key), key
	}
	return s.built
}

func (s *Screen) buildCard(c *widget.Context, key cardKey) widget.Component {
	children := []widget.Component{s.brand(c)}
	if key.step == stepServer {
		children = append(children, s.serverStep(c))
	} else {
		children = append(children, s.accountStep(c))
	}
	if key.err != "" {
		children = append(children, widget.Banner{Kind: widget.ErrorBanner, Content: key.err})
	}
	children = append(children, s.optionsSection(c))
	return widget.Col(cardGap, children...)
}

func (s *Screen) brand(c *widget.Context) widget.Component {
	title := &widget.Text{
		Content: c.T("view.connect.harmony"), Tone: widget.ToneText, LineHeight: titleLine,
		Style: paint.TextStyle{Size: titleSize, Weight: paint.Semibold, Spacing: -0.5},
	}
	privacy := &widget.Button{Icon: "eye", Variant: widget.Ghost, Small: true, OnClick: func() {
		s.Settings.HideDetails = !s.Settings.HideDetails
		s.Settings.Save()
	}}
	if s.Settings.HideDetails {
		privacy.Icon = "eye-slash"
	}
	tools := &widget.Row{Gap: 8, Items: []widget.RowItem{widget.Fixed(&s.language), widget.Fixed(privacy)}}
	top := &widget.Row{Gap: 12, Items: []widget.RowItem{
		widget.Fixed(widget.Logo{Size: logoSize, Tone: widget.ToneAccent}),
		widget.Fixed(title),
		widget.Grow(widget.Spacer{}),
		{Component: tools, Align: widget.AlignStart},
	}}
	tagline := widget.Label(c.T("view.connect.self_hosted_voice_video"), 14, paint.Regular, widget.ToneMuted)
	return widget.Col(4, top, tagline)
}

func hint(content string) widget.Component {
	return widget.Padded{Top: hintLift, Child: &widget.Text{
		Content: content, Tone: widget.ToneMuted, Wrap: true,
		Style: paint.TextStyle{Size: hintSize, Weight: paint.Regular}, LineHeight: hintSize * 1.5,
	}}
}

func linkRow(c *widget.Context, text, action string, onClick func()) widget.Component {
	style := paint.TextStyle{Size: switchAuthSize, Weight: paint.Regular}
	label := &widget.Text{Content: text, Style: style, Tone: widget.ToneMuted, Opacity: switchAuthAlpha}
	link := &widget.Button{Label: action, Variant: widget.Link, Size: switchAuthSize, Opacity: switchAuthAlpha, OnClick: onClick}
	row := &widget.Row{Gap: 5.6, Items: []widget.RowItem{widget.Fixed(label), widget.Fixed(link)}}
	return widget.Padded{Top: switchAuthTop, Child: row}
}

func mask(text string, hidden bool) string {
	if hidden {
		return strings.Repeat("•", len([]rune(text)))
	}
	return text
}
