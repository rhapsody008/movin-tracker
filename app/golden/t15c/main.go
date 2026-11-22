//go:build ignore

// Command t15c-golden writes the Go answers the TypeScript port of search,
// the snippet, NextRun and Day/AddDays must reproduce. A golden generator of
// the v3 port (app/golden/README.md): it needs the Go code, so run it before T7
// deletes it.
//
// Run from the repo root, in the Go tools container:
//
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t15c/main.go'
//
// It writes four fixtures:
//
//	app/src/docs/testdata/search/search-index.json   the fixture docs/index.json (Go's own Encode)
//	app/src/docs/testdata/search/search-texts.json   map of bucket key → docs/text/<path>.json body
//	app/src/docs/testdata/search/search-hits.go.json every query's Go hits, byte for byte
//	app/src/testdata/sched.go.json                   NextRun, Day and AddDays for a table of cases
//
// The TypeScript tests read the same fixture files, so the comparison is
// against the Go package itself rather than against a guess.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/docs"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/sched"
)

// fixed is the clock used for the fixture index's `updated` stamp.
var fixed = time.Date(2026, 11, 11, 3, 0, 0, 0, time.UTC)

// pad keeps every page over docs.MinTextChars.
var pad = strings.Repeat(" general information about the home and its fittings", 4)

// longClauses is 420 characters, so a match after it gets a "…" in front and
// a cut 240 runes later leaves 185 more for the "…" behind.
var longClauses = strings.Repeat("clause ", 60)

type fixture struct {
	key   string
	class string
	// status is "ok" unless set.
	status string
	// noText leaves the text blob out, so PageText fails and search skips it.
	noText bool
	pages  []docs.Page
}

func a4(n int, text string) docs.Page { return docs.Page{N: n, W: 595, H: 842, Text: text} }

// valves: 24 pages with the word "valve" (so the limit and the tie order
// both show), one page of stopwords only (not indexed) and one empty page.
func valves() []docs.Page {
	out := []docs.Page{a4(1, strings.Repeat("draining the loop ", 12)+"needle valve")}
	for n := 2; n <= 20; n++ {
		out = append(out, a4(n, strings.Repeat("valve ", 12)))
	}
	out = append(out,
		a4(21, "a valve at the end"),
		a4(22, "valve"),
		a4(23, "valve status glass"),
		a4(24, "valves"),
		a4(25, "the and of"),
		a4(26, ""),
	)
	return out
}

var fixtures = []fixture{
	{key: "docs/raw/4.0 Manuals/4.2 Kitchen/Fridge.pdf", class: docs.ClassText, pages: []docs.Page{
		a4(1, "Contents. Installation. Safety."+pad),
		a4(2, "Defrosting: defrost the freezer every six months and clean the door seals."+pad),
	}},
	{key: "docs/raw/4.0 Manuals/4.2 Kitchen/Oven.pdf", class: docs.ClassText, pages: []docs.Page{
		a4(1, "Oven cleaning with the pyrolytic programme; the door must be closed."+pad),
	}},
	{key: "docs/raw/1.0 Plans/1.3 Power.pdf", class: docs.ClassDrawing, pages: []docs.Page{
		{N: 1, W: 2384, H: 1684, Text: "POWER LEGEND 13A switched socket outlets; DB distribution board; sockets in bedroom 2." + pad},
	}},
	{key: "docs/raw/4.0 Manuals/Heater (scanned).pdf", class: docs.ClassScanned, pages: []docs.Page{
		a4(1, ""), a4(2, "x"),
	}},
	{key: "docs/raw/6.0 General/Warranty.pdf", class: docs.ClassText, pages: []docs.Page{
		a4(1, "Warranty: 12 months from handover. Two warranties for the glass panels and the status of each valve."+pad),
		a4(2, longClauses+"annex"+strings.Repeat(" appendix", 20)),
	}},
	{key: "docs/raw/7.0 中文/合同.pdf", class: docs.ClassText, pages: []docs.Page{
		a4(1, "厨房台面 石英石 保修 十年。热水器 安装在 阳台。"+pad),
		a4(2, "保修 "+strings.Repeat("厨房台面 石英石 ", 40)+"。"),
	}},
	{key: "docs/raw/9.0 Long/Valves.pdf", class: docs.ClassText, pages: valves()},
	// Astral characters (one code point, two UTF-16 units each): a snippet cut
	// in UTF-16 units would not match Go's.
	{key: "docs/raw/9.0 Long/Emoji.pdf", class: docs.ClassText, pages: []docs.Page{
		a4(1, strings.Repeat("🚰 ", 130)+"valve"),
	}},
	{key: "docs/raw/8.0 Broken/NoText.pdf", class: docs.ClassText, noText: true, pages: []docs.Page{
		a4(1, "This page's text blob is missing from the bucket."+pad),
	}},
	{key: "docs/raw/9.0 Long/Gone.pdf", class: docs.ClassText, status: docs.StatusRemoved, pages: []docs.Page{
		a4(1, "valve valve valve valve valve valve valve valve"+pad),
	}},
}

