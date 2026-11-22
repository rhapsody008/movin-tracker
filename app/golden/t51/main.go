//go:build ignore

// Command t51-golden prints Go's authoritative answers for T5.1a: the morning
// check-in's summary and per-task texts, the `ci:` keyboards, the checkin.json
// bytes, the due window, the record state rules and the `ci:` callback parse. A
// golden generator of the v3 port (app/golden/README.md): it needs the Go code,
// so run it before T7 deletes it.
//
// The text, keyboard and parsing functions are unexported in internal/telegram,
// so they are copied here verbatim with the lines they come from:
//
//	maxAskMessages / maxOverdueTitles / checkinPrefix  checkin.go:24-30
//	shortDay                                          checkin.go:66-72
//	agendaLine                                        checkin.go:74-83
//	checkinText                                       checkin.go:86-123
//	askText                                           checkin.go:125-131
//	askKeyboard                                       checkin.go:136-144
//	orNone                                            checkin.go:298-303
//	staleAsk                                          checkin.go:294-296
//	the `ci:` parse (callback data → patch)           checkin.go:223-253
//	split                                             bot.go:615-636
//
// and the two turns sendCheckin remembers, also verbatim (checkin.go:154-189):
// the summary parts joined into `lead`, and `Asked about:` with one line per
// ask. Go hands them to agent.remember as two turns; the port adds one note, so
// the note's text is Go's literal `(morning check-in)` and the reply joined by a
// blank line (decisions.md · T5.1a).
//
// Everything else is Go's own exported code: CheckinDue, CheckinStore.Load /
// Claim / Finish / Release, CheckinRecord.Finished / Taken / NextSince,
// entries.Doc.Agenda, sched.Day, sched.AddDays, objstore.NewMemory.
//
// Run from the repo root, in the Go tools container, and compare stdout with
// the committed fixture:
//
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t51/main.go' | cmp - app/src/telegram/testdata/checkin.go.json
//
// It writes no file itself: stdout is app/src/telegram/testdata/checkin.go.json.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/sched"
	"github.com/rhapsody008/movin-tracker/internal/telegram"
)

// checkin.go:24-30.
const (
	maxAskMessages   = 8
	maxOverdueTitles = 5
	checkinPrefix    = "ci:"
)

// bot.go:85-94.
const maxMessage = 4000

// The fixed clock and chat every check-in case uses: 09:30 on Thursday
// 12 November 2026 (the Go tests' ciNow, checkin_test.go:17).
const (
	ciNow  = "2026-11-12T09:30:00Z"
	ciDay  = "2026-11-12"
	ciChat = "-1001234567890"
	ciLoc  = "Asia/Singapore"
)

type golden struct {
	Constants   constants      `json:"constants"`
	Toasts      toasts         `json:"toasts"`
	Checkin     []checkinCase  `json:"checkin"`
	Keyboard    []keyboardCase `json:"keyboard"`
	Records     []recordCase   `json:"records"`
	RecordState []stateCase    `json:"record_state"`
	Due         []dueCase      `json:"due"`
	Callbacks   callbackFile   `json:"callbacks"`
}

type constants struct {
	MaxAskMessages    int    `json:"max_ask_messages"`
	MaxOverdueTitles  int    `json:"max_overdue_titles"`
	Prefix            string `json:"prefix"`
	MaxMessage        int    `json:"max_message"`
	StaleClaimSeconds int    `json:"stale_claim_seconds"`
	CheckinCutoff     int    `json:"checkin_cutoff"`
}

// toasts are the answers a stale `ci:` press shows (checkin.go:281-290).
type toasts struct {
	Archived     string `json:"archived"`
	AlreadyDone  string `json:"already_done"`
	MovedDated   string `json:"moved_dated"`
	MovedUndated string `json:"moved_undated"`
}

// docEntry is one entry of the document an agenda is built from: the fields the
// texts read, as plain strings ("" for Go's nil).
type docEntry struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Title    string `json:"title"`
	Date     string `json:"date"`
	Time     string `json:"time"`
	Room     string `json:"room"`
	Status   string `json:"status"`
	Archived bool   `json:"archived"`
	Created  string `json:"created"`
}

