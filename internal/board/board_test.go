package board_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/board"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/testutil"
)

func patch(t *testing.T, js string) board.Patch {
	t.Helper()
	var p board.Patch
	if err := json.Unmarshal([]byte(js), &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestValidation(t *testing.T) {
	long := func(n int) string { return `"` + strings.Repeat("x", n) + `"` }
	cases := []struct {
		name, js string
		ok       bool
	}{
		{"minimal", `{"title":"Book movers"}`, true},
		{"full", `{"title":"Sofa","cat":"shopping","status":"doing","due":"2026-11-20","time":"10:00","vendor":"Castlery","quoted":2000,"paid":null,"notes":"grey"}`, true},
		{"empty title", `{"title":"   "}`, false},
		{"title 200", `{"title":` + long(200) + `}`, true},
		{"title 201", `{"title":` + long(201) + `}`, false},
		{"vendor 201", `{"title":"a","vendor":` + long(201) + `}`, false},
		{"notes 4000", `{"title":"a","notes":` + long(4000) + `}`, true},
		{"notes 4001", `{"title":"a","notes":` + long(4001) + `}`, false},
		{"bad status", `{"title":"a","status":"blocked"}`, false},
		{"bad date", `{"title":"a","due":"20/11/2026"}`, false},
		{"impossible date", `{"title":"a","due":"2026-02-30"}`, false},
		{"bad time", `{"title":"a","time":"10am"}`, false},
		{"time 24:00", `{"title":"a","time":"24:00"}`, false},
		{"negative quote", `{"title":"a","quoted":-1}`, false},
		{"quote as string", `{"title":"a","quoted":"18k"}`, false},
		{"empty due clears", `{"title":"a","due":""}`, true},
		{"unknown field", `{"title":"a","colour":"red"}`, false},
		{"archived not bool", `{"title":"a","archived":"yes"}`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			it := board.Item{}
			err := patch(t, c.js).Apply(&it)
			var ve *board.ValidationError
			if c.ok && err != nil {
				t.Fatalf("want ok, got %v", err)
			}
			if !c.ok && !errors.As(err, &ve) {
				t.Fatalf("want ValidationError, got %v", err)
			}
		})
	}
}

func TestUnknownCategoryReadsAsAdmin(t *testing.T) {
	it := board.Item{}
	if err := patch(t, `{"title":"a","cat":"garden"}`).Apply(&it); err != nil || it.Cat != "admin" {
		t.Fatalf("cat=%q err=%v", it.Cat, err)
	}
	b, err := board.Decode([]byte(`{"items":[{"id":"1","title":"x","cat":"misc","status":"weird"}]}`))
	if err != nil || b.Items[0].Cat != "admin" || b.Items[0].Status != "todo" || b.Schema != 1 {
		t.Fatalf("decode normalisation: %+v err=%v", b, err)
	}
}

func TestCRUD(t *testing.T) {
	for name, store := range testutil.Stores(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			svc := board.NewService(store, testutil.Logger(nil))
			if err := svc.Load(ctx); err != nil {
				t.Fatal(err)
			}
			snap, _ := svc.Current(ctx)
			if len(snap.Board.Items) != 0 || snap.ETag == "" {
				t.Fatalf("first run should create an empty board, got %+v", snap)
			}

			created, _, err := svc.Create(ctx, "a@x", []board.Patch{patch(t, `{"title":"Book movers","quoted":1200}`)})
			if err != nil {
				t.Fatal(err)
			}
			it := created[0]
			if len(it.ID) != 26 || it.Cat != "admin" || it.Status != "todo" || it.By != "a@x" || it.Created == "" {
				t.Fatalf("defaults wrong: %+v", it)
			}

			up, _, err := svc.Update(ctx, "b@x", it.ID, patch(t, `{"status":"doing","paid":300,"quoted":null}`))
			if err != nil {
				t.Fatal(err)
			}
			if up.Status != "doing" || up.Paid == nil || *up.Paid != 300 || up.Quoted != nil || up.By != "b@x" || up.Title != "Book movers" {
				t.Fatalf("update wrong: %+v", up)
			}

			if _, _, err := svc.Update(ctx, "b@x", it.ID, patch(t, `{"status":"nope"}`)); err == nil {
				t.Fatal("invalid update must fail")
			}
			if got, _ := svc.Current(ctx); got.Board.Items[0].Status != "doing" {
				t.Fatal("failed update must not change the cached board")
			}
			if _, _, err := svc.Update(ctx, "b@x", "missing", patch(t, `{"status":"done"}`)); !errors.Is(err, board.ErrItemNotFound) {
				t.Fatalf("want ErrItemNotFound, got %v", err)
			}

			move, key := "2026-12-05", ""
			if _, err := svc.SetMeta(ctx, board.MetaPatch{MoveDate: &move, SetMove: true, KeyDate: &key, SetKey: true}); err != nil {
				t.Fatal(err)
			}

			if _, _, err := svc.Delete(ctx, it.ID); err != nil {
				t.Fatal(err)
			}

			// A fresh service (a restarted pod) sees the persisted state.
			fresh := board.NewService(store, testutil.Logger(nil))
			if err := fresh.Load(ctx); err != nil {
				t.Fatal(err)
			}
			got, _ := fresh.Current(ctx)
			if len(got.Board.Items) != 0 || got.Board.Meta.MoveDate == nil || *got.Board.Meta.MoveDate != move || got.Board.Meta.KeyDate != nil {
				t.Fatalf("persisted board wrong: %+v", got.Board)
			}
		})
	}
}

