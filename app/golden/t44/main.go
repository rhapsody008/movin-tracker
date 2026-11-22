//go:build ignore

// Command t44-golden prints Go's authoritative answers for T4.4: the help text,
// the `/recent` line assembly (including the zone Go formats it in), and the two
// document formatters `/sync` uses. A golden generator of the v3 port
// (app/golden/README.md): it needs the Go code, so run it before T7 deletes it.
//
// These are unexported in internal/telegram, so they are copied here verbatim
// with the lines they come from:
//
//	helpText  commands.go:24-40
//	recent's loop body (the line, not the entries read)  commands.go:84-96
//	counts    docs.go:81-95
//	docList   docs.go:97-119
//
// The `at` formatting is Go's own `time.Parse` / `Format("Mon 2 Jan 15:04")` in
// a real location, which is what the port has to reproduce with Intl.
//
// Run from the repo root, in the Go tools container, and compare stdout with
// the committed fixture:
//
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t44/main.go' | cmp - app/src/telegram/testdata/commands.go.json
//
// It writes no file itself: stdout is app/src/telegram/testdata/commands.go.json.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/docs"
	"github.com/rhapsody008/movin-tracker/internal/entries"
)

// helpText is commands.go:24-40, verbatim.
const helpText = `Tell me what's happening with the renovation and I'll keep the record: ideas, decisions, quotes, payments, dates, open questions. Ask me anything about it too.

Examples:
• Thinking of fluted glass for the dry kitchen sliding door
• Lim quoted 18k for carpentry, paid 30% today
• Electrician coming Friday 2pm to check the DB
• What did we decide for the kitchen and what did it cost?

Every change comes back with an Undo button.
/think   start a message with it when I should think it through first (slower), e.g. /think compare the two zip blind quotes
/recent  the last 10 changes
/undo    undo your last change
/sync    re-read the documents now (they also sync every night)
/checkin today's tasks and yesterday's open ones, with Done buttons (also sent every morning)
/help    this message`

type golden struct {
	HelpText string        `json:"help_text"`
	Recent   []recentCase  `json:"recent"`
	Counts   []countsCase  `json:"counts"`
	DocList  []docListCase `json:"doc_list"`
}

// recentCase is one journal record as `/recent` shows it. The port builds the
// same change from these fields, so the inputs travel with the answer.
type recentCase struct {
	At      string `json:"at"`
	By      string `json:"by"`
	Channel string `json:"channel"`
	Title   string `json:"title"`
	Loc     string `json:"loc"`
	Out     string `json:"out"`
}

type countsCase struct {
	Added   int    `json:"added"`
	Changed int    `json:"changed"`
	Removed int    `json:"removed"`
	Failed  int    `json:"failed"`
	Out     string `json:"out"`
}

// docCase is one index record, as docList reads it.
type docCase struct {
	Key    string `json:"key"`
	Class  string `json:"class"`
	Status string `json:"status"`
	Error  string `json:"error"`
}

type docListCase struct {
	Docs []docCase `json:"docs"`
	Max  int       `json:"max"`
	Out  string    `json:"out"`
}

func main() {
	g := golden{
		HelpText: helpText,
		Recent:   recentCases(),
		Counts: []countsCase{
			{0, 0, 0, 0, "nothing changed"},
			{1, 0, 0, 0, "1 added"},
			{0, 2, 0, 0, "2 changed"},
			{0, 0, 3, 0, "3 removed"},
			{0, 0, 0, 4, "4 failed"},
			{2, 1, 1, 1, "2 added, 1 changed, 1 removed, 1 failed"},
			// The order is added, changed, removed, failed — not any other.
			{1, 2, 3, 4, "1 added, 2 changed, 3 removed, 4 failed"},
			{0, 5, 0, 1, "5 changed, 1 failed"},
		},
		DocList: docListCases(),
	}
	out, err := json.MarshalIndent(g, "", "  ")
	if err != nil {
		fail(err)
	}
	fmt.Println(string(out))
}

