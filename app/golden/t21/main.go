//go:build ignore

// Command t21-golden writes the Go answers the TypeScript HTTP layer (T2.1)
// must reproduce. A golden generator of the v3 port (app/golden/README.md): it
// needs the Go code, so run it before T7 deletes it.
//
// Run from the repo root, in the Go tools container:
//
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t21/main.go'
//
// It writes two fixtures:
//
//	app/src/server/testdata/transcript.go.json    = the script below and the bytes Go answered
//	app/src/server/testdata/changetext.go.json     = fmtDate, Money, Summary and ChangeText
//
// The TypeScript transcript test replays every request of the script against
// the TypeScript server, with the same clock and the same memory store, and
// compares the status, the five headers recorded here and the body bytes. ULIDs
// and ETags are random, so both sides mask them before comparing; the tails of
// the decode errors differ by design (brief T2.1) and are masked too.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing/fstest"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/server"
)

// fixed is the clock the entries service uses, so created/updated/completed are
// the same bytes in both apps. The zone is the app's TZ: Asia/Singapore (UTC+8),
// so "today" is 2026-11-12 for this instant.
var fixed = time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)

const zone = "Asia/Singapore"

// ---------- the transcript ----------

// step is one request of the script together with the answer Go gave it.
type step struct {
	Name    string      `json:"name"`
	Method  string      `json:"method"`
	Path    string      `json:"path"`
	Headers [][2]string `json:"reqHeaders"`
	// Body is the exact body sent, byte for byte, except when BodyKind is
	// "oversize": then both sides build oversizeBody() instead and Body is
	// empty, so the fixture is not 1 MiB of 'a'.
	Body       string  `json:"reqBody"`
	BodyKind   string  `json:"reqBodyKind,omitempty"`
	Status     int     `json:"status"`
	Answer     headers `json:"headers"`
	AnswerBody string  `json:"body"`
}

// headers are the response headers both sides compare (§9: the ones that
// carry the contract).
type headers struct {
	ContentType         string `json:"content-type"`
	ETag                string `json:"etag"`
	Location            string `json:"location"`
	CacheControl        string `json:"cache-control"`
	XContentTypeOptions string `json:"x-content-type-options"`
}

// request is one line of the script. A field of the form $ID:<name>,
// $CHANGE:<name> or $ETAG:<name> takes the value an earlier answer carried, so
// the script can address the entries and changes it created.
type request struct {
	name     string
	method   string
	path     string
	headers  [][2]string
	body     string
	bodyKind string
}

// oversizeBody is 1 MiB + 1 bytes of a JSON object, one over the cap Go's
// http.MaxBytesReader enforces (server.go:223).
func oversizeBody() string {
	const prefix = `{"title":"`
	const suffix = `"}`
	return prefix + strings.Repeat("a", 1<<20+1-len(prefix)-len(suffix)) + suffix
}

// answer is what one step got back, for the references above.
type answer struct {
	status  int
	headers http.Header
	body    []byte
}

var refRe = regexp.MustCompile(`\$(ID|CHANGE|ETAG):([A-Za-z0-9-]+)`)

func resolve(s string, got map[string]answer) string {
	return refRe.ReplaceAllStringFunc(s, func(ref string) string {
		m := refRe.FindStringSubmatch(ref)
		a, ok := got[m[2]]
		if !ok {
			panic("no earlier step named " + m[2])
		}
		switch m[1] {
		case "ETAG":
			return a.headers.Get("ETag")
		case "ID", "CHANGE":
			var body struct {
				Entry  struct{ ID string } `json:"entry"`
				Change struct{ ID string } `json:"change"`
			}
			if err := json.Unmarshal(a.body, &body); err != nil {
				panic(fmt.Sprintf("%s: %v", m[2], err))
			}
			if m[1] == "ID" {
				return body.Entry.ID
			}
			return body.Change.ID
		}
		return ref
	})
}

