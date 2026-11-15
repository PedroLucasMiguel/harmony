package hotkey

// matcher turns the key and button events of a listener that sees everything into "held" and "not held" for one combo. The modifiers must be exactly the combo's: a bare V does not answer to Ctrl+V.
// Pressing is reported once however long the key repeats; letting go is the key coming up or a required modifier letting go first.
type matcher struct {
	combo Combo
	codes []uint32
	held  bool
}

type modifierState struct{ ctrl, alt, shift, meta bool }

func (m *matcher) modsMatch(s modifierState) bool {
	return s.ctrl == m.combo.Ctrl && s.alt == m.combo.Alt && s.shift == m.combo.Shift && s.meta == m.combo.Meta
}

func (m *matcher) isCode(code uint32) bool {
	for _, c := range m.codes {
		if c == code {
			return true
		}
	}
	return false
}

// down returns true when this press starts holding the combo.
func (m *matcher) down(code uint32, s modifierState) bool {
	if m.held || !m.isCode(code) || !m.modsMatch(s) {
		return false
	}
	m.held = true
	return true
}

// up returns true when this release ends holding the combo.
func (m *matcher) up(code uint32, s modifierState) bool {
	if !m.held || !(m.isCode(code) || !m.modsMatch(s)) {
		return false
	}
	m.held = false
	return true
}
