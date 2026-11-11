package docs_test

import (
	"strings"
	"testing"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/docs"
)

func TestSkipReason(t *testing.T) {
	for key, skip := range map[string]bool{
		"docs/raw/1.0 Plans & Drawings/1.1 Layout (A3).pdf": false,
		"docs/raw/Manual.PDF":                               false,
		"docs/raw/2.0 Checklists/._2.1 Gift.pdf":            true,
		"docs/raw/._top.pdf":                                true,
		"docs/raw/5.0 Vouchers/5.1 Video.mp4":               true,
		"docs/raw/notes.txt":                                true,
		"docs/raw/1.0 Plans/":                               true,
		"docs/raw/no-extension":                             true,
	} {
		if got := docs.SkipReason(key) != ""; got != skip {
			t.Errorf("%q: skip=%v (%q)", key, got, docs.SkipReason(key))
		}
	}
	if r := docs.SkipReason("docs/raw/a/b.mp4"); r != "not a PDF (mp4)" {
		t.Errorf("reason %q", r)
	}
}

func TestClassify(t *testing.T) {
	a4 := docs.PageInfo{W: 595, H: 842, Chars: 900}
	a4scan := docs.PageInfo{W: 595, H: 842, Chars: 0}
	cases := []struct {
		name      string
		pages     []docs.PageInfo
		class     string
		textPages int
	}{
		{"A4 manual", []docs.PageInfo{a4, a4, a4}, docs.ClassText, 3},
		{"A3 drawing, rotated", []docs.PageInfo{{W: 1191, H: 842, Chars: 1100}}, docs.ClassDrawing, 1},
		{"A1 drawing", []docs.PageInfo{{W: 2384, H: 1684, Chars: 1400}}, docs.ClassDrawing, 1},
		{"scan", []docs.PageInfo{a4scan, a4scan, a4scan}, docs.ClassScanned, 0},
		{"mostly screenshots", []docs.PageInfo{a4, a4scan, a4scan}, docs.ClassScanned, 1},
		{"half text is still text", []docs.PageInfo{a4, a4scan}, docs.ClassText, 1},
		{"no pages", nil, docs.ClassScanned, 0},
		{"landscape A4 is not a drawing", []docs.PageInfo{{W: 842, H: 595, Chars: 900}}, docs.ClassText, 1},
	}
	for _, c := range cases {
		class, tp := docs.Classify(c.pages)
		if class != c.class || tp != c.textPages {
			t.Errorf("%s: %s/%d, want %s/%d", c.name, class, tp, c.class, c.textPages)
		}
	}
}

func TestAssignIDIsStableAndUnique(t *testing.T) {
	k := "docs/raw/1.0 Plans/1.3 Power.pdf"
	id := docs.AssignID(k, map[string]string{})
	if len(id) != 8 || id != docs.AssignID(k, map[string]string{id: k}) {
		t.Fatalf("id %q not stable", id)
	}
	// Another key already holding the hash gets a suffix for the newcomer.
	if got := docs.AssignID(k, map[string]string{id: "docs/raw/other.pdf"}); got != id+"-2" {
		t.Fatalf("collision: %q", got)
	}
	if got := docs.AssignID(k, map[string]string{id: "x", id + "-2": "y"}); got != id+"-3" {
		t.Fatalf("second collision: %q", got)
	}
}

func TestPathsAndRoundTrip(t *testing.T) {
	d := docs.Doc{Key: "docs/raw/4.0 Manuals/4.2 Kitchen/SMEG Oven.pdf"}
	if d.Name() != "SMEG Oven.pdf" || d.Folder() != "4.0 Manuals/4.2 Kitchen" || d.TextKey() != "docs/text/4.0 Manuals/4.2 Kitchen/SMEG Oven.pdf.json" {
		t.Fatalf("paths: %q %q %q", d.Name(), d.Folder(), d.TextKey())
	}
	if (docs.Doc{Key: "docs/raw/top.pdf"}).Folder() != "" {
		t.Fatal("top-level folder")
	}
	ix := &docs.Index{Docs: []docs.Doc{
		{ID: "b", Key: "docs/raw/b.pdf", Status: docs.StatusOK, Class: docs.ClassText, Pages: 2},
		{ID: "a", Key: "docs/raw/a.pdf", Status: docs.StatusSkipped, Reason: "x"},
	}, LastSync: &docs.Sync{At: "2026-11-11T00:00:00Z", Reason: "startup", Added: 2}}
	b, err := ix.Encode(time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	back, err := docs.Decode(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(back.Docs) != 2 || back.Docs[0].Key != "docs/raw/a.pdf" || back.LastSync.Added != 2 || back.Find("b").Pages != 2 || back.Find("zz") != nil {
		t.Fatalf("round trip: %+v", back)
	}
	if empty, err := docs.Decode(nil); err != nil || len(empty.Docs) != 0 || empty.Schema != docs.Schema {
		t.Fatalf("empty: %+v %v", empty, err)
	}
	if _, err := docs.Decode([]byte(`{"schema":2,"docs":[]}`)); err == nil || !strings.Contains(err.Error(), "schema 2") {
		t.Fatalf("future schema accepted: %v", err)
	}
	if !(docs.Sync{Removed: 1}).Changes() || (docs.Sync{Failed: 2, Skipped: 3}).Changes() {
		t.Fatal("Changes()")
	}
}
