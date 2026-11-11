package entries_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/testutil"
)

var (
	zyWeb = entries.Actor{By: "zy@x", Channel: "web"}
	ptTg  = entries.Actor{By: "partner", Channel: "telegram"}
)

func load(t *testing.T, store objstore.Store) *entries.Service {
	t.Helper()
	svc := entries.NewService(store, testutil.Logger(nil))
	if err := svc.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	return svc
}

func create(t *testing.T, svc *entries.Service, a entries.Actor, js string) (entries.Entry, entries.Change) {
	t.Helper()
	res, err := svc.Create(context.Background(), a, []entries.Patch{patch(t, js)})
	if err != nil {
		t.Fatal(err)
	}
	return res.Entries[0], res.Changes[0]
}

func TestCRUD(t *testing.T) {
	for name, store := range testutil.Stores(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			svc := load(t, store)
			snap, _ := svc.Current(ctx)
			if len(snap.Doc.Entries) != 0 || snap.ETag == "" {
				t.Fatalf("first run should create an empty document, got %+v", snap)
			}

			e, ch := create(t, svc, zyWeb, `{"title":"Carpentry","kind":"task","cost":{"estimate":18000}}`)
			if len(e.ID) != 26 || e.Kind != "task" || e.Status != "todo" || e.By != "zy@x" || e.Channel != "web" || e.Created == "" {
				t.Fatalf("defaults wrong: %+v", e)
			}
			if ch.Op != "create" || ch.EntryID != e.ID || ch.Before != nil || ch.After == nil || ch.Channel != "web" {
				t.Fatalf("create change wrong: %+v", ch)
			}

			res, err := svc.Update(ctx, ptTg, e.ID, patch(t, `{"status":"doing","cost":{"actual":5400}}`))
			if err != nil {
				t.Fatal(err)
			}
			up := res.Entries[0]
			if up.Status != "doing" || *up.Cost.Estimate != 18000 || *up.Cost.Actual != 5400 || up.By != "partner" || up.Channel != "telegram" {
				t.Fatalf("update wrong: %+v", up)
			}
			if c := res.Changes[0]; c.Op != "update" || c.Before.Status != "todo" || c.After.Status != "doing" {
				t.Fatalf("update change wrong: %+v", c)
			}

			if _, err := svc.Update(ctx, zyWeb, e.ID, patch(t, `{"status":"nope"}`)); err == nil {
				t.Fatal("invalid update must fail")
			}
			if got, _ := svc.Current(ctx); got.Doc.Entries[0].Status != "doing" || len(got.Doc.Changes) != 2 {
				t.Fatal("failed update must not change the cached document or journal")
			}
			if _, err := svc.Update(ctx, zyWeb, "missing", patch(t, `{"status":"done"}`)); !errors.Is(err, entries.ErrEntryNotFound) {
				t.Fatalf("want ErrEntryNotFound, got %v", err)
			}
			if _, err := svc.Create(ctx, zyWeb, []entries.Patch{patch(t, `{"kind":"idea"}`)}); err == nil {
				t.Fatal("create without a title must fail")
			}

			move, key := "2026-12-05", ""
			if _, err := svc.SetMeta(ctx, entries.MetaPatch{MoveDate: &move, SetMove: true, KeyDate: &key, SetKey: true}); err != nil {
				t.Fatal(err)
			}
			if _, err := svc.Delete(ctx, zyWeb, e.ID); err != nil {
				t.Fatal(err)
			}

			// A fresh service (a restarted pod) sees the persisted state.
			got, _ := load(t, store).Current(ctx)
			if len(got.Doc.Entries) != 0 || got.Doc.Meta.MoveDate == nil || *got.Doc.Meta.MoveDate != move || got.Doc.Meta.KeyDate != nil {
				t.Fatalf("persisted doc wrong: %+v", got.Doc)
			}
			if len(got.Doc.Changes) != 3 || got.Doc.Changes[2].Op != "delete" {
				t.Fatalf("persisted journal wrong: %+v", got.Doc.Changes)
			}
		})
	}
}

