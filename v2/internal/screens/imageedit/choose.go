package imageedit

import (
	"os"

	"harmony/v2/internal/filedialog"
	"harmony/v2/internal/imagecrop"
	"harmony/v2/internal/ui/widget"
)

const maxFileBytes = 64 << 20

// Choose asks for a picture file, opens the editor on it, and gives the cut picture to onDone. onError gets the words to show
// when the file cannot be read; nothing is called when the dialog or the editor is cancelled.
func Choose(c *widget.Context, purpose Purpose, onDone func(imagecrop.Result), onError func(string)) {
	go func() {
		picked := filedialog.Pick(c.T(titleKey(purpose)))
		if len(picked) == 0 {
			return
		}
		OpenFile(c, purpose, picked[0], onDone, onError)
	}()
}

// OpenFile is Choose for a path already in hand, a file dropped on the window for one.
func OpenFile(c *widget.Context, purpose Purpose, path string, onDone func(imagecrop.Result), onError func(string)) {
	go func() {
		data, err := readLimited(path)
		var src *imagecrop.Source
		if err == nil {
			src, err = imagecrop.Inspect(data)
		}
		c.Post(func() {
			if err != nil {
				onError(c.T("app.could_not_read_that_image"))
				return
			}
			c.OpenModal(New(Options{Purpose: purpose, Source: src, Data: data, OnDone: onDone}))
		})
	}()
}

func titleKey(p Purpose) string {
	title, _ := p.words()
	return title
}

func readLimited(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > maxFileBytes {
		return nil, os.ErrInvalid
	}
	return os.ReadFile(path)
}