// messageCase is one message Go's sendCheckin sends: the summary parts have no
// keyboard, each ask carries its own.
type messageCase struct {
	Text     string                         `json:"text"`
	Keyboard *telegram.InlineKeyboardMarkup `json:"keyboard"`
}

// checkinCase is one agenda through the whole text assembly.
type checkinCase struct {
	Name     string        `json:"name"`
	Today    string        `json:"today"`
	Since    string        `json:"since"`
	Doc      []docEntry    `json:"doc"`
	Summary  string        `json:"summary"`
	Messages []messageCase `json:"messages"`
	Note     string        `json:"note"`
}

type keyboardCase struct {
	ID       string                         `json:"id"`
	Date     string                         `json:"date"`
	Keyboard *telegram.InlineKeyboardMarkup `json:"keyboard"`
	Longest  int                            `json:"longest_callback_bytes"`
}

// recordStep is one store operation of a record case, so the port replays the
// same sequence instead of a hand-written expectation.
type recordStep struct {
	Op     string `json:"op"` // claim | finish | release
	Day    string `json:"day,omitempty"`
	Chat   string `json:"chat,omitempty"`
	Status string `json:"status,omitempty"`
	Now    string `json:"now"`
}

type recordCase struct {
	Name  string       `json:"name"`
	Steps []recordStep `json:"steps"`
	JSON  string       `json:"json"`
}

// stateCase is one checkin.json as read, with Finished / Taken / NextSince.
type stateCase struct {
	JSON      string `json:"json"`
	Day       string `json:"day"`
	Now       string `json:"now"`
	Error     string `json:"error,omitempty"`
	Finished  bool   `json:"finished"`
	Taken     bool   `json:"taken"`
	NextSince string `json:"next_since"`
}

type dueCase struct {
	At     string `json:"at"`
	Hour   int    `json:"hour"`
	Minute int    `json:"minute"`
	Loc    string `json:"loc"`
	Out    bool   `json:"out"`
}

type callbackFile struct {
	Now   string         `json:"now"`
	Loc   string         `json:"loc"`
	Cases []callbackCase `json:"cases"`
}

type callbackCase struct {
	Data  string `json:"data"`
	Kind  string `json:"kind"` // ack | done | milestone | move
	ID    string `json:"id,omitempty"`
	Asked string `json:"asked,omitempty"`
	Days  int    `json:"days,omitempty"`
	Date  string `json:"date,omitempty"`
}

func main() {
	g := golden{
		Constants: constants{
			MaxAskMessages:    maxAskMessages,
			MaxOverdueTitles:  maxOverdueTitles,
			Prefix:            checkinPrefix,
			MaxMessage:        maxMessage,
			StaleClaimSeconds: int(telegram.StaleClaim / time.Second),
			CheckinCutoff:     sched.CheckinCutoff,
		},
		Toasts:      toastCases(),
		Checkin:     checkinCases(),
		Keyboard:    keyboardCases(),
		Records:     recordCases(),
		RecordState: stateCases(),
		Due:         dueCases(),
		Callbacks:   callbackCases(),
	}
	out, err := json.MarshalIndent(g, "", "  ")
	if err != nil {
		fail(err)
	}
	fmt.Println(string(out))
}

// ---------- the copied functions ----------

// shortDay is "Wed 11 Nov" (checkin.go:66-72).
func shortDay(day string) string {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return day
	}
	return t.Format("Mon 2 Jan")
}

// agendaLine (checkin.go:74-83), verbatim.
func agendaLine(e entries.Entry) string {
	s := e.Title
	if e.Time != nil {
		s = *e.Time + " " + s
	}
	if e.Room != nil {
		s += " (" + *e.Room + ")"
	}
	return s
}

