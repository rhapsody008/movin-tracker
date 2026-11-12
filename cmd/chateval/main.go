// Command chateval sends a fixed set of messages to the real LLM endpoint
// configured by LLM_* (from .env), through the agent, and prints the entry
// diff after each one. It runs on an in-memory copy of
// fixtures/entries.sample.json, so it never touches a real bucket. Messages
// run in order on the same document. Exits non-zero if any message makes the
// wrong change.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/config"
	"github.com/rhapsody008/movin-tracker/internal/docs"
	"github.com/rhapsody008/movin-tracker/internal/docs/convert"
	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/settings"
	"github.com/rhapsody008/movin-tracker/internal/testutil"
)

// check gets the document before and after the message, and the result.
type check func(before, after *entries.Doc, res agent.Result) error

// lastLog is the log written during the current case (tool calls).
var lastLog string

type evalCase struct {
	msg   string
	group bool
	check check
}

const (
	seedCleaning   = "01K9SEED000000000000000002"
	seedCountertop = "01K9SEED000000000000000003"
)

func live(d *entries.Doc, re string) []entries.Entry {
	rx := regexp.MustCompile("(?i)" + re)
	var out []entries.Entry
	for _, e := range d.Entries {
		if !e.Archived && (rx.MatchString(e.Title) || rx.MatchString(e.Vendor) || rx.MatchString(e.Notes)) {
			out = append(out, e)
		}
	}
	return out
}

// added returns entries present in after but not in before.
func added(before, after *entries.Doc) []entries.Entry {
	var out []entries.Entry
	for _, e := range after.Entries {
		if _, ok := before.Find(e.ID); !ok {
			out = append(out, e)
		}
	}
	return out
}

func eq(p *float64, v float64) bool { return p != nil && *p == v }

func unchanged(before, after *entries.Doc) error {
	if d := diff(before, after); len(d) != 1 || d[0] != "(no change)" {
		return fmt.Errorf("expected no change, got: %s", strings.Join(d, "; "))
	}
	return nil
}

// nextDec5 is the 5 Dec on or after today.
func nextDec5(now time.Time) string {
	d := fmt.Sprintf("%d-12-05", now.Year())
	if d < now.Format("2006-01-02") {
		d = fmt.Sprintf("%d-12-05", now.Year()+1)
	}
	return d
}

// fridays are the dates "Friday" can reasonably mean: the coming Friday
// (today if it is Friday) and the one after.
func fridays(now time.Time) []string {
	d := now
	for d.Weekday() != time.Friday {
		d = d.AddDate(0, 0, 1)
	}
	return []string{d.Format("2006-01-02"), d.AddDate(0, 0, 7).Format("2006-01-02")}
}

