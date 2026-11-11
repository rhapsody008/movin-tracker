package docs_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/docs"
	"github.com/rhapsody008/movin-tracker/internal/docs/convert"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/testutil"
)

const (
	manual  = "docs/raw/4.0 Manuals/Fridge.pdf"
	drawing = "docs/raw/1.0 Plans/1.3 Power.pdf"
	junk    = "docs/raw/1.0 Plans/._1.3 Power.pdf"
	video   = "docs/raw/5.0 Vouchers/5.1 Video.mp4"
)

func a4(text string) docs.Page { return docs.Page{W: 595, H: 842, Text: text} }

var long = strings.Repeat("Defrost the freezer every six months. Keep the door seal clean with warm soapy water. ", 3)

type notes struct {
	mu    sync.Mutex
	calls []docs.Sync
	docs  [][]docs.Doc
}

func (n *notes) DocsChanged(_ context.Context, r docs.Sync, d []docs.Doc) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.calls = append(n.calls, r)
	n.docs = append(n.docs, d)
}

func (n *notes) count() int { n.mu.Lock(); defer n.mu.Unlock(); return len(n.calls) }

type rig struct {
	store *objstore.Memory
	conv  *convert.Fake
	notes *notes
	sync  *docs.Syncer
}

func newRig(t *testing.T) *rig {
	store := objstore.NewMemory()
	conv := &convert.Fake{Pages: map[string][]docs.Page{
		"pdf-manual-v1":  {a4(long), a4(long)},
		"pdf-manual-v2":  {a4(long + "Version two."), a4(long)},
		"pdf-drawing-v1": {{W: 2384, H: 1684, Text: "POWER LEGEND " + long, Words: []docs.Word{{T: "DB", Box: [4]float64{100, 900, 120, 910}}}}},
	}, Fail: map[string]error{}}
	n := &notes{}
	r := &rig{store: store, conv: conv, notes: n, sync: &docs.Syncer{Store: store, Conv: conv, Notify: n, Log: testutil.Logger(nil),
		Now: func() time.Time { return time.Date(2026, 11, 11, 3, 0, 0, 0, time.UTC) }}}
	return r
}

func (r *rig) put(t *testing.T, key, body string) {
	if _, err := r.store.PutBlob(context.Background(), key, []byte(body), "application/pdf"); err != nil {
		t.Fatal(err)
	}
}