// script is the whole conversation. It covers every T2.1 route's success and
// error path, the auth answers, the health probes, the static catch-all and the
// three decode failures.
var script = []request{
	{name: "healthz", method: "GET", path: "/healthz"},
	{name: "readyz", method: "GET", path: "/readyz"},
	{name: "icon-without-auth", method: "GET", path: "/icon.svg", headers: [][2]string{{"X-Forwarded-Email", ""}}},
	{name: "page", method: "GET", path: "/"},
	{
		name: "page-for-a-stranger", method: "GET", path: "/",
		headers: [][2]string{{"X-Forwarded-Email", "stranger@example.com"}},
	},
	{name: "api-entries-without-auth", method: "GET", path: "/api/entries", headers: [][2]string{{"X-Forwarded-Email", ""}}},
	{
		name: "api-entries-for-a-stranger", method: "GET", path: "/api/entries",
		headers: [][2]string{{"X-Forwarded-Email", "stranger@example.com"}},
	},
	{name: "index-html-redirects", method: "GET", path: "/index.html"},
	{name: "missing-file", method: "GET", path: "/nope.txt"},
	{name: "api-404", method: "GET", path: "/api/nope"},
	// A trailing slash is not the same path, and an empty segment cannot fill a
	// wildcard, so this is the catch-all too (server-spec §9.7).
	{name: "api-trailing-slash", method: "GET", path: "/api/entries/"},
	// Go's URL parser refuses this before routing; the target is sent verbatim
	// (URL.Opaque) so the server's own answer is recorded.
	{name: "bad-escape", method: "GET", path: "/api/entries/%zz"},
	{name: "entries-empty", method: "GET", path: "/api/entries"},
	{
		name: "entries-304", method: "GET", path: "/api/entries",
		headers: [][2]string{{"If-None-Match", "$ETAG:entries-empty"}},
	},
	{name: "head-entries", method: "HEAD", path: "/api/entries"},
	{
		name: "case-insensitive-email", method: "GET", path: "/api/entries",
		headers: [][2]string{{"X-Forwarded-Email", "Partner@Example.COM"}},
	},
	{
		name: "clean-path-redirect", method: "GET", path: "//api//entries",
	},
	{
		name: "create", method: "POST", path: "/api/entries",
		body: `{"title":"Book movers","kind":"task","date":"2026-11-20","time":"10:00","cost":{"estimate":1200}}`,
	},
	{
		name: "create-html", method: "POST", path: "/api/entries",
		body: `{"title":"Paint <&\" seal","kind":"idea","room":"flex","date":"2026-12-01","time":"08:30",` +
			`"vendor":"Ah Seng & Sons","cost":{"estimate":1234.5},"notes":"a > b & c","source":"WhatsApp"}`,
	},
	{name: "create-empty-title", method: "POST", path: "/api/entries", body: `{"title":""}`},
	{name: "create-bad-date", method: "POST", path: "/api/entries", body: `{"title":"x","date":"tomorrow"}`},
	{name: "create-bad-room", method: "POST", path: "/api/entries", body: `{"title":"x","room":"garage"}`},
	{name: "create-unknown-field", method: "POST", path: "/api/entries", body: `{"title":"x","nope":1}`},
	{name: "create-empty-body", method: "POST", path: "/api/entries"},
	{name: "create-trailing-data", method: "POST", path: "/api/entries", body: `{"title":"Trailing"} {"title":"never read"}`},
	{name: "create-bad-json", method: "POST", path: "/api/entries", body: `{"title":`},
	{name: "create-too-large", method: "POST", path: "/api/entries", bodyKind: "oversize"},
	{name: "entries-two", method: "GET", path: "/api/entries"},
	{
		name: "patch-every-field", method: "PATCH", path: "/api/entries/$ID:create-html",
		body: `{"title":"Paint & seal","vendor":"Hock Seng","source":"","notes":"","category":"Paint",` +
			`"room":"living","status":"decided","date":"2026-12-05","time":"09:00",` +
			`"cost":{"estimate":1300,"actual":500},"tags":["paint","wet"],"milestone":true}`,
	},
	{
		name: "patch-by-the-partner", method: "PATCH", path: "/api/entries/$ID:create",
		headers: [][2]string{{"X-Forwarded-Email", "partner@example.com"}},
		body:    `{"status":"done","cost":{"actual":1200}}`,
	},
	{name: "patch-missing", method: "PATCH", path: "/api/entries/nope", body: `{"status":"todo"}`},
	{name: "patch-escaped-id", method: "PATCH", path: "/api/entries/a%2Fb", body: `{"status":"todo"}`},
	{name: "meta", method: "PUT", path: "/api/meta", body: `{"moveDate":"2026-12-05","keyDate":"2026-10-29"}`},
	{name: "meta-null", method: "PUT", path: "/api/meta", body: `{"keyDate":null}`},
	{name: "meta-bad-date", method: "PUT", path: "/api/meta", body: `{"moveDate":"5 Dec"}`},
	{name: "meta-not-a-string", method: "PUT", path: "/api/meta", body: `{"moveDate":5}`},
	{name: "meta-unknown-field", method: "PUT", path: "/api/meta", body: `{"nope":"x"}`},
	{name: "delete", method: "DELETE", path: "/api/entries/$ID:create"},
	{name: "delete-again", method: "DELETE", path: "/api/entries/$ID:create"},
	{name: "undo", method: "POST", path: "/api/changes/$CHANGE:delete/undo"},
	{name: "undo-again", method: "POST", path: "/api/changes/$CHANGE:delete/undo"},
	{name: "undo-unknown", method: "POST", path: "/api/changes/nope/undo"},
	{name: "method-mismatch", method: "PUT", path: "/api/entries", body: `{"title":"x"}`},
	{name: "post-healthz", method: "POST", path: "/healthz"},
	{name: "entries-final", method: "GET", path: "/api/entries"},
}

