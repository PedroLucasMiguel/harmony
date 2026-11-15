//go:build !darwin && !windows

package i18n

func platformLanguages() []string { return nil }
