package entries_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
)

func sgt(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Asia/Singapore")
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

// clockSvc is a memory-backed service whose clock reads *now, in SGT.
func clockSvc(t *testing.T, now *time.Time) *entries.Service {
	t.Helper()
	svc := load(t, objstore.NewMemory())
	svc.SetClock(func() time.Time { return *now })
	svc.SetLocation(sgt(t))
	return svc
}

func day(e entries.Entry) string {
	if e.Completed == nil {
		return "<nil>"
	}
	return *e.Completed
}

func TestCompletedDayFollowsStatus(t *testing.T) {
	ctx := context.Background()
	// 2026-11-12 23:30 UTC is already 13 Nov in Singapore.
	now := time.Date(2026, 11, 12, 23, 30, 0, 0, time.UTC)
	svc := clockSvc(t, &now)

	e, _ := create(t, svc, zyWeb, `{"title":"Hack the walls","kind":"task"}`)
	if e.Completed != nil {
		t.Fatalf("new todo has completed %q", *e.Completed)
	}
	res, err := svc.Update(ctx, zyWeb, e.ID, patch(t, `{"status":"done"}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := day(res.Entries[0]); got != "2026-11-13" {
		t.Fatalf("done day %s, want the SGT day 2026-11-13", got)
	}

	// Another edit while still done keeps the day.
	now = now.Add(72 * time.Hour)
	res, _ = svc.Update(ctx, zyWeb, e.ID, patch(t, `{"notes":"all walls"}`))
	if got := day(res.Entries[0]); got != "2026-11-13" {
		t.Fatalf("later edit moved the day to %s", got)
	}

	// Leaving done clears it; coming back stamps the new day.
	res, _ = svc.Update(ctx, zyWeb, e.ID, patch(t, `{"status":"doing"}`))
	if res.Entries[0].Completed != nil {
		t.Fatalf("still has a day after leaving done: %s", day(res.Entries[0]))
	}
	res, _ = svc.Update(ctx, zyWeb, e.ID, patch(t, `{"status":"done"}`))
	if got := day(res.Entries[0]); got != "2026-11-16" {
		t.Fatalf("redone day %s", got)
	}

	// An explicit day wins, on the move to done and later.
	res, _ = svc.Update(ctx, zyWeb, e.ID, patch(t, `{"completed":"2026-11-10"}`))
	if got := day(res.Entries[0]); got != "2026-11-10" {
		t.Fatalf("explicit day %s", got)
	}
	f, _ := create(t, svc, zyWeb, `{"title":"Keys collected","kind":"note","status":"done","milestone":true,"completed":"2026-11-01"}`)
	if day(f) != "2026-11-01" || !f.IsMilestone() {
		t.Fatalf("created done milestone: %+v", f)
	}
	// Created as done without a day: today.
	g, _ := create(t, svc, zyWeb, `{"title":"Paid deposit","kind":"task","status":"done"}`)
	if day(g) != "2026-11-16" {
		t.Fatalf("created as done: %s", day(g))
	}
	// A day on an entry that isn't done is refused.
	if _, err := svc.Update(ctx, zyWeb, res.Entries[0].ID, patch(t, `{"status":"todo","completed":"2026-11-10"}`)); err == nil || !strings.Contains(err.Error(), "completed needs status done") {
		t.Fatalf("want 'completed needs status done', got %v", err)
	}
	// Clearing the day of a done entry keeps the day it had.
	if res, _ := svc.Update(ctx, zyWeb, e.ID, patch(t, `{"completed":null}`)); day(res.Entries[0]) != "2026-11-10" {
		t.Fatalf("cleared day: %s", day(res.Entries[0]))
	}
	if res, _ := svc.Update(ctx, zyWeb, e.ID, patch(t, `{"completed":""}`)); day(res.Entries[0]) != "2026-11-10" {
		t.Fatalf("emptied day: %s", day(res.Entries[0]))
	}
	if _, err := svc.Update(ctx, zyWeb, e.ID, patch(t, `{"completed":"10/11/2026"}`)); err == nil {
		t.Fatal("bad completed date accepted")
	}
}

func TestUndoRestoresMilestoneAndDay(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 11, 12, 2, 0, 0, 0, time.UTC)
	svc := clockSvc(t, &now)
	e, _ := create(t, svc, zyWeb, `{"title":"Kitchen installed","kind":"task"}`)
	res, err := svc.Update(ctx, ptTg, e.ID, patch(t, `{"status":"done","milestone":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Entries[0]; !got.IsMilestone() || day(got) != "2026-11-12" {
		t.Fatalf("done ★: %+v", got)
	}
	ures, err := svc.Undo(ctx, ptTg, res.Changes[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if got := ures.Entries[0]; got.Milestone || got.Completed != nil || got.Status != "todo" {
		t.Fatalf("undo left %+v", got)
	}
	// And undoing the undo brings both back.
	if _, err := svc.Undo(ctx, ptTg, ures.Changes[0].ID); err != nil {
		t.Fatal(err)
	}
	snap, _ := svc.Current(ctx)
	if got, _ := snap.Doc.Find(e.ID); !got.IsMilestone() || day(got) != "2026-11-12" {
		t.Fatalf("redo: %+v", got)
	}
}

// Files written before milestones existed read the same and are written
// back without the new keys.
func TestOldEntriesUnchanged(t *testing.T) {
	old := `{"schema":1,"meta":{"moveDate":null,"keyDate":null},"entries":[{"id":"A","kind":"task","title":"Paint","room":null,"category":"","status":"done","cost":{"estimate":null,"actual":null},"vendor":"","date":"2026-11-01","time":null,"source":"","notes":"","tags":[],"archived":false,"by":"zy","channel":"web","created":"2026-11-01T00:00:00Z","updated":"2026-11-02T00:00:00Z"}],"changes":[]}`
	d, err := entries.Decode([]byte(old))
	if err != nil {
		t.Fatal(err)
	}
	if e := d.Entries[0]; e.Milestone || e.Completed != nil || e.IsMilestone() {
		t.Fatalf("old entry read as %+v", e)
	}
	out, _ := json.Marshal(d)
	if string(out) != old {
		t.Fatalf("round trip changed the file:\n%s\n%s", old, out)
	}
	// Hand-edited: a day on an entry that isn't done is dropped.
	d, _ = entries.Decode([]byte(strings.Replace(old, `"status":"done"`, `"status":"todo","completed":"2026-11-02","milestone":true`, 1)))
	if e := d.Entries[0]; e.Completed != nil || !e.Milestone || e.IsMilestone() {
		t.Fatalf("normalised %+v", e)
	}
}

func TestSearchMilestones(t *testing.T) {
	now := time.Date(2026, 11, 12, 2, 0, 0, 0, time.UTC)
	svc := clockSvc(t, &now)
	create(t, svc, zyWeb, `{"title":"Keys","kind":"note","status":"done","milestone":true}`)
	create(t, svc, zyWeb, `{"title":"Handover","kind":"task","milestone":true}`) // flagged, not done yet
	create(t, svc, zyWeb, `{"title":"Paint","kind":"task","status":"done"}`)
	snap, _ := svc.Current(context.Background())
	yes, no := true, false
	if r := snap.Doc.Search(entries.Filter{Milestone: &yes}); r.Total != 1 || r.Entries[0].Title != "Keys" {
		t.Fatalf("milestones: %+v", r)
	}
	if r := snap.Doc.Search(entries.Filter{Milestone: &no}); r.Total != 2 {
		t.Fatalf("not milestones: %+v", r)
	}
	var f entries.Filter
	if err := json.Unmarshal([]byte(`{"milestone":true}`), &f); err != nil || f.Milestone == nil || !*f.Milestone {
		t.Fatalf("filter JSON: %+v %v", f, err)
	}
}

// UpdateIf's check runs against the entry as written: when another copy of
// the app changed it after this one last read it, the retry re-checks and
// the update is cancelled instead of overwriting that change.
func TestUpdateIfRechecksAfterAConflict(t *testing.T) {
	ctx := context.Background()
	store := objstore.NewMemory()
	a, b := load(t, store), load(t, store)
	e, _ := create(t, a, zyWeb, `{"title":"Book movers","kind":"task","date":"2026-11-11"}`)
	if err := b.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	// b (web) marks it done; a (the bot) still has the old copy cached.
	if _, err := b.Update(ctx, zyWeb, e.ID, patch(t, `{"status":"done"}`)); err != nil {
		t.Fatal(err)
	}
	errDone := errors.New("already done")
	checks := 0
	_, err := a.UpdateIf(ctx, ptTg, e.ID, func(cur entries.Entry) error {
		checks++
		if cur.Status == "done" {
			return errDone
		}
		return nil
	}, patch(t, `{"date":"2026-11-13"}`))
	if !errors.Is(err, errDone) || checks != 2 {
		t.Fatalf("want the re-check to refuse (2 checks), got %v after %d", err, checks)
	}
	snap, _ := a.Current(ctx)
	if got, _ := snap.Doc.Find(e.ID); got.Status != "done" || *got.Date != "2026-11-11" {
		t.Fatalf("the web change was overwritten: %+v", got)
	}
}
