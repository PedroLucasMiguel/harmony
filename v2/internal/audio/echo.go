//go:build cgo || windows

package audio

// SetEchoCancellation turns the system's echo cancellation on or off; the streams that are open move over at once. When it cannot be turned on the
// error says why, and EchoNote keeps saying it.
func (d *Devices) SetEchoCancellation(on bool) error {
	if d == nil {
		return errNoAudio
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.echoOn == on {
		return nil
	}
	d.echo.note = ""
	if on {
		d.echoOn = true
		if err := d.echoStart(); err != nil {
			d.echoOn = false
			d.echo.note = err.Error()
			return err
		}
		d.closeAll()
	} else {
		d.closeAll()
		d.echoOn = false
		d.echoStop()
	}
	return d.reopenWanted()
}

// reopenWanted opens the streams that are in use again, after the way they are served changed.
func (d *Devices) reopenWanted() error {
	var err error
	if d.speakersWanted {
		err = d.openSpeakers()
	}
	if d.micWanted {
		if e := d.openMicrophone(); err == nil {
			err = e
		}
	}
	return err
}

// EchoNote is why echo cancellation is not working, or empty.
func (d *Devices) EchoNote() string {
	if d == nil {
		return ""
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.echo.note
}

func (d *Devices) captureID() string {
	if d.echo.source != "" {
		return d.echo.source
	}
	return d.inputID
}

func (d *Devices) playbackID() string {
	if d.echo.sink != "" {
		return d.echo.sink
	}
	return d.outputID
}
