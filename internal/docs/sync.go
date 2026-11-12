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

// Notifier hears about syncs that changed something: not no-op runs, and
// not the first import (while no document was readable yet). It must not
// block for long.
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

// ErrConflict means the index kept changing under this sync (another copy
// of the app writing it) until the retries ran out.
var ErrConflict = errors.New("documents index changed by someone else; try the sync again")

// ErrNewerIndex means the index holds records from a newer build. This
// build doesn't write over them (it would drop what it doesn't know).
var ErrNewerIndex = errors.New("documents index was written by a newer version of the app; this one leaves it alone")

// runMemo keeps what a run has already done per file (key + ETag), so a
// redo after another writer's index update converts and summarises nothing
// twice, failures included.
type runMemo struct {
	converted map[string]convOutcome
	summaries map[string]string // "" = tried and failed
}

type convOutcome struct {
	doc Doc
	err error
}

func memoKey(key, etag string) string { return key + "|" + etag }

func (s *Syncer) run(ctx context.Context, reason string) (Sync, error) {
	memo := &runMemo{converted: map[string]convOutcome{}, summaries: map[string]string{}}
	var res Sync
	for attempt := 0; attempt <= MaxIndexRetries; attempt++ {
		ix, etag, err := s.load(ctx)
		if err != nil {
			return s.fail(Sync{Reason: reason}, err)
		}
		if newerThanThisBuild(ix) {
			return s.fail(Sync{Reason: reason}, ErrNewerIndex)
		}
		objs, err := s.Store.List(ctx, RawPrefix)
		if err != nil {
			return s.fail(Sync{Reason: reason}, err)
		}
		var changed []Doc
		var first bool
		res, changed, first = s.apply(ctx, ix, objs, reason, memo)
		body, err := ix.Encode(s.now())
		if err != nil {
			return s.fail(res, err)
		}
		newTag, err := s.Store.Put(ctx, IndexKey, body, etag)
		if errors.Is(err, objstore.ErrPrecondition) {
			s.Log.Info("documents index changed while syncing; redoing", "attempt", attempt+1)
			continue
		}
		if err != nil {
			return s.fail(res, err)
		}
		s.mu.Lock()
		s.current, s.etag = ix, newTag
		s.mu.Unlock()
		s.Log.Info("documents synced", "reason", reason, "added", res.Added, "changed", res.Changed,
			"removed", res.Removed, "failed", res.Failed, "skipped", res.Skipped, "refreshed", res.Refreshed, "firstImport", first)
		if res.Changes() && !first && s.Notify != nil {
			s.Notify.DocsChanged(ctx, res, changed)
		}
		return res, nil
	}
	return s.fail(res, ErrConflict)
}

// newerThanThisBuild reports whether any record was read by a newer
// ConvertVersion than this build's.
func newerThanThisBuild(ix *Index) bool {
	for _, d := range ix.Docs {
		if d.Version > ConvertVersion {
			return true
		}
	}
	return false
}

// apply brings ix in line with the listing of docs/raw/ and returns what
// changed. It writes per-document text but not the index.
func (s *Syncer) apply(ctx context.Context, ix *Index, objs []objstore.ObjectInfo, reason string, memo *runMemo) (Sync, []Doc, bool) {
	res := Sync{Reason: reason, At: s.now().UTC().Format(time.RFC3339)}
	var changed []Doc
	// First import: nothing was readable before (an empty index, or one
	// where every document failed, e.g. before poppler was installed).
	first := true
	for _, d := range ix.Docs {
		if d.Status == StatusOK {
			first = false
			break
		}
	}
	taken := map[string]string{}
	for _, d := range ix.Docs {
		taken[d.ID] = d.Key
	}
	byKey := ix.ByKey()
	seen := map[string]bool{}
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
		if known && d.Status == StatusOK && d.ETag == o.ETag && d.Version >= ConvertVersion {
			s.retrySummary(ctx, d, memo) // unchanged; a missing summary gets one try per run
			continue
		}
		s.update(ctx, d, o, res.At, memo, &res, &changed)
	}
	for i := range ix.Docs {
		d := &ix.Docs[i]
		if !seen[d.Key] && d.Status != StatusRemoved {
			d.Status, d.RemovedAt, d.Reason = StatusRemoved, res.At, ""
			if SkipReason(d.Key) == "" {
				res.Removed++
				changed = append(changed, *d)
			}
		}
	}
	ix.LastSync = &res
	return res, changed, first
}