// TestConflictBothChangesSurvive is the forced conflict from the plan: two
// writers start from the same ETag; the second one's PUT gets 412, re-reads,
// re-applies, and both changes end up in board.json.
func TestConflictBothChangesSurvive(t *testing.T) {
	for name, store := range testutil.Stores(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			seed := board.NewService(store, testutil.Logger(nil))
			if err := seed.Load(ctx); err != nil {
				t.Fatal(err)
			}
			items, _, err := seed.Create(ctx, "seed", []board.Patch{patch(t, `{"title":"Carpentry"}`)})
			if err != nil {
				t.Fatal(err)
			}
			id := items[0].ID

			// Two replicas, both holding the same ETag in memory.
			a := board.NewService(store, testutil.Logger(nil))
			b := board.NewService(store, testutil.Logger(nil))
			if err := a.Load(ctx); err != nil {
				t.Fatal(err)
			}
			if err := b.Load(ctx); err != nil {
				t.Fatal(err)
			}
			sa, _ := a.Current(ctx)
			sb, _ := b.Current(ctx)
			if sa.ETag != sb.ETag {
				t.Fatal("setup: replicas should share an ETag")
			}

			if _, _, err := a.Update(ctx, "a", id, patch(t, `{"quoted":18000}`)); err != nil {
				t.Fatal(err)
			}
			// b's cached ETag is now stale: this write must hit 412 and retry.
			if _, _, err := b.Update(ctx, "b", id, patch(t, `{"paid":5400}`)); err != nil {
				t.Fatal(err)
			}

			check := board.NewService(store, testutil.Logger(nil))
			if err := check.Load(ctx); err != nil {
				t.Fatal(err)
			}
			got, _ := check.Current(ctx)
			it, _ := got.Board.Find(id)
			if it.Quoted == nil || *it.Quoted != 18000 || it.Paid == nil || *it.Paid != 5400 {
				t.Fatalf("both changes must survive, got quoted=%v paid=%v", it.Quoted, it.Paid)
			}
		})
	}
}

// TestConcurrentWriters hammers one board from two replicas at once. Every
// create that reports success must be in the final board.
func TestConcurrentWriters(t *testing.T) {
	for name, store := range testutil.Stores(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			reps := []*board.Service{board.NewService(store, testutil.Logger(nil)), board.NewService(store, testutil.Logger(nil))}
			for _, r := range reps {
				if err := r.Load(ctx); err != nil {
					t.Fatal(err)
				}
			}
			var wg sync.WaitGroup
			var mu sync.Mutex
			ok, conflicts := map[string]bool{}, 0
			for i := 0; i < 10; i++ {
				for ri, r := range reps {
					wg.Add(1)
					go func(i, ri int, r *board.Service) {
						defer wg.Done()
						title := fmt.Sprintf("r%d-item%d", ri, i)
						_, _, err := r.Create(ctx, "x", []board.Patch{patch(t, `{"title":"`+title+`"}`)})
						mu.Lock()
						defer mu.Unlock()
						switch {
						case err == nil:
							ok[title] = true
						case errors.Is(err, board.ErrConflict):
							conflicts++
						default:
							t.Errorf("unexpected error: %v", err)
						}
					}(i, ri, r)
				}
			}
			wg.Wait()
			check := board.NewService(store, testutil.Logger(nil))
			if err := check.Load(ctx); err != nil {
				t.Fatal(err)
			}
			got, _ := check.Current(ctx)
			present := map[string]bool{}
			for _, it := range got.Board.Items {
				present[it.Title] = true
			}
			for title := range ok {
				if !present[title] {
					t.Errorf("acknowledged write %q was lost", title)
				}
			}
			if len(got.Board.Items) != len(ok) {
				t.Errorf("board has %d items, %d writes acknowledged", len(got.Board.Items), len(ok))
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
	ctx := context.Background()
	mem := objstore.NewMemory()
	if err := board.NewService(mem, testutil.Logger(nil)).Load(ctx); err != nil {
		t.Fatal(err)
	}
	svc := board.NewService(alwaysConflict{mem}, testutil.Logger(nil))
	if err := svc.Load(ctx); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Create(ctx, "x", []board.Patch{patch(t, `{"title":"a"}`)}); !errors.Is(err, board.ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}
}

func TestPollPicksUpOutsideWrites(t *testing.T) {
	ctx := context.Background()
	store := objstore.NewMemory()
	a := board.NewService(store, testutil.Logger(nil))
	b := board.NewService(store, testutil.Logger(nil))
	a.Load(ctx)
	b.Load(ctx)
	ch, cancel := b.Subscribe()
	defer cancel()
	if _, _, err := a.Create(ctx, "a", []board.Patch{patch(t, `{"title":"from a"}`)}); err != nil {
		t.Fatal(err)
	}
	if err := b.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case snap := <-ch:
		if len(snap.Board.Items) != 1 || snap.Board.Items[0].Title != "from a" {
			t.Fatalf("got %+v", snap.Board.Items)
		}
	default:
		t.Fatal("refresh after an outside write must notify subscribers")
	}
}
