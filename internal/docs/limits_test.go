package docs_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/docs"
)

// A PDF over MaxPDFBytes is never read into memory: sync records it as
// failed with the reason, and a document that grew past it can't be viewed.
func TestPDFSizeLimit(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	big := strings.Repeat("x", docs.MaxPDFBytes+1)
	r.conv.Pages[big] = []docs.Page{{N: 1, W: 595, H: 842, Text: long}}
	r.put(t, "docs/raw/Huge.pdf", big)
	calls := r.conv.CallCount()
	r.run(t)
	d := r.doc(t, "docs/raw/Huge.pdf")
	if d.Status != docs.StatusFailed || !strings.Contains(d.Reason+d.Error, "too large to read (32 MB; the limit is 32 MB)") || r.conv.CallCount() != calls {
		t.Fatalf("huge PDF: %+v, converter calls %d → %d", d, calls, r.conv.CallCount())
	}

	// A readable sheet whose recorded size is over the limit (say, the
	// index says so after a replacement): the viewer refuses before reading.
	r.conv.Pages["pdf-sheet"] = []docs.Page{{N: 1, W: 1000, H: 500, Text: "POWER LEGEND " + long}}
	r.put(t, "docs/raw/Sheet.pdf", "pdf-sheet")
	r.run(t)
	body, etag, err := r.store.Get(ctx, docs.IndexKey)
	if err != nil {
		t.Fatal(err)
	}
	var ix map[string]any
	json.Unmarshal(body, &ix)
	for _, x := range ix["docs"].([]any) {
		if m := x.(map[string]any); m["key"] == "docs/raw/Sheet.pdf" {
			m["size"] = docs.MaxPDFBytes + 1
		}
	}
	body, _ = json.Marshal(ix)
	if _, err := r.store.Put(ctx, docs.IndexKey, body, etag); err != nil {
		t.Fatal(err)
	}
	if err := r.sync.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	v := &docs.Viewer{Sync: r.sync, Conv: r.conv}
	_, err = v.View(ctx, r.doc(t, "docs/raw/Sheet.pdf").ID, 1, nil)
	if !errors.Is(err, docs.ErrNotViewable) || !strings.Contains(err.Error(), "too large to view") {
		t.Fatalf("view of an oversized PDF: %v", err)
	}
}