// checkinText (checkin.go:86-123), verbatim.
func checkinText(today string, ag entries.Agenda) (summary string, asks []entries.Entry) {
	var b strings.Builder
	fmt.Fprintf(&b, "Good morning! %s\n", shortDay(today))
	if len(ag.Today) > 0 {
		b.WriteString("\nToday:\n")
		for _, e := range ag.Today {
			b.WriteString("• " + agendaLine(e) + "\n")
		}
	} else {
		b.WriteString("\nNothing dated for today.\n")
	}
	asks = ag.Ask
	var more []entries.Entry
	if len(asks) > maxAskMessages {
		asks, more = asks[:maxAskMessages], asks[maxAskMessages:]
	}
	if len(asks) > 0 {
		fmt.Fprintf(&b, "\nNot marked done yet (%d), below. Tap a button or just tell me.\n", len(ag.Ask))
	}
	if len(more) > 0 {
		b.WriteString("Also open from earlier days:\n")
		for _, e := range more {
			b.WriteString("• " + agendaLine(e) + " — " + shortDay(*e.Date) + "\n")
		}
	}
	if n := len(ag.Overdue); n > 0 {
		fmt.Fprintf(&b, "\nStill overdue (%d):\n", n)
		for i, e := range ag.Overdue {
			if i == maxOverdueTitles {
				fmt.Fprintf(&b, "…and %d more\n", n-maxOverdueTitles)
				break
			}
			b.WriteString("• " + agendaLine(e) + " — " + shortDay(*e.Date) + "\n")
		}
	}
	b.WriteString("\nAnything else, just say it, e.g. \"move the tiler to Friday\".")
	return b.String(), asks
}

// askText (checkin.go:125-131), verbatim.
func askText(e entries.Entry, today string) string {
	when := shortDay(*e.Date)
	if *e.Date == sched.AddDays(today, -1) {
		when = "Yesterday"
	}
	return when + ": " + agendaLine(e) + "\nDone?"
}

// askKeyboard (checkin.go:136-144), verbatim.
func askKeyboard(e entries.Entry) *telegram.InlineKeyboardMarkup {
	base := e.ID + ":" + strings.ReplaceAll(*e.Date, "-", "")
	return &telegram.InlineKeyboardMarkup{InlineKeyboard: [][]telegram.InlineKeyboardButton{{
		{Text: "Done", CallbackData: checkinPrefix + "d:" + base},
		{Text: "Done ★", CallbackData: checkinPrefix + "m:" + base},
		{Text: "Tomorrow", CallbackData: checkinPrefix + "r:" + base + ":1"},
		{Text: "+1 week", CallbackData: checkinPrefix + "r:" + base + ":7"},
	}}}
}

// split (bot.go:615-636), verbatim.
func split(s string, n int) []string {
	r := []rune(s)
	var out []string
	for len(r) > n {
		cut := n
		for i := n; i > n/2; i-- {
			if r[i] == '\n' {
				cut = i
				break
			}
		}
		out = append(out, strings.TrimRight(string(r[:cut]), "\n"))
		r = r[cut:]
		for len(r) > 0 && r[0] == '\n' {
			r = r[1:]
		}
	}
	if len(r) > 0 || len(out) == 0 {
		out = append(out, string(r))
	}
	return out
}

// staleAsk (checkin.go:294-296), verbatim.
type staleAsk string

func (s staleAsk) Error() string { return string(s) }

// orNone (checkin.go:298-303), verbatim.
func orNone(p *string) string {
	if p == nil {
		return "no date"
	}
	return shortDay(*p)
}

// parseCheckin is the parsing and switch of checkinCallback (checkin.go:223-253),
// verbatim: the answer is which patch it builds, or the bare ack.
func parseCheckin(data string, now time.Time, loc *time.Location) callbackCase {
	c := callbackCase{Data: data, Kind: "ack"}
	parts := strings.Split(strings.TrimPrefix(data, checkinPrefix), ":")
	if len(parts) < 3 || len(parts[2]) != 8 {
		return c
	}
	op, id := parts[0], parts[1]
	asked := parts[2][:4] + "-" + parts[2][4:6] + "-" + parts[2][6:]
	if !entries.ValidDate(asked) {
		return c
	}
	switch op {
	case "d":
		c.Kind, c.ID, c.Asked = "done", id, asked
	case "m":
		c.Kind, c.ID, c.Asked = "milestone", id, asked
	case "r":
		days := 0
		if len(parts) == 4 {
			days, _ = strconv.Atoi(parts[3])
		}
		if days < 1 || days > 31 {
			return c
		}
		c.Kind, c.ID, c.Asked, c.Days = "move", id, asked, days
		c.Date = sched.AddDays(sched.Day(now, loc), days)
	}
	return c
}

