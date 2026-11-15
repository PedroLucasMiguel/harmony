// Package store keeps the person's settings in a JSON file in the user's config directory.
package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

type Server struct {
	URL      string `json:"url"`
	Name     string `json:"name"`
	Username string `json:"username"`
	// NoBackground stops the server being kept connected while another is on screen.
	NoBackground bool `json:"noBackground,omitempty"`
}

type Settings struct {
	Language    string `json:"language"`
	Theme       string `json:"theme"`
	UIScale     int    `json:"uiScale"`
	HideDetails bool   `json:"hideDetails"`
	GPUEncoding bool   `json:"gpuEncoding"`
	ShowMembers bool   `json:"showMembers"`
	// AutoSignIn goes straight into the last server at start, and into a server picked from the rail, when its saved sign-in is still good.
	AutoSignIn     bool   `json:"autoSignIn"`
	CameraPreview  bool   `json:"cameraPreview"`
	InputDevice    string `json:"inputDevice"`
	OutputDevice   string `json:"outputDevice"`
	MicGain        int    `json:"micGain"`
	MasterVolume   int    `json:"masterVolume"`
	SoundpadVolume int    `json:"soundpadVolume"`
	MusicVolume    int    `json:"musicVolume"`
	MusicMuted     bool   `json:"musicMuted"`
	CameraDevice   string `json:"cameraDevice"`
	CameraSize     int    `json:"cameraSize"`
	CameraRate     int    `json:"cameraRate"`
	// VideoEncoder and VideoDecoder are the codec backends chosen by ID; empty is automatic.
	VideoEncoder string `json:"videoEncoder"`
	VideoDecoder string `json:"videoDecoder"`

	AutoWatchStreams   bool `json:"autoWatchStreams"`
	PauseHiddenCameras bool `json:"pauseHiddenCameras"`
	LinkPreviews       bool `json:"linkPreviews"`

	PushToTalk    bool              `json:"pushToTalk"`
	PushToTalkKey string            `json:"pushToTalkKey"`
	Hotkeys       map[string]string `json:"hotkeys,omitempty"`
	// ClipHotkeys are the keys of soundpad clips, by server address and then clip.
	ClipHotkeys   map[string]map[string]string `json:"clipHotkeys,omitempty"`
	TrayHintShown bool                         `json:"trayHintShown"`

	Servers []Server `json:"servers"`
	// LastURL is the server used most recently; the order of Servers is the person's own, as on the rail.
	LastURL       string                   `json:"lastServer,omitempty"`
	RecentEmoji   []string                 `json:"recentEmoji"`
	Stars         map[string][]Star        `json:"stars,omitempty"`
	SearchHistory map[string][]SearchEntry `json:"searchHistory,omitempty"`
	// PeerVolumes is how loud each person is played, by server address and then account.
	PeerVolumes map[string]map[int]PeerVolume `json:"peerVolumes,omitempty"`
	// DismissedEmbeds are the link cards the person closed, as "server#message".
	DismissedEmbeds []string `json:"dismissedEmbeds,omitempty"`

	// MicSensitivity is the noise gate's slider, 0 (no gate) to 100; the processing choices after it are the Voice & video page's.
	MicSensitivity      int  `json:"micSensitivity"`
	MicAutoSensitivity  bool `json:"micAutoSensitivity"`
	MicEchoCancellation bool `json:"micEchoCancellation"`
	MicNoiseSuppression bool `json:"micNoiseSuppression"`
	MicAISuppression    bool `json:"micAiSuppression"`
	MicAutoGain         bool `json:"micAutoGain"`

	// The Sounds page: the cues, other people's own join sounds, the mention sound, and the cues' volume in percent.
	VoiceSounds      bool `json:"voiceSounds"`
	CustomJoinSounds bool `json:"customJoinSounds"`
	MentionSound     bool `json:"mentionSound"`
	SoundVolume      int  `json:"soundVolume"`

	Shell
	ShareSettings
	ShareAudioSettings

	path      string
	starIDs   map[int]bool
	starScope string
}

func Load() *Settings {
	s := &Settings{Language: "auto", Theme: "midnight", UIScale: 115, GPUEncoding: true, AutoSignIn: true, ShowMembers: true, MicGain: 100, MasterVolume: 100, VoiceSounds: true, CustomJoinSounds: true, MentionSound: true, SoundVolume: 100, SoundpadVolume: 100, MusicVolume: 100,
		CameraSize: 360, CameraRate: 24, AutoWatchStreams: true, PauseHiddenCameras: true, LinkPreviews: true}
	s.Shell = shellDefaults()
	s.ShareSettings = shareDefaults()
	dir, err := os.UserConfigDir()
	if err != nil {
		return s
	}
	s.path = filepath.Join(dir, "Harmony v2", "settings.json")
	if data, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(data, s)
	}
	return s
}

func (s *Settings) Save() {
	if s.path == "" {
		return
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(s.path), 0o755)
	_ = os.WriteFile(s.path, data, 0o600)
}

// RememberServer notes the server as the one used most recently, keeping its place and what was known about it unless the new details say more; a new server goes last.
func (s *Settings) RememberServer(server Server) {
	s.LastURL = server.URL
	for i, known := range s.Servers {
		if known.URL == server.URL {
			if server.Name == "" {
				server.Name = known.Name
			}
			if server.Username == "" {
				server.Username = known.Username
			}
			server.NoBackground = known.NoBackground
			s.Servers[i] = server
			return
		}
	}
	s.Servers = append(s.Servers, server)
}

// ClearUsername forgets the account name saved for a server.
func (s *Settings) ClearUsername(url string) {
	for i := range s.Servers {
		if s.Servers[i].URL == url {
			s.Servers[i].Username = ""
		}
	}
}

// Forget removes a server from the list.
func (s *Settings) Forget(url string) {
	s.Servers = slices.DeleteFunc(s.Servers, func(known Server) bool { return known.URL == url })
	if s.LastURL == url {
		s.LastURL = ""
	}
}

// MoveServer puts a server before another, or after it.
func (s *Settings) MoveServer(url, to string, after bool) {
	from := slices.IndexFunc(s.Servers, func(k Server) bool { return k.URL == url })
	if from < 0 || url == to {
		return
	}
	moving := s.Servers[from]
	s.Servers = slices.Delete(s.Servers, from, from+1)
	at := slices.IndexFunc(s.Servers, func(k Server) bool { return k.URL == to })
	if at < 0 {
		s.Servers = slices.Insert(s.Servers, from, moving)
		return
	}
	if after {
		at++
	}
	s.Servers = slices.Insert(s.Servers, at, moving)
}

func (s *Settings) Server(url string) (Server, bool) {
	for _, known := range s.Servers {
		if known.URL == url {
			return known, true
		}
	}
	return Server{}, false
}

// Title is the name the server gave itself, or its address when it has not been reached yet.
func (s Server) Title() string {
	if s.Name != "" {
		return s.Name
	}
	host := s.URL
	if _, after, ok := strings.Cut(host, "://"); ok {
		host = after
	}
	host, _, _ = strings.Cut(host, "/")
	if _, after, ok := strings.Cut(host, "@"); ok {
		host = after
	}
	if host != "" {
		return host
	}
	return s.URL
}

// LastServer is the address of the server used most recently, or empty when there is none.
func (s *Settings) LastServer() string {
	if _, ok := s.Server(s.LastURL); ok {
		return s.LastURL
	}
	if len(s.Servers) == 0 {
		return ""
	}
	return s.Servers[0].URL
}