func TestCreateMany(t *testing.T) {
	svc := load(t, objstore.NewMemory())
	res, err := svc.Create(context.Background(), ptTg, []entries.Patch{
		patch(t, `{"title":"Quartz top","kind":"idea","room":"wet kitchen"}`),
		patch(t, `{"title":"Electrician visit","kind":"task","date":"2026-11-14","time":"14:00"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Entries) != 2 || len(res.Changes) != 2 || res.Changes[0].ID == res.Changes[1].ID {
		t.Fatalf("got %d entries, %d changes", len(res.Entries), len(res.Changes))
	}
	// One bad patch rejects the whole batch.
	if _, err := svc.Create(context.Background(), ptTg, []entries.Patch{
		patch(t, `{"title":"ok"}`), patch(t, `{"title":"bad","room":"garage"}`),
	}); err == nil {
		t.Fatal("want error")
	}
	if snap, _ := svc.Current(context.Background()); len(snap.Doc.Entries) != 2 {
		t.Fatalf("a failed batch must write nothing, have %d entries", len(snap.Doc.Entries))
	}
}

func TestUndo(t *testing.T) {
	for name, store := range testutil.Stores(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			svc := load(t, store)

			// Undo a create removes the entry.
			e, ch := create(t, svc, ptTg, `{"title":"Fluted panels","room":"dry kitchen"}`)
			if _, err := svc.Undo(ctx, ptTg, ch.ID); err != nil {
				t.Fatal(err)
			}
			if snap, _ := svc.Current(ctx); len(snap.Doc.Entries) != 0 {
				t.Fatal("undo of create should remove the entry")
			}
			// The same change cannot be undone twice.
			if _, err := svc.Undo(ctx, ptTg, ch.ID); !errors.Is(err, entries.ErrUndoStale) {
				t.Fatalf("second undo: want ErrUndoStale, got %v", err)
			}

			// Undo an update restores the old fields and stamps the undoer.
			e, _ = create(t, svc, zyWeb, `{"title":"Sofa","kind":"idea","cost":{"estimate":2000}}`)
			res, _ := svc.Update(ctx, ptTg, e.ID, patch(t, `{"status":"decided","cost":{"estimate":2500}}`))
			ures, err := svc.Undo(ctx, zyWeb, res.Changes[0].ID)
			if err != nil {
				t.Fatal(err)
			}
			got := ures.Entries[0]
			if got.Status != "idea" || *got.Cost.Estimate != 2000 || got.By != "zy@x" || got.Channel != "web" {
				t.Fatalf("undo of update wrong: %+v", got)
			}
			if c := ures.Changes[0]; c.Op != "undo" || c.Before.Status != "decided" || c.After.Status != "idea" {
				t.Fatalf("undo change wrong: %+v", c)
			}
			// Undoing the undo re-applies the update.
			if _, err := svc.Undo(ctx, zyWeb, ures.Changes[0].ID); err != nil {
				t.Fatal(err)
			}
			snap, _ := svc.Current(ctx)
			if cur, _ := snap.Doc.Find(e.ID); cur.Status != "decided" {
				t.Fatalf("undo of undo: status %q", cur.Status)
			}

			// Undo a delete puts the entry back.
			dres, _ := svc.Delete(ctx, zyWeb, e.ID)
			if _, err := svc.Undo(ctx, zyWeb, dres.Changes[0].ID); err != nil {
				t.Fatal(err)
			}
			snap, _ = svc.Current(ctx)
			if cur, ok := snap.Doc.Find(e.ID); !ok || cur.Title != "Sofa" {
				t.Fatal("undo of delete should restore the entry")
			}

			if _, err := svc.Undo(ctx, zyWeb, "nope"); !errors.Is(err, entries.ErrChangeNotFound) {
				t.Fatalf("want ErrChangeNotFound, got %v", err)
			}
		})
	}
}

func TestUndoRefusedAfterLaterEdit(t *testing.T) {
	ctx := context.Background()
	svc := load(t, objstore.NewMemory())
	e, _ := create(t, svc, zyWeb, `{"title":"Lights","kind":"task"}`)
	first, _ := svc.Update(ctx, zyWeb, e.ID, patch(t, `{"vendor":"Lim"}`))
	if _, err := svc.Update(ctx, ptTg, e.ID, patch(t, `{"notes":"warm white"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Undo(ctx, zyWeb, first.Changes[0].ID); !errors.Is(err, entries.ErrUndoStale) {
		t.Fatalf("want ErrUndoStale, got %v", err)
	}
	snap, _ := svc.Current(ctx)
	if cur, _ := snap.Doc.Find(e.ID); cur.Notes != "warm white" || cur.Vendor != "Lim" {
		t.Fatalf("refused undo must not change the entry: %+v", cur)
	}
}

func TestJournalCapAndRecent(t *testing.T) {
	ctx := context.Background()
	svc := load(t, objstore.NewMemory())
	first, firstCh := create(t, svc, zyWeb, `{"title":"first"}`)
	for i := 0; i < entries.MaxChanges; i++ {
		a := zyWeb
		if i%2 == 1 {
			a = ptTg
		}
		create(t, svc, a, fmt.Sprintf(`{"title":"n%d"}`, i))
	}
	snap, _ := svc.Current(ctx)
	if len(snap.Doc.Changes) != entries.MaxChanges {
		t.Fatalf("journal has %d changes, want cap %d", len(snap.Doc.Changes), entries.MaxChanges)
	}
	if _, err := svc.Undo(ctx, zyWeb, firstCh.ID); !errors.Is(err, entries.ErrChangeNotFound) {
		t.Fatalf("dropped change: want ErrChangeNotFound, got %v", err)
	}
	if _, ok := snap.Doc.Find(first.ID); !ok {
		t.Fatal("trimming the journal must not remove entries")
	}

	recent, _ := svc.Recent(ctx, 3, "")
	if len(recent) != 3 || recent[0].After.Title != fmt.Sprintf("n%d", entries.MaxChanges-1) {
		t.Fatalf("recent wrong: %+v", recent)
	}
	mine, _ := svc.Recent(ctx, 2, "partner")
	if len(mine) != 2 || mine[0].By != "partner" || mine[1].By != "partner" {
		t.Fatalf("recent by partner wrong: %+v", mine)
	}
}

// TestConflictBothChangesSurvive: two writers start from the same ETag; the
// second one's PUT gets 412, re-reads, re-applies, and both changes land.
func TestConflictBothChangesSurvive(t *testing.T) {
	for name, store := range testutil.Stores(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			e, _ := create(t, load(t, store), zyWeb, `{"title":"Carpentry","kind":"task"}`)

			a, b := load(t, store), load(t, store)
			sa, _ := a.Current(ctx)
			sb, _ := b.Current(ctx)
			if sa.ETag != sb.ETag {
				t.Fatal("setup: replicas should share an ETag")
			}
			if _, err := a.Update(ctx, zyWeb, e.ID, patch(t, `{"cost":{"estimate":18000}}`)); err != nil {
				t.Fatal(err)
			}
			// b's cached ETag is now stale: this write must hit 412 and retry.
			if _, err := b.Update(ctx, ptTg, e.ID, patch(t, `{"cost":{"actual":5400}}`)); err != nil {
				t.Fatal(err)
			}
			got, _ := load(t, store).Current(ctx)
			cur, _ := got.Doc.Find(e.ID)
			if cur.Cost.Estimate == nil || *cur.Cost.Estimate != 18000 || cur.Cost.Actual == nil || *cur.Cost.Actual != 5400 {
				t.Fatalf("both changes must survive, got %+v", cur.Cost)
			}
			if len(got.Doc.Changes) != 3 {
				t.Fatalf("journal should hold create + 2 updates, has %d", len(got.Doc.Changes))
			}
		})
	}
}

// TestConcurrentWriters hammers one document from two replicas at once.
// Every create that reports success must be in the final document.
func TestConcurrentWriters(t *testing.T) {
	for name, store := range testutil.Stores(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			reps := []*entries.Service{load(t, store), load(t, store)}
			var wg sync.WaitGroup
			var mu sync.Mutex
			ok, conflicts := map[string]bool{}, 0
			for i := 0; i < 10; i++ {
				for ri, r := range reps {
					wg.Add(1)
					go func(i, ri int, r *entries.Service) {
						defer wg.Done()
						title := fmt.Sprintf("r%d-entry%d", ri, i)
						_, err := r.Create(ctx, zyWeb, []entries.Patch{patch(t, `{"title":"`+title+`"}`)})
						mu.Lock()
						defer mu.Unlock()
						switch {
						case err == nil:
							ok[title] = true
						case errors.Is(err, entries.ErrConflict):
							conflicts++
						default:
							t.Errorf("unexpected error: %v", err)
						}
					}(i, ri, r)
				}
			}
			wg.Wait()
			got, _ := load(t, store).Current(ctx)
			present := map[string]bool{}
			for _, e := range got.Doc.Entries {
				present[e.Title] = true
			}
			for title := range ok {
				if !present[title] {
					t.Errorf("acknowledged write %q was lost", title)
				}
			}
			if len(got.Doc.Entries) != len(ok) || len(got.Doc.Changes) != len(ok) {
				t.Errorf("doc has %d entries and %d changes, %d writes acknowledged", len(got.Doc.Entries), len(got.Doc.Changes), len(ok))
			}
			t.Logf("%d writes kept, %d returned 409 after retries", len(ok), conflicts)
		})
	}
}

// alwaysConflict makes every conditional PUT lose, to check the retry cap.
type alwaysConflict struct{ objstore.Store }

func (alwaysConflict) Put(context.Context, string, []byte, string) (string, error) {
	return "", objstore.ErrPrecondition
}

func TestGivesUpAfterRetries(t *testing.T) {
	mem := objstore.NewMemory()
	load(t, mem)
	svc := load(t, alwaysConflict{mem})
	if _, err := svc.Create(context.Background(), zyWeb, []entries.Patch{patch(t, `{"title":"a"}`)}); !errors.Is(err, entries.ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}
}

func TestPollPicksUpOutsideWrites(t *testing.T) {
	ctx := context.Background()
	store := objstore.NewMemory()
	a, b := load(t, store), load(t, store)
	ch, cancel := b.Subscribe()
	defer cancel()
	create(t, a, ptTg, `{"title":"from the bot"}`)
	if err := b.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case snap := <-ch:
		if len(snap.Doc.Entries) != 1 || snap.Doc.Entries[0].Title != "from the bot" || snap.Doc.Entries[0].Channel != "telegram" {
			t.Fatalf("got %+v", snap.Doc.Entries)
		}
	default:
		t.Fatal("refresh after an outside write must notify subscribers")
	}
}