// ---------- the cases ----------

// ulid is a plausible 26-character entries id.
func ulid(n int) string { return fmt.Sprintf("01K8ZQ4R7S9T2V5W8X1Y3Z5A%02d", n) }

func task(n int, title, date string, extra ...string) docEntry {
	e := docEntry{ID: ulid(n), Kind: "task", Title: title, Date: date, Status: "todo", Created: fmt.Sprintf("2026-11-01T00:00:%02dZ", n)}
	for i := 0; i+1 < len(extra); i += 2 {
		switch extra[i] {
		case "time":
			e.Time = extra[i+1]
		case "room":
			e.Room = extra[i+1]
		case "kind":
			e.Kind = extra[i+1]
		}
	}
	return e
}

// mk turns a docEntry into the Go entry the agenda holds.
func mk(d docEntry) entries.Entry {
	e := entries.Entry{ID: d.ID, Kind: d.Kind, Title: d.Title, Status: d.Status, Archived: d.Archived, Created: d.Created}
	if d.Date != "" {
		date := d.Date
		e.Date = &date
	}
	if d.Time != "" {
		t := d.Time
		e.Time = &t
	}
	if d.Room != "" {
		r := d.Room
		e.Room = &r
	}
	return e
}

func checkinCases() []checkinCase {
	type in struct {
		name, today, since string
		doc                []docEntry
	}
	var ten []docEntry
	for i := 1; i <= 10; i++ {
		ten = append(ten, task(i, fmt.Sprintf("Task %02d", i), "2026-11-11"))
	}
	var overdue []docEntry
	for i := 1; i <= 7; i++ {
		overdue = append(overdue, task(i, fmt.Sprintf("Old %d", i), fmt.Sprintf("2026-11-%02d", 3+i)))
	}
	cases := []in{
		// Nothing at all.
		{name: "empty", today: "2026-11-12"},
		// Three tasks from yesterday: three ask messages.
		{name: "three_asks", today: "2026-11-12", doc: []docEntry{
			task(1, "Book movers", "2026-11-11"),
			task(2, "Order tiles", "2026-11-11"),
			task(3, "Measure windows", "2026-11-11"),
		}},
		// Ten asks: eight messages, the rest listed in the summary.
		{name: "ten_asks", today: "2026-11-12", doc: ten},
		// Seven overdue: five listed, then `…and 2 more`.
		{name: "seven_overdue", today: "2026-11-12", doc: overdue},
		// A day further back is labelled by its own short day.
		{name: "missed_days", today: "2026-11-16", since: "2026-11-14", doc: []docEntry{
			task(1, "Paint touch-up", "2026-11-14"),
			task(2, "Sweep", "2026-11-15"),
		}},
		// Today's entries with a time and a room, and an ask with a room.
		{name: "room_and_time", today: "2026-11-12", doc: []docEntry{
			task(1, "Electrician", "2026-11-12", "time", "14:00"),
			task(2, "Fridge delivery", "2026-11-12", "time", "09:00", "room", "dry kitchen"),
			task(3, "Pick grout colour", "2026-11-12", "kind", "question"),
			task(4, "Measure windows", "2026-11-11", "room", "living"),
		}},
	}
	out := make([]checkinCase, 0, len(cases))
	for _, c := range cases {
		out = append(out, one(c.name, c.today, c.since, c.doc))
	}
	return out
}

// one runs one agenda through checkinText, askText, askKeyboard and split, then
// joins what sendCheckin would remember (checkin.go:154-189).
func one(name, today, since string, doc []docEntry) checkinCase {
	ents := make([]entries.Entry, 0, len(doc))
	for _, d := range doc {
		ents = append(ents, mk(d))
	}
	ag := (&entries.Doc{Entries: ents}).Agenda(today, since)
	summary, asks := checkinText(today, ag)
	var messages []messageCase
	var lead strings.Builder
	for _, p := range split(summary, maxMessage) {
		messages = append(messages, messageCase{Text: p})
		lead.WriteString(p)
	}
	var asked []string
	for _, e := range asks {
		txt := askText(e, today)
		messages = append(messages, messageCase{Text: txt, Keyboard: askKeyboard(e)})
		asked = append(asked, "• "+strings.ReplaceAll(txt, "\nDone?", ""))
	}
	reply := lead.String()
	if len(asked) > 0 {
		reply += "\n\nAsked about:\n" + strings.Join(asked, "\n")
	}
	return checkinCase{Name: name, Today: today, Since: since, Doc: doc, Summary: summary, Messages: messages,
		Note: "(morning check-in)\n\n" + reply}
}

