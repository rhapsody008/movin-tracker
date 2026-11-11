// Package objstore is the thin layer over S3 that the rest of the app uses:
// read an object with its ETag, and write it only if the ETag still matches.
package objstore

import (
	"context"
	"errors"
	"time"
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
	// Put writes body. With ifMatch set, the write only happens if the stored
	// ETag equals it. With ifMatch empty, the write only happens if the object
	// does not exist yet (If-None-Match: *). Returns the new ETag or ErrPrecondition.
	Put(ctx context.Context, key string, body []byte, ifMatch string) (etag string, err error)
	// Stat returns the object's ETag, size and last-modified time, or ErrNotFound.
	Stat(ctx context.Context, key string) (ObjectInfo, error)
	// Delete removes the object. Deleting a missing key is not an error.
	Delete(ctx context.Context, key string) error
}

// Blobs is implemented by stores that also hold files (the documents and
// what is derived from them): list everything under a key prefix, and write
// without a version guard. Keys are relative to the store's own prefix.
type Blobs interface {
	// List returns every object whose key starts with prefix, at any depth,
	// sorted by key. A prefix that matches nothing gives an empty list.
	List(ctx context.Context, prefix string) ([]ObjectInfo, error)
	// PutBlob writes body unconditionally with the given content type and
	// returns the new ETag.
	PutBlob(ctx context.Context, key string, body []byte, contentType string) (etag string, err error)
}

type ObjectInfo struct {
	Key          string
	ETag         string
	Size         int64
	LastModified time.Time
}

// Info describes where a store keeps its objects, for the admin page. It
// never carries key material.
type Info struct {
	Backend          string `json:"backend"` // s3 | memory
	Bucket           string `json:"bucket,omitempty"`
	Region           string `json:"region,omitempty"`
	Prefix           string `json:"prefix,omitempty"`
	Endpoint         string `json:"endpoint,omitempty"` // empty means AWS S3
	CredentialSource string `json:"credentialSource,omitempty"`
	CredentialError  string `json:"credentialError,omitempty"`
}

// Describer is implemented by stores that can report Info.
type Describer interface {
	Info(ctx context.Context) Info
}

var (
	_ Blobs = (*S3)(nil)
	_ Blobs = (*Memory)(nil)
)