func setup() *server.Server {
	store := objstore.NewMemory()
	log := slog.New(slog.NewJSONHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelDebug}))
	ents := entries.NewService(store, log)
	loc, err := time.LoadLocation(zone)
	if err != nil {
		panic(err)
	}
	ents.SetLocation(loc)
	ents.SetClock(func() time.Time { return fixed })
	if err := ents.Load(context.Background()); err != nil {
		panic(err)
	}
	return &server.Server{
		Entries: ents,
		Store:   store,
		Log:     log,
		Static: fstest.MapFS{
			"index.html": {Data: []byte("<!doctype html><title>Our new place</title>")},
			"icon.svg":   {Data: []byte("<svg/>")},
		},
		AuthHeader:    "X-Forwarded-Email",
		AllowedEmails: []string{"zy@example.com", "partner@example.com"},
		// No Agent, Settings, Bot, Docs or Guide: T2.1 does not route to them.
	}
}

func runScript(ts *httptest.Server) []step {
	got := map[string]answer{}
	out := make([]step, 0, len(script))
	client := &http.Client{
		// Record the 301s of /index.html and of a path the mux cleans, rather
		// than the page a browser would end up on after following them.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	for _, r := range script {
		path := resolve(r.path, got)
		var body io.Reader
		switch r.bodyKind {
		case "":
			if r.body != "" {
				body = strings.NewReader(r.body)
			}
		case "oversize":
			body = strings.NewReader(oversizeBody())
		default:
			panic("unknown body kind " + r.bodyKind)
		}
		req, err := newRequest(r.method, ts.URL, path, body)
		if err != nil {
			panic(err)
		}
		req.Header.Set("X-Forwarded-Email", "zy@example.com")
		// sent is what actually went out: the references are resolved here, so the
		// fixture holds the header values, not the $ETAG:** syntax of the script.
		sent := [][2]string{}
		for _, h := range r.headers {
			value := resolve(h[1], got)
			req.Header.Set(h[0], value)
			sent = append(sent, [2]string{h[0], value})
		}
		resp, err := client.Do(req)
		if err != nil {
			panic(fmt.Sprintf("%s: %v", r.name, err))
		}
		raw, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			panic(err)
		}
		got[r.name] = answer{status: resp.StatusCode, headers: resp.Header, body: raw}
		out = append(out, step{
			Name: r.name, Method: r.method, Path: path, Headers: sent,
			Body: r.body, BodyKind: r.bodyKind,
			Status: resp.StatusCode,
			Answer: headers{
				ContentType:         resp.Header.Get("Content-Type"),
				ETag:                resp.Header.Get("ETag"),
				Location:            resp.Header.Get("Location"),
				CacheControl:        resp.Header.Get("Cache-Control"),
				XContentTypeOptions: resp.Header.Get("X-Content-Type-Options"),
			},
			AnswerBody: string(raw),
		})
	}
	return out
}

