package serveradmin

import (
	"bytes"
	"context"
	"os"

	"harmony/v2/internal/filedialog"
	"harmony/v2/internal/hclient"
	"harmony/v2/internal/imagecrop"
	"harmony/v2/internal/screens/imageedit"
)

const maxPictureFile = 64 << 20

// editPicture asks for a picture file, lets the person cut it in the image editor (which takes the window while it is open), uploads
// the result and gives its hash to done on the interface's thread. A failure is said in the footer.
func (d *Dialog) editPicture(purpose imageedit.Purpose, title string, done func(hash string)) {
	c, client := d.ctx, d.Session.Client()
	go func() {
		path := filedialog.PickImage(title)
		if path == "" {
			return
		}
		data, err := readPicture(path)
		var src *imagecrop.Source
		if err == nil {
			src, err = imagecrop.Inspect(data)
		}
		c.Post(func() {
			if err != nil {
				d.report(noteFailed, c.T("app.could_not_read_that_image"))
				return
			}
			back := func() { c.OpenModal(d) }
			c.OpenModal(imageedit.New(imageedit.Options{
				Purpose: purpose, Source: src, Data: data, OnCancel: back,
				OnDone: func(res imagecrop.Result) {
					back()
					d.upload(client, res, done)
				},
			}))
		})
	}()
}

func (d *Dialog) upload(client *hclient.Client, res imagecrop.Result, done func(string)) {
	c := d.ctx
	d.report(noteSaving, "")
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), saveTimeout)
		defer cancel()
		hash, err := client.Upload(ctx, bytes.NewReader(res.Data), int64(len(res.Data)), res.ContentType, nil)
		c.Post(func() {
			if err != nil {
				d.report(noteFailed, err.Error())
				return
			}
			done(hash)
		})
	}()
}

func readPicture(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > maxPictureFile {
		return nil, os.ErrInvalid
	}
	return os.ReadFile(path)
}
