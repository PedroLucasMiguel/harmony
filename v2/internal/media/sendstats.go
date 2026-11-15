package media

import (
	"time"

	"github.com/pion/webrtc/v4"
)

// SendStats is what the connection says about the video being sent, as running totals.
type SendStats struct {
	Bytes   uint64
	Packets uint64
	// Lost is packets the relay reports lost, FractionLost the share of the last report.
	Lost         int32
	FractionLost float64
	RTT          time.Duration
	OK           bool
}

// SendStats reads the video sender's totals and the relay's receiver report; OK is false before the first report.
func (p *VideoPublisher) SendStats() SendStats {
	var out SendStats
	for _, r := range p.pc.GetStats() {
		switch s := r.(type) {
		case webrtc.OutboundRTPStreamStats:
			if s.Kind == "video" {
				out.Bytes, out.Packets, out.OK = s.BytesSent, uint64(s.PacketsSent), true
			}
		case webrtc.RemoteInboundRTPStreamStats:
			if s.Kind == "video" {
				out.Lost, out.FractionLost = s.PacketsLost, s.FractionLost
				out.RTT = time.Duration(s.RoundTripTime * float64(time.Second))
			}
		}
	}
	return out
}
