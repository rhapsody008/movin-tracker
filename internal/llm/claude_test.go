package llm_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"

	"github.com/rhapsody008/movin-tracker/internal/llm"
	"github.com/rhapsody008/movin-tracker/internal/settings"
)

// fakeClaude is a minimal stand-in for api.anthropic.com: it records every
// request and answers from a queue of handlers.
type fakeClaude struct {
	srv       *httptest.Server
	mu        sync.Mutex
	reqs      []recorded
	replies   []func(w http.ResponseWriter)
	fallbacks []string // allowed_fallback_models in the model lookup
	lookups   int
}

type recorded struct {
	path   string
	header http.Header
	body   map[string]any
	raw    string
}

func newFakeClaude(t *testing.T, replies ...func(w http.ResponseWriter)) *fakeClaude {
	f := &fakeClaude{replies: replies}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/models/") { // fallback eligibility lookup
			f.mu.Lock()
			f.lookups++
			fb := f.fallbacks
			f.mu.Unlock()
			// Like the real API: without the fallback beta the list is empty.
			if fb == nil || !strings.Contains(r.Header.Get("Anthropic-Beta"), "server-side-fallback-2026-07-01") {
				fb = []string{}
			}
			jsonReply(map[string]any{"id": strings.TrimPrefix(r.URL.Path, "/v1/models/"), "type": "model", "allowed_fallback_models": fb})(w)
			return
		}
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		json.Unmarshal(b, &m)
		f.mu.Lock()
		f.reqs = append(f.reqs, recorded{r.URL.Path, r.Header.Clone(), m, string(b)})
		var reply func(http.ResponseWriter)
		if len(f.replies) > 0 {
			reply, f.replies = f.replies[0], f.replies[1:]
		}
		f.mu.Unlock()
		if reply == nil {
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(500)
			return
		}
		reply(w)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeClaude) cfg() settings.LLM {
	return settings.LLM{Kind: settings.KindClaude, BaseURL: f.srv.URL, APIKey: "sk-ant-test-key-0001", Model: "claude-opus-5-5", TimeoutSec: 30}
}

func (f *fakeClaude) req(i int) recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reqs[i]
}

func jsonReply(v any) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(v)
	}
}

func errReply(status int, msg string) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("retry-after-ms", "1")
		w.Header().Set("request-id", "req_test_1")
		w.WriteHeader(status)
		fmt.Fprintf(w, `{"type":"error","error":{"type":"x","message":%q}}`, msg)
	}
}

func message(stop string, content ...map[string]any) map[string]any {
	return map[string]any{
		"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
		"content": content, "stop_reason": stop,
		"usage": map[string]any{"input_tokens": 1200, "output_tokens": 40, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 150},
	}
}

func text(s string) map[string]any { return map[string]any{"type": "text", "text": s} }

var probeTools = []llm.Tool{{Type: "function", Function: llm.FunctionDecl{
	Name: "set_dates", Description: "Set the move-in date.",
	Parameters: json.RawMessage(`{"type":"object","properties":{"move_in":{"type":"string"}},"required":["move_in"],"additionalProperties":false}`),
}}}