func keyboardCases() []keyboardCase {
	list := []docEntry{
		task(1, "Book movers", "2026-11-11"),
		task(7, "Order tiles", "2026-11-11", "room", "living"),
	}
	out := make([]keyboardCase, 0, len(list))
	for _, d := range list {
		e := mk(d)
		kb := askKeyboard(e)
		longest := 0
		for _, row := range kb.InlineKeyboard {
			for _, b := range row {
				if n := len(b.CallbackData); n > longest {
					longest = n
				}
			}
		}
		out = append(out, keyboardCase{ID: e.ID, Date: *e.Date, Keyboard: kb, Longest: longest})
	}
	return out
}

func recordCases() []recordCase {
	cases := []struct {
		name  string
		steps []recordStep
	}{
		// The first ever: no window yet, so `since` is omitted.
		{"sending_first", []recordStep{
			{Op: "claim", Day: ciDay, Chat: ciChat, Now: "2026-11-12T01:30:00Z"},
		}},
		// No chat configured either: both optional fields are omitted.
		{"sending_first_no_chat", []recordStep{
			{Op: "claim", Day: ciDay, Now: "2026-11-12T01:30:00Z"},
		}},
		{"sent_first", []recordStep{
			{Op: "claim", Day: ciDay, Chat: ciChat, Now: "2026-11-12T01:30:00Z"},
			{Op: "finish", Status: "sent", Now: "2026-11-12T01:31:00Z"},
		}},
		// The next morning asks from the 12th.
		{"sending_next_day", []recordStep{
			{Op: "claim", Day: "2026-11-12", Chat: ciChat, Now: "2026-11-12T01:30:00Z"},
			{Op: "finish", Status: "sent", Now: "2026-11-12T01:31:00Z"},
			{Op: "claim", Day: "2026-11-13", Chat: "-100999", Now: "2026-11-13T01:30:00Z"},
		}},
		{"quiet_next_day", []recordStep{
			{Op: "claim", Day: "2026-11-12", Chat: ciChat, Now: "2026-11-12T01:30:00Z"},
			{Op: "finish", Status: "quiet", Now: "2026-11-12T01:31:00Z"},
			{Op: "claim", Day: "2026-11-13", Chat: ciChat, Now: "2026-11-13T01:30:00Z"},
			{Op: "finish", Status: "quiet", Now: "2026-11-13T01:31:00Z"},
		}},
		// A first-ever claim that crashed, taken over within the day: the window
		// stays empty (so the takeover asks about yesterday), not the day itself.
		{"takeover_of_a_crashed_first_ever", []recordStep{
			{Op: "claim", Day: ciDay, Chat: ciChat, Now: "2026-11-12T01:30:00Z"},
			{Op: "claim", Day: ciDay, Chat: ciChat, Now: "2026-11-12T01:41:00Z"},
		}},
		// Giving back the first ever leaves an empty record (no conditional delete).
		{"released_first_ever", []recordStep{
			{Op: "claim", Day: ciDay, Chat: ciChat, Now: "2026-11-12T01:30:00Z"},
			{Op: "release", Now: "2026-11-12T01:31:00Z"},
		}},
	}
	out := make([]recordCase, 0, len(cases))
	for _, c := range cases {
		out = append(out, recordCase{Name: c.name, Steps: c.steps, JSON: runSteps(c.steps)})
	}
	return out
}

