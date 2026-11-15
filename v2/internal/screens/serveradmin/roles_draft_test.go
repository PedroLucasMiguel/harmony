package serveradmin

import (
	"testing"

	"harmony/v2/internal/hclient"
)

func TestDraftBody(t *testing.T) {
	role := hclient.Role{ID: 3, Name: "Mod", Color: "#e91e63", Permissions: []string{"users.mute"}}
	d := draftOf(&role)
	if b := d.body(); b == nil || b.Color != "#e91e63" || b.Style != nil || len(b.Permissions) != 1 {
		t.Fatalf("a plain role is sent with its colour and no style: %+v", b)
	}
	d.Look.Color = "#e91e"
	if d.body() != nil {
		t.Fatal("half a colour is not sent")
	}
	d.Look.Color = "#e91e63"
	d.Name = "  "
	if d.body() != nil {
		t.Fatal("a name that is only spaces is not sent")
	}
}

func TestDraftGradientColourIsFirstStop(t *testing.T) {
	role := hclient.Role{ID: 4, Name: "G", Color: "#8e2de2", Style: &hclient.NameStyle{Mode: "gradient", Colors: []string{"#8e2de2", "#00c6ff"}, Speed: 6}}
	d := draftOf(&role)
	d.Look.Colors[0] = "#112233"
	b := d.body()
	if b == nil || b.Color != "#112233" || b.Style == nil || b.Style.Mode != "gradient" {
		t.Fatalf("the plain colour follows the first stop: %+v", b)
	}
	d.Look.Colors[1] = "#12"
	if d.body() != nil {
		t.Fatal("a half typed stop is not sent")
	}
}

func TestToggle(t *testing.T) {
	list := toggle([]string{"a", "b"}, "b", false)
	list = toggle(list, "c", true)
	list = toggle(list, "c", true)
	if len(list) != 2 || list[0] != "a" || list[1] != "c" {
		t.Fatalf("got %v", list)
	}
}