func TestClaudeRequestShape(t *testing.T) {
	for _, c := range []struct {
		name         string
		onDemand     bool
		think, force bool
		wantEffort   any
		wantToolNone bool
	}{
		{"think on demand, plain", true, false, false, "low", false},
		{"think on demand, /think", true, true, false, "high", false},
		{"server decides", false, false, true, nil, true},
		{"server decides, /think", false, true, false, "high", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeClaude(t, jsonReply(message("end_turn", text("ok"))))
			cfg := f.cfg()
			cfg.ThinkOnDemand = c.onDemand
			res, err := llm.New(cfg).Complete(context.Background(), llm.Request{
				System:   []llm.Section{{Text: "rules", CacheBreak: true}, {Text: "today"}},
				Messages: []llm.Message{{Role: "user", Content: "hi"}},
				Tools:    probeTools, ForceAnswer: c.force, Think: c.think,
			})
			if err != nil {
				t.Fatal(err)
			}
			if res.Message.Content != "ok" || res.Stop != llm.StopEnd {
				t.Fatalf("res %+v", res)
			}
			if want := (llm.Usage{In: 1200, Out: 40, CacheRead: 1000, CacheWrite: 150}); res.Usage != want {
				t.Fatalf("usage %+v", res.Usage)
			}
			r := f.req(0)
			b := r.body
			if r.path != "/v1/messages" || b["max_tokens"] != float64(llm.ClaudeMaxTokens) || b["model"] != "claude-opus-5-5" {
				t.Fatalf("path %s body %v", r.path, b)
			}
			for _, k := range []string{"temperature", "top_p", "thinking"} {
				if _, ok := b[k]; ok {
					t.Errorf("sent %s", k)
				}
			}
			var effort any
			if oc, ok := b["output_config"].(map[string]any); ok {
				effort = oc["effort"]
			}
			if effort != c.wantEffort {
				t.Errorf("effort %v, want %v", effort, c.wantEffort)
			}
			tc, _ := b["tool_choice"].(map[string]any)
			if (tc != nil && tc["type"] == "none") != c.wantToolNone {
				t.Errorf("tool_choice %v", b["tool_choice"])
			}
			// Cache marks: on the rules block and top level, not on "today".
			sys := b["system"].([]any)
			mark := map[string]any{"type": "ephemeral", "ttl": "5m"}
			if len(sys) != 2 || !reflect.DeepEqual(sys[0].(map[string]any)["cache_control"], mark) || sys[1].(map[string]any)["cache_control"] != nil {
				t.Errorf("system %v", sys)
			}
			if !reflect.DeepEqual(b["cache_control"], mark) {
				t.Errorf("no top-level cache_control")
			}
			tool := b["tools"].([]any)[0].(map[string]any)
			schema := tool["input_schema"].(map[string]any)
			if tool["name"] != "set_dates" || schema["type"] != "object" || schema["additionalProperties"] != false ||
				!reflect.DeepEqual(schema["required"], []any{"move_in"}) {
				t.Errorf("tool %v", tool)
			}
			// SDK v2.3.0 sends the key as a bearer token.
			if r.header.Get("Authorization") != "Bearer sk-ant-test-key-0001" || r.header.Get("Anthropic-Version") == "" {
				t.Errorf("headers %v", r.header)
			}
		})
	}
}

// Round 2 must carry round 1's assistant content exactly (thinking block
// with its signature, text, tool_use), then all tool results in one user
// message.
func TestClaudeEchoesTurnContentAndMergesToolResults(t *testing.T) {
	round1 := []map[string]any{
		{"type": "thinking", "thinking": "Need the date tool.", "signature": "sig-abc"},
		text("Setting it."),
		{"type": "tool_use", "id": "toolu_1", "name": "set_dates", "input": map[string]any{"move_in": "2026-12-05"}},
		{"type": "tool_use", "id": "toolu_2", "name": "set_dates", "input": map[string]any{"move_in": "2026-12-06"}},
	}
	f := newFakeClaude(t, jsonReply(message("tool_use", round1...)), jsonReply(message("end_turn", text("Done."))))
	p := llm.New(f.cfg())
	msgs := []llm.Message{{Role: "user", Content: "ZY: hi"}, {Role: "user", Content: "Partner: we move in Dec 5"}}
	res, err := p.Complete(context.Background(), llm.Request{Messages: msgs, Tools: probeTools})
	if err != nil {
		t.Fatal(err)
	}
	if res.Stop != llm.StopTool || len(res.Message.ToolCalls) != 2 || res.Message.ToolCalls[0].Function.Arguments != `{"move_in":"2026-12-05"}` || res.Message.Content != "Setting it." {
		t.Fatalf("round 1 %+v", res)
	}
	msgs = append(msgs, res.Message,
		llm.Message{Role: "tool", ToolCallID: "toolu_1", Content: `{"ok":true}`},
		llm.Message{Role: "tool", ToolCallID: "toolu_2", Content: `{"ok":true}`})
	if _, err := p.Complete(context.Background(), llm.Request{Messages: msgs, Tools: probeTools}); err != nil {
		t.Fatal(err)
	}
	got := f.req(1).body["messages"].([]any)
	if len(got) != 3 {
		t.Fatalf("want user, assistant, user; got %d: %v", len(got), got)
	}
	u0 := got[0].(map[string]any)
	if u0["role"] != "user" || len(u0["content"].([]any)) != 2 {
		t.Errorf("same-role user turns not merged: %v", u0)
	}
	a := got[1].(map[string]any)
	wantJSON, _ := json.Marshal(round1)
	var want, have any
	json.Unmarshal(wantJSON, &want)
	haveJSON, _ := json.Marshal(a["content"])
	json.Unmarshal(haveJSON, &have)
	if a["role"] != "assistant" || !reflect.DeepEqual(stripNulls(have), want) {
		t.Errorf("assistant content changed:\n got %s\nwant %s", haveJSON, wantJSON)
	}
	u2 := got[2].(map[string]any)["content"].([]any)
	if len(u2) != 2 || u2[0].(map[string]any)["type"] != "tool_result" || u2[1].(map[string]any)["tool_use_id"] != "toolu_2" {
		t.Errorf("tool results not merged into one user message: %v", u2)
	}
}