// recentCases runs commands.go:84-96 over records whose only interesting fields
// are the ones printed.
func recentCases() []recentCase {
	type in struct {
		at, by, channel, title, loc string
	}
	cases := []in{
		// The plain case: a Telegram write in the app's own zone.
		{"2026-11-12T14:00:00Z", "Partner", "telegram", "Theirs", "Asia/Singapore"},
		// A web write says so.
		{"2026-11-12T14:00:00Z", "zy@example.com", "web", "From web", "Asia/Singapore"},
		// The same instant in a zone west of UTC: the day moves back.
		{"2026-11-12T02:00:00Z", "ZY", "telegram", "Late", "America/New_York"},
		// An `at` with its own offset is normalised into the location.
		{"2026-11-12T23:30:00+08:00", "ZY", "telegram", "Offset", "UTC"},
		// A fractional second and a negative offset, as a stored stamp can have them.
		{"2026-11-12T23:30:00.250-05:00", "ZY", "telegram", "Fraction", "Asia/Singapore"},
		// Midnight is 00:00, not 24:00.
		{"2026-11-11T16:00:00Z", "ZY", "telegram", "Midnight", "Asia/Singapore"},
		// A single-digit day is not zero padded.
		{"2026-12-05T09:05:00Z", "ZY", "telegram", "Early", "UTC"},
		// Not RFC 3339: Go shows the string as it is.
		{"2026-11-12 14:00", "ZY", "telegram", "Broken", "UTC"},
		// A day the month does not have is not RFC 3339 either.
		{"2026-02-30T14:00:00Z", "ZY", "telegram", "No such day", "UTC"},
	}
	out := make([]recentCase, 0, len(cases))
	for _, c := range cases {
		loc, err := time.LoadLocation(c.loc)
		if err != nil {
			fail(err)
		}
		change := entries.Change{ID: "01K8ZQ4R7S9T2V5W8X1Y3Z5A6B", At: c.at, By: c.by, Channel: c.channel,
			Op: "create", EntryID: "01K8ZQ4R7S9T2V5W8X1Y3Z5A6C", After: &entries.Entry{Kind: entries.KindNote, Title: c.title}}
		// commands.go:84-96, verbatim (the change text included).
		at := change.At
		if t, err := time.Parse(time.RFC3339, change.At); err == nil {
			at = t.In(loc).Format("Mon 2 Jan 15:04")
		}
		via := ""
		if change.Channel == "web" {
			via = " (web)"
		}
		line := fmt.Sprintf("• %s — %s%s, %s", agent.ChangeText(change), change.By, via, at)
		out = append(out, recentCase{At: c.at, By: c.by, Channel: c.channel, Title: c.title, Loc: c.loc, Out: line})
	}
	return out
}

// docListCases exercises every state suffix and the `…and n more` cut.
func docListCases() []docListCase {
	readable := func(key string) docCase { return docCase{Key: key, Class: docs.ClassText, Status: docs.StatusOK} }
	scanned := func(key string) docCase {
		return docCase{Key: key, Class: docs.ClassScanned, Status: docs.StatusOK}
	}
	return []docListCase{
		// No documents: no lines at all, not a blank one.
		{Docs: nil, Max: 10, Out: ""},
		{Docs: []docCase{readable("docs/raw/Fridge.pdf")}, Max: 10, Out: "• Fridge.pdf"},
		// The folder goes: only the file name is shown.
		{Docs: []docCase{readable("docs/raw/kitchen/Fridge manual.pdf")}, Max: 10, Out: "• Fridge manual.pdf"},
		{Docs: []docCase{
			readable("docs/raw/Fridge.pdf"),
			{Key: "docs/raw/Oven.pdf", Class: docs.ClassText, Status: docs.StatusFailed, Error: "conversion failed"},
			{Key: "docs/raw/Old quote.pdf", Class: docs.ClassText, Status: docs.StatusRemoved},
		}, Max: 10, Out: "• Fridge.pdf\n• Oven.pdf (couldn't be read)\n• Old quote.pdf (removed)"},
		// A scanned document that is readable still says it is not searchable.
		{Docs: []docCase{scanned("docs/raw/Leaflet.pdf")}, Max: 10, Out: "• Leaflet.pdf (pictures only: not searchable yet)"},
		// A readable document keeping its last failure.
		{Docs: []docCase{
			{Key: "docs/raw/Fridge.pdf", Class: docs.ClassText, Status: docs.StatusOK, Error: "the last read failed"},
		}, Max: 10, Out: "• Fridge.pdf (the new version couldn't be read; the previous one is still used)"},
		// Failed wins over the kept-error line, and removed wins over both.
		{Docs: []docCase{
			{Key: "docs/raw/A.pdf", Class: docs.ClassScanned, Status: docs.StatusFailed, Error: "x"},
			{Key: "docs/raw/B.pdf", Class: docs.ClassScanned, Status: docs.StatusRemoved, Error: "x"},
		}, Max: 10, Out: "• A.pdf (couldn't be read)\n• B.pdf (removed)"},
		// The cut comes after max lines and counts what is left.
		{Docs: []docCase{
			readable("docs/raw/A.pdf"),
			readable("docs/raw/B.pdf"),
			readable("docs/raw/C.pdf"),
			readable("docs/raw/D.pdf"),
			readable("docs/raw/E.pdf"),
		}, Max: 2, Out: "• A.pdf\n• B.pdf\n…and 3 more"},
		// max larger than the list: no cut line.
		{Docs: []docCase{readable("docs/raw/A.pdf"), readable("docs/raw/B.pdf")}, Max: 15, Out: "• A.pdf\n• B.pdf"},
		// Exactly max documents: no cut line either.
		{Docs: []docCase{readable("docs/raw/A.pdf"), readable("docs/raw/B.pdf")}, Max: 2, Out: "• A.pdf\n• B.pdf"},
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
