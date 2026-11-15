// Package conntest checks, one step at a time, how far this computer gets toward a server and its media path.
package conntest

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"

	"harmony/v2/internal/hclient"
)

const (
	gatherTimeout = 6 * time.Second
	probeTimeout  = 5 * time.Second
)

type Step struct {
	Name   string
	OK     bool
	Detail string
}

type Verdict struct {
	OK   bool
	Text string
}

type Translate func(key string, vars ...string) string

// Run reports each step as it finishes and returns what it all means.
func Run(ctx context.Context, client *hclient.Client, t Translate, report func(Step)) Verdict {
	health, err := client.Health(ctx)
	if err != nil {
		report(Step{Name: t("diag.step_reach"), Detail: err.Error()})
		return Verdict{Text: t("diag.verdict_unreachable")}
	}
	report(Step{Name: t("diag.step_reach"), OK: true, Detail: t("diag.signaling_on", "address", health.SignalingBase)})

	if !health.OK {
		report(Step{Name: t("diag.step_media"), Detail: "mediamtx: " + health.MediaMTX})
		return Verdict{Text: t("diag.verdict_media_down")}
	}
	report(Step{Name: t("diag.step_media"), OK: true})

	if err := answers(ctx, health.SignalingBase); err != nil {
		report(Step{Name: t("diag.step_exchange"), Detail: err.Error()})
		return Verdict{Text: t("diag.verdict_unreachable")}
	}
	report(Step{Name: t("diag.step_exchange"), OK: true})

	servers, err := client.ICEServers(ctx)
	if err != nil {
		report(Step{Name: t("diag.step_test"), Detail: err.Error()})
		return Verdict{Text: t("diag.verdict_stopped", "message", err.Error())}
	}
	return checkStun(ctx, servers, t, report)
}

func answers(ctx context.Context, base string) error {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base, nil)
	if err != nil {
		return err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	return res.Body.Close()
}

func checkStun(ctx context.Context, servers []hclient.ICEServer, t Translate, report func(Step)) Verdict {
	types, err := candidateTypes(ctx, servers)
	if err != nil {
		report(Step{Name: t("diag.step_test"), Detail: err.Error()})
		return Verdict{Text: t("diag.verdict_stopped", "message", err.Error())}
	}
	found := strings.Join(types, ", ")
	offered := offersStun(servers)
	reflexive := contains(types, "srflx")
	switch {
	case !offered:
		report(Step{Name: t("diag.step_stun"), OK: true, Detail: t("diag.stun_not_needed")})
	case reflexive:
		report(Step{Name: t("diag.step_stun"), OK: true, Detail: found})
	default:
		if found == "" {
			found = t("diag.none")
		}
		report(Step{Name: t("diag.step_stun"), Detail: t("diag.stun_only", "types", found)})
		return Verdict{Text: t("diag.verdict_udp_blocked")}
	}
	return Verdict{OK: true, Text: t("diag.verdict_ok")}
}

// candidateTypes gathers the addresses this computer could be reached on: host, srflx (a STUN answer) and relay.
func candidateTypes(ctx context.Context, servers []hclient.ICEServer) ([]string, error) {
	config := webrtc.Configuration{}
	for _, s := range servers {
		config.ICEServers = append(config.ICEServers, webrtc.ICEServer{URLs: s.URLs, Username: s.Username, Credential: s.Credential})
	}
	pc, err := webrtc.NewPeerConnection(config)
	if err != nil {
		return nil, err
	}
	defer pc.Close()

	var mu sync.Mutex
	seen := map[string]bool{}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			mu.Lock()
			seen[c.Typ.String()] = true
			mu.Unlock()
		}
	})
	if _, err := pc.CreateDataChannel("probe", nil); err != nil {
		return nil, err
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return nil, err
	}
	done := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return nil, err
	}
	select {
	case <-done:
	case <-time.After(gatherTimeout):
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	pc.Close()

	mu.Lock()
	defer mu.Unlock()
	types := make([]string, 0, len(seen))
	for typ := range seen {
		types = append(types, typ)
	}
	sort.Strings(types)
	return types, nil
}

func offersStun(servers []hclient.ICEServer) bool {
	for _, s := range servers {
		for _, url := range s.URLs {
			if strings.HasPrefix(url, "stun:") || strings.HasPrefix(url, "stuns:") {
				return true
			}
		}
	}
	return false
}

func contains(list []string, item string) bool {
	for _, v := range list {
		if v == item {
			return true
		}
	}
	return false
}