// stripNulls drops empty optional fields the SDK may add, so only the
// content blocks' real fields are compared.
func stripNulls(v any) any {
	switch x := v.(type) {
	case []any:
		for i := range x {
			x[i] = stripNulls(x[i])
		}
	case map[string]any:
		for k, e := range x {
			if e == nil {
				delete(x, k)
				continue
			}
			x[k] = stripNulls(e)
		}
	}
	return v
}

func TestClaudeStreaming(t *testing.T) {
	sse := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		ev := func(typ string, data string) { fmt.Fprintf(w, "event: %s\ndata: %s\n\n", typ, data) }
		ev("message_start", `{"type":"message_start","message":{"id":"msg_s","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}`)
		ev("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`)
		ev("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hidden"}}`)
		ev("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}`)
		ev("content_block_stop", `{"type":"content_block_stop","index":0}`)
		ev("content_block_start", `{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`)
		ev("content_block_delta", `{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}}`)
		ev("content_block_delta", `{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"lo"}}`)
		ev("content_block_stop", `{"type":"content_block_stop","index":1}`)
		ev("content_block_start", `{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_9","name":"set_dates","input":{}}}`)
		ev("content_block_delta", `{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"move_in\":"}}`)
		ev("content_block_delta", `{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"2026-12-05\"}"}}`)
		ev("content_block_stop", `{"type":"content_block_stop","index":2}`)
		ev("message_delta", `{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}`)
		ev("message_stop", `{"type":"message_stop"}`)
	}
	f := newFakeClaude(t, sse)
	var deltas []string
	res, err := llm.New(f.cfg()).Complete(context.Background(), llm.Request{
		Messages: []llm.Message{{Role: "user", Content: "hi"}}, Tools: probeTools, Stream: true,
		OnText: func(s string) { deltas = append(deltas, s) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(deltas, "|") != "Hel|lo" {
		t.Errorf("deltas %q (thinking must not stream)", deltas)
	}
	if res.Stop != llm.StopTool || len(res.Message.ToolCalls) != 1 || res.Message.ToolCalls[0].Function.Arguments != `{"move_in":"2026-12-05"}` || res.Message.Content != "Hello" {
		t.Fatalf("res %+v", res)
	}
	if f.req(0).body["stream"] != true {
		t.Errorf("stream not requested")
	}
}

func TestClaudeStopReasons(t *testing.T) {
	for _, c := range []struct {
		stop string
		want llm.Stop
	}{{"refusal", llm.StopRefusal}, {"max_tokens", llm.StopMaxTokens}, {"end_turn", llm.StopEnd}} {
		f := newFakeClaude(t, jsonReply(message(c.stop, text("partial"))))
		res, err := llm.New(f.cfg()).Complete(context.Background(), llm.Request{Messages: []llm.Message{{Role: "user", Content: "q"}}})
		if err != nil || res.Stop != c.want {
			t.Errorf("%s: %v %q", c.stop, err, res.Stop)
		}
	}
	// pause_turn is sent back once and the continuation answers.
	f := newFakeClaude(t, jsonReply(message("pause_turn", text("..."))), jsonReply(message("end_turn", text("done"))))
	res, err := llm.New(f.cfg()).Complete(context.Background(), llm.Request{Messages: []llm.Message{{Role: "user", Content: "q"}}})
	// Both parts come back as one turn: text, blocks and usage merged.
	if err != nil || res.Message.Content != "...done" || len(f.reqs) != 2 || res.Usage.In != 2400 || res.Usage.Out != 80 {
		t.Fatalf("pause_turn: %v content %q usage %+v reqs=%d", err, res.Message.Content, res.Usage, len(f.reqs))
	}
	if blocks, ok := res.Message.Native.([]anthropic.BetaContentBlockParamUnion); !ok || len(blocks) != 2 {
		t.Fatalf("pause_turn: native blocks %v", res.Message.Native)
	}
}

func TestClaudeErrors(t *testing.T) {
	key := "sk-ant-test-key-0001"
	for _, c := range []struct {
		name    string
		replies []func(http.ResponseWriter)
		status  int // 0 = success expected
		calls   int
	}{
		{"401 not retried", []func(http.ResponseWriter){errReply(401, "invalid x-api-key")}, 401, 1},
		{"429 retried then ok", []func(http.ResponseWriter){errReply(429, "rate limited"), jsonReply(message("end_turn", text("ok")))}, 0, 2},
		{"529 gives up after retries", []func(http.ResponseWriter){errReply(529, "overloaded"), errReply(529, "overloaded"), errReply(529, "overloaded")}, 529, 3},
		{"key echoed by server is scrubbed", []func(http.ResponseWriter){errReply(400, "bad key "+key)}, 400, 1},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeClaude(t, c.replies...)
			_, err := llm.New(f.cfg()).Complete(context.Background(), llm.Request{Messages: []llm.Message{{Role: "user", Content: "q"}}})
			if len(f.reqs) != c.calls {
				t.Errorf("calls %d, want %d", len(f.reqs), c.calls)
			}
			if c.status == 0 {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			var ae *llm.APIError
			if !errors.As(err, &ae) && !strings.Contains(fmt.Sprint(err), fmt.Sprint(c.status)) {
				t.Fatalf("err %T %v", err, err)
			}
			if ae != nil && ae.Status != c.status {
				t.Errorf("status %d", ae.Status)
			}
			if strings.Contains(fmt.Sprint(err), key) {
				t.Errorf("key in error: %v", err)
			}
			if c.status == 401 && !strings.Contains(fmt.Sprint(err), "invalid x-api-key") {
				t.Errorf("message lost: %v", err)
			}
		})
	}
}

// ANTHROPIC_* in the environment must never be used: not the key, not the
// base URL, not custom headers.
func TestClaudeIgnoresAmbientEnvironment(t *testing.T) {
	stray := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("request went to ANTHROPIC_BASE_URL")
	}))
	defer stray.Close()
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-ambient-9999")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "ambient-token")
	t.Setenv("ANTHROPIC_BASE_URL", stray.URL)
	t.Setenv("ANTHROPIC_CUSTOM_HEADERS", "X-Leak: yes")
	for _, key := range []string{"", "sk-ant-mine-0002"} {
		f := newFakeClaude(t, jsonReply(message("end_turn", text("ok"))))
		cfg := f.cfg()
		cfg.APIKey = key
		if _, err := llm.New(cfg).Complete(context.Background(), llm.Request{Messages: []llm.Message{{Role: "user", Content: "q"}}}); err != nil {
			t.Fatal(err)
		}
		h := f.req(0).header
		want := ""
		if key != "" {
			want = "Bearer " + key
		}
		if h.Get("Authorization") != want || h.Get("X-Api-Key") != "" || h.Get("X-Leak") != "" {
			t.Errorf("key %q: headers %v", key, h)
		}
	}
}