func (r *rig) run(t *testing.T) docs.Sync {
	t.Helper()
	res, err := r.sync.Sync(context.Background(), "test")
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func (r *rig) doc(t *testing.T, key string) docs.Doc {
	t.Helper()
	ix, err := r.sync.Index(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range ix.Docs {
		if d.Key == key {
			return d
		}
	}
	t.Fatalf("%s not in the index", key)
	return docs.Doc{}
}

func TestSyncLifecycle(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	r.put(t, manual, "pdf-manual-v1")
	r.put(t, drawing, "pdf-drawing-v1")
	r.put(t, junk, "apple double")
	r.put(t, video, "mp4")

	// First import: two documents read, two skipped, nobody notified.
	res := r.run(t)
	if res.Added != 2 || res.Skipped != 2 || res.Failed != 0 || res.Removed != 0 || r.notes.count() != 0 {
		t.Fatalf("first import %+v, notes %d", res, r.notes.count())
	}
	m := r.doc(t, manual)
	if m.Status != docs.StatusOK || m.Class != docs.ClassText || m.Pages != 2 || m.TextPages != 2 || m.ID == "" {
		t.Fatalf("manual %+v", m)
	}
	if d := r.doc(t, drawing); d.Class != docs.ClassDrawing {
		t.Fatalf("drawing %+v", d)
	}
	if j := r.doc(t, junk); j.Status != docs.StatusSkipped || j.Reason == "" {
		t.Fatalf("junk %+v", j)
	}
	pt, err := r.sync.PageText(ctx, r.doc(t, drawing))
	if err != nil || len(pt.Pages) != 1 || pt.Pages[0].Words[0].T != "DB" || pt.Key != drawing {
		t.Fatalf("page text %+v %v", pt, err)
	}
	calls := r.conv.CallCount()

	// Nothing changed: no conversions, no notes.
	if res := r.run(t); res.Changes() || res.Skipped != 0 || r.conv.CallCount() != calls || r.notes.count() != 0 {
		t.Fatalf("idempotent run %+v (calls %d→%d)", res, calls, r.conv.CallCount())
	}

	// A new version: changed, one note with that document.
	r.put(t, manual, "pdf-manual-v2")
	if res := r.run(t); res.Changed != 1 || r.notes.count() != 1 || r.notes.docs[0][0].Key != manual {
		t.Fatalf("changed %+v notes %+v", res, r.notes.docs)
	}
	id := r.doc(t, manual).ID
	if id != m.ID {
		t.Fatalf("id changed %s → %s", m.ID, id)
	}

	// Deleted from the bucket: kept as removed, noted.
	r.store.Delete(ctx, manual)
	if res := r.run(t); res.Removed != 1 || r.doc(t, manual).Status != docs.StatusRemoved || r.notes.count() != 2 {
		t.Fatalf("removed %+v", res)
	}
	// Uploaded again: back, same id.
	r.put(t, manual, "pdf-manual-v1")
	if res := r.run(t); res.Added != 1 || r.doc(t, manual).Status != docs.StatusOK || r.doc(t, manual).ID != id {
		t.Fatalf("re-added %+v %+v", res, r.doc(t, manual))
	}
}

func TestSyncFailureIsRetried(t *testing.T) {
	r := newRig(t)
	r.put(t, manual, "pdf-manual-v1")
	r.conv.Fail["pdf-manual-v1"] = errors.New("pdftotext: broken file")
	if res := r.run(t); res.Failed != 1 || r.doc(t, manual).Status != docs.StatusFailed || r.doc(t, manual).Reason != "pdftotext: broken file" {
		t.Fatalf("failed %+v %+v", res, r.doc(t, manual))
	}
	delete(r.conv.Fail, "pdf-manual-v1")
	if res := r.run(t); res.Added != 1 || r.doc(t, manual).Status != docs.StatusOK {
		t.Fatalf("retry %+v", res)
	}
}

func TestSyncIsSingleFlight(t *testing.T) {
	r := newRig(t)
	r.put(t, manual, "pdf-manual-v1")
	r.put(t, drawing, "pdf-drawing-v1")
	r.conv.Delay = 100 * time.Millisecond
	var wg sync.WaitGroup
	results := make([]docs.Sync, 4)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], _ = r.sync.Sync(context.Background(), "web")
		}(i)
	}
	wg.Wait()
	if r.conv.CallCount() != 2 {
		t.Fatalf("converter called %d times for 2 documents", r.conv.CallCount())
	}
	for _, res := range results {
		if res.Added != 2 {
			t.Fatalf("joined caller got %+v", res)
		}
	}
}

// Another writer saves the index between our read and our write: we redo
// the run on top of theirs, keep their document, and don't convert ours twice.
type racingStore struct {
	*objstore.Memory
	once  sync.Once
	sneak func()
}

func (s *racingStore) Put(ctx context.Context, key string, body []byte, ifMatch string) (string, error) {
	if key == docs.IndexKey {
		s.once.Do(s.sneak)
	}
	return s.Memory.Put(ctx, key, body, ifMatch)
}