// runSteps applies the steps with Go's own store and returns checkin.json's bytes.
func runSteps(steps []recordStep) string {
	ctx := context.Background()
	store := objstore.NewMemory()
	cs := &telegram.CheckinStore{Store: store}
	var claim *telegram.CheckinClaim
	for _, s := range steps {
		now := mustTime(s.Now)
		switch s.Op {
		case "claim":
			c, _, err := cs.Claim(ctx, s.Day, s.Chat, now)
			if err != nil {
				fail(err)
			}
			if c == nil {
				fail(fmt.Errorf("the claim of %s was refused", s.Day))
			}
			claim = c
		case "finish":
			if err := cs.Finish(ctx, claim, s.Status, now); err != nil {
				fail(err)
			}
		case "release":
			if err := cs.Release(ctx, claim); err != nil {
				fail(err)
			}
		default:
			fail(fmt.Errorf("unknown step %q", s.Op))
		}
	}
	body, _, err := store.Get(ctx, telegram.CheckinKey)
	if err != nil {
		fail(err)
	}
	return string(body)
}

func stateCases() []stateCase {
	type in struct{ json, day, now string }
	list := []in{
		// A fresh claim held for nine minutes: taken, and the next one asks its own window.
		{`{"schema":1,"day":"2026-11-12","status":"sending","at":"2026-11-12T01:20:00Z","chat":"1"}`, "2026-11-12", "2026-11-12T01:29:00Z"},
		// Exactly StaleClaim old: takeable.
		{`{"schema":1,"day":"2026-11-12","status":"sending","at":"2026-11-12T01:20:00Z","chat":"1"}`, "2026-11-12", "2026-11-12T01:30:00Z"},
		// An `at` Go can't parse (and one with milliseconds, which RFC 3339 has not): not taken.
		{`{"schema":1,"day":"2026-11-12","status":"sending","at":"yesterday"}`, "2026-11-12", "2026-11-12T01:29:00Z"},
		{`{"schema":1,"day":"2026-11-12","status":"sending","at":"2026-11-12T01:30:00.500Z"}`, "2026-11-12", "2026-11-12T01:29:00Z"},
		// A crashed claim's own window is asked again.
		{`{"schema":1,"day":"2026-11-12","status":"sending","since":"2026-11-09","at":"2026-11-12T01:20:00Z"}`, "2026-11-12", "2026-11-12T01:25:00Z"},
		// Finished days.
		{`{"schema":1,"day":"2026-11-12","status":"sent","at":"2026-11-12T01:30:00Z","chat":"-100"}`, "2026-11-12", "2026-11-12T14:00:00Z"},
		{`{"schema":1,"day":"2026-11-12","status":"quiet","at":"2026-11-12T01:30:00Z"}`, "2026-11-12", "2026-11-12T01:31:00Z"},
		// Yesterday's record: today is not finished, and asks from the 11th.
		{`{"schema":1,"day":"2026-11-11","status":"sent","at":"2026-11-11T01:30:00Z"}`, "2026-11-13", "2026-11-13T01:30:00Z"},
		// No record at all.
		{`{}`, "2026-11-12", "2026-11-12T01:30:00Z"},
		// A field of the wrong type: Go's decode error.
		{`{"schema":"x"}`, "2026-11-12", "2026-11-12T01:30:00Z"},
	}
	out := make([]stateCase, 0, len(list))
	for _, c := range list {
		out = append(out, oneState(c.json, c.day, c.now))
	}
	return out
}

func oneState(body, day, nowText string) stateCase {
	ctx := context.Background()
	store := objstore.NewMemory()
	if _, err := store.Put(ctx, telegram.CheckinKey, []byte(body), ""); err != nil {
		fail(err)
	}
	sc := stateCase{JSON: body, Day: day, Now: nowText}
	rec, _, err := (&telegram.CheckinStore{Store: store}).Load(ctx)
	if err != nil {
		sc.Error = err.Error()
		return sc
	}
	now := mustTime(nowText)
	sc.Finished = rec.Finished(day)
	sc.Taken = rec.Taken(day, now)
	sc.NextSince = rec.NextSince()
	return sc
}

