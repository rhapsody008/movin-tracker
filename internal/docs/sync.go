package docs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/objstore"
)

// Store is what the documents feature needs from the bucket.
type Store interface {
	objstore.Store
	objstore.Blobs
}

// Converter is what a sync needs from internal/docs/convert (an interface
// here so this package doesn't import it).
type Converter interface {
	Text(ctx context.Context, pdf []byte) ([]Page, error)
}

// Notifier hears about syncs that changed something (not the first import,
// not no-op runs). It must not block for long.
type Notifier interface {
	DocsChanged(ctx context.Context, result Sync, changed []Doc)
}

// Summariser writes a document's one-line summary from its first text
// (step 1.5.9). A nil Summariser leaves summaries empty.
type Summariser interface {
	Summarise(ctx context.Context, d Doc, text string) (string, error)
}

// Syncer brings docs/index.json and docs/text/ in line with docs/raw/.
type Syncer struct {
	Store     Store
	Conv      Converter
	Notify    Notifier   // may be nil
	Summarise Summariser // may be nil
	Log       *slog.Logger
	Now       func() time.Time

	mu      sync.Mutex
	running *flight
	current *Index // the last index read or written
	etag    string
	subs    []chan struct{}
}

type flight struct {
	done chan struct{}
	res  Sync
	err  error
}

// MaxIndexRetries is how often a sync re-reads and redoes its index write
// after another writer got there first.
const MaxIndexRetries = 3

func (s *Syncer) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Sync runs one sync. If one is already running, it waits for that one and
// returns its result instead of starting another.
func (s *Syncer) Sync(ctx context.Context, reason string) (Sync, error) {
	s.mu.Lock()
	if f := s.running; f != nil {
		s.mu.Unlock()
		select {
		case <-f.done:
			return f.res, f.err
		case <-ctx.Done():
			return Sync{}, ctx.Err()
		}
	}
	f := &flight{done: make(chan struct{})}
	s.running = f
	s.mu.Unlock()

	f.res, f.err = s.run(ctx, reason)

	s.mu.Lock()
	s.running = nil
	subs := append([]chan struct{}(nil), s.subs...)
	s.mu.Unlock()
	close(f.done)
	for _, c := range subs {
		select {
		case c <- struct{}{}:
		default:
		}
	}
	return f.res, f.err
}

// Running reports whether a sync is in progress.
func (s *Syncer) Running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.running != nil
}

// Subscribe returns a channel that gets a value after every sync, and a
// cancel function.
func (s *Syncer) Subscribe() (<-chan struct{}, func()) {
	c := make(chan struct{}, 1)
	s.mu.Lock()
	s.subs = append(s.subs, c)
	s.mu.Unlock()
	return c, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		for i, x := range s.subs {
			if x == c {
				s.subs = append(s.subs[:i], s.subs[i+1:]...)
				return
			}
		}
	}
}

// Index returns the documents index, reading it from the bucket when this
// process hasn't seen it yet. It never fails for a missing index.
func (s *Syncer) Index(ctx context.Context) (*Index, error) {
	s.mu.Lock()
	cur := s.current
	s.mu.Unlock()
	if cur != nil {
		return cur, nil
	}
	ix, etag, err := s.load(ctx)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if s.current == nil {
		s.current, s.etag = ix, etag
	}
	cur = s.current
	s.mu.Unlock()
	return cur, nil
}