// update reads a new, changed, failed, re-added or older-version document.
func (s *Syncer) update(ctx context.Context, d *Doc, o objstore.ObjectInfo, now string, memo *runMemo, res *Sync, changed *[]Doc) {
	wasOK := d.Status == StatusOK
	// Readable before (not counting a removal): decides changed vs added.
	readable := d.Pages > 0 && d.Status != StatusRemoved
	refresh := wasOK && d.ETag == o.ETag // same file, older reader
	k := memoKey(o.Key, o.ETag)
	out, done := memo.converted[k]
	if !done {
		nd := *d
		out = convOutcome{err: s.convert(ctx, &nd, o)}
		out.doc = nd
		memo.converted[k] = out
	}
	if out.err != nil {
		res.Failed++
		s.Log.Warn("document sync failed", "key", o.Key, "err", out.err, "keptPrevious", wasOK)
		if wasOK {
			// Keep the readable record; the next sync tries again. Say why
			// on the record so the admin sees which file it was.
			d.Error, d.ErrorAt = "couldn't read the new version: "+out.err.Error(), now
			return
		}
		d.Status, d.Reason, d.ETag, d.Size, d.SyncedAt = StatusFailed, out.err.Error(), o.ETag, o.Size, now
		d.Error, d.ErrorAt = out.err.Error(), now
		return
	}
	id := d.ID
	*d = out.doc
	d.ID, d.SyncedAt, d.RemovedAt, d.Version = id, now, "", ConvertVersion
	d.Error, d.ErrorAt = "", ""
	switch {
	case refresh:
		res.Refreshed++ // not announced
		return
	case readable:
		res.Changed++
	default:
		res.Added++
	}
	*changed = append(*changed, *d)
}

// retrySummary fills a missing summary of an unchanged document, once per
// run (the result is remembered across redone attempts).
func (s *Syncer) retrySummary(ctx context.Context, d *Doc, memo *runMemo) {
	if s.Summarise == nil || d.Summary != "" || d.Class == ClassScanned {
		return
	}
	k := memoKey(d.Key, d.ETag)
	if out, ok := memo.converted[k]; ok && out.err == nil && out.doc.Summary != "" {
		d.Summary = out.doc.Summary // bought while converting, earlier in this run
		return
	}
	sum, tried := memo.summaries[k]
	if !tried {
		if pt, err := s.PageText(ctx, *d); err == nil {
			sum = s.summarise(ctx, *d, pt.Pages)
		}
		memo.summaries[k] = sum
	}
	d.Summary = sum
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
	if o.Size > MaxPDFBytes {
		return fmt.Errorf("too large to read (%d MB; the limit is %d MB)", o.Size>>20, MaxPDFBytes>>20)
	}
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
		if Garbled(p.Text) {
			pages[i].Text, pages[i].Words = "", nil // unusable; keeps it out of search
		}
		info[i] = PageInfo{W: p.W, H: p.H, Chars: nonSpace(pages[i].Text)}
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
		d.Summary = s.summarise(ctx, *d, pages)
	}
	return nil
}

// summarise returns a summary from the first ~3000 characters of text, or
// "" when the model fails (tried again at the next sync).
func (s *Syncer) summarise(ctx context.Context, d Doc, pages []Page) string {
	sum, err := s.Summarise.Summarise(ctx, d, firstText(pages, 3000))
	if err != nil {
		s.Log.Warn("document summary failed", "key", d.Key, "err", err)
		return ""
	}
	return sum
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
