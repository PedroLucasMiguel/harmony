package store

// CustomColours are the four colours of the custom palette, as "#rrggbb".
type CustomColours struct {
	Bg      string `json:"bg"`
	Surface string `json:"surface"`
	Text    string `json:"text"`
	Accent  string `json:"accent"`
}

// Shell is what the window frame and the layout remember. A width of 0 is the column's usual one.
type Shell struct {
	// TextScale is the size of the type alone in percent, 80 to 200.
	TextScale      int            `json:"textScale"`
	CustomTheme    *CustomColours `json:"customTheme,omitempty"`
	SideWidth      int            `json:"sideWidth,omitempty"`
	MembersWidth   int            `json:"membersWidth,omitempty"`
	ForumListWidth int            `json:"forumListWidth,omitempty"`
	DMListWidth    int            `json:"dmListWidth,omitempty"`
	// DMLinkPreviews is a card under a link in a private message, which tells the server the address.
	DMLinkPreviews bool `json:"dmLinkPreviews"`
	// PictureInPicture floats the streams of the call in one small window over the other pages; PipPopOut makes that window the whole app while it is minimised.
	PictureInPicture bool `json:"pictureInPicture"`
	PipPopOut        bool `json:"pipPopOut"`
	// PipRect is where the window was left and how big it was made, in interface pixels from the page's corner; empty is the usual place.
	PipRect Rect `json:"pipRect"`
}

// Rect is a place and a size.
type Rect struct {
	X, Y, W, H float32
}

func shellDefaults() Shell { return Shell{TextScale: 100, DMLinkPreviews: true, PipPopOut: true} }
