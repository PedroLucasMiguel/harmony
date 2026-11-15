module harmony/v2

go 1.27.4

require (
	github.com/coder/websocket v1.8.15
	github.com/ebitengine/purego v0.11.3
	github.com/gen2brain/malgo v0.11.28
	github.com/gen2brain/raylib-go/raylib v0.62.2
	github.com/go-text/typesetting v0.3.5
	github.com/hajimehoshi/go-mp3 v0.3.4
	github.com/jfreymuth/oggvorbis v1.0.5
	github.com/ncruces/zenity v0.10.15
	github.com/pion/interceptor v0.1.51
	github.com/pion/rtcp v1.2.20
	github.com/pion/rtp v1.10.6
	github.com/pion/webrtc/v4 v4.2.26
	github.com/rivo/uniseg v0.4.7
	github.com/srwiley/oksvg v0.0.0-20221011165216-be6e8873101c
	github.com/srwiley/rasterx v0.0.0-20220730225603-2ab79fcdd4ef
	github.com/thesyncim/gopus v0.2.3
	golang.org/x/crypto v0.59.0
	golang.org/x/image v0.48.0
	golang.org/x/text v0.44.0
)

require (
	github.com/akavel/rsrc v0.10.2 // indirect
	github.com/dchest/jsmin v1.0.0 // indirect
	github.com/godbus/dbus/v5 v5.2.4
	github.com/google/uuid v1.6.0 // indirect
	github.com/jfreymuth/vorbis v1.0.2 // indirect
	github.com/josephspurrier/goversioninfo v1.7.0 // indirect
	github.com/jupiterrider/ffi v0.8.0 // indirect
	github.com/pion/datachannel v1.6.4 // indirect
	github.com/pion/dtls/v3 v3.1.15 // indirect
	github.com/pion/ice/v4 v4.4.9 // indirect
	github.com/pion/logging v0.2.4 // indirect
	github.com/pion/mdns/v2 v2.2.2 // indirect
	github.com/pion/randutil v0.1.0 // indirect
	github.com/pion/sctp v1.12.1 // indirect
	github.com/pion/sdp/v3 v3.0.20 // indirect
	github.com/pion/srtp/v3 v3.1.3 // indirect
	github.com/pion/stun/v4 v4.0.1 // indirect
	github.com/pion/transport/v5 v5.1.5 // indirect
	github.com/pion/turn/v5 v5.1.3 // indirect
	github.com/randall77/makefat v0.0.0-20260406194835-1b91746796b7 // indirect
	github.com/wlynxg/anet v0.0.5 // indirect
	golang.org/x/net v0.62.0 // indirect
	golang.org/x/sys v0.50.0 // indirect
	golang.org/x/time v0.16.0 // indirect
)

// go-text/typesetting 0.3.5 with the gvar table read per glyph and the morx ligature ids left packed: 40 MB less heap.
replace github.com/go-text/typesetting => ./third_party/typesetting
