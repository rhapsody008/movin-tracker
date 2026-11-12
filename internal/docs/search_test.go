package docs_test

import (
	"context"
	"strings"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/docs"
)

func libRig(t *testing.T) (*rig, *docs.Library) {
	r := newRig(t)
	pad := strings.Repeat(" general information about the home and its fittings", 4)
	r.conv.Pages["pdf-fridge"] = []docs.Page{
		{N: 1, W: 595, H: 842, Text: "Contents. Installation. Safety." + pad},
		{N: 2, W: 595, H: 842, Text: "Defrosting: defrost the freezer every six months and clean the door seals." + pad},
	}
	r.conv.Pages["pdf-oven"] = []docs.Page{
		{N: 1, W: 595, H: 842, Text: "Oven cleaning with the pyrolytic programme; the door must be closed." + pad},
	}
	r.conv.Pages["pdf-power"] = []docs.Page{
		{N: 1, W: 2384, H: 1684, Text: "POWER LEGEND 13A switched socket outlets; DB distribution board; sockets in bedroom 2." + pad},
	}
	r.conv.Pages["pdf-scan"] = []docs.Page{{N: 1, W: 595, H: 842, Text: ""}, {N: 2, W: 595, H: 842, Text: "x"}}
	r.put(t, "docs/raw/4.0 Manuals/4.2 Kitchen/Fridge.pdf", "pdf-fridge")
	r.put(t, "docs/raw/4.0 Manuals/4.2 Kitchen/Oven.pdf", "pdf-oven")
	r.put(t, "docs/raw/1.0 Plans/1.3 Power.pdf", "pdf-power")
	r.put(t, "docs/raw/4.0 Manuals/Heater (scanned).pdf", "pdf-scan")
	r.run(t)
	return r, &docs.Library{Sync: r.sync}
}

func TestSearchRanksAndFilters(t *testing.T) {
	r, lib := libRig(t)
	ctx := context.Background()
	hits, err := lib.Search(ctx, "how do I defrost the freezer?", docs.SearchOptions{})
	if err != nil || len(hits) == 0 {
		t.Fatalf("%v %v", hits, err)
	}
	if hits[0].Name != "Fridge.pdf" || hits[0].Page != 2 || !strings.Contains(hits[0].Snippet, "defrost the freezer") || hits[0].Folder != "4.0 Manuals/4.2 Kitchen" {
		t.Fatalf("top hit %+v", hits[0])
	}
	// Plural folding: "socket" finds "sockets"/"socket outlets".
	if hits, _ := lib.Search(ctx, "socket", docs.SearchOptions{}); len(hits) != 1 || hits[0].Name != "1.3 Power.pdf" {
		t.Fatalf("socket: %+v", hits)
	}
	// "door" is on the fridge and oven pages; folder and doc filters narrow it.
	if hits, _ := lib.Search(ctx, "door", docs.SearchOptions{}); len(hits) != 2 {
		t.Fatalf("door: %+v", hits)
	}
	if hits, _ := lib.Search(ctx, "door", docs.SearchOptions{Folder: "1.0 plans"}); len(hits) != 0 {
		t.Fatalf("folder filter: %+v", hits)
	}
	oven := r.doc(t, "docs/raw/4.0 Manuals/4.2 Kitchen/Oven.pdf")
	if hits, _ := lib.Search(ctx, "door", docs.SearchOptions{Doc: oven.ID}); len(hits) != 1 || hits[0].Doc != oven.ID {
		t.Fatalf("doc filter: %+v", hits)
	}
	if hits, _ := lib.Search(ctx, "the and of", docs.SearchOptions{}); len(hits) != 0 {
		t.Fatalf("stopwords matched: %+v", hits)
	}
	// The scanned document is in the index but not searchable.
	if d := r.doc(t, "docs/raw/4.0 Manuals/Heater (scanned).pdf"); d.Class != docs.ClassScanned {
		t.Fatalf("scan class %q", d.Class)
	}
	if hits, _ := lib.Search(ctx, "x", docs.SearchOptions{}); len(hits) != 0 {
		t.Fatalf("scanned page searchable: %+v", hits)
	}
	// Page lookup.
	d, p, ok, err := lib.Page(ctx, oven.ID, 1)
	if err != nil || !ok || d.ID != oven.ID || !strings.Contains(p.Text, "pyrolytic") {
		t.Fatalf("page: %v %v %+v", ok, err, p)
	}
	if _, _, ok, _ := lib.Page(ctx, oven.ID, 7); ok {
		t.Fatalf("page 7 of a 1-page document")
	}
}

func TestSearchSeesNewDocumentsAfterSync(t *testing.T) {
	r, lib := libRig(t)
	ctx := context.Background()
	if hits, _ := lib.Search(ctx, "warranty", docs.SearchOptions{}); len(hits) != 0 {
		t.Fatalf("before: %+v", hits)
	}
	r.conv.Pages["pdf-warranty"] = []docs.Page{{N: 1, W: 595, H: 842, Text: "Warranty: 12 months from the date of handover for all fittings." + strings.Repeat(" more", 30)}}
	r.put(t, "docs/raw/6.0 General/Warranty.pdf", "pdf-warranty")
	r.run(t)
	if hits, _ := lib.Search(ctx, "warranty handover", docs.SearchOptions{}); len(hits) != 1 || hits[0].Name != "Warranty.pdf" {
		t.Fatalf("after sync: %+v", hits)
	}
}

// Lowercasing can change a string's byte length (Ⱥ → ⱥ); the snippet must
// still be cut at the right place, not panic.
func TestSnippetWithLengthChangingCase(t *testing.T) {
	r := newRig(t)
	r.conv.Pages["pdf-odd"] = []docs.Page{{N: 1, W: 595, H: 842, Text: strings.Repeat("Ⱥ", 120) + " valve"}}
	r.put(t, "docs/raw/odd.pdf", "pdf-odd")
	r.run(t)
	hits, err := (&docs.Library{Sync: r.sync}).Search(context.Background(), "valve", docs.SearchOptions{})
	if err != nil || len(hits) != 1 || !strings.HasSuffix(hits[0].Snippet, "valve") {
		t.Fatalf("%+v %v", hits, err)
	}
}