// newRequest builds the request for one step. A path with an invalid percent
// escape cannot be parsed into a URL, so it goes out as an opaque target: that
// is the request a browser can still send, and the server answers it itself.
func newRequest(method, base, path string, body io.Reader) (*http.Request, error) {
	if !hasBadEscape(path) {
		return http.NewRequest(method, base+path, body)
	}
	req, err := http.NewRequest(method, base, body)
	if err != nil {
		return nil, err
	}
	req.URL.Opaque = path
	return req, nil
}

// hasBadEscape reports a "%" that does not start a %XX escape.
func hasBadEscape(p string) bool {
	for i := 0; i < len(p); i++ {
		if p[i] != '%' {
			continue
		}
		if i+2 >= len(p) || !isHexDigit(p[i+1]) || !isHexDigit(p[i+2]) {
			return true
		}
		i += 2
	}
	return false
}

func isHexDigit(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

// ---------- change lines ----------

type moneyCase struct {
	In  float64 `json:"in"`
	Out string  `json:"out"`
}

type dateCase struct {
	In  string `json:"in"`
	Out string `json:"out"`
}

// changeText is what the TypeScript port must answer: a doc holding every
// Change of the table (so the port can decode them with its own decoder) and
// the ChangeText of each, in the same order.
type changeText struct {
	FmtDate     []dateCase   `json:"fmtDate"`
	Money       []moneyCase  `json:"money"`
	Doc         *entries.Doc `json:"doc"`
	ChangeTexts []string     `json:"changeTexts"`
}

func sp(s string) *string   { return &s }
func fp(f float64) *float64 { return &f }

func entry(title string) *entries.Entry {
	return &entries.Entry{
		ID: "01ARZ3NDEKTSV4RRFFQ69G5FAV", Kind: entries.KindTask, Title: title,
		Status: "todo", Tags: []string{}, By: "zy@example.com", Channel: "web",
		Created: "2026-11-12T10:00:00Z", Updated: "2026-11-12T10:00:00Z",
	}
}

func change(op string, before, after *entries.Entry) entries.Change {
	return entries.Change{
		ID: "01ARZ3NDEKTSV4RRFFQ69G5FB0", At: "2026-11-12T10:00:00Z",
		By: "zy@example.com", Channel: "web", Op: op, EntryID: "e1",
		Before: before, After: after,
	}
}

func update(before, after *entries.Entry) entries.Change {
	return change("update", before, after)
}

func changeTextFixture() changeText {
	// 1: a create with everything Summary prints.
	rich := entry("Quartz countertop")
	rich.Kind, rich.Room, rich.Status = entries.KindDecision, sp("wet kitchen"), "decided"
	rich.Date, rich.Time, rich.Vendor = sp("2026-11-20"), sp("10:00"), "Stone Atelier"
	rich.Cost = entries.Cost{Estimate: fp(3000), Actual: fp(5400.5)}
	rich.Completed, rich.Milestone, rich.Archived = sp("2026-11-20"), true, true

	// 2: a create with nothing but a title, so Summary is "task · …".
	plain := entry("Book movers")

	// 3: the money edge cases in a Summary.
	odd := entry("Odd amounts")
	odd.Kind = entries.KindIdea
	odd.Status = "idea"
	odd.Cost = entries.Cost{Estimate: fp(0.995), Actual: fp(1234567.5)}

	// 4: an entry with a date but no time, and a time-less completed day.
	dated := entry("Lift booking")
	dated.Date = sp("2026-11-20")

	// 5: the base for every diff branch.
	base := entry("Wardrobe")
	base.Kind, base.Room, base.Status = entries.KindTask, sp("master bedroom"), "doing"
	base.Category, base.Vendor, base.Source = "furniture", "Carpentry Co", "WhatsApp"
	base.Notes, base.Tags = "oak, 2.4 m", []string{"wardrobe", "oak"}
	base.Date, base.Time = sp("2026-11-20"), sp("10:00")
	base.Cost = entries.Cost{Estimate: fp(1200), Actual: fp(600)}

	// 6: the archived pair.
	archiveBefore := entry("Old sofa")
	archiveAfter := *archiveBefore
	archiveAfter.Archived = true

	restoreBefore := entry("Old sofa")
	restoreBefore.Archived = true
	restoreAfter := *restoreBefore
	restoreAfter.Archived = false

	// 7: a done entry and its done-day.
	doneBefore := entry("Handover")
	doneBefore.Status, doneBefore.Completed = "done", sp("2026-11-11")
	doneAfter := *doneBefore
	doneAfter.Completed = sp("2026-11-12")

	// 8: the same entry, edited in every way ChangeText reports.
	edited := *base
	edited.Title, edited.Kind, edited.Status = "Wardrobe carcass", entries.KindDecision, "decided"
	edited.Room, edited.Category = sp("bedroom 2"), "carpentry"
	edited.Cost = entries.Cost{Estimate: fp(1300), Actual: nil}
	edited.Date, edited.Time = sp("2026-12-05"), sp("09:30")
	edited.Vendor, edited.Source, edited.Notes = "Hock Seng", "", ""
	edited.Tags = []string{"wardrobe"}
	edited.Milestone = true

	// 9: a milestone removed.
	starBefore := entry("TV console")
	starBefore.Milestone = true
	starAfter := *starBefore
	starAfter.Milestone = false

	// 10: an archived entry edited at the same time: the archive line wins.
	archiveEditBefore := entry("Old sofa")
	archiveEditAfter := *archiveEditBefore
	archiveEditAfter.Archived, archiveEditAfter.Title = true, "Old sofa (sold)"

	// 11: the no-diff case: only the stamps moved.
	same := entry("Sofa")
	sameLater := *same
	sameLater.Updated = "2026-11-12T11:00:00Z"

	// 12: a create whose date has no time but a cost, so Summary keeps order.
	ordered := entry("Curtains")
	ordered.Kind, ordered.Status = entries.KindQuestion, "shortlisted"
	ordered.Room = sp("living")
	ordered.Date, ordered.Vendor = sp("2026-12-05"), "Curtain World"
	ordered.Cost = entries.Cost{Estimate: fp(999.999)}
	ordered.Tags = []string{"curtain"}

	changes := []entries.Change{
		change("create", nil, rich),
		change("create", nil, plain),
		change("create", nil, odd),
		change("create", nil, dated),
		change("create", nil, ordered),
		change("delete", plain, nil),
		change("undo", nil, plain),
		change("undo", plain, nil),
		change("undo", base, &edited),
		update(archiveBefore, &archiveAfter),
		update(restoreBefore, &restoreAfter),
		update(doneBefore, &doneAfter),
		update(base, &edited),
		update(starBefore, &starAfter),
		update(archiveEditBefore, &archiveEditAfter),
		update(same, &sameLater),
		// One field at a time, so every add() branch is its own line.
		updateWith(base, func(e *entries.Entry) { e.Title = "Wardrobe (fitted)" }),
		updateWith(base, func(e *entries.Entry) { e.Kind, e.Status = entries.KindDecision, "decided" }),
		updateWith(base, func(e *entries.Entry) { e.Status = "done"; e.Completed = sp("2026-11-12") }),
		updateWith(base, func(e *entries.Entry) { e.Room = sp("bedroom 2") }),
		updateWith(base, func(e *entries.Entry) { e.Room = nil }),
		updateWith(base, func(e *entries.Entry) { e.Category = "joinery" }),
		updateWith(base, func(e *entries.Entry) { e.Cost.Estimate = fp(1300) }),
		updateWith(base, func(e *entries.Entry) { e.Cost.Actual = nil }),
		updateWith(base, func(e *entries.Entry) { e.Date = sp("2026-12-05") }),
		updateWith(base, func(e *entries.Entry) { e.Time = sp("11:00") }),
		updateWith(base, func(e *entries.Entry) { e.Vendor = "Hock Seng" }),
		updateWith(base, func(e *entries.Entry) { e.Source = "" }),
		updateWith(base, func(e *entries.Entry) { e.Notes = "" }),
		updateWith(base, func(e *entries.Entry) { e.Tags = []string{"oak"} }),
		updateWith(base, func(e *entries.Entry) { e.Milestone = true }),
		updateWithDated(base, func(e *entries.Entry) { e.Completed = sp("2026-11-13") }),
	}
	texts := make([]string, len(changes))
	for i, c := range changes {
		texts[i] = agent.ChangeText(c)
	}

	money := []moneyCase{}
	for _, f := range []float64{
		0, 0.005, 0.01, 0.1, 0.995, 0.999, 12.345, 99.99, 100.005, 999.999,
		1200, 1234.5, 5400.5, 1e6, 1234567.5, -0.005, -1.5, -1234.5678,
	} {
		money = append(money, moneyCase{In: f, Out: agent.Money(f)})
	}

	return changeText{
		FmtDate:     dateTable(),
		Money:       money,
		Doc:         &entries.Doc{Schema: 1, Meta: entries.Meta{}, Entries: []entries.Entry{}, Changes: changes},
		ChangeTexts: texts,
	}
}

// updateWith is update for a base entry edited by mutate; the copy is deep
// enough for these fields (Cost is a value, Tags is replaced, never changed).
func updateWith(base *entries.Entry, mutate func(*entries.Entry)) entries.Change {
	after := *base
	after.Tags = append([]string{}, base.Tags...)
	mutate(&after)
	return update(base, &after)
}

// updateWithDated is updateWith for the base entry in done state, so a change of
// the completed day alone is the "done on" branch.
func updateWithDated(base *entries.Entry, mutate func(*entries.Entry)) entries.Change {
	before := *base
	before.Status, before.Completed = "done", sp("2026-11-12")
	after := before
	after.Tags = append([]string{}, before.Tags...)
	mutate(&after)
	return update(&before, &after)
}

// dateTable reads fmtDate through agent.Summary, its only exported caller: a
// one-entry Summary prints the entry's date (and time) as fmtDate does.
func dateTable() []dateCase {
	out := []dateCase{}
	for _, d := range []string{
		"2026-11-20", "2026-01-01", "2026-12-31", "2026-02-28", "2026-02-29",
		"2026-2-3", "2026-13-01", "tomorrow", "", "2026-11-20T00:00:00Z",
	} {
		e := entry("x")
		e.Date = sp(d)
		out = append(out, dateCase{In: d, Out: summaryDate(agent.Summary(*e))})
	}
	return out
}

// summaryDate is the date part of "task · x · <date>" (or the whole line when
// Summary printed no date, which happens for an empty string).
func summaryDate(s string) string {
	parts := strings.Split(s, " · ")
	return parts[len(parts)-1]
}

// ---------- output ----------

func writeFile(path string, v any) int {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		panic(err)
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		panic(err)
	}
	return len(b)
}

func main() {
	out := flag.String("out", "app/src/server/testdata/transcript.go.json", "where the transcript goes")
	changeOut := flag.String("changetext-out", "app/src/server/testdata/changetext.go.json", "where the change-line table goes")
	flag.Parse()

	srv := setup()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	rows := runScript(ts)
	fmt.Printf("transcript: %d requests → %s (%d bytes)\n", len(rows), *out, writeFile(*out, rows))

	ct := changeTextFixture()
	fmt.Printf("change lines: %d changes → %s (%d bytes)\n", len(ct.ChangeTexts), *changeOut, writeFile(*changeOut, ct))

	var buf bytes.Buffer
	for _, r := range rows {
		fmt.Fprintf(&buf, "%-24s %-6s %-32s %d %6d\n", r.Name, r.Method, r.Path, r.Status, len(r.AnswerBody))
	}
	fmt.Print(buf.String())
}