func TestSyncRedoesAfterAnotherWriter(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	other := "docs/raw/other.pdf"
	r.put(t, manual, "pdf-manual-v1")
	r.put(t, other, "pdf-other")
	otherInfo, _ := r.store.Stat(ctx, other)
	rs := &racingStore{Memory: r.store}
	rs.sneak = func() {
		theirs := &docs.Index{Docs: []docs.Doc{{ID: "abc12345", Key: other, ETag: otherInfo.ETag, Status: docs.StatusOK, Class: docs.ClassText, Pages: 1, Summary: "theirs", Version: docs.ConvertVersion}}}
		b, _ := theirs.Encode(time.Now())
		if _, err := r.store.Put(ctx, docs.IndexKey, b, ""); err != nil {
			t.Error(err)
		}
	}
	s := &docs.Syncer{Store: rs, Conv: r.conv, Log: testutil.Logger(nil)}
	res, err := s.Sync(ctx, "test")
	if err != nil {
		t.Fatal(err)
	}
	if r.conv.CallCount() != 2 { // manual + other in the first attempt; nothing again after the redo
		t.Fatalf("converter calls %d", r.conv.CallCount())
	}
	body, _, _ := r.store.Get(ctx, docs.IndexKey)
	var ix docs.Index
	json.Unmarshal(body, &ix)
	if len(ix.Docs) != 2 || res.Added != 1 {
		t.Fatalf("index after redo: %+v, res %+v", ix.Docs, res)
	}
	for _, d := range ix.Docs {
		if d.Key == other && (d.Summary != "theirs" || d.ID != "abc12345") {
			t.Fatalf("their document was overwritten: %+v", d)
		}
	}
}

// A first sync where everything failed (no poppler yet) and the fixed one
// after it are both the first import: no notice for the whole library.
func TestFailedThenFixedImportStaysSilent(t *testing.T) {
	r := newRig(t)
	r.put(t, manual, "pdf-manual-v1")
	r.put(t, drawing, "pdf-drawing-v1")
	r.conv.Fail["pdf-manual-v1"] = errors.New("pdfinfo: not installed")
	r.conv.Fail["pdf-drawing-v1"] = errors.New("pdfinfo: not installed")
	if res := r.run(t); res.Failed != 2 || r.notes.count() != 0 {
		t.Fatalf("all failed: %+v", res)
	}
	r.conv.Fail = map[string]error{}
	if res := r.run(t); res.Added != 2 || r.notes.count() != 0 {
		t.Fatalf("fixed import: %+v, notes %d", res, r.notes.count())
	}
	// From now on changes are announced.
	r.put(t, manual, "pdf-manual-v2")
	if res := r.run(t); res.Changed != 1 || r.notes.count() != 1 {
		t.Fatalf("later change: %+v, notes %d", res, r.notes.count())
	}
}

// Documents read by an older ConvertVersion are read again, counted as
// refreshed, and not announced.
func TestOlderVersionIsRefreshedQuietly(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	r.put(t, manual, "pdf-manual-v1")
	r.put(t, drawing, "pdf-drawing-v1")
	r.run(t)
	// Pretend the index was written by an older build.
	ix, _ := r.sync.Index(ctx)
	for i := range ix.Docs {
		ix.Docs[i].Version = docs.ConvertVersion - 1
	}
	b, _ := ix.Encode(time.Now())
	_, etag, _ := r.store.Get(ctx, docs.IndexKey)
	if _, err := r.store.Put(ctx, docs.IndexKey, b, etag); err != nil {
		t.Fatal(err)
	}
	calls := r.conv.CallCount()
	res := r.run(t)
	if res.Refreshed != 2 || res.Changes() || r.conv.CallCount() != calls+2 || r.notes.count() != 0 {
		t.Fatalf("refresh %+v (calls +%d, notes %d)", res, r.conv.CallCount()-calls, r.notes.count())
	}
	if d := r.doc(t, manual); d.Version != docs.ConvertVersion {
		t.Fatalf("version %d", d.Version)
	}
	if res := r.run(t); res.Refreshed != 0 || r.conv.CallCount() != calls+2 {
		t.Fatalf("second run refreshed again: %+v", res)
	}
}
