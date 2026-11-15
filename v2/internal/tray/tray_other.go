//go:build !darwin && !windows && !linux

package tray

func start(Options) impl { return nil }
