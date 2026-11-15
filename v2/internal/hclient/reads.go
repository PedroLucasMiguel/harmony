package hclient

// Group is a heading in the channel list; its channels name it by id.
type Group struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Position int    `json:"position"`
	Locked   bool   `json:"locked"`
	Roles    []int  `json:"roles"`
	Users    []int  `json:"users"`
}

// ReadMark is what is new to you in one channel, as the server counts it.
type ReadMark struct {
	ChannelID  int `json:"channelId"`
	Unread     int `json:"unread"`
	Mentions   int `json:"mentions"`
	LastID     int `json:"lastId"`
	LastReadID int `json:"lastReadId"`
}
