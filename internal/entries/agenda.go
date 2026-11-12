package entries

import (
	"sort"
	"time"
)

// MaxAskDays is how far back the morning check-in asks about undone tasks
// when earlier check-ins were missed; older ones count as overdue.
const MaxAskDays = 7

// Agenda is what the morning check-in reports for one day.
type Agenda struct {
	// Today: undone entries of any kind dated today, by time.
	Today []Entry
	// Ask: undone tasks dated since the last check-in up to yesterday; the
	// check-in asks about each of these.
	Ask []Entry
	// Overdue: undone tasks dated before that window, oldest first.
	Overdue []Entry
}

// Quiet reports a day with nothing to say.
func (a Agenda) Quiet() bool { return len(a.Today)+len(a.Ask)+len(a.Overdue) == 0 }

// Agenda picks the check-in's entries for today (YYYY-MM-DD). since is the
// first day not yet asked about (the day after the last check-in); it is
// clamped to at most MaxAskDays back, and "" means yesterday. Archived and
// done entries are left out, and so are undated ones.
func (d *Doc) Agenda(today, since string) Agenda {
	t, err := time.Parse("2006-01-02", today)
	if err != nil {
		return Agenda{}
	}
	yesterday := t.AddDate(0, 0, -1).Format("2006-01-02")
	floor := t.AddDate(0, 0, -MaxAskDays).Format("2006-01-02")
	if since == "" || !ValidDate(since) {
		since = yesterday
	}
	if since < floor {
		since = floor
	}
	var a Agenda
	for _, e := range d.Entries {
		if e.Archived || e.Status == StatusDone || e.Date == nil {
			continue
		}
		day := *e.Date
		switch {
		case day == today:
			a.Today = append(a.Today, e.Clone())
		case e.Kind != KindTask || day > today:
		case day >= since && day <= yesterday:
			a.Ask = append(a.Ask, e.Clone())
		case day < since:
			a.Overdue = append(a.Overdue, e.Clone())
		}
	}
	for _, l := range [][]Entry{a.Today, a.Ask, a.Overdue} {
		sort.SliceStable(l, func(i, j int) bool { return when(l[i]) < when(l[j]) })
	}
	return a
}

// when orders entries by date, then time (untimed last), then creation.
func when(e Entry) string {
	t := "99:99"
	if e.Time != nil {
		t = *e.Time
	}
	return *e.Date + " " + t + " " + e.Created
}