// index builds the fixture index: ids as AssignID gives them, one record per
// fixture, sorted by key on Encode.
func index() *docs.Index {
	ix, _ := docs.Decode(nil)
	taken := map[string]string{}
	for _, f := range fixtures {
		status := f.status
		if status == "" {
			status = docs.StatusOK
		}
		id := docs.AssignID(f.key, taken)
		taken[id] = f.key
		ix.Docs = append(ix.Docs, docs.Doc{
			ID:        id,
			Key:       f.key,
			ETag:      `"` + fmt.Sprintf("%08x", len(f.key)) + `"`,
			Size:      1024,
			Pages:     len(f.pages),
			Class:     f.class,
			Status:    status,
			TextPages: 1,
			SyncedAt:  "2026-11-11T03:00:00Z",
			Version:   docs.ConvertVersion,
		})
	}
	return ix
}

type goldenQuery struct {
	Query  string     `json:"query"`
	Doc    string     `json:"doc,omitempty"`
	Folder string     `json:"folder,omitempty"`
	Limit  int        `json:"limit,omitempty"`
	Hits   []docs.Hit `json:"hits"`
}

func queries(ix *docs.Index) []goldenQuery {
	ovenID, emojiID := "", ""
	for _, d := range ix.Docs {
		switch d.Key {
		case "docs/raw/4.0 Manuals/4.2 Kitchen/Oven.pdf":
			ovenID = d.ID
		case "docs/raw/9.0 Long/Emoji.pdf":
			emojiID = d.ID
		}
	}
	return []goldenQuery{
		{Query: "how do I defrost the freezer?"},
		{Query: "socket"},
		{Query: "sockets"},
		{Query: "warranties"},
		{Query: "warranty"},
		{Query: "status"},
		{Query: "glass"},
		{Query: "door"},
		{Query: "door", Folder: "1.0 plans"},
		{Query: "door", Folder: "/1.0 PLANS/"},
		{Query: "door", Folder: "4.0 manuals/4.2 kitchen"},
		{Query: "door", Doc: ovenID},
		{Query: "the and of"},
		{Query: "x"}, // only a scanned page has it: not searchable
		{Query: "厨房台面"},
		{Query: "保修"},
		{Query: "valve"},
		{Query: "valve", Limit: 100},
		{Query: "valve", Limit: 3},
		{Query: "valve", Doc: emojiID},
		{Query: "annex"},
		{Query: "needle"},
		{Query: "oven pyrolytic"},
		{Query: "unknownwordnotpresent"},
	}
}

type goldenNext struct {
	Now  string `json:"now"`
	HH   int    `json:"hh"`
	MM   int    `json:"mm"`
	TZ   string `json:"tz"`
	Next string `json:"next"` // RFC3339 in the zone
	UTC  string `json:"utc"`
}

type goldenDay struct {
	Now string `json:"now"`
	TZ  string `json:"tz"`
	Day string `json:"day"`
}

type goldenAdd struct {
	Day  string `json:"day"`
	N    int    `json:"n"`
	Want string `json:"want"`
}

type schedGolden struct {
	Next    []goldenNext `json:"next"`
	Day     []goldenDay  `json:"day"`
	AddDays []goldenAdd  `json:"addDays"`
}

func main() {
	out := flag.String("out", "app/src/docs/testdata/search", "where the search fixtures go")
	schedOut := flag.String("sched-out", "app/src/testdata", "where the schedule answers go")
	flag.Parse()
	if err := write(*out, *schedOut); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		os.Exit(1)
	}
}

