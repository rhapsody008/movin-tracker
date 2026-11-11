package objstore

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"sort"
	"strings"
	"sync"
	"time"
)

// Memory is an in-process Store with the same conditional-write rules as S3.
// Used by unit tests and by chat-eval so they never touch a real bucket.
type Memory struct {
	mu   sync.Mutex
	objs map[string]memObj
	seq  int
}

type memObj struct {
	body []byte
	etag string
	mod  time.Time
}

func NewMemory() *Memory { return &Memory{objs: map[string]memObj{}} }

func (m *Memory) Get(_ context.Context, key string) ([]byte, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o, ok := m.objs[key]
	if !ok {
		return nil, "", ErrNotFound
	}
	return append([]byte(nil), o.body...), o.etag, nil
}

func (m *Memory) Put(_ context.Context, key string, body []byte, ifMatch string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o, ok := m.objs[key]
	switch {
	case ifMatch == "" && ok:
		return "", ErrPrecondition
	case ifMatch != "" && (!ok || o.etag != ifMatch):
		return "", ErrPrecondition
	}
	// Same body twice must still give a fresh ETag, or a no-op write would
	// look like "nothing changed" to pollers; S3 has the same property only
	// by accident of content, so mix in a sequence number.
	m.seq++
	sum := md5.Sum(append([]byte{byte(m.seq), byte(m.seq >> 8)}, body...))
	etag := `"` + hex.EncodeToString(sum[:]) + `"`
	m.objs[key] = memObj{body: append([]byte(nil), body...), etag: etag, mod: time.Now().UTC()}
	return etag, nil
}

func (m *Memory) Stat(_ context.Context, key string) (ObjectInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	o, ok := m.objs[key]
	if !ok {
		return ObjectInfo{}, ErrNotFound
	}
	return ObjectInfo{Key: key, ETag: o.etag, Size: int64(len(o.body)), LastModified: o.mod}, nil
}

func (m *Memory) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.objs, key)
	return nil
}

func (m *Memory) Info(context.Context) Info { return Info{Backend: "memory"} }

func (m *Memory) List(_ context.Context, prefix string) ([]ObjectInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []ObjectInfo{}
	for k, o := range m.objs {
		if strings.HasPrefix(k, prefix) {
			out = append(out, ObjectInfo{Key: k, ETag: o.etag, Size: int64(len(o.body)), LastModified: o.mod})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

func (m *Memory) PutBlob(_ context.Context, key string, body []byte, _ string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	sum := md5.Sum(append([]byte{byte(m.seq), byte(m.seq >> 8)}, body...))
	etag := `"` + hex.EncodeToString(sum[:]) + `"`
	m.objs[key] = memObj{body: append([]byte(nil), body...), etag: etag, mod: time.Now().UTC()}
	return etag, nil
}
