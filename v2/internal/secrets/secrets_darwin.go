//go:build darwin

package secrets

import (
	"fmt"
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

const (
	securityPath = "/System/Library/Frameworks/Security.framework/Security"
	cfPath       = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"

	encodingUTF8        = 0x08000100
	statusNotFound      = -25300
	statusDuplicateItem = -25299
)

// keychain holds the addresses of the framework functions and of the constants they take.
var keychain struct {
	once sync.Once
	err  error

	release, stringCreate, dataCreate, dictCreate, dataLength, dataBytes uintptr
	itemAdd, itemCopy, itemUpdate, itemDelete                            uintptr

	keyCallbacks, valueCallbacks                                          uintptr
	class, classPassword, attrService, attrAccount, valueData, returnData uintptr
	matchLimit, matchLimitOne, boolTrue                                   uintptr
}

func loadKeychain() error {
	keychain.once.Do(func() {
		k := &keychain
		sec, err := purego.Dlopen(securityPath, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			k.err = err
			return
		}
		cf, err := purego.Dlopen(cfPath, purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			k.err = err
			return
		}
		fn := func(lib uintptr, name string) uintptr {
			p, err := purego.Dlsym(lib, name)
			if err != nil && k.err == nil {
				k.err = err
			}
			return p
		}
		val := func(lib uintptr, name string) uintptr { return deref(fn(lib, name)) }
		k.release, k.stringCreate, k.dataCreate = fn(cf, "CFRelease"), fn(cf, "CFStringCreateWithBytes"), fn(cf, "CFDataCreate")
		k.dictCreate, k.dataLength, k.dataBytes = fn(cf, "CFDictionaryCreate"), fn(cf, "CFDataGetLength"), fn(cf, "CFDataGetBytePtr")
		k.keyCallbacks, k.valueCallbacks = fn(cf, "kCFTypeDictionaryKeyCallBacks"), fn(cf, "kCFTypeDictionaryValueCallBacks")
		k.boolTrue = val(cf, "kCFBooleanTrue")
		k.itemAdd, k.itemCopy, k.itemUpdate, k.itemDelete = fn(sec, "SecItemAdd"), fn(sec, "SecItemCopyMatching"), fn(sec, "SecItemUpdate"), fn(sec, "SecItemDelete")
		k.class, k.classPassword = val(sec, "kSecClass"), val(sec, "kSecClassGenericPassword")
		k.attrService, k.attrAccount, k.valueData = val(sec, "kSecAttrService"), val(sec, "kSecAttrAccount"), val(sec, "kSecValueData")
		k.returnData, k.matchLimit, k.matchLimitOne = val(sec, "kSecReturnData"), val(sec, "kSecMatchLimit"), val(sec, "kSecMatchLimitOne")
	})
	return keychain.err
}

// deref reads the pointer-sized value at an address the system gave out.
func deref(addr uintptr) uintptr {
	return *(*uintptr)(*(*unsafe.Pointer)(unsafe.Pointer(&addr)))
}

// bytesAt copies n bytes from an address the system gave out.
func bytesAt(addr uintptr, n int) []byte {
	return append([]byte(nil), unsafe.Slice((*byte)(*(*unsafe.Pointer)(unsafe.Pointer(&addr))), n)...)
}

// heapCell is a word the system may write to during a call: never on a Go stack, which can move while the call is made.
//
//go:noinline
func heapCell() *uintptr { return new(uintptr) }

func call(fn uintptr, args ...uintptr) uintptr {
	r, _, _ := purego.SyscallN(fn, args...)
	return r
}

func cfString(s string) uintptr {
	b := make([]byte, len(s)) // on the heap: a stack address given to the system as a plain integer goes stale when the stack moves
	copy(b, s)
	r := call(keychain.stringCreate, 0, addressOf(b), uintptr(len(b)), encodingUTF8, 0)
	runtime.KeepAlive(b)
	return r
}

func cfData(b []byte) uintptr {
	r := call(keychain.dataCreate, 0, addressOf(b), uintptr(len(b)))
	runtime.KeepAlive(b)
	return r
}

func addressOf(b []byte) uintptr {
	if len(b) == 0 {
		return 0
	}
	return uintptr(unsafe.Pointer(&b[0]))
}

// dict makes a dictionary of the key and value pairs; the caller releases it.
func dict(pairs ...uintptr) uintptr {
	n := len(pairs) / 2
	keys, values := make([]uintptr, n), make([]uintptr, n)
	for i := range n {
		keys[i], values[i] = pairs[2*i], pairs[2*i+1]
	}
	r := call(keychain.dictCreate, 0, uintptr(unsafe.Pointer(&keys[0])), uintptr(unsafe.Pointer(&values[0])), uintptr(n), keychain.keyCallbacks, keychain.valueCallbacks)
	runtime.KeepAlive(keys)
	runtime.KeepAlive(values)
	return r
}

func failure(what string, code int32) error { return fmt.Errorf("keychain %s: status %d", what, code) }

// withItem runs fn with a query naming the item, plus the pairs asked for, and releases what it made afterwards.
func withItem(key string, extra []uintptr, fn func(query uintptr) error) error {
	if err := loadKeychain(); err != nil {
		return err
	}
	k := &keychain
	svc, acct := cfString(service), cfString(key)
	defer call(k.release, svc)
	defer call(k.release, acct)
	query := dict(append([]uintptr{k.class, k.classPassword, k.attrService, svc, k.attrAccount, acct}, extra...)...)
	defer call(k.release, query)
	return fn(query)
}

// Get is what is kept under the key.
func Get(key string) ([]byte, error) {
	if err := loadKeychain(); err != nil {
		return nil, err
	}
	var out []byte
	err := withItem(key, []uintptr{keychain.returnData, keychain.boolTrue, keychain.matchLimit, keychain.matchLimitOne}, func(query uintptr) error {
		result := heapCell()
		switch code := int32(call(keychain.itemCopy, query, uintptr(unsafe.Pointer(result)))); code {
		case 0:
			defer call(keychain.release, *result)
			out = bytesAt(call(keychain.dataBytes, *result), int(call(keychain.dataLength, *result)))
			return nil
		case statusNotFound:
			return ErrNotFound
		default:
			return failure("read", code)
		}
	})
	return out, err
}

// Set keeps the value under the key, replacing what was there.
func Set(key string, value []byte) error {
	k := &keychain
	return withItem(key, nil, func(query uintptr) error {
		data := cfData(value)
		defer call(k.release, data)
		svc, acct := cfString(service), cfString(key)
		defer call(k.release, svc)
		defer call(k.release, acct)
		fresh := dict(k.class, k.classPassword, k.attrService, svc, k.attrAccount, acct, k.valueData, data)
		defer call(k.release, fresh)
		code := int32(call(k.itemAdd, fresh, 0))
		if code == statusDuplicateItem {
			change := dict(k.valueData, data)
			defer call(k.release, change)
			code = int32(call(k.itemUpdate, query, change))
		}
		if code != 0 {
			return failure("write", code)
		}
		return nil
	})
}

// Delete forgets the key; a key that is not there is not an error.
func Delete(key string) error {
	return withItem(key, nil, func(query uintptr) error {
		if code := int32(call(keychain.itemDelete, query)); code != 0 && code != statusNotFound {
			return failure("delete", code)
		}
		return nil
	})
}
