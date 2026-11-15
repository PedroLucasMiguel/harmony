// Package voicenote records, stores and plays voice messages: Opus in WebM, wire-compatible with the Electron client.
package voicenote

import (
	"strings"
	"time"
)

const (
	// Prefix starts the name of every voice message; it is what makes an audio attachment one.
	Prefix = "voice-message-"
	// ContentType is what a voice message is uploaded as.
	ContentType = "audio/webm"
	// MaxSeconds is the longest recording; at this it pauses, ready to send.
	MaxSeconds = 15 * 60
	// MinDuration is the shortest recording worth sending.
	MinDuration = 700 * time.Millisecond
)

// Name is what a recording started at that time is called.
func Name(at time.Time) string { return Prefix + at.Format("20060102-150405") + ".webm" }

// IsVoiceNote says whether an attachment is a voice message: a sound that is called like one.
func IsVoiceNote(name, mediaType string) bool {
	return mediaType == "audio" && strings.HasPrefix(name, Prefix)
}
