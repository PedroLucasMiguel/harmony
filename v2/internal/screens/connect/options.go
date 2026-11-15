package connect

import (
	"strings"

	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/widget"
)

const (
	optionsGap    = 16
	checkNoteTop  = 2
	checkNoteSize = 12
	checkNoteLine = 1.5
)

func (s *Screen) optionsSection(c *widget.Context) widget.Component {
	note := c.T("gpu.on_encode")
	if !s.gpuEncoding.Checked {
		note = c.T("app.off_encoding_on_the_cpu")
	}
	s.gpuEncoding.Content = widget.Col(0,
		widget.Label(c.T("view.connect.encode_on_the_gpu"), 13, paint.Regular, widget.ToneText),
		widget.Padded{Top: checkNoteTop, Child: &widget.Text{
			Content: note, Tone: widget.ToneMuted, Wrap: true,
			Style: paint.TextStyle{Size: checkNoteSize, Weight: paint.Regular}, LineHeight: checkNoteSize * checkNoteLine,
		}},
	)
	test := &widget.Button{Label: c.T("test_connection.test_my_connection"), Variant: widget.Ghost, Small: true, OnClick: s.testConnection}
	s.options.Summary = c.T("view.connect.options")
	s.options.Body = widget.Col(optionsGap, widget.Start{Child: test}, &s.gpuEncoding)
	return &s.options
}

func (s *Screen) testConnection() {
	address := s.address
	if s.step == stepServer {
		address = strings.TrimSpace(s.serverURL.Value)
	}
	if address == "" {
		s.fail(s.Strings().T("connect.enter_address"))
		return
	}
	s.TestServer(hclient.New(address, s.serverPassword.Value, false))
}
