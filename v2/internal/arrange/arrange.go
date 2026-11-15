// Package arrange works out the channel list after a channel or a group is moved: the lists the server takes whole.
package arrange

import (
	"slices"

	"harmony/v2/internal/hclient"
)

// Kind says where a drop lands.
type Kind uint8

const (
	None Kind = iota
	BeforeChannel
	IntoGroup
	End
	BeforeGroup
	AfterGroup
)

// Drop is where a moved channel or group lands: above a channel, at the end of a group, above or below a group heading, or at the very end.
type Drop struct {
	Kind Kind
	ID   int
}

// Node is one thing in the list as it is drawn: a channel on its own, or a group and the channels in it.
type Node struct {
	Group bool
	ID    int
	Kids  []int
}

// Of is the list as the server's channels and groups draw it: by position, a group's channels under its heading. A channel in a group
// that is not known stays on its own.
func Of(channels []hclient.Channel, groups []hclient.Group) []Node {
	type entry struct {
		node     Node
		position int
	}
	entries := make([]entry, 0, len(channels)+len(groups))
	for _, g := range groups {
		entries = append(entries, entry{Node{Group: true, ID: g.ID}, g.Position})
	}
	for _, ch := range channels {
		if ch.GroupID != nil {
			if at := slices.IndexFunc(entries, func(e entry) bool { return e.node.Group && e.node.ID == *ch.GroupID }); at >= 0 {
				entries[at].node.Kids = append(entries[at].node.Kids, ch.ID)
				continue
			}
		}
		entries = append(entries, entry{Node{ID: ch.ID}, ch.Position})
	}
	slices.SortStableFunc(entries, func(a, b entry) int { return a.position - b.position })
	nodes := make([]Node, len(entries))
	for i, e := range entries {
		nodes[i] = e.node
	}
	return nodes
}

// Placements is the whole list in the order it is drawn, which is what the server takes.
func Placements(nodes []Node) []hclient.Placement {
	var out []hclient.Placement
	for _, n := range nodes {
		if !n.Group {
			out = append(out, hclient.Placement{ID: n.ID})
			continue
		}
		out = append(out, hclient.Placement{Group: n.ID})
		gid := n.ID
		for _, kid := range n.Kids {
			out = append(out, hclient.Placement{ID: kid, GroupID: &gid})
		}
	}
	return out
}

func clone(nodes []Node) []Node {
	out := slices.Clone(nodes)
	for i := range out {
		out[i].Kids = slices.Clone(out[i].Kids)
	}
	return out
}

func topIndex(nodes []Node, group bool, id int) int {
	return slices.IndexFunc(nodes, func(n Node) bool { return n.Group == group && n.ID == id })
}

// holder is the group a channel is in, as an index in nodes, or -1 when it is on its own.
func holder(nodes []Node, channel int) int {
	return slices.IndexFunc(nodes, func(n Node) bool { return n.Group && slices.Contains(n.Kids, channel) })
}

// MoveChannel moves a channel to its landing place; the result is nil when that place does not exist or is the channel itself.
func MoveChannel(nodes []Node, id int, to Drop) []Node {
	if to.Kind == BeforeChannel && to.ID == id {
		return nil
	}
	out := clone(nodes)
	if at := topIndex(out, false, id); at >= 0 {
		out = slices.Delete(out, at, at+1)
	} else if g := holder(out, id); g >= 0 {
		out[g].Kids = slices.DeleteFunc(out[g].Kids, func(k int) bool { return k == id })
	} else {
		return nil
	}
	switch to.Kind {
	case BeforeChannel:
		if at := topIndex(out, false, to.ID); at >= 0 {
			return slices.Insert(out, at, Node{ID: id})
		}
		if g := holder(out, to.ID); g >= 0 {
			at := slices.Index(out[g].Kids, to.ID)
			out[g].Kids = slices.Insert(out[g].Kids, at, id)
			return out
		}
	case IntoGroup:
		if g := topIndex(out, true, to.ID); g >= 0 {
			out[g].Kids = append(out[g].Kids, id)
			return out
		}
	case End:
		return append(out, Node{ID: id})
	case BeforeGroup:
		if g := topIndex(out, true, to.ID); g >= 0 {
			return slices.Insert(out, g, Node{ID: id})
		}
	case AfterGroup:
		if g := topIndex(out, true, to.ID); g >= 0 {
			return slices.Insert(out, g+1, Node{ID: id})
		}
		return append(out, Node{ID: id})
	}
	return nil
}

// MoveGroup moves a group, with its channels, above a group or a channel (above the group that holds it), or to the end.
func MoveGroup(nodes []Node, id int, to Drop) []Node {
	out := clone(nodes)
	from := topIndex(out, true, id)
	if from < 0 {
		return nil
	}
	moving := out[from]
	out = slices.Delete(out, from, from+1)
	at := len(out)
	switch to.Kind {
	case BeforeGroup:
		at = topIndex(out, true, to.ID)
	case BeforeChannel:
		if at = topIndex(out, false, to.ID); at < 0 {
			at = holder(out, to.ID)
		}
	case End:
	default:
		return nil
	}
	if at < 0 {
		return nil
	}
	return slices.Insert(out, at, moving)
}

// Nudge moves one channel or group a place up or down within what it is in; nil when it cannot.
func Nudge(nodes []Node, group bool, id, step int) []Node {
	out := clone(nodes)
	if at := topIndex(out, group, id); at >= 0 {
		if to := at + step; to >= 0 && to < len(out) {
			out[at], out[to] = out[to], out[at]
			return out
		}
		return nil
	}
	g := holder(out, id)
	if group || g < 0 {
		return nil
	}
	kids := out[g].Kids
	at := slices.Index(kids, id)
	if to := at + step; to >= 0 && to < len(kids) {
		kids[at], kids[to] = kids[to], kids[at]
		return out
	}
	return nil
}
