package agent_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
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

// TestOpenAIRequestsGolden pins the exact bytes the OpenAI-compatible path
// sends for a few fixed turns, so refactors of the LLM layer can't change
// the wire. Random entry IDs and timestamps are replaced with placeholders.
// Regenerate (only for an intended wire change): UPDATE_GOLDEN=1 go test ./internal/agent -run Golden
func TestOpenAIRequestsGolden(t *testing.T) {
	var mu sync.Mutex
	var bodies []string
	round := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, r.Method+" "+r.URL.Path+"\n"+string(b))
		round++
		n := round
		mu.Unlock()
		msg := map[string]any{"role": "assistant", "content": "Noted."}
		if n%2 == 1 { // first round of each turn calls a tool
			msg = map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{
				"id": "call_1", "type": "function",
				"function": map[string]string{"name": "search_entries", "arguments": `{"text":"countertop"}`},
			}}}
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": msg}}})
	}))
	defer srv.Close()

	logs := &testutil.SyncBuffer{}
	svc := entries.NewService(objstore.NewMemory(), testutil.Logger(logs))
	ctx := context.Background()
	if err := svc.Load(ctx); err != nil {
		t.Fatal(err)
	}
	a := entries.Actor{By: "ZY", Channel: "web"}
	if _, err := svc.Create(ctx, a, []entries.Patch{
		mustPatch(t, `{"kind":"decision","title":"Sintered stone countertop","room":"wet kitchen","category":"carpentry","cost":{"estimate":4200},"vendor":"StoneWorks"}`),
		mustPatch(t, `{"kind":"task","title":"Electrician visit","date":"2026-11-14","time":"14:00"}`),
	}); err != nil {
		t.Fatal(err)
	}
	key := "2026-10-29"
	if _, err := svc.SetMeta(ctx, entries.MetaPatch{KeyDate: &key, SetKey: true}); err != nil {
		t.Fatal(err)
	}
	runner := &agent.Runner{Entries: svc, Loc: time.UTC, Log: testutil.Logger(logs), Now: func() time.Time { return time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC) }}

	base := settings.Defaults
	base.BaseURL, base.Model = srv.URL+"/v1", "m"
	cases := []struct {
		req agent.Request
		cfg func(c *settings.LLM)
	}{
		{agent.Request{By: "ZY", Channel: "web", Turns: []agent.Turn{{Role: "user", Content: "what countertop did we pick?"}}},
			func(c *settings.LLM) { c.Streaming = false }},
		{agent.Request{By: "Partner", Channel: "telegram", Group: true, Turns: []agent.Turn{
			{Role: "user", Content: "ZY: hi"}, {Role: "assistant", Content: "Hello."}, {Role: "user", Content: "Partner: countertop?"}}},
			func(c *settings.LLM) { c.Streaming = true; c.ThinkOnDemand = true; c.MaxToolRounds = 1 }},
		{agent.Request{By: "ZY", Channel: "telegram", Think: true, Turns: []agent.Turn{{Role: "user", Content: "compare the countertop options"}}},
			func(c *settings.LLM) { c.Streaming = false; c.ThinkOnDemand = true }},
	}
	for _, c := range cases {
		cfg := base
		c.cfg(&cfg)
		if _, err := runner.Run(ctx, c.req, cfg, nil); err != nil {
			t.Fatal(err)
		}
	}

	got := normalise(strings.Join(bodies, "\n----\n"))
	path := "testdata/openai_requests.golden"
	if os.Getenv("UPDATE_GOLDEN") == "1" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (generate with UPDATE_GOLDEN=1)", err)
	}
	if !bytes.Equal([]byte(got), want) {
		gl, wl := strings.Split(got, "\n"), strings.Split(string(want), "\n")
		for i := 0; i < len(gl) || i < len(wl); i++ {
			var g, w string
			if i < len(gl) {
				g = gl[i]
			}
			if i < len(wl) {
				w = wl[i]
			}
			if g != w {
				t.Fatalf("request bytes changed at line %d:\n got: %.400s\nwant: %.400s", i+1, g, w)
			}
		}
	}
}

var (
	ulidRe = regexp.MustCompile(`\b[0-9A-HJKMNP-TV-Z]{26}\b`)
	tsRe   = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})`)
)

func normalise(s string) string {
	return tsRe.ReplaceAllString(ulidRe.ReplaceAllString(s, "<ULID>"), "<TIME>")
}
