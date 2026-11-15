//go:build windows

package native

// What a camera offers: the sizes and rates of the modes its source reader lists.

func listCameraFormats(id string) []CameraFormat {
	var out []CameraFormat
	done := make(chan struct{})
	go func() {
		defer close(done)
		end, err := comSession()
		if err != nil {
			return
		}
		defer end()
		cam := &camera{p: CaptureParams{CameraID: id}}
		defer cam.release()
		if cam.openReader() != nil {
			return
		}
		for i := 0; ; i++ {
			mt, hr := cam.reader.nativeType(i)
			if hr.failed() {
				return
			}
			w, h, ok := mt.size()
			rate, _, _ := mt.getUINT64(&mfMTFrameRate)
			mt.release()
			if !ok || w <= 0 || h <= 0 {
				continue
			}
			fps := 30.0
			if den := uint32(rate); den != 0 {
				fps = float64(rate>>32) / float64(den)
			}
			out = append(out, CameraFormat{W: w, H: h, MaxFPS: fps})
		}
	}()
	<-done
	return out
}