// One deadline covers the call and its retries.
func TestClaudeDeadlineSpansRetries(t *testing.T) {
	slow := func(w http.ResponseWriter) {
		time.Sleep(700 * time.Millisecond)
		errReply(529, "overloaded")(w)
	}
	f := newFakeClaude(t, slow, slow, slow)
	cfg := f.cfg()
	cfg.TimeoutSec = 1
	start := time.Now()
	_, err := llm.New(cfg).Complete(context.Background(), llm.Request{Messages: []llm.Message{{Role: "user", Content: "q"}}})
	if err == nil {
		t.Fatal("want an error")
	}
	if d := time.Since(start); d > 1600*time.Millisecond {
		t.Errorf("took %v; the 1 s deadline should cover all retries", d)
	}
}

func TestClaudeModels(t *testing.T) {
	f := newFakeClaude(t, jsonReply(map[string]any{
		"data":     []any{map[string]any{"id": "claude-sonnet-5-5", "type": "model"}, map[string]any{"id": "claude-opus-5-5", "type": "model"}},
		"has_more": false, "first_id": "a", "last_id": "b",
	}))
	ids, err := llm.New(f.cfg()).Models(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(ids, ",") != "claude-opus-5-5,claude-sonnet-5-5" || f.req(0).path != "/v1/models" {
		t.Fatalf("ids %v path %s", ids, f.req(0).path)
	}
}

// Fallbacks go out only for models that allow them; a declined message is
// then re-served inside the same call, and the fallback block is sent back
// unchanged next round. The eligibility lookup is cached.
func TestClaudeRefusalFallbacks(t *testing.T) {
	served := message("end_turn",
		map[string]any{"type": "fallback", "from": map[string]any{"model": "claude-opus-5-5"}, "to": map[string]any{"model": "claude-opus-5"}, "trigger": map[string]any{"type": "refusal"}},
		text("Here is the answer."))
	f := newFakeClaude(t, jsonReply(served), jsonReply(message("end_turn", text("ok"))))
	f.fallbacks = []string{"claude-opus-5"}
	p := llm.New(f.cfg())
	res, err := p.Complete(context.Background(), llm.Request{Messages: []llm.Message{{Role: "user", Content: "q"}}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Message.Content != "Here is the answer." || res.Stop != llm.StopEnd {
		t.Fatalf("fallback reply %+v", res)
	}
	r := f.req(0)
	if r.body["fallbacks"] != "default" || !strings.Contains(r.header.Get("Anthropic-Beta"), "server-side-fallback-2026-07-01") {
		t.Fatalf("fallbacks not requested: %v / %q", r.body["fallbacks"], r.header.Get("Anthropic-Beta"))
	}
	msgs := []llm.Message{{Role: "user", Content: "q"}, res.Message, {Role: "user", Content: "and?"}}
	if _, err := p.Complete(context.Background(), llm.Request{Messages: msgs}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.req(1).raw, `"type":"fallback"`) {
		t.Errorf("fallback block not sent back: %s", f.req(1).raw)
	}
	if f.lookups != 1 {
		t.Errorf("eligibility looked up %d times, want 1 (cached)", f.lookups)
	}

	// A model without allowed fallbacks: no parameter, no beta header.
	g := newFakeClaude(t, jsonReply(message("refusal", text(""))))
	cfg := g.cfg()
	cfg.Model = "claude-haiku-5-5"
	res, err = llm.New(cfg).Complete(context.Background(), llm.Request{Messages: []llm.Message{{Role: "user", Content: "q"}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, has := g.req(0).body["fallbacks"]; has || g.req(0).header.Get("Anthropic-Beta") != "" {
		t.Errorf("fallbacks sent for a model without them")
	}
	if res.Stop != llm.StopRefusal {
		t.Errorf("whole-chain refusal: stop %q", res.Stop)
	}
}

// More cache marks than the API allows: the earliest system marks go.
func TestClaudeCacheMarkLimit(t *testing.T) {
	f := newFakeClaude(t, jsonReply(message("end_turn", text("ok"))))
	var secs []llm.Section
	for i := 0; i < 5; i++ {
		secs = append(secs, llm.Section{Text: fmt.Sprintf("part %d", i), CacheBreak: true})
	}
	if _, err := llm.New(f.cfg()).Complete(context.Background(), llm.Request{System: secs, Messages: []llm.Message{{Role: "user", Content: "q"}}}); err != nil {
		t.Fatal(err)
	}
	marks := strings.Count(f.req(0).raw, `"cache_control"`)
	if marks != llm.MaxCacheMarks {
		t.Fatalf("%d cache marks sent, want %d", marks, llm.MaxCacheMarks)
	}
	sys := f.req(0).body["system"].([]any)
	if sys[0].(map[string]any)["cache_control"] != nil || sys[4].(map[string]any)["cache_control"] == nil {
		t.Fatalf("the earliest marks should go: %v", sys)
	}
}

// A model lookup cut short by the caller isn't remembered as "no fallbacks".
func TestClaudeFallbackLookupNotCachedOnCancel(t *testing.T) {
	f := newFakeClaude(t, jsonReply(message("end_turn", text("ok"))))
	f.fallbacks = []string{"claude-opus-5"}
	cfg := f.cfg()
	cfg.Model = "claude-cancel-test"
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	llm.New(cfg).Complete(ctx, llm.Request{Messages: []llm.Message{{Role: "user", Content: "q"}}})
	if _, err := llm.New(cfg).Complete(context.Background(), llm.Request{Messages: []llm.Message{{Role: "user", Content: "q"}}}); err != nil {
		t.Fatal(err)
	}
	if f.req(len(f.reqs) - 1).body["fallbacks"] != "default" {
		t.Fatal("a cancelled lookup disabled fallbacks for the next caller")
	}
}
