package sched_test

import (
	"testing"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/sched"
)

func TestSchedule(t *testing.T) {
	sg, _ := time.LoadLocation("Asia/Singapore")
	for in, want := range map[string]string{"": "03:00 on", "03:00": "03:00 on", "21:30": "21:30 on", "off": "00:00 off", "OFF": "00:00 off"} {
		h, m, on, err := sched.Parse("X", in, "03:00")
		got := time.Date(0, 1, 1, h, m, 0, 0, time.UTC).Format("15:04")
		if on {
			got += " on"
		} else {
			got += " off"
		}
		if err != nil || got != want {
			t.Errorf("%q: %s %v", in, got, err)
		}
	}
	for _, bad := range []string{"3", "24:00", "07:61", "noon"} {
		if _, _, _, err := sched.Parse("X", bad, "03:00"); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	// 02:59 SGT → today 03:00; 03:00 exactly → tomorrow; 23:50 → tomorrow, across midnight and month end.
	cases := map[string]string{
		"2026-11-11T02:59:00+08:00": "2026-11-11T03:00:00+08:00",
		"2026-11-11T03:00:00+08:00": "2026-11-12T03:00:00+08:00",
		"2026-11-30T23:50:00+08:00": "2026-12-01T03:00:00+08:00",
		"2026-11-11T19:30:00Z":      "2026-11-13T03:00:00+08:00", // = 03:30 SGT on the 12th, already past 03:00
	}
	for now, want := range cases {
		n, _ := time.Parse(time.RFC3339, now)
		if got := sched.NextRun(n, 3, 0, sg).Format(time.RFC3339); got != want {
			t.Errorf("now %s: next %s, want %s", now, got, want)
		}
	}
}

func TestDays(t *testing.T) {
	sg, _ := time.LoadLocation("Asia/Singapore")
	if got := sched.Day(time.Date(2026, 11, 12, 16, 30, 0, 0, time.UTC), sg); got != "2026-11-13" {
		t.Errorf("Day in SGT = %s", got)
	}
	for in, want := range map[[2]any]string{{"2026-11-30", 1}: "2026-12-01", {"2026-01-01", -1}: "2025-12-31", {"2026-11-12", 7}: "2026-11-19", {"bad", 1}: "", {"", 1}: ""} {
		if got := sched.AddDays(in[0].(string), in[1].(int)); got != want {
			t.Errorf("AddDays(%v) = %q, want %q", in, got, want)
		}
	}
}