func cases(now time.Time) []evalCase {
	return []evalCase{
		{msg: "We move in on 5 Dec", check: func(_, a *entries.Doc, _ agent.Result) error {
			if want := nextDec5(now); a.Meta.MoveDate == nil || *a.Meta.MoveDate != want {
				return fmt.Errorf("moveDate = %v, want %s", deref(a.Meta.MoveDate), want)
			}
			return nil
		}},
		{msg: "Thinking of fluted glass for the dry kitchen sliding door", check: func(b, a *entries.Doc, _ agent.Result) error {
			n := added(b, a)
			if len(n) != 1 {
				return fmt.Errorf("want one new entry, got %d", len(n))
			}
			e := n[0]
			if e.Kind != "idea" || e.Room == nil || *e.Room != "dry kitchen" {
				return fmt.Errorf("got kind=%s room=%v, want idea / dry kitchen", e.Kind, deref(e.Room))
			}
			if e.Date != nil || e.Cost.Estimate != nil || e.Vendor != "" {
				return fmt.Errorf("invented a date, cost or vendor: %+v", e)
			}
			return nil
		}},
		{msg: "Decided: Daikin system 4 aircon, 5.8k from CoolAir", check: func(b, a *entries.Doc, _ agent.Result) error {
			n := added(b, a)
			if len(n) != 1 {
				return fmt.Errorf("want one new entry, got %d", len(n))
			}
			e := n[0]
			if e.Kind != "decision" && e.Status != "decided" {
				return fmt.Errorf("got kind=%s status=%s, want a decision", e.Kind, e.Status)
			}
			if !eq(e.Cost.Estimate, 5800) && !eq(e.Cost.Actual, 5800) {
				return fmt.Errorf("cost = %+v, want 5800", e.Cost)
			}
			if !strings.Contains(strings.ToLower(e.Vendor), "coolair") {
				return fmt.Errorf("vendor = %q, want CoolAir", e.Vendor)
			}
			return nil
		}},
		{msg: "Electrician coming Friday 2pm to check the DB", check: func(b, a *entries.Doc, _ agent.Result) error {
			n := added(b, a)
			if len(n) != 1 {
				return fmt.Errorf("want one new entry, got %d", len(n))
			}
			e := n[0]
			ok := e.Date != nil && (*e.Date == fridays(now)[0] || *e.Date == fridays(now)[1])
			if e.Kind != "task" || !ok || e.Time == nil || *e.Time != "14:00" {
				return fmt.Errorf("got kind=%s date=%v time=%v, want task / %s / 14:00", e.Kind, deref(e.Date), deref(e.Time), fridays(now)[0])
			}
			return nil
		}},
		{msg: "Lim quoted 18k for carpentry, paid 30% today", check: func(b, a *entries.Doc, _ agent.Result) error {
			es := live(a, "carpent")
			if len(es) != 1 {
				return fmt.Errorf("want exactly one live carpentry entry (update, not duplicate), got %d", len(es))
			}
			e := es[0]
			if !eq(e.Cost.Estimate, 18000) || !eq(e.Cost.Actual, 5400) {
				return fmt.Errorf("carpentry estimate=%v actual=%v, want 18000 / 5400", deref(e.Cost.Estimate), deref(e.Cost.Actual))
			}
			if !strings.Contains(strings.ToLower(e.Vendor+" "+e.Title+" "+e.Notes), "lim") {
				return fmt.Errorf("carpentry entry does not mention Lim")
			}
			return nil
		}},
		{msg: "Put the grey tiles in the bathroom", check: func(b, a *entries.Doc, res agent.Result) error {
			// Two bathrooms and no tiles on record: it should ask, not guess.
			if err := unchanged(b, a); err != nil {
				return err
			}
			if !strings.Contains(res.Reply, "?") {
				return fmt.Errorf("expected a clarifying question, got %q", res.Reply)
			}
			return nil
		}},
		{msg: "What did we decide for the kitchen countertop and how much was it?", check: func(b, a *entries.Doc, res agent.Result) error {
			if err := unchanged(b, a); err != nil {
				return err
			}
			r := strings.ReplaceAll(strings.ToLower(res.Reply), ",", "")
			if !strings.Contains(r, "sintered") || !(strings.Contains(r, "4200") || strings.Contains(r, "4.2k")) {
				return fmt.Errorf("reply should name sintered stone and 4,200: %q", res.Reply)
			}
			return nil
		}},
		{msg: "Drop the post-reno cleaning", check: func(_, a *entries.Doc, _ agent.Result) error {
			e, ok := a.Find(seedCleaning)
			if !ok {
				return fmt.Errorf("post-reno cleaning was hard-deleted; it should be archived")
			}
			if !e.Archived {
				return fmt.Errorf("post-reno cleaning is not archived")
			}
			return nil
		}},
		{msg: "Undo that", check: func(_, a *entries.Doc, _ agent.Result) error {
			e, ok := a.Find(seedCleaning)
			if !ok || e.Archived {
				return fmt.Errorf("post-reno cleaning should be back (not archived)")
			}
			return nil
		}},
		{msg: "We collected the keys today, that's a milestone", check: func(b, a *entries.Doc, _ agent.Result) error {
			before, after := milestones(b), milestones(a)
			if len(after) != len(before)+1 {
				return fmt.Errorf("want one new milestone, got %d → %d", len(before), len(after))
			}
			e := after[len(after)-1]
			if today := now.Format("2006-01-02"); e.Completed == nil || *e.Completed != today {
				return fmt.Errorf("milestone %q done on %v, want %s", e.Title, deref(e.Completed), today)
			}
			if !regexp.MustCompile(`(?i)key`).MatchString(e.Title) {
				return fmt.Errorf("milestone title %q doesn't mention the keys", e.Title)
			}
			return nil
		}},
		{msg: "What milestones have we hit so far?", check: func(b, a *entries.Doc, res agent.Result) error {
			if err := unchanged(b, a); err != nil {
				return err
			}
			if !regexp.MustCompile(`(?i)key`).MatchString(res.Reply) {
				return fmt.Errorf("reply should mention collecting the keys: %q", res.Reply)
			}
			return nil
		}},
		{msg: "Partner: ok see you at dinner", group: true, check: func(b, a *entries.Doc, res agent.Result) error {
			if err := unchanged(b, a); err != nil {
				return err
			}
			if !res.Silent {
				return fmt.Errorf("group chatter should get no reply, got %q", res.Reply)
			}
			return nil
		}},
	}
}

