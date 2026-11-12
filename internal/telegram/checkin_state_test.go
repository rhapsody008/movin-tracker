package telegram_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/telegram"
	"github.com/rhapsody008/movin-tracker/internal/testutil"
)

func TestCheckinDue(t *testing.T) {
	sg, _ := time.LoadLocation("Asia/Singapore")
	for at, want := range map[string]bool{
		"2026-11-12T09:29:00+08:00": false,
		"2026-11-12T09:30:00+08:00": true,
		"2026-11-12T14:00:00+08:00": true, // Mac woke up late: catch up
		"2026-11-12T19:59:00+08:00": true,
		"2026-11-12T20:00:00+08:00": false, // too late: skip the day
		"2026-11-12T01:30:00Z":      true,  // 09:30 SGT
		"2026-11-12T00:30:00Z":      false, // 08:30 SGT
	} {
		n, _ := time.Parse(time.RFC3339, at)
		if got := telegram.CheckinDue(n, 9, 30, sg); got != want {
			t.Errorf("%s: due %v, want %v", at, got, want)
		}
	}
}

func TestCheckinClaim(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 11, 12, 1, 30, 0, 0, time.UTC)
	st := &telegram.CheckinStore{Store: objstore.NewMemory()}

	// First ever: claimed, asks about yesterday (no window yet).
	c, _, err := st.Claim(ctx, "2026-11-12", "-100", now)
	if err != nil || c == nil || c.Record.Since != "" {
		t.Fatalf("first claim: %+v %v", c, err)
	}
	// While it is being sent, nobody else gets it, and it isn't finished.
	if c2, cur, _ := st.Claim(ctx, "2026-11-12", "-100", now); c2 != nil || cur.Finished("2026-11-12") || !cur.Taken("2026-11-12", now) {
		t.Fatalf("second claim while sending: %+v %+v", c2, cur)
	}
	if err := st.Finish(ctx, c, telegram.CheckinSent, now); err != nil {
		t.Fatal(err)
	}
	if c2, cur, _ := st.Claim(ctx, "2026-11-12", "-100", now); c2 != nil || !cur.Finished("2026-11-12") {
		t.Fatalf("claimed again after sent: %+v", cur)
	}
	// Next day: the 12th's tasks were "today" then, so the 13th asks from the 12th.
	now = now.Add(24 * time.Hour)
	c, _, _ = st.Claim(ctx, "2026-11-13", "-100", now)
	if c == nil || c.Record.Since != "2026-11-12" || c.Prev.Day != "2026-11-12" {
		t.Fatalf("next day: %+v", c)
	}
	// A failed send gives the day back with the old record; the retry asks
	// about the same days.
	if err := st.Release(ctx, c); err != nil {
		t.Fatal(err)
	}
	c, _, _ = st.Claim(ctx, "2026-11-13", "-100", now)
	if c == nil || c.Record.Since != "2026-11-12" {
		t.Fatalf("retry after release: %+v", c)
	}
	// A crash mid-send: the claim holds for StaleClaim, then is taken over
	// with the crashed claim's window, not an empty one.
	now = now.Add(telegram.StaleClaim - time.Second)
	if c2, _, _ := st.Claim(ctx, "2026-11-13", "-100", now); c2 != nil {
		t.Fatal("fresh claim retaken")
	}
	now = now.Add(2 * time.Second)
	c, _, _ = st.Claim(ctx, "2026-11-13", "-100", now)
	if c == nil || c.Prev.Status != telegram.CheckinSending || c.Record.Since != "2026-11-12" {
		t.Fatalf("stale claim: %+v", c)
	}
	// A quiet day also moves the window on.
	if err := st.Finish(ctx, c, telegram.CheckinQuiet, now); err != nil {
		t.Fatal(err)
	}
	now = now.Add(24 * time.Hour)
	if c, _, _ = st.Claim(ctx, "2026-11-14", "-100", now); c == nil || c.Record.Since != "2026-11-13" {
		t.Fatalf("after a quiet day: %+v", c)
	}
}

func TestCheckinReleaseOfFirstEver(t *testing.T) {
	ctx := context.Background()
	st := &telegram.CheckinStore{Store: objstore.NewMemory()}
	c, _, _ := st.Claim(ctx, "2026-11-12", "1", time.Now())
	if c == nil {
		t.Fatal("no claim")
	}
	if err := st.Release(ctx, c); err != nil {
		t.Fatal(err)
	}
	if c, _, _ := st.Claim(ctx, "2026-11-12", "1", time.Now()); c == nil {
		t.Fatal("not claimable after release")
	}
}

// Two copies of the app (dev and production) racing for the same day: one
// wins, on memory and on S3 (MinIO).
func TestCheckinOneWinner(t *testing.T) {
	for name, store := range testutil.Stores(t) {
		t.Run(name, func(t *testing.T) {
			var wg sync.WaitGroup
			wins := make(chan bool, 8)
			for i := 0; i < 8; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					st := &telegram.CheckinStore{Store: store}
					c, _, err := st.Claim(context.Background(), "2026-11-12", "1", time.Now())
					if err != nil {
						t.Error(err)
					}
					wins <- c != nil
				}()
			}
			wg.Wait()
			close(wins)
			n := 0
			for ok := range wins {
				if ok {
					n++
				}
			}
			if n != 1 {
				t.Fatalf("%d winners", n)
			}
		})
	}
}
