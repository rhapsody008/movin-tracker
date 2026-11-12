package agent_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/settings"
	"github.com/rhapsody008/movin-tracker/internal/testutil"
)

// step is one scripted model response: either text or tool calls.
type step struct {
	text  string
	calls [][2]string // name, arguments JSON
}

type sentMsg struct {
	Role       string `json:"role"`
	Content    string `json:"content"`
	ToolCallID string `json:"tool_call_id"`
}

// scriptLLM is a stub OpenAI-compatible endpoint that plays steps in order
// and records every request's messages and tool_choice.
type scriptLLM struct {
	mu      sync.Mutex
	steps   []step
	reqs    [][]sentMsg
	choices []string
	srv     *httptest.Server
}

func newScript(t *testing.T, steps ...step) *scriptLLM {
	s := &scriptLLM{steps: steps}
	s.srv = httptest.NewServer(http.HandlerFunc(s.handle))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *scriptLLM) handle(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Stream     bool      `json:"stream"`
		ToolChoice string    `json:"tool_choice"`
		Messages   []sentMsg `json:"messages"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	s.mu.Lock()
	s.reqs = append(s.reqs, req.Messages)
	s.choices = append(s.choices, req.ToolChoice)
	var st step
	if len(s.steps) > 0 {
		st, s.steps = s.steps[0], s.steps[1:]
	} else {
		st = step{text: "Done talking."}
	}
	s.mu.Unlock()
	if req.ToolChoice == "none" {
		st.calls = nil
		if st.text == "" {
			st.text = "Forced answer."
		}
	}
	var calls []any
	for i, c := range st.calls {
		calls = append(calls, map[string]any{"id": fmt.Sprintf("call_%d", i), "type": "function", "function": map[string]string{"name": c[0], "arguments": c[1]}})
	}
	if !req.Stream {
		msg := map[string]any{"role": "assistant", "content": st.text}
		if calls != nil {
			msg["tool_calls"] = calls
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": msg}}})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	chunk := func(delta map[string]any) {
		b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": delta}}})
		fmt.Fprintf(w, "data: %s\n\n", b)
	}
	for i, c := range st.calls {
		chunk(map[string]any{"tool_calls": []any{map[string]any{"index": i, "id": fmt.Sprintf("call_%d", i), "type": "function", "function": map[string]string{"name": c[0], "arguments": ""}}}})
		half := len(c[1]) / 2
		chunk(map[string]any{"tool_calls": []any{map[string]any{"index": i, "function": map[string]string{"arguments": c[1][:half]}}}})
		chunk(map[string]any{"tool_calls": []any{map[string]any{"index": i, "function": map[string]string{"arguments": c[1][half:]}}}})
	}
	for _, word := range strings.SplitAfter(st.text, " ") {
		if word != "" {
			chunk(map[string]any{"content": word})
		}
	}
	fmt.Fprint(w, "data: [DONE]\n\n")
}

func (s *scriptLLM) toolResults() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	if len(s.reqs) == 0 {
		return nil
	}
	for _, m := range s.reqs[len(s.reqs)-1] {
		if m.Role == "tool" {
			out = append(out, m.Content)
		}
	}
	return out
}

type rig struct {
	runner *agent.Runner
	svc    *entries.Service
	llm    *scriptLLM
	cfg    settings.LLM
	logs   *testutil.SyncBuffer
}

func newRig(t *testing.T, steps ...step) *rig {
	t.Helper()
	logs := &testutil.SyncBuffer{}
	svc := entries.NewService(objstore.NewMemory(), testutil.Logger(logs))
	if err := svc.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	s := newScript(t, steps...)
	cfg := settings.Defaults
	cfg.BaseURL, cfg.Model, cfg.Streaming, cfg.MaxToolRounds = s.srv.URL+"/v1", "m", false, 5
	return &rig{
		runner: &agent.Runner{Entries: svc, Loc: time.UTC, Log: testutil.Logger(logs), Now: func() time.Time { return time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC) }},
		svc:    svc, llm: s, cfg: cfg, logs: logs,
	}
}

func (r *rig) run(t *testing.T, req agent.Request) agent.Result {
	t.Helper()
	res, err := r.runner.Run(context.Background(), req, r.cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func user(by, channel, text string) agent.Request {
	return agent.Request{By: by, Channel: channel, Turns: []agent.Turn{{Role: "user", Content: text}}}
}

func TestAddEntryProducesChangeLinesWithUndoIDs(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", stream), func(t *testing.T) {
			r := newRig(t,
				step{calls: [][2]string{{"add_entry", `{"entries":[{"kind":"idea","title":"Quartz countertop","room":"wet kitchen","estimate":3000},{"kind":"task","title":"Electrician visit","date":"2026-11-14","time":"14:00"}]}`}}},
				step{text: "Saved both."},
			)
			r.cfg.Streaming = stream
			var events []agent.Event
			res, err := r.runner.Run(context.Background(), user("partner", "telegram", "quartz for wet kitchen ~3k, electrician Fri 2pm"), r.cfg, func(e agent.Event) { events = append(events, e) })
			if err != nil {
				t.Fatal(err)
			}
			if res.Reply != "Saved both." || len(res.Changes) != 2 {
				t.Fatalf("reply %q changes %+v", res.Reply, res.Changes)
			}
			if res.Changes[0].Text != "Saved: wet kitchen · idea · Quartz countertop · est $3,000" {
				t.Fatalf("line 0 = %q", res.Changes[0].Text)
			}
			if res.Changes[1].Text != "Saved: task · Electrician visit · Sat, 14 Nov 14:00" {
				t.Fatalf("line 1 = %q", res.Changes[1].Text)
			}
			snap, _ := r.svc.Current(context.Background())
			for i, c := range res.Changes {
				if c.ID == "" || snap.Doc.Changes[i].ID != c.ID {
					t.Fatalf("change line %d does not carry its journal id", i)
				}
			}
			for _, e := range snap.Doc.Entries {
				if e.By != "partner" || e.Channel != "telegram" {
					t.Fatalf("actor not stamped: %+v", e)
				}
			}
			var changeEvents int
			for _, e := range events {
				if e.Type == "change" && e.ID != "" {
					changeEvents++
				}
			}
			if changeEvents != 2 {
				t.Fatalf("want 2 change events with ids, got %+v", events)
			}
			if !strings.Contains(r.logs.String(), `"msg":"agent tool call"`) || !strings.Contains(r.logs.String(), `"channel":"telegram"`) {
				t.Fatal("tool call not logged with channel")
			}
		})
	}
}

func TestUpdateSearchAndArchive(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	res, _ := r.svc.Create(ctx, entries.Actor{By: "zy", Channel: "web"}, []entries.Patch{mustPatch(t, `{"kind":"task","title":"Carpentry","vendor":"Lim","cost":{"estimate":18000}}`)})
	id := res.Entries[0].ID

	r.llm.steps = []step{
		{calls: [][2]string{{"search_entries", `{"vendor":"lim"}`}}},
		{calls: [][2]string{{"update_entry", fmt.Sprintf(`{"id":%q,"actual":5400,"status":"doing","stray":"ignored"}`, id)}}},
		{text: "Recorded the deposit."},
	}
	out := r.run(t, user("zy", "web", "paid Lim 30% today"))
	if len(out.Changes) != 1 || out.Changes[0].Text != "Updated: Carpentry (status doing, paid $5,400)" {
		t.Fatalf("changes %+v", out.Changes)
	}
	// The search result reached the model before the update.
	if first := r.llm.reqs[1]; !strings.Contains(first[len(first)-1].Content, `"total":1`) {
		t.Fatalf("search result not sent to model: %+v", first[len(first)-1])
	}

	r.llm.steps = []step{{calls: [][2]string{{"update_entry", fmt.Sprintf(`{"id":%q,"archived":true}`, id)}}}, {text: "Dropped."}}
	out = r.run(t, user("zy", "web", "drop the carpentry one"))
	if out.Changes[0].Text != "Archived: Carpentry" {
		t.Fatalf("archive line %q", out.Changes[0].Text)
	}
}

func TestToolErrorsGoBackToTheModel(t *testing.T) {
	r := newRig(t,
		step{calls: [][2]string{{"teleport", `{}`}, {"add_entry", `{"entries":[{"kind":"idea","title":"x","room":"garage"}]}`}, {"update_entry", `not json`}}},
		step{text: "Sorry."},
	)
	out := r.run(t, user("zy", "web", "hi"))
	if len(out.Changes) != 0 {
		t.Fatalf("nothing should change: %+v", out.Changes)
	}
	results := r.llm.toolResults()
	if len(results) != 3 {
		t.Fatalf("want 3 tool results, got %v", results)
	}
	for i, want := range []string{`unknown tool`, `room must be one of`, `not valid JSON`} {
		if !strings.Contains(results[i], `"error"`) || !strings.Contains(results[i], want) {
			t.Errorf("result %d = %s, want error containing %q", i, results[i], want)
		}
	}
}

func TestForcedAnswerWhenModelKeepsCallingTools(t *testing.T) {
	loop := step{calls: [][2]string{{"search_entries", `{}`}}}
	r := newRig(t, loop, loop, loop, loop)
	r.cfg.MaxToolRounds = 2
	out := r.run(t, user("zy", "web", "what's up"))
	if out.Reply != "Forced answer." {
		t.Fatalf("reply %q", out.Reply)
	}
	if n := len(r.llm.choices); n != 3 || r.llm.choices[2] != "none" {
		t.Fatalf("want 3 rounds with the last forced, got %v", r.llm.choices)
	}
}

func TestUndoChangeWithoutIDUndoesCallersLatest(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	mine, _ := r.svc.Create(ctx, entries.Actor{By: "zy", Channel: "telegram"}, []entries.Patch{mustPatch(t, `{"kind":"idea","title":"Mine"}`)})
	r.svc.Create(ctx, entries.Actor{By: "partner", Channel: "telegram"}, []entries.Patch{mustPatch(t, `{"kind":"idea","title":"Theirs"}`)})

	r.llm.steps = []step{{calls: [][2]string{{"undo_change", `{}`}}}, {text: "Undone."}}
	out := r.run(t, user("zy", "telegram", "undo that"))
	if len(out.Changes) != 1 || out.Changes[0].Text != "Undone: removed Mine" {
		t.Fatalf("changes %+v", out.Changes)
	}
	snap, _ := r.svc.Current(ctx)
	if _, ok := snap.Doc.Find(mine.Entries[0].ID); ok || len(snap.Doc.Entries) != 1 {
		t.Fatal("zy's entry should be gone and partner's kept")
	}
}

func TestSetDates(t *testing.T) {
	r := newRig(t, step{calls: [][2]string{{"set_dates", `{"move_in":"2026-12-05"}`}}}, step{text: "Set."})
	out := r.run(t, user("zy", "web", "we move in on 5 Dec"))
	if len(out.Changes) != 1 || out.Changes[0].Text != "Move-in set to Sat, 5 Dec" || out.Changes[0].ID != "" {
		t.Fatalf("changes %+v", out.Changes)
	}
}

func TestGroupSilence(t *testing.T) {
	r := newRig(t, step{text: agent.SilentReply})
	req := user("partner", "telegram", "Partner: dinner at 7?")
	req.Group = true
	if out := r.run(t, req); !out.Silent || out.Reply != "" {
		t.Fatalf("want silent, got %+v", out)
	}
	if sys := r.llm.reqs[0][0].Content; !strings.Contains(sys, "group chat") || !strings.Contains(sys, agent.SilentReply) {
		t.Fatal("group rule missing from the system prompt")
	}

	// Never silent once something was recorded.
	r.llm.steps = []step{{calls: [][2]string{{"add_entry", `{"entries":[{"kind":"note","title":"Lift booking needed"}]}`}}}, {text: agent.SilentReply}}
	if out := r.run(t, req); out.Silent || out.Reply != "Done." || len(out.Changes) != 1 {
		t.Fatalf("want a reply after a change, got %+v", out)
	}

	// Outside a group, the marker is never honoured.
	r.llm.steps = []step{{text: agent.SilentReply}}
	if out := r.run(t, user("zy", "web", "ok")); out.Silent || out.Reply == "" {
		t.Fatalf("web chat must always answer, got %+v", out)
	}
}

func TestSystemSectionsListRecentEntriesOnly(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	clock := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	r.svc.SetClock(func() time.Time { clock = clock.Add(time.Second); return clock })
	a := entries.Actor{By: "zy", Channel: "web"}
	var ids []string
	for i := 0; i < agent.PromptEntries+5; i++ {
		res, _ := r.svc.Create(ctx, a, []entries.Patch{mustPatch(t, fmt.Sprintf(`{"kind":"note","title":"n%03d"}`, i))})
		ids = append(ids, res.Entries[0].ID)
	}
	// n000 is the oldest and would drop off; touching it makes it recent.
	r.svc.Update(ctx, a, ids[0], mustPatch(t, `{"notes":"touched"}`))
	// An archived entry never appears, however recent.
	r.svc.Update(ctx, a, ids[1], mustPatch(t, `{"archived":true}`))
	snap, _ := r.svc.Current(ctx)
	var sb strings.Builder
	for _, s := range r.runner.SystemSections(snap.Doc, agent.Request{}) {
		sb.WriteString(s.Text)
	}
	p := sb.String()
	if !strings.Contains(p, "use search_entries for the rest") || !strings.Contains(p, "master bathroom") || strings.Contains(p, "group chat") {
		t.Fatal("prompt missing the overflow hint, the room list, or has the group rule outside a group")
	}
	if !strings.Contains(p, `"n000"`) || strings.Contains(p, `"n001"`) {
		t.Fatal("want the touched n000 listed and the archived n001 left out")
	}
	// 154 live (one archived), 150 shown: the four oldest untouched,
	// n002..n005, fall off.
	for _, gone := range []string{`"n002"`, `"n005"`} {
		if strings.Contains(p, gone) {
			t.Fatalf("%s should have dropped off", gone)
		}
	}
	if !strings.Contains(p, `"n006"`) || !strings.Contains(p, `"n007"`) {
		t.Fatal("n006 and n007 should be listed")
	}
	// Listed in creation order, and the rules come before the entries (stable prefix).
	if i0, i7, i8 := strings.Index(p, `"n000"`), strings.Index(p, `"n007"`), strings.Index(p, `"n008"`); i0 >= i7 || i7 >= i8 {
		t.Fatal("entries should be in creation order")
	}
	if strings.Index(p, "Rules:") > strings.Index(p, "Current entries") {
		t.Fatal("rules should come before the entry list")
	}
}

func TestRunRejectsBadInput(t *testing.T) {
	r := newRig(t)
	if _, err := r.runner.Run(context.Background(), agent.Request{Turns: []agent.Turn{{Role: "assistant", Content: "hi"}}}, r.cfg, nil); err == nil {
		t.Fatal("want error when the last turn is not a user turn")
	}
	cfg := r.cfg
	cfg.Model = ""
	var ie *agent.InputError
	if _, err := r.runner.Run(context.Background(), user("zy", "web", "hi"), cfg, nil); !errors.As(err, &ie) || !strings.Contains(err.Error(), "Settings → LLM") {
		t.Fatalf("want an InputError pointing at Settings → LLM, got %v", err)
	}
}

func TestCleanTurns(t *testing.T) {
	var in []agent.Turn
	in = append(in, agent.Turn{Role: "assistant", Content: "hello"}, agent.Turn{Role: "system", Content: "x"}, agent.Turn{Role: "user", Content: " "})
	for i := 0; i < 20; i++ {
		in = append(in, agent.Turn{Role: "user", Content: fmt.Sprint(i)}, agent.Turn{Role: "assistant", Content: "ok"})
	}
	in = append(in, agent.Turn{Role: "user", Content: strings.Repeat("é", 5000)})
	out := agent.CleanTurns(in)
	if len(out) > agent.MaxTurns || out[0].Role != "user" || len([]rune(out[len(out)-1].Content)) != 4000 {
		t.Fatalf("got %d turns, first %q", len(out), out[0].Role)
	}
}

func TestMoneyAndChangeText(t *testing.T) {
	for in, want := range map[float64]string{0: "$0", 950: "$950", 3000: "$3,000", 1234567: "$1,234,567", 1234.5: "$1,234.50", 99.999: "$100"} {
		if got := agent.Money(in); got != want {
			t.Errorf("Money(%v) = %q, want %q", in, got, want)
		}
	}
	room := "flex"
	before := entries.Entry{Kind: "idea", Title: "Nook", Status: "idea"}
	after := before
	after.Room, after.Status = &room, "decided"
	cases := map[string]entries.Change{
		"Updated: Nook (status decided, room flex)": {Op: "update", Before: &before, After: &after},
		"Deleted: Nook":         {Op: "delete", Before: &before},
		"Undone: restored Nook": {Op: "undo", After: &before},
		"Undone: removed Nook":  {Op: "undo", Before: &before},
		"Undone: Nook":          {Op: "undo", Before: &after, After: &before},
		"Saved: idea · Nook":    {Op: "create", After: &before},
		"Updated: Nook":         {Op: "update", Before: &before, After: &before},
	}
	for want, c := range cases {
		if got := agent.ChangeText(c); got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	}
}

func mustPatch(t *testing.T, js string) entries.Patch {
	t.Helper()
	var p entries.Patch
	if err := json.Unmarshal([]byte(js), &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestParseThink(t *testing.T) {
	for _, c := range []struct {
		in, rest string
		think    bool
	}{
		{"/think compare the quotes", "compare the quotes", true},
		{"  /THINK\nwhich one?", "which one?", true},
		{"/think", "", true},
		{"/thinking about tiles", "/thinking about tiles", false},
		{"I think so", "I think so", false},
		{"/thin", "/thin", false},
	} {
		rest, think := agent.ParseThink(c.in)
		if rest != c.rest || think != c.think {
			t.Errorf("ParseThink(%q) = %q, %v; want %q, %v", c.in, rest, think, c.rest, c.think)
		}
	}
}
