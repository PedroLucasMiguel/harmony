//go:build !darwin

package video

import (
	"errors"

	"harmony/v2/internal/video/native"
)

// No platform binds decoded pictures as textures yet except macOS: the Frame keeps them in system memory.
type glImporter struct{}

func glSupported() bool { return false }

func newGLImporter() (*glImporter, error) {
	return nil, errors.New("pictures cannot be bound as textures here")
}

func (g *glImporter) upload(native.GPUPicture, int, int) (uint32, error) {
	return 0, errors.New("pictures cannot be bound as textures here")
}

func (g *glImporter) free() {}
