package agent_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/settings"
)

// claudeStep is one scripted Messages API reply.
type claudeStep struct {
	stop    string      // end_turn, tool_use, refusal, max_tokens
	text    string      // text block (may be empty)
	calls   [][2]string // tool name + JSON input
	thought string      // a thinking block, sent back verbatim next round
}

type claudeScript struct {
	srv   *httptest.Server
	mu    sync.Mutex
	steps []claudeStep
	reqs  []map[string]json.RawMessage
}

func newClaudeScript(t *testing.T, steps ...claudeStep) *claudeScript {
	s := &claudeScript{steps: steps}
	n := 0
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/models/") { // fallback lookup: none
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"id":"claude-opus-5-5","type":"model","allowed_fallback_models":[]}`)
			return
		}
		b, _ := io.ReadAll(r.Body)
		var m map[string]json.RawMessage
		json.Unmarshal(b, &m)
		s.mu.Lock()
		s.reqs = append(s.reqs, m)
		if len(s.steps) == 0 {
			s.mu.Unlock()
			t.Errorf("unscripted request")
			w.WriteHeader(500)
			return
		}
		st := s.steps[0]
		s.steps = s.steps[1:]
		n++
		id := n
		s.mu.Unlock()
		var content []map[string]any
		if st.thought != "" {
			content = append(content, map[string]any{"type": "thinking", "thinking": st.thought, "signature": "sig-" + st.thought})
		}
		if st.text != "" {
			content = append(content, map[string]any{"type": "text", "text": st.text})
		}
		for i, c := range st.calls {
			var in any
			json.Unmarshal([]byte(c[1]), &in)
			content = append(content, map[string]any{"type": "tool_use", "id": "toolu_" + string(rune('a'+id)) + string(rune('0'+i)), "name": c[0], "input": in})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"id": "msg", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
			"content": content, "stop_reason": st.stop,
			"usage": map[string]any{"input_tokens": 100, "output_tokens": 10, "cache_read_input_tokens": 80 * (id - 1), "cache_creation_input_tokens": 20},
		})
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func claudeRig(t *testing.T, steps ...claudeStep) (*rig, *claudeScript) {
	r := newRig(t)
	cs := newClaudeScript(t, steps...)
	r.cfg = settings.Defaults
	r.cfg.Kind, r.cfg.BaseURL, r.cfg.APIKey, r.cfg.Model = settings.KindClaude, cs.srv.URL, "sk-ant-test", "claude-opus-5-5"
	r.cfg.Streaming, r.cfg.MaxToolRounds = false, 3
	return r, cs
}

func TestClaudeAgentRecordsAndKeepsThePrefix(t *testing.T) {
	r, cs := claudeRig(t,
		claudeStep{stop: "tool_use", thought: "record it", calls: [][2]string{{"add_entry", `{"entries":[{"kind":"idea","title":"Quartz countertop","room":"wet kitchen"}]}`}}},
		claudeStep{stop: "tool_use", thought: "and the date", text: "Also the date.", calls: [][2]string{{"set_dates", `{"move_in":"2027-03-15"}`}}},
		claudeStep{stop: "end_turn", text: "Saved both."},
	)
	res := r.run(t, user("ZY", "telegram", "quartz for the wet kitchen; we move in 15 Mar 2027"))
	if res.Reply != "Saved both." || len(res.Changes) != 2 || res.Changes[0].ID == "" {
		t.Fatalf("res %+v", res)
	}
	if res.Usage.In != 300 || res.Usage.CacheRead != 240 || res.Usage.CacheWrite != 60 {
		t.Errorf("usage totals %+v", res.Usage)
	}
	if !strings.Contains(r.logs.String(), `"msg":"llm call"`) || !strings.Contains(r.logs.String(), `"cacheRead":160`) {
		t.Errorf("per-call usage not logged")
	}
	// Append-only within the turn: each request repeats the previous
	// request's system, tools and messages exactly, then adds to them.
	if len(cs.reqs) != 3 {
		t.Fatalf("requests %d", len(cs.reqs))
	}
	for k := 0; k+1 < len(cs.reqs); k++ {
		a, b := cs.reqs[k], cs.reqs[k+1]
		for _, f := range []string{"system", "tools", "output_config", "cache_control", "max_tokens", "model"} {
			if !bytes.Equal(a[f], b[f]) {
				t.Errorf("request %d → %d: %s changed", k, k+1, f)
			}
		}
		var ma, mb []json.RawMessage
		json.Unmarshal(a["messages"], &ma)
		json.Unmarshal(b["messages"], &mb)
		if len(mb) <= len(ma) {
			t.Fatalf("messages did not grow")
		}
		for i := range ma {
			if !bytes.Equal(ma[i], mb[i]) {
				t.Errorf("request %d → %d: message %d rewritten:\n%s\n%s", k, k+1, i, ma[i], mb[i])
			}
		}
	}
	// The thinking block came back unchanged in the next request.
	if !strings.Contains(string(cs.reqs[1]["messages"]), `"signature":"sig-record it"`) {
		t.Errorf("thinking block not replayed: %s", cs.reqs[1]["messages"])
	}
}

func TestClaudeAgentForcedRoundAndRefusal(t *testing.T) {
	// MaxToolRounds 1: the second round is forced to answer (tool_choice none).
	r, cs := claudeRig(t,
		claudeStep{stop: "tool_use", calls: [][2]string{{"add_entry", `{"entries":[{"kind":"note","title":"Kept"}]}`}}},
		claudeStep{stop: "refusal", text: "I can't"},
	)
	r.cfg.MaxToolRounds = 1
	var events []agent.Event
	res, err := r.runner.Run(context.Background(), user("ZY", "web", "note: kept"), r.cfg, func(e agent.Event) { events = append(events, e) })
	if err != nil {
		t.Fatal(err)
	}
	if res.Reply != agent.RefusalReply || len(res.Changes) != 1 {
		t.Fatalf("refusal must keep earlier changes: %+v", res)
	}
	if tc := string(cs.reqs[1]["tool_choice"]); !strings.Contains(tc, `"none"`) {
		t.Errorf("forced round tool_choice %s", tc)
	}
	if last := events[len(events)-1]; last.Type != "reset" {
		t.Errorf("refusal should reset streamed text, events %+v", events)
	}
}

func TestClaudeAgentCutOff(t *testing.T) {
	r, _ := claudeRig(t, claudeStep{stop: "max_tokens", text: "The long answer"})
	res := r.run(t, user("ZY", "web", "explain everything"))
	if res.Reply != "The long answer"+agent.CutOffNote {
		t.Fatalf("reply %q", res.Reply)
	}
	r2, _ := claudeRig(t, claudeStep{stop: "max_tokens"})
	if _, err := r2.runner.Run(context.Background(), user("ZY", "web", "q"), r2.cfg, nil); err != agent.ErrCutOff {
		t.Fatalf("empty cut-off: %v", err)
	}
}

// The prompt's cached parts change only when they must: the rules never,
// the entries on a write, the date part every day.
func TestSystemSectionsStability(t *testing.T) {
	r := newRig(t)
	ctx := context.Background()
	if _, err := r.svc.Create(ctx, entries.Actor{By: "ZY", Channel: "web"}, []entries.Patch{mustPatch(t, `{"kind":"idea","title":"Herringbone floor"}`)}); err != nil {
		t.Fatal(err)
	}
	sections := func() []string {
		snap, err := r.svc.Current(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, s := range r.runner.SystemSections(snap.Doc, agent.Request{}) {
			out = append(out, s.Text)
		}
		return out
	}
	a := sections()
	if len(a) != 3 || !strings.HasPrefix(a[1], "\n\nCurrent entries") || !strings.Contains(a[2], "Today is 2026-11-11") {
		t.Fatalf("layout %q", a)
	}
	if b := sections(); strings.Join(a, "|") != strings.Join(b, "|") {
		t.Fatalf("two turns without a write differ")
	}
	r.runner.Now = func() time.Time { return time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC) }
	c := sections()
	if c[0] != a[0] || c[1] != a[1] || c[2] == a[2] {
		t.Fatalf("a new day should change only the date part")
	}
	if _, err := r.svc.Create(ctx, entries.Actor{By: "ZY", Channel: "web"}, []entries.Patch{mustPatch(t, `{"kind":"task","title":"Book movers"}`)}); err != nil {
		t.Fatal(err)
	}
	d := sections()
	if d[0] != c[0] || d[1] == c[1] || d[2] != c[2] {
		t.Fatalf("an entry write should change only the entries part")
	}
	// Joined, the sections are what the OpenAI path sends as one string.
	snap, _ := r.svc.Current(ctx)
	if r.runner.SystemPrompt(snap.Doc, agent.Request{}) != strings.Join(d, "") {
		t.Fatalf("SystemPrompt is not the joined sections")
	}
}
