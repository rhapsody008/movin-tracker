// Package objstore is the thin layer over S3 that the rest of the app uses:
// read an object with its ETag, and write it only if the ETag still matches.
package objstore

import (
	"context"
	"errors"
)

var (
	// ErrNotFound means the object does not exist.
	ErrNotFound = errors.New("object not found")
	// ErrPrecondition means a conditional write lost the race (HTTP 412),
	// or If-None-Match: * found the object already there.
	ErrPrecondition = errors.New("precondition failed")
)

// Store reads and conditionally writes whole objects by key.
type Store interface {
	// Get returns the body and ETag, or ErrNotFound.
	Get(ctx context.Context, key string) (body []byte, etag string, err error)
	// Head returns the current ETag, or ErrNotFound.
	Head(ctx context.Context, key string) (etag string, err error)
	// Put writes body. With ifMatch set, the write only happens if the stored
	// ETag equals it. With ifMatch empty, the write only happens if the object
	// does not exist yet (If-None-Match: *). Returns the new ETag or ErrPrecondition.
	Put(ctx context.Context, key string, body []byte, ifMatch string) (etag string, err error)
}
