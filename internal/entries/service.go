package entries

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

const Key = "entries.json"

// MaxRetries is how many times a write is retried after losing an ETag race
// before the caller gets ErrConflict (HTTP 409).
const MaxRetries = 3

var (
	ErrConflict      = errors.New("someone else just changed the entries")
	ErrEntryNotFound = errors.New("no entry with that id")
)

// Actor is who made a change and through which channel (web, telegram).
type Actor struct {
	By      string
	Channel string
}

// Snapshot is the document as of one ETag. On the wire (GET /api/entries
// and every SSE event) the doc is sent as a View, without the journal.
type Snapshot struct {
	Doc  *Doc   `json:"-"`
	ETag string `json:"etag"`
}

type wireSnapshot struct {
	Doc  *View  `json:"doc"`
	ETag string `json:"etag"`
}

func (s Snapshot) MarshalJSON() ([]byte, error) {
	return json.Marshal(wireSnapshot{s.Doc.View(), s.ETag})
}

// UnmarshalJSON reads the wire form back; the journal is not on the wire,
// so Changes comes back empty.
func (s *Snapshot) UnmarshalJSON(b []byte) error {
	var w wireSnapshot
	if err := json.Unmarshal(b, &w); err != nil {
		return err
	}
	s.ETag, s.Doc = w.ETag, nil
	if w.Doc != nil {
		s.Doc = &Doc{Schema: w.Doc.Schema, Meta: w.Doc.Meta, Entries: w.Doc.Entries, Changes: []Change{}}
	}
	return nil
}

// Result is what a journaled write returns: the entries it touched, the
// journal records it added (their IDs are the undo handles), and the new
// snapshot.
type Result struct {
	Entries  []Entry
	Changes  []Change
	Snapshot Snapshot
}

// Service owns the in-memory copy of entries.json and is the only code that
// writes it. Reads are served from memory; Poll keeps memory in step with
// writes made elsewhere (a seed, a restore from a bucket version).
type Service struct {
	store objstore.Store
	log   *slog.Logger
	now   func() time.Time
	loc   *time.Location // for the done day (Completed); UTC until set

	writeMu sync.Mutex // one write at a time from this process

	mu     sync.RWMutex
	cur    *Doc
	etag   string
	subs   map[chan Snapshot]struct{}
	loaded bool
}

func NewService(store objstore.Store, log *slog.Logger) *Service {
	return &Service{store: store, log: log, now: time.Now, loc: time.UTC, subs: map[chan Snapshot]struct{}{}}
}

// SetLocation sets the time zone whose calendar day is recorded when an
// entry moves to done (the app's TZ).
func (s *Service) SetLocation(loc *time.Location) {
	if loc != nil {
		s.loc = loc
	}
}

func (s *Service) today() string { return s.now().In(s.loc).Format("2006-01-02") }

// SetClock replaces the time source (tests).
func (s *Service) SetClock(now func() time.Time) { s.now = now }

// Load reads entries.json, creating an empty one on first run.
func (s *Service) Load(ctx context.Context) error {
	d, etag, err := s.read(ctx)
	if errors.Is(err, objstore.ErrNotFound) {
		d = Empty()
		body, _ := json.Marshal(d)
		etag, err = s.store.Put(ctx, Key, body, "")
		if errors.Is(err, objstore.ErrPrecondition) {
			// Another writer created it first; use theirs.
			d, etag, err = s.read(ctx)
		} else if err == nil {
			s.log.Info("created empty entries document", "key", Key)
		}
	}
	if err != nil {
		return err
	}
	s.set(d, etag)
	return nil
}

func (s *Service) read(ctx context.Context) (*Doc, string, error) {
	body, etag, err := s.store.Get(ctx, Key)
	if err != nil {
		return nil, "", err
	}
	d, err := Decode(body)
	if err != nil {
		return nil, "", err
	}
	return d, etag, nil
}

func (s *Service) set(d *Doc, etag string) {
	s.mu.Lock()
	changed := etag != s.etag
	s.cur, s.etag, s.loaded = d, etag, true
	snap := Snapshot{Doc: d, ETag: etag}
	if changed {
		for ch := range s.subs {
			sendLatest(ch, snap)
		}
	}
	s.mu.Unlock()
}

// sendLatest never blocks: a slow subscriber only ever needs the newest doc.
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

// Current returns the cached document. Callers must not modify it.
func (s *Service) Current(ctx context.Context) (Snapshot, error) {
	s.mu.RLock()
	loaded := s.loaded
	snap := Snapshot{Doc: s.cur, ETag: s.etag}
	s.mu.RUnlock()
	if loaded {
		return snap, nil
	}
	if err := s.Load(ctx); err != nil {
		return Snapshot{}, err
	}
	return s.Current(ctx)
}

