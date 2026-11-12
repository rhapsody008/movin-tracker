package entries_test

import (
	"strings"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/entries"
)

func agendaTitles(es []entries.Entry) string {
	var out []string
	for _, e := range es {
		out = append(out, e.Title)
	}
	return strings.Join(out, ",")
}

func TestAgenda(t *testing.T) {
	s := func(v string) *string { return &v }
	mk := func(title, kind, status, date string, tm *string, archived bool) entries.Entry {
		e := entries.Entry{ID: title, Title: title, Kind: kind, Status: status, Archived: archived, Time: tm, Created: "2026-11-01T00:00:00Z"}
		if date != "" {
			e.Date = s(date)
		}
		return e
	}
	d := &entries.Doc{Entries: []entries.Entry{
		mk("tiler", "task", "todo", "2026-11-12", s("14:00"), false),
		mk("electrician", "task", "doing", "2026-11-12", s("09:00"), false),
		mk("pick tiles", "question", "idea", "2026-11-12", nil, false), // any kind today, untimed last
		mk("done today", "task", "done", "2026-11-12", nil, false),
		mk("archived today", "task", "todo", "2026-11-12", nil, true),
		mk("yesterday", "task", "todo", "2026-11-11", nil, false),
		mk("yesterday done", "task", "done", "2026-11-11", nil, false),
		mk("yesterday idea", "idea", "idea", "2026-11-11", nil, false), // not a task: not asked about
		mk("three days ago", "task", "todo", "2026-11-09", nil, false),
		mk("ten days ago", "task", "todo", "2026-11-02", nil, false),
		mk("tomorrow", "task", "todo", "2026-11-13", nil, false),
		mk("undated", "task", "doing", "", nil, false),
	}}
	cases := []struct {
		name, since, today, ask, overdue string
	}{
		{"normal day: yesterday asked", "2026-11-11", "electrician,tiler,pick tiles", "yesterday", "ten days ago,three days ago"},
		{"no record yet: yesterday", "", "electrician,tiler,pick tiles", "yesterday", "ten days ago,three days ago"},
		{"missed days are asked", "2026-11-08", "electrician,tiler,pick tiles", "three days ago,yesterday", "ten days ago"},
		{"at most 7 days back", "2026-10-01", "electrician,tiler,pick tiles", "three days ago,yesterday", "ten days ago"},
		{"already asked today", "2026-11-12", "electrician,tiler,pick tiles", "", "ten days ago,three days ago,yesterday"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := d.Agenda("2026-11-12", c.since)
			if got := agendaTitles(a.Today); got != c.today {
				t.Errorf("today %q, want %q", got, c.today)
			}
			if got := agendaTitles(a.Ask); got != c.ask {
				t.Errorf("ask %q, want %q", got, c.ask)
			}
			if got := agendaTitles(a.Overdue); got != c.overdue {
				t.Errorf("overdue %q, want %q", got, c.overdue)
			}
			if a.Quiet() {
				t.Error("not a quiet day")
			}
		})
	}
	// "ten days ago" sits on the floor: since 2026-11-05 means it's overdue.
	if a := d.Agenda("2026-11-12", "2026-11-05"); agendaTitles(a.Overdue) != "ten days ago" {
		t.Errorf("overdue at the floor: %q", agendaTitles(a.Overdue))
	}
	quiet := &entries.Doc{Entries: []entries.Entry{mk("tomorrow", "task", "todo", "2026-11-13", nil, false), mk("undated", "task", "todo", "", nil, false), mk("done", "task", "done", "2026-11-11", nil, false)}}
	if a := quiet.Agenda("2026-11-12", ""); !a.Quiet() {
		t.Errorf("quiet day not quiet: %+v", a)
	}
	if a := d.Agenda("bad", ""); !a.Quiet() {
		t.Error("bad day should give nothing")
	}
}
