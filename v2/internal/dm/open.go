package dm

import (
	"encoding/json"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// What the vault remembers of the texts seen of one message, to tell a replay, a swap and an edit put back.
type textState struct {
	seen    map[[nonceLen]byte]bool
	current [nonceLen]byte
	has     bool
	edited  int64
	rev     int
	shown   *Message
}

type placement int

const (
	current placement = iota
	// superseded is an older text than the one shown, arriving late or put back: the newer one stays.
	superseded
	// refused is not where it was sealed to be: under another message's id, or an edit of another message.
	refused
)

// opened is a payload that opened, and whether its sender's key is one accepted for them here.
type opened struct {
	plain     []byte
	confirmed bool
}

// open opens something sealed between you and `peer`; fromMe says which of the two keys is yours.
func (v *vault) open(conversation, peer, senderKey, recipientKey int, fromMe bool, aad, sealed string, group bool) (opened, bool) {
	mine, theirs := recipientKey, senderKey
	if fromMe {
		mine, theirs = senderKey, recipientKey
	}
	key := v.pair(conversation, mine, peer, theirs, group)
	if key == nil {
		return opened{}, false
	}
	plain, ok := key.open(aad, sealed)
	if !ok {
		return opened{}, false
	}
	// Your own copy of what you wrote needs no confirming: nobody's key is in question.
	if peer == v.me {
		return opened{plain, true}, true
	}
	return opened{plain, v.confirm(peer, theirs)}, true
}

// confirm says whether `theirs` is a key accepted for `peer` here, first pinning their current one if none was yet. One
// that isn't is remembered, so the conversation can say their key changed. Either of the two people holding the halves
// of a pair can seal anything in it, so a key nobody accepted is as good as a stranger's.
func (v *vault) confirm(peer, theirs int) bool {
	if !v.file.hasPin(peer) {
		cur, ok := v.current[peer]
		if !ok {
			cur = theirs
		}
		v.acceptUpTo(peer, cur)
	}
	if v.isAccepted(peer, theirs) {
		return true
	}
	if v.unconfirmed[peer] == nil {
		v.unconfirmed[peer] = map[int]bool{}
	}
	v.unconfirmed[peer][theirs] = true
	return false
}

func before(a0 int64, a1 int, b0 int64, b1 int) bool { return a0 < b0 || a0 == b0 && a1 < b1 }

// openMessage is a sealed message as the chat draws it; one that does not open still shows, saying so. `peer` is the
// other person of a pair and 0 for a group, where what is opened is between you and whoever wrote it.
func (v *vault) openMessage(m *rawMessage, peer int) *Message {
	group := peer == 0
	if group {
		peer = m.User
	}
	out := &Message{
		ID: m.ID, Conversation: m.Conversation, User: m.User, Kind: Kind(m.Kind), CreatedAt: m.CreatedAt,
		EditedAt: m.EditedAt, Pinned: m.Pinned,
	}
	if out.Kind == "" {
		out.Kind = KindText
	}
	switch out.Kind {
	case KindCall, KindGroup:
		if len(m.Meta) > 0 && string(m.Meta) != "null" {
			out.Line = m.Meta
		}
	default:
		if !v.fill(out, m, peer, group) {
			return v.supersededView(m, peer, group)
		}
	}
	out.Reactions = v.openReactions(m.Conversation, group, peer, m.ID, m.Reactions)
	if out.Kind == KindText && !out.Unreadable {
		if t := v.texts[m.ID]; t != nil {
			t.shown = out
		}
	}
	return out
}

// supersededView is the message as it was shown, for a text older than the one shown.
func (v *vault) supersededView(m *rawMessage, peer int, group bool) *Message {
	shown := *v.texts[m.ID].shown
	shown.Layout = nil
	shown.Reactions = v.openReactions(m.Conversation, group, peer, m.ID, m.Reactions)
	return &shown
}

// fill opens the text of m into out. It reports false when the text is a superseded one and the message shown stays.
func (v *vault) fill(out *Message, m *rawMessage, peer int, group bool) bool {
	if m.SenderKey == 0 || m.RecipientKey == 0 || m.Sealed == "" {
		out.Unreadable = true
		return true
	}
	got, ok := v.open(m.Conversation, peer, m.SenderKey, m.RecipientKey, m.User == v.me, aadMessage(m.Conversation, m.User), m.Sealed, group)
	var p payload
	if ok {
		p, ok = parsePayload(got.plain)
	}
	if !ok {
		out.Unreadable = true
		return true
	}
	switch v.place(m, m.Sealed, p) {
	case superseded:
		if v.texts[m.ID].shown != nil {
			return false
		}
	case refused:
		out.Unreadable, out.OutOfPlace = true, true
		return true
	}
	out.Unconfirmed = !got.confirmed
	out.Body, out.Rev, out.Reply, out.File, out.Poll, out.mid = p.Body, p.Rev, p.Reply, p.File, p.Poll, p.Mid
	if p.File != nil {
		out.AttachmentHash = m.AttachmentHash
	}
	return true
}

// place says where an opened text of `m` stands. Refused when its sealed text or its own id was seen under another
// message id (sent again, or two swapped), or when it is an edit of another message. Nothing is remembered of a text
// that is refused, so it cannot spoil the real one.
//
// A text of this message already seen and since replaced is superseded, not refused: the newer one stays shown. Only the
// sender can make a new text, so that is the server putting an old one back, or a page fetched before an edit arriving
// after it; either way the old words are not shown, and the real current ones are not covered by a refusal. A new text
// older than the one shown, by the server's edit time and then its edit count, is late, and superseded too.
func (v *vault) place(m *rawMessage, sealed string, p payload) placement {
	nonce, ok := nonceOf(sealed)
	if !ok {
		return refused
	}
	id := m.ID
	elsewhere := v.seenElsewhere(nonce, p, id) || p.Of != nil && *p.Of != id
	t := v.texts[id]
	if t == nil {
		t = &textState{seen: map[[nonceLen]byte]bool{}}
		v.texts[id] = t
	}
	if t.has && t.current == nonce {
		return current
	}
	if elsewhere {
		return refused
	}
	if t.seen[nonce] {
		return superseded
	}
	older := t.has && before(m.EditedAt, p.Rev, t.edited, t.rev)
	t.seen[nonce] = true
	if !older {
		t.current, t.has, t.edited, t.rev = nonce, true, m.EditedAt, p.Rev
	}
	v.nonces[nonce] = id
	if p.Mid != "" {
		v.mids[p.Mid] = id
	}
	if older {
		return superseded
	}
	return current
}

func (v *vault) seenElsewhere(nonce [nonceLen]byte, p payload, id int) bool {
	if other, ok := v.nonces[nonce]; ok && other != id {
		return true
	}
	other, ok := v.mids[p.Mid]
	return p.Mid != "" && ok && other != id
}

// forgetAllBut forgets what was seen of every message but these: their texts, nonces and own ids. The session keeps the
// messages it shows and the last of each conversation, so a replay or a swap is still told among all of those; one
// involving a message let go is told again once both are loaded together.
func (v *vault) forgetAllBut(keep map[int]bool) {
	for id := range v.texts {
		if !keep[id] {
			delete(v.texts, id)
		}
	}
	for nonce, id := range v.nonces {
		if !keep[id] {
			delete(v.nonces, nonce)
		}
	}
	for mid, id := range v.mids {
		if !keep[id] {
			delete(v.mids, mid)
		}
	}
}

// openVersion is an earlier text of `m`, with ok false if it does not open here or is not one of `m`'s. Seen, it cannot
// be put back as the current one later.
func (v *vault) openVersion(m *Message, peer int, ver rawVersion) (string, bool) {
	group := peer == 0
	author := m.User
	if group {
		peer = author
	}
	got, ok := v.open(m.Conversation, peer, ver.SenderKey, ver.RecipientKey, author == v.me, aadMessage(m.Conversation, author), ver.Sealed, group)
	if !ok {
		return "", false
	}
	p, ok := parsePayload(got.plain)
	nonce, hasNonce := nonceOf(ver.Sealed)
	if !ok || !hasNonce {
		return "", false
	}
	foreign := v.seenElsewhere(nonce, p, m.ID) || p.Of != nil && *p.Of != m.ID || p.Mid != "" && m.mid != "" && p.Mid != m.mid
	if foreign {
		return "", false
	}
	v.nonces[nonce] = m.ID
	if p.Mid != "" {
		v.mids[p.Mid] = m.ID
	}
	t := v.texts[m.ID]
	if t == nil {
		t = &textState{seen: map[[nonceLen]byte]bool{}}
		v.texts[m.ID] = t
	}
	t.seen[nonce] = true
	return p.Body, true
}

const voteMarker = "poll:"

// isVote says whether a reaction's text is a vote in a poll ("poll:" and one or two digits).
func isVote(emoji string) bool {
	rest, ok := strings.CutPrefix(emoji, voteMarker)
	if !ok || len(rest) == 0 || len(rest) > 2 {
		return false
	}
	_, err := strconv.ParseUint(rest, 10, 8)
	return err == nil
}

const (
	maxEmoji = 20
	maxVotes = 12
)

// openReactions is everybody's sealed reactions to a message, opened and counted as a channel's are.
func (v *vault) openReactions(conversation int, group bool, peer, message int, sealed []rawReaction) []Reaction {
	var out []Reaction
	for _, r := range sealed {
		who := peer
		if group {
			who = r.User
		}
		got, ok := v.open(conversation, who, r.SenderKey, r.RecipientKey, r.User == v.me, aadReaction(conversation, message, r.User), r.Sealed, group)
		if !ok || !utf8.Valid(got.plain) {
			continue
		}
		var emoji []string
		if json.Unmarshal(got.plain, &emoji) != nil {
			continue
		}
		var plain, votes []string
		for _, e := range emoji {
			if isVote(e) {
				votes = append(votes, e)
			} else {
				plain = append(plain, e)
			}
		}
		// A person's votes in a poll ride with their emoji and are not counted against the 20.
		list := append(plain[:min(len(plain), maxEmoji)], votes[:min(len(votes), maxVotes)]...)
		for _, e := range list {
			i := slices.IndexFunc(out, func(x Reaction) bool { return x.Emoji == e })
			switch {
			case i < 0:
				out = append(out, Reaction{Emoji: e, Count: 1, Users: []int{r.User}})
			case !slices.Contains(out[i].Users, r.User):
				out[i].Count++
				out[i].Users = append(out[i].Users, r.User)
			}
		}
	}
	return out
}
