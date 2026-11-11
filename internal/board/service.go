package board

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/rhapsody008/movin-tracker/internal/objstore"
)

const Key = "board.json"

// MaxRetries is how many times a write is retried after losing an ETag race
// before the caller gets ErrConflict (HTTP 409).
const MaxRetries = 3

var (
	ErrConflict     = errors.New("someone else just changed the board")
	ErrItemNotFound = errors.New("no item with that id")
)

// Snapshot is the board as of one ETag. It is what GET /api/board returns
// and what every SSE event carries.
type Snapshot struct {
	Board *Board `json:"board"`
	ETag  string `json:"etag"`
}

// Service owns the in-memory copy of board.json and is the only code that
// writes it. Reads are served from memory; Poll keeps memory in step with
// writes made elsewhere (another replica, a seed, a restore from a version).
type Service struct {
	store objstore.Store
	log   *slog.Logger
	now   func() time.Time

	writeMu sync.Mutex // one write at a time from this process

	mu     sync.RWMutex
	cur    *Board
	etag   string
	subs   map[chan Snapshot]struct{}
	loaded bool
}

func NewService(store objstore.Store, log *slog.Logger) *Service {
	return &Service{store: store, log: log, now: time.Now, subs: map[chan Snapshot]struct{}{}}
}

// Load reads board.json, creating an empty one on first run.
func (s *Service) Load(ctx context.Context) error {
	b, etag, err := s.read(ctx)
	if errors.Is(err, objstore.ErrNotFound) {
		b = Empty()
		body, _ := json.Marshal(b)
		etag, err = s.store.Put(ctx, Key, body, "")
		if errors.Is(err, objstore.ErrPrecondition) {
			// Another writer created it first; use theirs.
			b, etag, err = s.read(ctx)
		} else if err == nil {
			s.log.Info("created empty board", "key", Key)
		}
	}
	if err != nil {
		return err
	}
	s.set(b, etag)
	return nil
}

func (s *Service) read(ctx context.Context) (*Board, string, error) {
	body, etag, err := s.store.Get(ctx, Key)
	if err != nil {
		return nil, "", err
	}
	b, err := Decode(body)
	if err != nil {
		return nil, "", err
	}
	return b, etag, nil
}

func (s *Service) set(b *Board, etag string) {
	s.mu.Lock()
	changed := etag != s.etag
	s.cur, s.etag, s.loaded = b, etag, true
	snap := Snapshot{Board: b, ETag: etag}
	if changed {
		for ch := range s.subs {
			sendLatest(ch, snap)
		}
	}
	s.mu.Unlock()
}

// sendLatest never blocks: a slow subscriber only ever needs the newest board.
func sendLatest(ch chan Snapshot, snap Snapshot) {
	for {
		select {
		case ch <- snap:
			return
		default:
			select {
			case <-ch:
			default:
			}
		}
	}
}

// Current returns the cached board. Callers must not modify it.
func (s *Service) Current(ctx context.Context) (Snapshot, error) {
	s.mu.RLock()
	loaded := s.loaded
	snap := Snapshot{Board: s.cur, ETag: s.etag}
	s.mu.RUnlock()
	if loaded {
		return snap, nil
	}
	if err := s.Load(ctx); err != nil {
		return Snapshot{}, err
	}
	return s.Current(ctx)
}

// Refresh does a HEAD and re-reads the board only if its ETag moved.
func (s *Service) Refresh(ctx context.Context) error {
	etag, err := s.store.Head(ctx, Key)
	if err != nil {
		return err
	}
	s.mu.RLock()
	same := etag == s.etag
	s.mu.RUnlock()
	if same {
		return nil
	}
	b, etag, err := s.read(ctx)
	if err != nil {
		return err
	}
	s.set(b, etag)
	return nil
}

// Poll calls Refresh every interval until ctx ends.
func (s *Service) Poll(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.Refresh(ctx); err != nil && ctx.Err() == nil {
				s.log.Warn("board refresh failed", "err", err)
			}
		}
	}
}

