package docs_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/docs"
)

func TestViewer(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	r.conv.Pages["pdf-sheet"] = []docs.Page{{N: 1, W: 1000, H: 500, Text: "POWER LEGEND " + long, Words: []docs.Word{
		{T: "BALCONY", Box: [4]float64{100, 50, 160, 60}}, // top-left
		{T: "DB", Box: [4]float64{800, 400, 820, 410}},    // bottom-right
	}}}
	r.put(t, "docs/raw/1.0 Plans/Sheet.pdf", "pdf-sheet")
	r.run(t)
	id := r.doc(t, "docs/raw/1.0 Plans/Sheet.pdf").ID
	v := &docs.Viewer{Sync: r.sync, Conv: r.conv}

	full, err := v.View(ctx, id, 1, nil)
	if err != nil || !strings.Contains(string(full.PNG), "page=1 region=<nil> edge=1568") || len(full.Words) != 2 || full.W != 1000 {
		t.Fatalf("full view %+v %v", full, err)
	}
	crop, err := v.View(ctx, id, 1, &docs.Region{X0: 0.5, Y0: 0.5, X1: 1, Y1: 1})
	if err != nil || strings.Join(crop.Words, ",") != "DB" {
		t.Fatalf("crop words %v %v", crop.Words, err)
	}
	// The same view again comes from the cache.
	renders := r.conv.Renders
	if _, err := v.View(ctx, id, 1, nil); err != nil || r.conv.Renders != renders {
		t.Fatalf("cache: %v renders %d→%d", err, renders, r.conv.Renders)
	}
	for _, bad := range []struct {
		id   string
		page int
		reg  *docs.Region
	}{{"nope", 1, nil}, {id, 2, nil}} {
		if _, err := v.View(ctx, bad.id, bad.page, bad.reg); !errors.Is(err, docs.ErrNotViewable) {
			t.Errorf("%v: %v", bad, err)
		}
	}
	if _, err := v.View(ctx, id, 1, &docs.Region{X0: 0.6, Y0: 0, X1: 0.5, Y1: 1}); err == nil {
		t.Error("inverted region accepted")
	}
	// A removed document can't be viewed.
	r.store.Delete(ctx, "docs/raw/1.0 Plans/Sheet.pdf")
	r.run(t)
	if _, err := v.View(ctx, id, 1, nil); !errors.Is(err, docs.ErrNotViewable) {
		t.Errorf("removed doc: %v", err)
	}
}
