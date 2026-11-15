package media

import (
	"time"

	"github.com/pion/webrtc/v4"
)

// RTT is the round trip to the media relay on the path in use, and false until it has been measured.
func (p *VoicePublisher) RTT() (time.Duration, bool) {
	for _, stat := range p.pc.GetStats() {
		pair, ok := stat.(webrtc.ICECandidatePairStats)
		if ok && pair.Nominated && pair.CurrentRoundTripTime > 0 {
			return time.Duration(pair.CurrentRoundTripTime * float64(time.Second)), true
		}
	}
	return 0, false
}
