// Command chateval sends the Phase 3 messages to the real LLM endpoint
// configured by LLM_* (from .env) and prints the board diff after each one.
// It runs on an in-memory copy of fixtures/board.sample.json, so it never
// touches a real bucket. Exits non-zero if any message makes the wrong change.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/rhapsody008/movin-tracker/internal/board"
	"github.com/rhapsody008/movin-tracker/internal/chat"
	"github.com/rhapsody008/movin-tracker/internal/config"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/testutil"
)

type check func(b *board.Board) error

type evalCase struct {
	msg   string
	check check
}

func live(b *board.Board, re string) []board.Item {
	rx := regexp.MustCompile("(?i)" + re)
	var out []board.Item
	for _, it := range b.Items {
		if !it.Archived && (rx.MatchString(it.Title) || rx.MatchString(it.Vendor)) {
			out = append(out, it)
		}
	}
	return out
}

func eq(p *float64, v float64) bool { return p != nil && *p == v }

// nextDec5 is the 5 Dec on or after today.
func nextDec5(now time.Time) string {
	d := fmt.Sprintf("%d-12-05", now.Year())
	if d < now.Format("2006-01-02") {
		d = fmt.Sprintf("%d-12-05", now.Year()+1)
	}
	return d
}

func cases(now time.Time) []evalCase {
	return []evalCase{
		{"We move in on 5 Dec", func(b *board.Board) error {
			if want := nextDec5(now); b.Meta.MoveDate == nil || *b.Meta.MoveDate != want {
				return fmt.Errorf("moveDate = %v, want %s", deref(b.Meta.MoveDate), want)
			}
			return nil
		}},
		{"Lim quoted 18k for carpentry, paid 30% today", func(b *board.Board) error {
			its := live(b, "carpent")
			if len(its) != 1 {
				return fmt.Errorf("want exactly one live carpentry item (update, not duplicate), got %d", len(its))
			}
			it := its[0]
			if !eq(it.Quoted, 18000) || !eq(it.Paid, 5400) {
				return fmt.Errorf("carpentry quoted=%v paid=%v, want 18000 / 5400", deref(it.Quoted), deref(it.Paid))
			}
			if !strings.Contains(strings.ToLower(it.Vendor+" "+it.Title+" "+it.Notes), "lim") {
				return fmt.Errorf("carpentry item does not mention Lim")
			}
			return nil
		}},
		{"Add a 3-seater sofa, budget 2k, to the shopping list", func(b *board.Board) error {
			its := live(b, "sofa")
			if len(its) != 1 {
				return fmt.Errorf("want one sofa item, got %d", len(its))
			}
			if its[0].Cat != "shopping" || !eq(its[0].Quoted, 2000) {
				return fmt.Errorf("sofa cat=%s quoted=%v, want shopping / 2000", its[0].Cat, deref(its[0].Quoted))
			}
			if its[0].Due != nil {
				return fmt.Errorf("sofa got an invented date %s", *its[0].Due)
			}
			return nil
		}},
		{"Drop the post-reno cleaning", func(b *board.Board) error {
			it, ok := b.Find("01K7SEED000000000000000009")
			if !ok {
				return fmt.Errorf("post-reno cleaning was hard-deleted; it should be archived")
			}
			if !it.Archived {
				return fmt.Errorf("post-reno cleaning is not archived")
			}
			return nil
		}},
	}
}

