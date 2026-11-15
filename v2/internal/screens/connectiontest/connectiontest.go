// Package connectiontest is the dialog that runs a connection test and lists how each step went.
package connectiontest

import (
	"context"
	"sync"

	"harmony/v2/internal/conntest"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/ui/geom"
	"harmony/v2/internal/ui/paint"
	"harmony/v2/internal/ui/redraw"
	"harmony/v2/internal/ui/widget"
)

const (
	stepGap     = 6
	verdictSize = 13
	verdictLine = 1.5
)

type Dialog struct {
	widget.Dialog
	close  widget.Button
	cancel context.CancelFunc

	mu      sync.Mutex
	steps   []conntest.Step
	verdict *conntest.Verdict
}

// Start opens the test and runs it in the background until it ends or the dialog is closed.
func Start(c *widget.Context, client *hclient.Client) {
	ctx, cancel := context.WithCancel(context.Background())
	d := &Dialog{cancel: cancel}
	d.Title = c.T("diag.connection_test")
	d.OnClose = func() {
		cancel()
		c.CloseModal()
	}
	d.close = widget.Button{Label: c.T("diag_close.close"), Variant: widget.Ghost, OnClick: d.OnClose}
	c.OpenModal(d)

	translate := conntest.Translate(c.T)
	go func() {
		verdict := conntest.Run(ctx, client, translate, func(step conntest.Step) {
			d.mu.Lock()
			d.steps = append(d.steps, step)
			d.mu.Unlock()
			redraw.Request()
		})
		d.mu.Lock()
		d.verdict = &verdict
		d.mu.Unlock()
		redraw.Request()
	}()
}

func (d *Dialog) Draw(c *widget.Context, bounds geom.Rect) {
	d.Children = d.children(c)
	d.Dialog.Draw(c, bounds)
}

func (d *Dialog) children(c *widget.Context) []widget.Component {
	d.mu.Lock()
	defer d.mu.Unlock()
	rows := make([]widget.Component, len(d.steps))
	for i, step := range d.steps {
		text := step.Name
		if step.Detail != "" {
			text += " \u2014 " + step.Detail
		}
		rows[i] = widget.StatusRow{OK: step.OK, Text: text}
	}
	text, tone := c.T("app.testing"), widget.ToneMuted
	if d.verdict != nil {
		text = d.verdict.Text
		if !d.verdict.OK {
			tone = widget.ToneWarn
		}
	}
	verdict := &widget.Text{
		Content: text, Tone: tone, Wrap: true,
		Style: paint.TextStyle{Size: verdictSize, Weight: paint.Regular}, LineHeight: verdictSize * verdictLine,
	}
	return []widget.Component{widget.Col(stepGap, rows...), verdict, &d.close}
}