// milestones are the done, flagged entries, oldest change first.
func milestones(d *entries.Doc) []entries.Entry {
	var out []entries.Entry
	for _, e := range d.Entries {
		if !e.Archived && e.IsMilestone() {
			out = append(out, e)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Updated < out[j].Updated })
	return out
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
	saved := flag.Bool("saved", false, "use the LLM connection saved on the web page (settings.json in the configured bucket, read only) instead of LLM_* from .env; run it where the app's S3 settings and SETTINGS_SECRET are, e.g. docker compose exec app")
	kind := flag.String("kind", "", "switch the connection kind for this run: claude (keeps the key only if it belongs to the Claude origin)")
	model := flag.String("model", "", "use this model for this run")
	withDocs := flag.Bool("docs", false, "also ask about the real documents in the bucket (read only; needs -saved and poppler, i.e. run inside the dev app)")
	flag.Parse()
	c, err := config.Load()
	if err != nil {
		return err
	}
	llmCfg := c.LLM
	var bucket *objstore.S3
	if *withDocs && !*saved {
		return fmt.Errorf("-docs needs -saved (the documents are in the bucket)")
	}
	if *saved {
		store, err := objstore.NewS3(context.Background(), objstore.S3Options{Bucket: c.S3Bucket, Prefix: c.S3Prefix, Region: c.AWSRegion, EndpointURL: c.S3EndpointURL})
		if err != nil {
			return err
		}
		bucket = store
		sets, err := settings.NewService(store, c.LLM, c.SettingsSecret, testutil.Logger(nil))
		if err != nil {
			return err
		}
		llmCfg = sets.WithClaudeBaseURL(c.ClaudeBaseURL).Resolve(context.Background())
	}
	switch *kind {
	case "":
	case settings.KindClaude:
		if llmCfg.Kind != settings.KindClaude {
			// A key only goes to the origin it was configured for.
			if !settings.SameOrigin(llmCfg.BaseURL, c.ClaudeBaseURL) {
				llmCfg.APIKey = ""
			}
			llmCfg.Kind, llmCfg.BaseURL = settings.KindClaude, c.ClaudeBaseURL
		}
	default:
		return fmt.Errorf("-kind must be claude (or left out)")
	}
	if *model != "" {
		llmCfg.Model = *model
	}
	if llmCfg.BaseURL == "" || llmCfg.Model == "" {
		return fmt.Errorf("set LLM_BASE_URL, LLM_MODEL (and LLM_API_KEY if needed) in .env first, or use -saved")
	}
	if llmCfg.Kind == settings.KindClaude && llmCfg.APIKey == "" {
		return fmt.Errorf("no key for the Claude origin: save one on the web page (Settings → LLM) or set LLM_KIND=claude and LLM_API_KEY")
	}
	fixture := "fixtures/entries.sample.json"
	if flag.NArg() > 0 {
		fixture = flag.Arg(0)
	}
	data, err := os.ReadFile(fixture)
	if err != nil {
		return err
	}
	seed, err := entries.Decode(data)
	if err != nil {
		return err
	}

	ctx := context.Background()
	logs := &testutil.SyncBuffer{}
	svc := entries.NewService(objstore.NewMemory(), testutil.Logger(logs))
	svc.SetLocation(c.Location)
	if err := svc.Load(ctx); err != nil {
		return err
	}
	if _, err := svc.Replace(ctx, seed); err != nil {
		return err
	}
	runner := &agent.Runner{Entries: svc, Loc: c.Location, Log: testutil.Logger(logs), Now: time.Now}
	if *withDocs {
		// Read only: the Syncer is only asked for the index and page text,
		// never to sync, so nothing in the bucket changes.
		pop := &convert.Poppler{}
		syncer := &docs.Syncer{Store: bucket, Conv: pop, Log: testutil.Logger(logs)}
		ix, err := syncer.Index(ctx)
		if err != nil || len(ix.Docs) == 0 {
			return fmt.Errorf("no documents index in the bucket (%v); run a sync in the app first", err)
		}
		runner.Docs = &docs.Library{Sync: syncer}
		runner.Viewer = &docs.Viewer{Sync: syncer, Conv: pop}
	}
	now := time.Now().In(c.Location)
	effort := "server default"
	switch {
	case llmCfg.Kind == settings.KindClaude && llmCfg.ThinkOnDemand:
		effort = "low (think only when asked)"
	case llmCfg.ThinkOnDemand:
		effort = "thinking off (think only when asked)"
	}
	fmt.Printf("chat-eval: %s model %s at %s, %s, today %s\n\n", llmCfg.Kind, llmCfg.Model, llmCfg.BaseURL, effort, now.Format("Mon 2 Jan 2006"))
	var total agent.Result
	var secs float64

	all := cases(now)
	if *withDocs {
		all = append(all, docCases()...)
	}
	failed := 0
	for i, tc := range all {
		before, _ := svc.Current(ctx)
		start := time.Now()
		req := agent.Request{By: "chat-eval", Channel: "web", Group: tc.group, Turns: []agent.Turn{{Role: "user", Content: tc.msg}}}
		if tc.group {
			req.Channel = "telegram"
		}
		mark := len(logs.String())
		res, err := runner.Run(ctx, req, llmCfg, nil)
		lastLog = logs.String()[mark:]
		after, _ := svc.Current(ctx)
		took := time.Since(start).Seconds()
		secs += took
		u := res.Usage
		total.Usage.In += u.In
		total.Usage.Out += u.Out
		total.Usage.CacheRead += u.CacheRead
		total.Usage.CacheWrite += u.CacheWrite
		fmt.Printf("%d. %q  (%.1fs)\n", i+1, tc.msg, took)
		fmt.Printf("   usage:   in %d, out %d, cache read %d, cache write %d\n", u.In, u.Out, u.CacheRead, u.CacheWrite)
		if err != nil {
			fmt.Printf("   FAIL  agent error: %v\n\n", err)
			failed++
			continue
		}
		if res.Silent {
			fmt.Printf("   reply:   (silent)\n")
		} else {
			fmt.Printf("   reply:   %s\n", res.Reply)
		}
		for _, l := range res.Changes {
			fmt.Printf("   change:  %s\n", l.Text)
		}
		for _, l := range diff(before.Doc, after.Doc) {
			fmt.Printf("   diff:    %s\n", l)
		}
		if err := tc.check(before.Doc, after.Doc, res); err != nil {
			fmt.Printf("   FAIL  %v\n\n", err)
			failed++
		} else {
			fmt.Printf("   PASS\n\n")
		}
	}
	printTotals(len(all), secs, total)
	if failed > 0 {
		fmt.Println("tool-call log:")
		for _, l := range strings.Split(strings.TrimSpace(logs.String()), "\n") {
			if strings.Contains(l, "agent tool call") {
				fmt.Println("  ", l)
			}
		}
		return fmt.Errorf("%d of %d messages made the wrong change", failed, len(all))
	}
	fmt.Printf("All %d messages produced the right change.\n", len(all))
	return nil
}

