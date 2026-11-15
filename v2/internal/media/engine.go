// Package media sends and receives voice and screens over WebRTC, through the server's MediaMTX relay, with Pion.
package media

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

// The relay advertises its own address, so the first candidates are enough.
const gatherTimeout = 3 * time.Second

type Engine struct {
	api  *webrtc.API
	ice  []webrtc.ICEServer
	http *http.Client
}

// The relay passes streams through, so a receiver must accept whichever profile its publisher used (Electron sends 42001f,
// the encoders here High, Main or constrained baseline). A profile matches on its first two bytes, profile_idc and the
// constraint flags; the level is mapped to 1f (up to 3.1) or 28 by video.ProfileLevelID and level asymmetry is allowed.
var h264Profiles = []string{
	"42001f", "42c01f", "42e01f",
	"4d001f", "4d401f", "640c1f", "64001f",
	"4d0028", "4d4028", "640c28", "640028",
}

func New(servers []webrtc.ICEServer, loopback bool, hc *http.Client) (*Engine, error) {
	m := &webrtc.MediaEngine{}

	audioFeedback := []webrtc.RTCPFeedback{{Type: "nack"}}
	if err := m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
			SDPFmtpLine: "minptime=10;useinbandfec=1", RTCPFeedback: audioFeedback,
		},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}

	videoFeedback := []webrtc.RTCPFeedback{{Type: "goog-remb"}, {Type: "ccm", Parameter: "fir"}, {Type: "nack"}, {Type: "nack", Parameter: "pli"}}
	pt := uint8(102)
	for _, profile := range h264Profiles {
		for _, mode := range []string{"1", "0"} {
			if err := m.RegisterCodec(webrtc.RTPCodecParameters{
				RTPCodecCapability: webrtc.RTPCodecCapability{
					MimeType: webrtc.MimeTypeH264, ClockRate: 90000,
					SDPFmtpLine:  fmt.Sprintf("level-asymmetry-allowed=1;packetization-mode=%s;profile-level-id=%s", mode, profile),
					RTCPFeedback: videoFeedback,
				},
				PayloadType: webrtc.PayloadType(pt),
			}, webrtc.RTPCodecTypeVideo); err != nil {
				return nil, err
			}
			pt++
		}
	}

	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, registry); err != nil {
		return nil, err
	}

	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(loopback)

	if hc == nil {
		hc = &http.Client{Timeout: 15 * time.Second}
	}
	return &Engine{
		api:  webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings)),
		ice:  servers,
		http: hc,
	}, nil
}

func (e *Engine) newPC() (*webrtc.PeerConnection, error) {
	return e.api.NewPeerConnection(webrtc.Configuration{ICEServers: e.ice, BundlePolicy: webrtc.BundlePolicyMaxBundle})
}

var ErrNotLive = errors.New("that stream is not live")

func (e *Engine) negotiate(ctx context.Context, pc *webrtc.PeerConnection, url string) (string, error) {
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return "", err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return "", err
	}
	select {
	case <-gathered:
	case <-time.After(gatherTimeout):
	case <-ctx.Done():
		return "", ctx.Err()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(pc.LocalDescription().SDP))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/sdp")
	res, err := e.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("could not reach the media server: %w", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	switch {
	case res.StatusCode == http.StatusNotFound:
		return "", ErrNotLive
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		return "", errors.New("the media server refused this session (token expired?)")
	case res.StatusCode >= 300:
		return "", fmt.Errorf("media server returned %d: %s", res.StatusCode, strings.TrimSpace(string(body[:min(len(body), 200)])))
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: string(body)}); err != nil {
		return "", err
	}
	resource := ""
	if loc := res.Header.Get("Location"); loc != "" {
		if base, err := req.URL.Parse(loc); err == nil {
			resource = base.String()
		}
	}
	return resource, nil
}

func (e *Engine) hangup(resource string) {
	if resource == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, resource, nil)
	if err != nil {
		return
	}
	if res, err := e.http.Do(req); err == nil {
		res.Body.Close()
	}
}