func dueCases() []dueCase {
	list := []dueCase{
		// The minute, in the app's zone: >= 09:30 and < 20:00.
		{At: "2026-11-12T09:29:00+08:00", Hour: 9, Minute: 30, Loc: ciLoc},
		{At: "2026-11-12T09:30:00+08:00", Hour: 9, Minute: 30, Loc: ciLoc},
		{At: "2026-11-12T14:00:00+08:00", Hour: 9, Minute: 30, Loc: ciLoc},
		{At: "2026-11-12T19:59:00+08:00", Hour: 9, Minute: 30, Loc: ciLoc},
		{At: "2026-11-12T20:00:00+08:00", Hour: 9, Minute: 30, Loc: ciLoc},
		{At: "2026-11-12T23:00:00+08:00", Hour: 9, Minute: 30, Loc: ciLoc},
		// The same instants written in UTC.
		{At: "2026-11-12T01:30:00Z", Hour: 9, Minute: 30, Loc: ciLoc},
		{At: "2026-11-12T00:30:00Z", Hour: 9, Minute: 30, Loc: ciLoc},
		// A different setting, and the cutoff in UTC.
		{At: "2026-11-12T07:14:00Z", Hour: 7, Minute: 15, Loc: "UTC"},
		{At: "2026-11-12T07:15:00Z", Hour: 7, Minute: 15, Loc: "UTC"},
		{At: "2026-11-12T20:00:00Z", Hour: 7, Minute: 15, Loc: "UTC"},
		// A zone west of UTC.
		{At: "2026-11-12T09:29:00-05:00", Hour: 9, Minute: 30, Loc: "America/New_York"},
		{At: "2026-11-12T09:30:00-05:00", Hour: 9, Minute: 30, Loc: "America/New_York"},
		{At: "2026-11-12T20:00:00-05:00", Hour: 9, Minute: 30, Loc: "America/New_York"},
	}
	for i, c := range list {
		loc, err := time.LoadLocation(c.Loc)
		if err != nil {
			fail(err)
		}
		list[i].Out = telegram.CheckinDue(mustTime(c.At), c.Hour, c.Minute, loc)
	}
	return list
}

func callbackCases() callbackFile {
	now := mustTime(ciNow)
	loc, err := time.LoadLocation(ciLoc)
	if err != nil {
		fail(err)
	}
	id := ulid(1)
	data := []string{
		// The four buttons askKeyboard sends.
		checkinPrefix + "d:" + id + ":20261111",
		checkinPrefix + "m:" + id + ":20261111",
		checkinPrefix + "r:" + id + ":20261111:1",
		checkinPrefix + "r:" + id + ":20261111:7",
		// 31 days is the last one that moves.
		checkinPrefix + "r:" + id + ":20261111:31",
		// Malformed: too few parts, the wrong date length, an impossible day.
		checkinPrefix + "d:" + id,
		checkinPrefix + "r:" + id + ":20261111",
		checkinPrefix + "d:" + id + ":2026111",
		checkinPrefix + "d:" + id + ":2026111a",
		checkinPrefix + "d:" + id + ":20261311",
		checkinPrefix + "d:" + id + ":20260230",
		// Out of range and unparsable day counts.
		checkinPrefix + "r:" + id + ":20261111:0",
		checkinPrefix + "r:" + id + ":20261111:32",
		checkinPrefix + "r:" + id + ":20261111:-1",
		checkinPrefix + "r:" + id + ":20261111:x",
		// An unknown op, a foreign prefix and nothing at all.
		checkinPrefix + "x:" + id + ":20261111",
		"undo:01K8ZQ4R7S9T2V5W8X1Y3Z5A6C",
		"",
		// The op decides; extra parts are ignored (op d never reads parts[3]).
		checkinPrefix + "d:" + id + ":20261111:extra",
	}
	cases := make([]callbackCase, 0, len(data))
	for _, d := range data {
		cases = append(cases, parseCheckin(d, now, loc))
	}
	return callbackFile{Now: ciNow, Loc: ciLoc, Cases: cases}
}

func toastCases() toasts {
	dated := "2026-11-13"
	moved := func(date *string) string {
		return string(staleAsk("That task was moved since (" + orNone(date) + "), so I left it."))
	}
	return toasts{
		Archived:     string(staleAsk("That entry was archived.")),
		AlreadyDone:  string(staleAsk("Already done.")),
		MovedDated:   moved(&dated),
		MovedUndated: moved(nil),
	}
}

func mustTime(text string) time.Time {
	t, err := time.Parse(time.RFC3339, text)
	if err != nil {
		fail(err)
	}
	return t
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
