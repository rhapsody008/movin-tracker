// Package sched reads the app's daily schedule settings ("HH:MM" in the
// app's time zone, or "off") and works out when they next fire.
package sched

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Parse reads one schedule variable: "HH:MM" (24 h) or "off". Empty means
// def. name is the variable, for the error message.
func Parse(name, s, def string) (hour, minute int, on bool, err error) {
	s = strings.TrimSpace(strings.ToLower(s))
	switch s {
	case "off", "none", "false":
		return 0, 0, false, nil
	case "":
		s = def
	}
	h, m, ok := strings.Cut(s, ":")
	hh, err1 := strconv.Atoi(h)
	mm, err2 := strconv.Atoi(m)
	if !ok || err1 != nil || err2 != nil || hh < 0 || hh > 23 || mm < 0 || mm > 59 {
		return 0, 0, false, fmt.Errorf("%s must be HH:MM (24 h) or off, not %q", name, s)
	}
	return hh, mm, true, nil
}

// NextRun is the next time after now that the clock in loc shows hh:mm.
func NextRun(now time.Time, hh, mm int, loc *time.Location) time.Time {
	n := now.In(loc)
	next := time.Date(n.Year(), n.Month(), n.Day(), hh, mm, 0, 0, loc)
	if !next.After(n) {
		next = time.Date(n.Year(), n.Month(), n.Day()+1, hh, mm, 0, 0, loc)
	}
	return next
}

// Day is now's calendar day in loc (YYYY-MM-DD).
func Day(now time.Time, loc *time.Location) string { return now.In(loc).Format("2006-01-02") }

// AddDays moves a YYYY-MM-DD day by n days ("" stays "").
func AddDays(day string, n int) string {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return ""
	}
	return t.AddDate(0, 0, n).Format("2006-01-02")
}
