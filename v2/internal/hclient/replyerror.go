package hclient

import "fmt"

// Codes the server answers a voice request with that a person is told about in their own words.
const (
	CodePasswordRequired = "password_required"
	CodeBadPassword      = "bad_password"
	CodeChannelFull      = "channel_full"
	CodeForbidden        = "forbidden"
)

// ReplyError is a realtime request the server refused: Code says why and Cap is how many people a full room holds.
type ReplyError struct {
	Request string `json:"-"`
	Code    string `json:"error"`
	Cap     int    `json:"cap"`
}

func (e *ReplyError) Error() string { return fmt.Sprintf("%s: %s", e.Request, e.Code) }