// Subscribe returns a channel that receives the board after every change.
func (s *Service) Subscribe() (<-chan Snapshot, func()) {
	ch := make(chan Snapshot, 1)
	s.mu.Lock()
	s.subs[ch] = struct{}{}
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		delete(s.subs, ch)
		s.mu.Unlock()
	}
}

// mutate is the write path: apply fn to a copy of the board, PUT it with
// If-Match, and on a lost race re-read and re-apply up to MaxRetries times.
func (s *Service) mutate(ctx context.Context, fn func(b *Board) error) (Snapshot, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	snap, err := s.Current(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	base, etag := snap.Board, snap.ETag
	for attempt := 0; ; attempt++ {
		b := base.Clone()
		if err := fn(b); err != nil {
			return Snapshot{}, err
		}
		body, err := json.Marshal(b)
		if err != nil {
			return Snapshot{}, err
		}
		newTag, err := s.store.Put(ctx, Key, body, etag)
		if err == nil {
			s.set(b, newTag)
			return Snapshot{Board: b, ETag: newTag}, nil
		}
		if !errors.Is(err, objstore.ErrPrecondition) {
			return Snapshot{}, err
		}
		if attempt >= MaxRetries {
			s.log.Warn("write gave up after ETag conflicts", "attempts", attempt+1)
			return Snapshot{}, ErrConflict
		}
		s.log.Info("ETag conflict, re-reading board", "attempt", attempt+1)
		if base, etag, err = s.read(ctx); err != nil {
			return Snapshot{}, err
		}
		s.set(base, etag)
	}
}

func (s *Service) stamp() string { return s.now().UTC().Format(time.RFC3339) }

// Create adds new items. Each patch must include a title.
func (s *Service) Create(ctx context.Context, by string, patches []Patch) ([]Item, Snapshot, error) {
	var created []Item
	snap, err := s.mutate(ctx, func(b *Board) error {
		created = created[:0]
		for _, p := range patches {
			if _, ok := p["title"]; !ok {
				return invalid("title is required")
			}
			now := s.stamp()
			it := Item{ID: ulid.Make().String(), Cat: "admin", Status: "todo", Created: now, Updated: now, By: by}
			if err := p.Apply(&it); err != nil {
				return err
			}
			b.Items = append(b.Items, it)
			created = append(created, it)
		}
		return nil
	})
	return created, snap, err
}

// Update changes fields of one item.
func (s *Service) Update(ctx context.Context, by, id string, p Patch) (Item, Snapshot, error) {
	var out Item
	snap, err := s.mutate(ctx, func(b *Board) error {
		i := b.find(id)
		if i < 0 {
			return fmt.Errorf("%w: %s", ErrItemNotFound, id)
		}
		it := b.Items[i]
		if err := p.Apply(&it); err != nil {
			return err
		}
		it.Updated, it.By = s.stamp(), by
		b.Items[i] = it
		out = it
		return nil
	})
	return out, snap, err
}

// Delete removes an item for good. Bucket versioning is the only way back.
func (s *Service) Delete(ctx context.Context, id string) (Item, Snapshot, error) {
	var out Item
	snap, err := s.mutate(ctx, func(b *Board) error {
		i := b.find(id)
		if i < 0 {
			return fmt.Errorf("%w: %s", ErrItemNotFound, id)
		}
		out = b.Items[i]
		b.Items = append(b.Items[:i], b.Items[i+1:]...)
		return nil
	})
	return out, snap, err
}

// SetMeta changes the move-in and/or key collection date.
func (s *Service) SetMeta(ctx context.Context, mp MetaPatch) (Snapshot, error) {
	return s.mutate(ctx, func(b *Board) error { return mp.Apply(&b.Meta) })
}

// Replace overwrites the whole board (seed and import). It still goes
// through the ETag check so it cannot silently clobber a concurrent edit.
func (s *Service) Replace(ctx context.Context, nb *Board) (Snapshot, error) {
	return s.mutate(ctx, func(b *Board) error {
		*b = *nb.Clone()
		return nil
	})
}
