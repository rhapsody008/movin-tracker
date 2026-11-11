package docs

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ParseSchedule reads DOCS_SYNC_SCHEDULE: "HH:MM" (24 h, in the app's time
// zone) or "off". Empty means the default, 03:00.
func ParseSchedule(s string) (hour, minute int, on bool, err error) {
	s = strings.TrimSpace(strings.ToLower(s))
	switch s {
	case "off", "none", "false":
		return 0, 0, false, nil
	case "":
		s = "03:00"
	}
	h, m, ok := strings.Cut(s, ":")
	hh, err1 := strconv.Atoi(h)
	mm, err2 := strconv.Atoi(m)
	if !ok || err1 != nil || err2 != nil || hh < 0 || hh > 23 || mm < 0 || mm > 59 {
		return 0, 0, false, fmt.Errorf("DOCS_SYNC_SCHEDULE must be HH:MM (24 h) or off, not %q", s)
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

// Background runs the startup sync, the daily sync and a once-a-minute
// check for index changes made by another copy of the app (dev and
// production share the bucket). It returns when ctx ends.
func (s *Syncer) Background(ctx context.Context, schedule string, loc *time.Location) error {
	hh, mm, on, err := ParseSchedule(schedule)
	if err != nil {
		return err
	}
	go func() {
		if _, err := s.Sync(ctx, "startup"); err != nil && ctx.Err() == nil {
			s.Log.Warn("startup document sync failed", "err", err)
		}
	}()
	refresh := time.NewTicker(time.Minute)
	defer refresh.Stop()
	var daily <-chan time.Time
	var timer *time.Timer
	arm := func() {
		if !on {
			return
		}
		next := NextRun(s.now(), hh, mm, loc)
		s.Log.Info("next daily document sync", "at", next.Format(time.RFC3339))
		if timer != nil {
			timer.Stop()
		}
		timer = time.NewTimer(time.Until(next))
		daily = timer.C
	}
	arm()
	for {
		select {
		case <-ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return nil
		case <-refresh.C:
			if err := s.Refresh(ctx); err != nil && ctx.Err() == nil {
				s.Log.Debug("documents index refresh failed", "err", err)
			}
		case <-daily:
			if _, err := s.Sync(ctx, "daily"); err != nil && ctx.Err() == nil {
				s.Log.Warn("daily document sync failed", "err", err)
			}
			arm()
		}
	}
}
