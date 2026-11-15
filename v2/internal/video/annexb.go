package video

import (
	"bytes"
	"io"
)

type auReader struct {
	r    io.Reader
	buf  []byte
	cur  []byte
	have bool
	eof  error
}

func newAUReader(r io.Reader) *auReader { return &auReader{r: r, buf: make([]byte, 0, 1<<20)} }

var startCode3 = []byte{0, 0, 1}

func (a *auReader) nextNAL() ([]byte, error) {
	for {
		if first := bytes.Index(a.buf, startCode3); first >= 0 {
			head := first
			if head > 0 && a.buf[head-1] == 0 {
				head--
			}
			if next := bytes.Index(a.buf[first+3:], startCode3); next >= 0 {
				end := first + 3 + next
				if end > 0 && a.buf[end-1] == 0 {
					end--
				}
				nal := append([]byte(nil), a.buf[head:end]...)
				a.buf = append(a.buf[:0], a.buf[end:]...)
				return nal, nil
			}
		}
		if a.eof != nil {
			if len(a.buf) > 0 {
				nal := append([]byte(nil), a.buf...)
				a.buf = a.buf[:0]
				return nal, nil
			}
			return nil, a.eof
		}
		chunk := make([]byte, 64<<10)
		n, err := a.r.Read(chunk)
		a.buf = append(a.buf, chunk[:n]...)
		if err != nil {
			a.eof = err
		}
	}
}

func nalType(nal []byte) int {
	i := bytes.Index(nal, startCode3)
	if i < 0 || i+3 >= len(nal) {
		return -1
	}
	return int(nal[i+3] & 0x1f)
}

func (a *auReader) Next() ([]byte, error) {
	for {
		nal, err := a.nextNAL()
		if err != nil {
			if a.have && len(a.cur) > 0 && err == io.EOF {
				au := a.cur
				a.cur, a.have = nil, false
				return au, nil
			}
			return nil, err
		}
		if nalType(nal) == 9 {
			if a.have && len(a.cur) > 0 {
				au := a.cur
				a.cur = append([]byte(nil), nal...)
				return au, nil
			}
			a.cur, a.have = append([]byte(nil), nal...), true
			continue
		}
		if a.have {
			a.cur = append(a.cur, nal...)
		}
	}
}
