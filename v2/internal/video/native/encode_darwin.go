//go:build darwin

package native

func newEncoder(p EncodeParams, onAU func([]byte)) (Encoder, error) {
	e, err := newVTEncoder(p, true, onAU)
	if err != nil {
		return nil, err
	}
	return e, nil
}