// printTotals sums the run. Prompt tokens follow Claude's accounting, where
// cached tokens are reported apart from input (vMLX reports no cache use).
func printTotals(n int, secs float64, u agent.Result) {
	t := u.Usage
	prompt := t.In + t.CacheRead + t.CacheWrite
	hit := 0.0
	if prompt > 0 {
		hit = 100 * float64(t.CacheRead) / float64(prompt)
	}
	fmt.Printf("totals: %d messages, %.1f s (%.1f s each), prompt tokens %d (uncached %d, cache read %d = %.0f%%, cache write %d), output %d\n",
		n, secs, secs/float64(max(n, 1)), prompt, t.In, t.CacheRead, hit, t.CacheWrite, t.Out)
}

// diff describes what changed between two documents, field by field.
func diff(a, b *entries.Doc) []string {
	var out []string
	if s := deref(a.Meta.MoveDate); s != deref(b.Meta.MoveDate) {
		out = append(out, fmt.Sprintf("meta.moveDate: %v → %v", s, deref(b.Meta.MoveDate)))
	}
	if s := deref(a.Meta.KeyDate); s != deref(b.Meta.KeyDate) {
		out = append(out, fmt.Sprintf("meta.keyDate: %v → %v", s, deref(b.Meta.KeyDate)))
	}
	old := map[string]entries.Entry{}
	for _, e := range a.Entries {
		old[e.ID] = e
	}
	seen := map[string]bool{}
	for _, e := range b.Entries {
		seen[e.ID] = true
		prev, ok := old[e.ID]
		if !ok {
			j, _ := json.Marshal(map[string]any{"kind": e.Kind, "room": e.Room, "category": e.Category, "status": e.Status, "date": e.Date, "time": e.Time, "vendor": e.Vendor, "estimate": e.Cost.Estimate, "actual": e.Cost.Actual, "milestone": e.Milestone, "completed": e.Completed})
			out = append(out, fmt.Sprintf("+ %q %s", e.Title, j))
			continue
		}
		var ch []string
		cmp := func(name string, x, y any) {
			if fmt.Sprint(x) != fmt.Sprint(y) {
				ch = append(ch, fmt.Sprintf("%s: %v → %v", name, x, y))
			}
		}
		cmp("title", prev.Title, e.Title)
		cmp("kind", prev.Kind, e.Kind)
		cmp("room", deref(prev.Room), deref(e.Room))
		cmp("category", prev.Category, e.Category)
		cmp("status", prev.Status, e.Status)
		cmp("date", deref(prev.Date), deref(e.Date))
		cmp("time", deref(prev.Time), deref(e.Time))
		cmp("vendor", prev.Vendor, e.Vendor)
		cmp("estimate", deref(prev.Cost.Estimate), deref(e.Cost.Estimate))
		cmp("actual", deref(prev.Cost.Actual), deref(e.Cost.Actual))
		cmp("notes", prev.Notes, e.Notes)
		cmp("archived", prev.Archived, e.Archived)
		cmp("milestone", prev.Milestone, e.Milestone)
		cmp("completed", deref(prev.Completed), deref(e.Completed))
		if len(ch) > 0 {
			out = append(out, fmt.Sprintf("~ %q %s", prev.Title, strings.Join(ch, ", ")))
		}
	}
	for _, e := range a.Entries {
		if !seen[e.ID] {
			out = append(out, fmt.Sprintf("- %q (hard-deleted)", e.Title))
		}
	}
	if len(out) == 0 {
		out = append(out, "(no change)")
	}
	return out
}