func write(dir, schedDir string) error {
	ctx := context.Background()
	ix := index()
	body, err := ix.Encode(fixed)
	if err != nil {
		return err
	}
	if err := save(filepath.Join(dir, "search-index.json"), body); err != nil {
		return err
	}

	store := objstore.NewMemory()
	if _, err := store.Put(ctx, docs.IndexKey, body, ""); err != nil {
		return err
	}
	texts := map[string]docs.PageText{}
	for _, f := range fixtures {
		// A removed document keeps its text in the bucket; only its status keeps
		// it out of search.
		if f.noText {
			continue
		}
		pt := docs.PageText{Key: f.key, ETag: docETag(ix, f.key), Pages: f.pages}
		blob, err := json.Marshal(pt)
		if err != nil {
			return err
		}
		if _, err := store.PutBlob(ctx, docs.TextKeyFor(f.key), blob, "application/json"); err != nil {
			return err
		}
		texts[f.key] = pt
	}
	blob, err := json.MarshalIndent(texts, "", "  ")
	if err != nil {
		return err
	}
	if err := save(filepath.Join(dir, "search-texts.json"), append(blob, '\n')); err != nil {
		return err
	}

	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	syncer := &docs.Syncer{Store: store, Log: log}
	lib := &docs.Library{Sync: syncer}
	var goldens []goldenQuery
	for _, q := range queries(ix) {
		hits, err := lib.Search(ctx, q.Query, docs.SearchOptions{Doc: q.Doc, Folder: q.Folder, Limit: q.Limit})
		if err != nil {
			return fmt.Errorf("search %q: %w", q.Query, err)
		}
		if hits == nil {
			hits = []docs.Hit{} // what internal/agent/doctools.go puts in {"hits": …}
		}
		q.Hits = hits
		goldens = append(goldens, q)
	}
	golden, err := marshal(goldens)
	if err != nil {
		return err
	}
	if err := save(filepath.Join(dir, "search-hits.go.json"), golden); err != nil {
		return err
	}

	s, err := marshal(schedCases())
	if err != nil {
		return err
	}
	if err := save(filepath.Join(schedDir, "sched.go.json"), s); err != nil {
		return err
	}
	for _, q := range goldens {
		fmt.Printf("%-32q %d hits\n", q.Query, len(q.Hits))
	}
	fmt.Printf("sched: %d next, %d day, %d addDays\n", len(schedCases().Next), len(schedCases().Day), len(schedCases().AddDays))
	return nil
}

func docETag(ix *docs.Index, key string) string {
	for _, d := range ix.Docs {
		if d.Key == key {
			return d.ETag
		}
	}
	return ""
}

// schedCases is the table the TypeScript scheduler must agree with: midnight,
// month end, exactly on the time, Singapore (+08, no DST) and London across
// both 2026 changes.
func schedCases() schedGolden {
	var next []struct{ now, tz string }
	for _, c := range []struct{ now, tz string }{
		{"2026-11-11T02:59:00+08:00", "Asia/Singapore"},
		{"2026-11-11T03:00:00+08:00", "Asia/Singapore"},
		{"2026-11-30T23:50:00+08:00", "Asia/Singapore"},
		{"2026-11-11T19:30:00Z", "Asia/Singapore"},
		{"2026-12-31T23:59:59+08:00", "Asia/Singapore"},
		{"2026-11-11T03:00:00Z", "UTC"},
		{"2026-11-11T02:59:59Z", "UTC"},
		{"2026-03-28T00:00:00Z", "Europe/London"},
		{"2026-03-28T12:00:00Z", "Europe/London"},
		{"2026-03-28T22:30:00Z", "Europe/London"},
		{"2026-10-24T12:00:00Z", "Europe/London"},
		{"2026-10-24T01:30:00Z", "Europe/London"},
		{"2026-03-29T01:30:00Z", "Europe/London"},
	} {
		next = append(next, c)
	}
	g := schedGolden{}
	for _, c := range next {
		now := mustTime(c.now)
		loc := mustLoc(c.tz)
		n := sched.NextRun(now, 3, 0, loc)
		g.Next = append(g.Next, goldenNext{
			Now:  c.now,
			HH:   3,
			MM:   0,
			TZ:   c.tz,
			Next: n.Format(time.RFC3339),
			UTC:  n.UTC().Format(time.RFC3339),
		})
	}
	for _, c := range []struct{ now, tz string }{
		{"2026-11-12T16:30:00Z", "Asia/Singapore"},
		{"2026-11-11T20:00:00Z", "Asia/Singapore"},
		{"2026-03-29T22:30:00Z", "Europe/London"},
		{"2026-11-11T03:00:00Z", "UTC"},
	} {
		g.Day = append(g.Day, goldenDay{Now: c.now, TZ: c.tz, Day: sched.Day(mustTime(c.now), mustLoc(c.tz))})
	}
	for _, c := range []struct {
		day string
		n   int
	}{{"2026-11-30", 1}, {"2026-01-01", -1}, {"2026-11-12", 7}, {"2026-02-28", 1}, {"2024-02-28", 1}, {"bad", 1}, {"", 1}, {"2026-11-30", -30}} {
		g.AddDays = append(g.AddDays, goldenAdd{Day: c.day, N: c.n, Want: sched.AddDays(c.day, c.n)})
	}
	return g
}

func mustTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func mustLoc(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return loc
}

// marshal writes Go's JSON the way the TypeScript side prints it: two-space
// indent, no HTML escaping, one trailing newline.
func marshal(v any) ([]byte, error) {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}

func save(path string, body []byte) error {
	if err := os.WriteFile(path, body, 0o644); err != nil {
		return err
	}
	fmt.Printf("wrote %s (%d bytes)\n", path, len(body))
	return nil
}
