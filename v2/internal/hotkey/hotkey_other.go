//go:build !darwin && !windows && !linux

package hotkey

func supported() string { return ErrUnavailable }

func newBackend(func(string, bool)) backend { return nil }
