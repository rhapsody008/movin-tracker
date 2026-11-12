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
	st := &telegram.CheckinStore{Store: objstore.NewMemory(), Now: func() time.Time { return now }}

	// First ever: claimed, nothing to ask from before.
	prev, tag, ok, err := st.Claim(ctx, "2026-11-12", "-100")
	if err != nil || !ok || prev.Since() != "" {
		t.Fatalf("first claim: %+v %v %v", prev, ok, err)
	}
	// While it is being sent, nobody else gets it.
	if _, _, ok, _ := st.Claim(ctx, "2026-11-12", "-100"); ok {
		t.Fatal("second claim while sending")
	}
	r, _, _ := st.Load(ctx)
	if err := st.Finish(ctx, tag, r, telegram.CheckinSent); err != nil {
		t.Fatal(err)
	}
	if _, _, ok, _ := st.Claim(ctx, "2026-11-12", "-100"); ok {
		t.Fatal("claimed again after sent")
	}
	// Next day: claimed, asks from the day after the last one.
	now = now.Add(24 * time.Hour)
	prev, tag, ok, _ = st.Claim(ctx, "2026-11-13", "-100")
	if !ok || prev.Since() != "2026-11-13" {
		t.Fatalf("next day: %+v %v", prev, ok)
	}
	// A failed send gives the day back with the old record, so the retry
	// still asks from the same day.
	if err := st.Release(ctx, tag, prev); err != nil {
		t.Fatal(err)
	}
	prev, _, ok, _ = st.Claim(ctx, "2026-11-13", "-100")
	if !ok || prev.Since() != "2026-11-13" {
		t.Fatalf("retry after release: %+v %v", prev, ok)
	}
	// A crash mid-send: the claim holds for StaleClaim, then can be retaken,
	// and that check-in asks about the crashed day's tasks again.
	now = now.Add(telegram.StaleClaim - time.Second)
	if _, _, ok, _ := st.Claim(ctx, "2026-11-13", "-100"); ok {
		t.Fatal("fresh claim retaken")
	}
	now = now.Add(2 * time.Second)
	prev, _, ok, _ = st.Claim(ctx, "2026-11-13", "-100")
	if !ok || prev.Status != telegram.CheckinSending || prev.Since() != "2026-11-13" {
		t.Fatalf("stale claim: %+v %v", prev, ok)
	}
}

func TestCheckinReleaseOfFirstEver(t *testing.T) {
	ctx := context.Background()
	st := &telegram.CheckinStore{Store: objstore.NewMemory(), Now: time.Now}
	prev, tag, ok, _ := st.Claim(ctx, "2026-11-12", "1")
	if !ok {
		t.Fatal("no claim")
	}
	if err := st.Release(ctx, tag, prev); err != nil {
		t.Fatal(err)
	}
	if _, _, ok, _ := st.Claim(ctx, "2026-11-12", "1"); !ok {
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
					st := &telegram.CheckinStore{Store: store, Now: time.Now}
					_, _, ok, err := st.Claim(context.Background(), "2026-11-12", "1")
					if err != nil {
						t.Error(err)
					}
					wins <- ok
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