func deref[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	if os.Getenv("S3_BUCKET") == "" {
		os.Setenv("S3_BUCKET", "unused") // config requires it; chat-eval uses memory
	}
	c, err := config.Load()
	if err != nil {
		return err
	}
	if c.LLM.BaseURL == "" || c.LLM.Model == "" {
		return fmt.Errorf("set LLM_BASE_URL, LLM_MODEL (and LLM_API_KEY) in .env first")
	}
	fixture := "fixtures/board.sample.json"
	if len(os.Args) > 1 {
		fixture = os.Args[1]
	}
	data, err := os.ReadFile(fixture)
	if err != nil {
		return err
	}
	seed, err := board.Decode(data)
	if err != nil {
		return err
	}

	ctx := context.Background()
	logs := &testutil.SyncBuffer{}
	svc := board.NewService(objstore.NewMemory(), testutil.Logger(logs))
	if err := svc.Load(ctx); err != nil {
		return err
	}
	if _, err := svc.Replace(ctx, seed); err != nil {
		return err
	}
	runner := &chat.Runner{Board: svc, Loc: c.Location, Log: testutil.Logger(logs), Now: time.Now}
	now := time.Now().In(c.Location)
	fmt.Printf("chat-eval: model %s at %s, today %s\n\n", c.LLM.Model, c.LLM.BaseURL, now.Format("Mon 2 Jan 2006"))

	failed := 0
	for i, tc := range cases(now) {
		before, _ := svc.Current(ctx)
		start := time.Now()
		res, err := runner.Run(ctx, "chat-eval", c.LLM, []chat.Turn{{Role: "user", Content: tc.msg}}, nil)
		after, _ := svc.Current(ctx)
		fmt.Printf("%d. %q  (%.1fs)\n", i+1, tc.msg, time.Since(start).Seconds())
		if err != nil {
			fmt.Printf("   FAIL  chat error: %v\n\n", err)
			failed++
			continue
		}
		fmt.Printf("   reply:   %s\n", res.Reply)
		for _, l := range res.Changes {
			fmt.Printf("   change:  %s\n", l)
		}
		for _, l := range diff(before.Board, after.Board) {
			fmt.Printf("   diff:    %s\n", l)
		}
		if err := tc.check(after.Board); err != nil {
			fmt.Printf("   FAIL  %v\n\n", err)
			failed++
		} else {
			fmt.Printf("   PASS\n\n")
		}
	}
	if failed > 0 {
		fmt.Println("tool-call log:")
		for _, l := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
			if strings.Contains(l, "chat tool call") {
				fmt.Println("  ", l)
			}
		}
		return fmt.Errorf("%d of 4 messages made the wrong change", failed)
	}
	fmt.Println("All 4 messages produced the right board change.")
	return nil
}

// diff describes what changed between two boards, field by field.
func diff(a, b *board.Board) []string {
	var out []string
	if s := deref(a.Meta.MoveDate); s != deref(b.Meta.MoveDate) {
		out = append(out, fmt.Sprintf("meta.moveDate: %v → %v", s, deref(b.Meta.MoveDate)))
	}
	if s := deref(a.Meta.KeyDate); s != deref(b.Meta.KeyDate) {
		out = append(out, fmt.Sprintf("meta.keyDate: %v → %v", s, deref(b.Meta.KeyDate)))
	}
	old := map[string]board.Item{}
	for _, it := range a.Items {
		old[it.ID] = it
	}
	seen := map[string]bool{}
	for _, it := range b.Items {
		seen[it.ID] = true
		prev, ok := old[it.ID]
		if !ok {
			j, _ := json.Marshal(map[string]any{"cat": it.Cat, "status": it.Status, "due": it.Due, "time": it.Time, "vendor": it.Vendor, "quoted": it.Quoted, "paid": it.Paid})
			out = append(out, fmt.Sprintf("+ %q %s", it.Title, j))
			continue
		}
		var ch []string
		cmp := func(name string, x, y any) {
			if fmt.Sprint(x) != fmt.Sprint(y) {
				ch = append(ch, fmt.Sprintf("%s: %v → %v", name, x, y))
			}
		}
		cmp("title", prev.Title, it.Title)
		cmp("cat", prev.Cat, it.Cat)
		cmp("status", prev.Status, it.Status)
		cmp("due", deref(prev.Due), deref(it.Due))
		cmp("time", deref(prev.Time), deref(it.Time))
		cmp("vendor", prev.Vendor, it.Vendor)
		cmp("quoted", deref(prev.Quoted), deref(it.Quoted))
		cmp("paid", deref(prev.Paid), deref(it.Paid))
		cmp("notes", prev.Notes, it.Notes)
		cmp("archived", prev.Archived, it.Archived)
		if len(ch) > 0 {
			out = append(out, fmt.Sprintf("~ %q %s", prev.Title, strings.Join(ch, ", ")))
		}
	}
	for _, it := range a.Items {
		if !seen[it.ID] {
			out = append(out, fmt.Sprintf("- %q (hard-deleted)", it.Title))
		}
	}
	if len(out) == 0 {
		out = append(out, "(no change)")
	}
	return out
}
