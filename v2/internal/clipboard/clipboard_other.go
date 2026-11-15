//go:build !darwin && !windows

package clipboard

// Files is the paths of the files on the clipboard.
func Files() []string { return nil }

// Image is a picture on the clipboard as PNG, or nil.
func Image() []byte { return nil }
