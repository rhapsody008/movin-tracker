package entries_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/entries"
)

func searchDoc(t *testing.T) *entries.Doc {
	t.Helper()
	d := entries.Empty()
	add := func(updated, kind, js string) {
		e := entries.NewEntry(kind)
		if err := patch(t, js).Apply(&e); err != nil {
			t.Fatal(err)
		}
		e.ID, e.Updated = e.Title, updated
		d.Entries = append(d.Entries, e)
	}
	add("2026-11-01T00:00:00Z", "idea", `{"title":"Quartz countertop","room":"wet kitchen","category":"carpentry","cost":{"estimate":3000},"tags":["counter","stone"]}`)
	add("2026-11-03T00:00:00Z", "decision", `{"title":"Sintered stone top","room":"dry kitchen","category":"carpentry","status":"decided","vendor":"Lim Carpentry","tags":["counter"],"notes":"Picked over quartz"}`)
	add("2026-11-02T00:00:00Z", "task", `{"title":"Electrician visit","category":"electrical","date":"2026-11-14","time":"14:00","vendor":"Tan Electric"}`)
	add("2026-11-04T00:00:00Z", "task", `{"title":"Book movers","category":"admin","date":"2026-12-01","status":"doing"}`)
	add("2026-11-05T00:00:00Z", "note", `{"title":"Maybe a reading nook","room":"flex","archived":true}`)
	add("2026-11-06T00:00:00Z", "question", `{"title":"Can we hack the bedroom 2 wall?","room":"bedroom 2","source":"site visit"}`)
	return d
}

func titles(r entries.SearchResult) string {
	var out []string
	for _, e := range r.Entries {
		out = append(out, e.Title)
	}
	return strings.Join(out, " | ")
}

func TestSearch(t *testing.T) {
	d := searchDoc(t)
	cases := []struct {
		name string
		f    entries.Filter
		want string
	}{
		{"everything, newest first, no archived", entries.Filter{},
			"Can we hack the bedroom 2 wall? | Book movers | Sintered stone top | Electrician visit | Quartz countertop"},
		{"include archived", entries.Filter{IncludeArchived: true, Kinds: []string{"note"}}, "Maybe a reading nook"},
		{"kitchen decisions", entries.Filter{Rooms: []string{"Dry Kitchen", "wet kitchen"}, Statuses: []string{"decided"}}, "Sintered stone top"},
		{"kind any-of", entries.Filter{Kinds: []string{"Task", "question"}}, "Can we hack the bedroom 2 wall? | Book movers | Electrician visit"},
		{"room excludes entries without one", entries.Filter{Rooms: []string{"flex"}}, ""},
		{"category", entries.Filter{Category: "Carpentry"}, "Sintered stone top | Quartz countertop"},
		{"tags need all", entries.Filter{Tags: []string{"counter", "stone"}}, "Quartz countertop"},
		{"vendor substring", entries.Filter{Vendor: "lim"}, "Sintered stone top"},
		{"text words all match, any field", entries.Filter{Text: "quartz top"}, "Sintered stone top | Quartz countertop"},
		{"text matches room", entries.Filter{Text: "bedroom"}, "Can we hack the bedroom 2 wall?"},
		{"text matches source", entries.Filter{Text: "site"}, "Can we hack the bedroom 2 wall?"},
		{"date range inclusive", entries.Filter{DateFrom: "2026-11-14", DateTo: "2026-11-30"}, "Electrician visit"},
		{"date from only", entries.Filter{DateFrom: "2026-11-15"}, "Book movers"},
		{"limit", entries.Filter{Limit: 2}, "Can we hack the bedroom 2 wall? | Book movers"},
		{"no match", entries.Filter{Text: "jacuzzi"}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := titles(d.Search(c.f)); got != c.want {
				t.Fatalf("got  %q\nwant %q", got, c.want)
			}
		})
	}
}

func TestSearchTotalAndCaps(t *testing.T) {
	d := entries.Empty()
	for i := 0; i < 250; i++ {
		e := entries.NewEntry("note")
		e.Title, e.Updated = fmt.Sprintf("n%d", i), fmt.Sprintf("2026-11-01T00:00:%03dZ", i)
		d.Entries = append(d.Entries, e)
	}
	r := d.Search(entries.Filter{})
	if r.Total != 250 || len(r.Entries) != entries.DefaultLimit {
		t.Fatalf("default: total=%d len=%d", r.Total, len(r.Entries))
	}
	if r := d.Search(entries.Filter{Limit: 1000}); len(r.Entries) != entries.MaxLimit {
		t.Fatalf("max: len=%d", len(r.Entries))
	}
	// Results are copies: changing them must not touch the document.
	r.Entries[0].Title = "changed"
	if d.Search(entries.Filter{Limit: 1}).Entries[0].Title == "changed" {
		t.Fatal("search returned shared memory")
	}
}