// Refresh does a HEAD and re-reads the document only if its ETag moved.
// It skips when a write is running: the write leaves the cache current, and
// a read finishing after it would put an older document back.
func (s *Service) Refresh(ctx context.Context) error {
	if !s.writeMu.TryLock() {
		return nil
	}
	defer s.writeMu.Unlock()
	st, err := s.store.Stat(ctx, Key)
	if err != nil {
		return err
	}
	etag := st.ETag
	s.mu.RLock()
	same := etag == s.etag
	s.mu.RUnlock()
	if same {
		return nil
	}
	d, etag, err := s.read(ctx)
	if err != nil {
		return err
	}
	s.set(d, etag)
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
				s.log.Warn("entries refresh failed", "err", err)
			}
		}
	}
}

// Subscribe returns a channel that receives the document after every change.
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

// mutate is the write path: apply fn to a copy of the document, PUT it with
// If-Match, and on a lost race re-read and re-apply up to MaxRetries times.
// fn must be safe to call more than once.
func (s *Service) mutate(ctx context.Context, fn func(d *Doc) error) (Snapshot, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	snap, err := s.Current(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	base, etag := snap.Doc, snap.ETag
	for attempt := 0; ; attempt++ {
		d := base.Clone()
		if err := fn(d); err != nil {
			return Snapshot{}, err
		}
		body, err := json.Marshal(d)
		if err != nil {
			return Snapshot{}, err
		}
		newTag, err := s.store.Put(ctx, Key, body, etag)
		if err == nil {
			s.set(d, newTag)
			return Snapshot{Doc: d, ETag: newTag}, nil
		}
		if !errors.Is(err, objstore.ErrPrecondition) {
			return Snapshot{}, err
		}
		if attempt >= MaxRetries {
			s.log.Warn("write gave up after ETag conflicts", "attempts", attempt+1)
			return Snapshot{}, ErrConflict
		}
		s.log.Info("ETag conflict, re-reading entries", "attempt", attempt+1)
		if base, etag, err = s.read(ctx); err != nil {
			return Snapshot{}, err
		}
		s.set(base, etag)
	}
}

func (s *Service) stamp() string { return s.now().UTC().Format(time.RFC3339) }

// Create adds new entries. Each patch must include a title; a missing kind
// means note.
func (s *Service) Create(ctx context.Context, a Actor, patches []Patch) (Result, error) {
	var res Result
	snap, err := s.mutate(ctx, func(d *Doc) error {
		res = Result{}
		for _, p := range patches {
			if _, ok := p["title"]; !ok {
				return invalid("title is required")
			}
			now := s.stamp()
			e := NewEntry("")
			e.ID, e.Created, e.Updated, e.By, e.Channel = ulid.Make().String(), now, now, a.By, a.Channel
			if err := p.Apply(&e); err != nil {
				return err
			}
			if err := settleCompleted(nil, &e, p, s.today()); err != nil {
				return err
			}
			d.Entries = append(d.Entries, e)
			res.Entries = append(res.Entries, e)
			res.Changes = append(res.Changes, s.record(d, a, "create", e.ID, nil, &e))
		}
		return nil
	})
	res.Snapshot = snap
	return res, err
}

// Update changes fields of one entry.
func (s *Service) Update(ctx context.Context, a Actor, id string, p Patch) (Result, error) {
	var res Result
	snap, err := s.mutate(ctx, func(d *Doc) error {
		res = Result{}
		i := d.find(id)
		if i < 0 {
			return fmt.Errorf("%w: %s", ErrEntryNotFound, id)
		}
		before, e := d.Entries[i], d.Entries[i] // value copies; see Entry
		if err := p.Apply(&e); err != nil {
			return err
		}
		if err := settleCompleted(&before, &e, p, s.today()); err != nil {
			return err
		}
		e.Updated, e.By, e.Channel = s.stamp(), a.By, a.Channel
		d.Entries[i] = e
		res.Entries = []Entry{e}
		res.Changes = []Change{s.record(d, a, "update", id, &before, &e)}
		return nil
	})
	res.Snapshot = snap
	return res, err
}

// Delete removes an entry. The journal keeps a copy, so it can be undone
// while the change is still in the journal; after that, bucket versioning
// is the only way back.
func (s *Service) Delete(ctx context.Context, a Actor, id string) (Result, error) {
	var res Result
	snap, err := s.mutate(ctx, func(d *Doc) error {
		res = Result{}
		i := d.find(id)
		if i < 0 {
			return fmt.Errorf("%w: %s", ErrEntryNotFound, id)
		}
		before := d.Entries[i]
		d.Entries = append(d.Entries[:i], d.Entries[i+1:]...)
		res.Entries = []Entry{before}
		res.Changes = []Change{s.record(d, a, "delete", id, &before, nil)}
		return nil
	})
	res.Snapshot = snap
	return res, err
}

// SetMeta changes the move-in and/or key collection date. Not journaled.
func (s *Service) SetMeta(ctx context.Context, mp MetaPatch) (Snapshot, error) {
	return s.mutate(ctx, func(d *Doc) error { return mp.Apply(&d.Meta) })
}

// Replace overwrites the whole document (seed). It still goes through the
// ETag check so it cannot silently clobber a concurrent edit.
func (s *Service) Replace(ctx context.Context, nd *Doc) (Snapshot, error) {
	return s.mutate(ctx, func(d *Doc) error {
		*d = *nd.Clone()
		return nil
	})
}
