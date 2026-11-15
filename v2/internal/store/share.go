package store

// ShareSettings is what a screen share is sent at and how, kept between shares.
type ShareSettings struct {
	// ShareResolution is "480", "720", "1080" or "native"; ShareFramerate 30, 60, 120 or 0 for native.
	ShareResolution string `json:"resolution"`
	ShareFramerate  int    `json:"framerate"`
	// SharePriority is "sharp" or "smooth".
	SharePriority string `json:"priority"`
	// ShareAutoAdapt lowers a share by itself when the computer cannot keep up (the Electron client's shareAutoAdapt).
	ShareAutoAdapt bool `json:"shareAutoAdapt"`
}

func shareDefaults() ShareSettings {
	return ShareSettings{ShareResolution: "1080", ShareFramerate: 30, SharePriority: "sharp", ShareAutoAdapt: true}
}
