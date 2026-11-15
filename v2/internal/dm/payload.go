package dm

import (
	"bytes"
	"encoding/json"
	"math"
	"unicode/utf8"
)

// payload is what a sealed message says: the fields Ciranda has and no others, in its order.
type payload struct {
	Body  string          `json:"body"`
	File  *File           `json:"file,omitempty"`
	Reply *Reply          `json:"reply,omitempty"`
	Poll  json.RawMessage `json:"poll,omitempty"`
	Mid   string          `json:"mid"`
	Rev   int             `json:"rev,omitempty"`
	Of    *int            `json:"of,omitempty"`
}

// messageJSON is the padded JSON that is sealed; a new message gets an id of its own, an edit keeps its message's.
func messageJSON(p payload) []byte {
	if p.Mid == "" {
		p.Mid = b64(random(16))
	}
	return pad(marshal(p))
}

func marshal(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return bytes.TrimRight(buf.Bytes(), "\n")
}

// parsePayload reads what was sealed, as leniently as every client does: fields that are not what they should be are
// left out, and trailing spaces are the padding.
func parsePayload(plain []byte) (payload, bool) {
	var p payload
	if !utf8.Valid(plain) {
		return p, false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(plain, &fields) != nil || fields == nil {
		return p, false
	}
	_ = json.Unmarshal(fields["body"], &p.Body)
	_ = json.Unmarshal(fields["mid"], &p.Mid)
	p.File = validFile(fields["file"])
	p.Reply = validReply(fields["reply"])
	if raw := fields["poll"]; len(raw) > 0 && raw[0] == '{' {
		p.Poll = raw
	}
	if n, ok := safeInteger(fields["rev"]); ok && n > 0 {
		p.Rev = n
	}
	if n, ok := safeInteger(fields["of"]); ok {
		p.Of = &n
	}
	return p, true
}

// safeInteger reads a JSON number that is a whole number a double holds exactly, as 1 and 1.0 are.
func safeInteger(raw json.RawMessage) (int, bool) {
	var f float64
	if json.Unmarshal(raw, &f) != nil || f != math.Trunc(f) || math.Abs(f) > 1<<53-1 {
		return 0, false
	}
	return int(f), true
}

func validKey(key string) bool {
	if len(key) != 43 {
		return false
	}
	_, ok := unb64(key)
	return ok
}

func validFile(raw json.RawMessage) *File {
	var f struct {
		Key  string  `json:"key"`
		Name string  `json:"name"`
		Mime *string `json:"mime"`
		Size float64 `json:"size"`
	}
	if len(raw) == 0 || raw[0] != '{' || json.Unmarshal(raw, &f) != nil || !validKey(f.Key) {
		return nil
	}
	file := &File{Key: f.Key, Name: f.Name, Mime: "application/octet-stream"}
	if f.Mime != nil {
		file.Mime = *f.Mime
	}
	if f.Size >= 0 && !math.IsInf(f.Size, 0) {
		file.Size = int64(f.Size)
	}
	file.Media = mediaOf(file.Mime)
	return file
}

func validReply(raw json.RawMessage) *Reply {
	var r struct {
		ID             json.RawMessage `json:"id"`
		User           json.RawMessage `json:"userId"`
		Body           string          `json:"body"`
		AttachmentName string          `json:"attachmentName"`
		Deleted        bool            `json:"deleted"`
	}
	if len(raw) == 0 || raw[0] != '{' || json.Unmarshal(raw, &r) != nil {
		return nil
	}
	id, ok := safeInteger(r.ID)
	if !ok {
		return nil
	}
	user, _ := safeInteger(r.User)
	return &Reply{ID: id, User: user, Body: r.Body, AttachmentName: r.AttachmentName, Deleted: r.Deleted}
}
