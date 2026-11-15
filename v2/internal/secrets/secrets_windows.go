//go:build windows

package secrets

import (
	"errors"
	"syscall"
	"unsafe"
)

// On Windows each value is encrypted with the data protection API, which ties it to this Windows account, and kept in
// the settings directory's secrets file.

const uiForbidden = 0x1

var (
	crypt32       = syscall.NewLazyDLL("crypt32.dll")
	kernel32      = syscall.NewLazyDLL("kernel32.dll")
	procProtect   = crypt32.NewProc("CryptProtectData")
	procUnprotect = crypt32.NewProc("CryptUnprotectData")
	procLocalFree = kernel32.NewProc("LocalFree")
)

type dataBlob struct {
	size uint32
	data *byte
}

func blobOf(b []byte) dataBlob {
	if len(b) == 0 {
		return dataBlob{}
	}
	return dataBlob{size: uint32(len(b)), data: &b[0]}
}

// entropy is mixed into the encryption so another program running as this person cannot open the value by asking.
var entropy = []byte(service)

func transform(proc *syscall.LazyProc, in []byte) ([]byte, error) {
	source, extra, out := blobOf(in), blobOf(entropy), dataBlob{}
	ok, _, err := proc.Call(uintptr(unsafe.Pointer(&source)), 0, uintptr(unsafe.Pointer(&extra)), 0, 0, uiForbidden, uintptr(unsafe.Pointer(&out)))
	if ok == 0 {
		if err == nil {
			err = errors.New("the data protection call failed")
		}
		return nil, err
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.data)))
	return append([]byte(nil), unsafe.Slice(out.data, out.size)...), nil
}

var store = &fileStore{
	seal: func(b []byte) ([]byte, error) { return transform(procProtect, b) },
	open: func(b []byte) ([]byte, error) { return transform(procUnprotect, b) },
}

// Get is what is kept under the key.
func Get(key string) ([]byte, error) { return store.get(key) }

// Set keeps the value under the key, replacing what was there.
func Set(key string, value []byte) error { return store.set(key, value) }

// Delete forgets the key; a key that is not there is not an error.
func Delete(key string) error { return store.remove(key) }