// Refresh re-reads the index if it changed in the bucket (another replica
// or a manual edit). Cheap when nothing changed.
func (s *Syncer) Refresh(ctx context.Context) error {
	info, err := s.Store.Stat(ctx, IndexKey)
	if errors.Is(err, objstore.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	s.mu.Lock()
	same := info.ETag == s.etag && s.current != nil
	s.mu.Unlock()
	if same {
		return nil
	}
	ix, etag, err := s.load(ctx)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.current, s.etag = ix, etag
	s.mu.Unlock()
	return nil
}

func (s *Syncer) load(ctx context.Context) (*Index, string, error) {
	body, etag, err := s.Store.Get(ctx, IndexKey)
	if errors.Is(err, objstore.ErrNotFound) {
		ix, _ := Decode(nil)
		return ix, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	ix, err := Decode(body)
	return ix, etag, err
}

// PageText reads a document's per-page text.
func (s *Syncer) PageText(ctx context.Context, d Doc) (*PageText, error) {
	body, _, err := s.Store.Get(ctx, d.TextKey())
	if err != nil {
		return nil, err
	}
	var pt PageText
	if err := json.Unmarshal(body, &pt); err != nil {
		return nil, fmt.Errorf("decode %s: %w", d.TextKey(), err)
	}
	return &pt, nil
}

func (s *Syncer) run(ctx context.Context, reason string) (Sync, error) {
	res := Sync{Reason: reason}
	var changedDocs []Doc
	done := map[string]Doc{} // documents converted in this run, reused if the index write is redone
	var firstImport bool
	for attempt := 0; ; attempt++ {
		ix, etag, err := s.load(ctx)
		if err != nil {
			return s.fail(res, err)
		}
		firstImport = len(ix.Docs) == 0
		objs, err := s.Store.List(ctx, RawPrefix)
		if err != nil {
			return s.fail(res, err)
		}
		res = Sync{Reason: reason}
		changedDocs = changedDocs[:0]
		byKey := ix.ByKey()
		taken := map[string]string{}
		for _, d := range ix.Docs {
			taken[d.ID] = d.Key
		}
		seen := map[string]bool{}
		now := s.now().UTC().Format(time.RFC3339)
		for _, o := range objs {
			seen[o.Key] = true
			d, known := byKey[o.Key]
			if !known {
				id := AssignID(o.Key, taken)
				taken[id] = o.Key
				ix.Docs = append(ix.Docs, Doc{ID: id, Key: o.Key})
				byKey = ix.ByKey() // the append may have moved the slice
				d = byKey[o.Key]
			}
			if why := SkipReason(o.Key); why != "" {
				if d.Status != StatusSkipped || d.ETag != o.ETag {
					res.Skipped++
				}
				d.Status, d.Reason, d.ETag, d.Size, d.RemovedAt = StatusSkipped, why, o.ETag, o.Size, ""
				continue
			}
			if known && d.Status == StatusOK && d.ETag == o.ETag {
				continue // unchanged
			}
			wasOK := known && d.Status == StatusOK
			if c, ok := done[o.Key]; ok && c.ETag == o.ETag {
				id := d.ID // converted in an earlier attempt of this run
				*d = c
				d.ID = id
			} else if err := s.convert(ctx, d, o); err != nil {
				d.Status, d.Reason, d.ETag, d.Size, d.SyncedAt = StatusFailed, err.Error(), o.ETag, o.Size, now
				res.Failed++
				s.Log.Warn("document sync failed", "key", o.Key, "err", err)
				continue
			}
			d.SyncedAt, d.RemovedAt = now, ""
			done[o.Key] = *d
			if wasOK {
				res.Changed++
			} else {
				res.Added++
			}
			changedDocs = append(changedDocs, *d)
		}
		for i := range ix.Docs {
			d := &ix.Docs[i]
			if !seen[d.Key] && d.Status != StatusRemoved {
				d.Status, d.RemovedAt, d.Reason = StatusRemoved, now, ""
				if SkipReason(d.Key) == "" {
					res.Removed++
					changedDocs = append(changedDocs, *d)
				}
			}
		}
		res.At = now
		ix.LastSync = &res
		body, err := ix.Encode(s.now())
		if err != nil {
			return s.fail(res, err)
		}
		newTag, err := s.Store.Put(ctx, IndexKey, body, etag)
		if errors.Is(err, objstore.ErrPrecondition) && attempt < MaxIndexRetries {
			s.Log.Info("documents index changed while syncing; redoing", "attempt", attempt+1)
			continue
		}
		if err != nil {
			return s.fail(res, err)
		}
		s.mu.Lock()
		s.current, s.etag = ix, newTag
		s.mu.Unlock()
		break
	}
	s.Log.Info("documents synced", "reason", reason, "added", res.Added, "changed", res.Changed,
		"removed", res.Removed, "failed", res.Failed, "skipped", res.Skipped, "firstImport", firstImport)
	if res.Changes() && !firstImport && s.Notify != nil {
		s.Notify.DocsChanged(ctx, res, changedDocs)
	}
	return res, nil
}

func (s *Syncer) fail(res Sync, err error) (Sync, error) {
	res.Error = err.Error()
	res.At = s.now().UTC().Format(time.RFC3339)
	s.Log.Warn("documents sync failed", "err", err)
	return res, err
}

// convert reads one PDF, extracts its pages, stores their text and fills
// the document's fields. The summary is redone when a Summariser is set.
func (s *Syncer) convert(ctx context.Context, d *Doc, o objstore.ObjectInfo) error {
	pdf, etag, err := s.Store.Get(ctx, o.Key)
	if err != nil {
		return fmt.Errorf("read: %w", err)
	}
	pages, err := s.Conv.Text(ctx, pdf)
	if err != nil {
		return err
	}
	info := make([]PageInfo, len(pages))
	for i, p := range pages {
		info[i] = PageInfo{W: p.W, H: p.H, Chars: nonSpace(p.Text)}
	}
	class, textPages := Classify(info)
	body, err := json.Marshal(PageText{Key: o.Key, ETag: etag, Pages: pages})
	if err != nil {
		return err
	}
	if _, err := s.Store.PutBlob(ctx, TextKeyFor(o.Key), body, "application/json"); err != nil {
		return fmt.Errorf("write text: %w", err)
	}
	d.ETag, d.Size, d.Pages, d.Class, d.TextPages = etag, o.Size, len(pages), class, textPages
	d.Status, d.Reason, d.Summary = StatusOK, "", ""
	if s.Summarise != nil && class != ClassScanned {
		if sum, err := s.Summarise.Summarise(ctx, *d, firstText(pages, 3000)); err == nil {
			d.Summary = sum
		} else {
			s.Log.Warn("document summary failed", "key", o.Key, "err", err)
		}
	}
	return nil
}

func nonSpace(s string) int {
	n := 0
	for _, r := range s {
		if r != ' ' && r != '\n' && r != '\t' && r != '\r' && r != '\f' {
			n++
		}
	}
	return n
}

// firstText returns up to max characters of the document's text, from the
// first pages on.
func firstText(pages []Page, max int) string {
	var b []rune
	for _, p := range pages {
		if len(b) >= max {
			break
		}
		b = append(b, []rune(p.Text+"\n")...)
	}
	if len(b) > max {
		b = b[:max]
	}
	return string(b)
}
