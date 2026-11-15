package raw

var getKeyPressed Entry

func init() { getKeyPressed = Lookup("GetKeyPressed") }

// GetKeyPressed takes the next key pressed since the last call off the window's queue, or 0 when there is none; it is the key's place on the keyboard, not the letter it types.
func GetKeyPressed() int32 { return int32(getKeyPressed.Call()) }
