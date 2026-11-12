package docs

import (
	"context"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/sched"
)

// DefaultSyncSchedule is DOCS_SYNC_SCHEDULE's default.
const DefaultSyncSchedule = "03:00"

// Background runs the startup sync, the daily sync and a once-a-minute
// check for index changes made by another copy of the app (dev and
// production share the bucket). It returns when ctx ends.
func (s *Syncer) Background(ctx context.Context, schedule string, loc *time.Location) error {
	hh, mm, on, err := sched.Parse("DOCS_SYNC_SCHEDULE", schedule, DefaultSyncSchedule)
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
		next := sched.NextRun(s.now(), hh, mm, loc)
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
