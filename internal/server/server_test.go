package server_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/fernet/fernet-go"

	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/server"
	"github.com/rhapsody008/movin-tracker/internal/settings"
	"github.com/rhapsody008/movin-tracker/internal/testutil"
)

const (
	envKey    = "sk-env-key-0000-aaaa"
	storedKey = "sk-drawer-secret-7f3a"
)

// fakeLLM is a stub OpenAI-compatible endpoint. It answers "move in on 5 Dec"
// with a set_dates tool call, and anything else with plain text. It records
// the model and Authorization header of every request.
type fakeLLM struct {
	mu      sync.Mutex
	models  []string
	auths   []string
	srv     *httptest.Server
	noTools atomic.Bool // simulate a model that ignores tools
}

func newFakeLLM(t *testing.T) *fakeLLM {
	f := &fakeLLM{}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeLLM) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.auths = append(f.auths, r.Header.Get("Authorization"))
	f.mu.Unlock()
	if r.URL.Path == "/v1/models" {
		json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"id": "model-b"}, {"id": "model-a"}}})
		return
	}
	var req struct {
		Model      string `json:"model"`
		Stream     bool   `json:"stream"`
		ToolChoice string `json:"tool_choice"`
		Messages   []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	json.NewDecoder(r.Body).Decode(&req)
	f.mu.Lock()
	f.models = append(f.models, req.Model)
	f.mu.Unlock()

	last := req.Messages[len(req.Messages)-1]
	var content string
	var call map[string]any
	switch {
	case last.Role == "tool":
		content = "Move-in is set to 5 Dec."
	case strings.Contains(last.Content, "move in") && !f.noTools.Load() && req.ToolChoice != "none":
		call = map[string]any{"id": "call_1", "type": "function", "function": map[string]string{"name": "set_dates", "arguments": `{"move_in":"2026-12-05"}`}}
	default:
		content = "Nothing to change."
	}

	if !req.Stream {
		msg := map[string]any{"role": "assistant", "content": content}
		if call != nil {
			msg["tool_calls"] = []any{call}
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": msg}}})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	chunk := func(delta map[string]any) {
		b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": delta}}})
		fmt.Fprintf(w, "data: %s\n\n", b)
	}
	if call != nil {
		// Split the arguments across chunks, as real endpoints do.
		chunk(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "call_1", "type": "function", "function": map[string]string{"name": "set_dates", "arguments": `{"move_in":`}}}})
		chunk(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "function": map[string]string{"arguments": `"2026-12-05"}`}}}})
	} else {
		for _, word := range strings.SplitAfter(content, " ") {
			chunk(map[string]any{"content": word})
		}
	}
	fmt.Fprint(w, "data: [DONE]\n\n")
}

type env struct {
	srv  *httptest.Server
	ents *entries.Service
	llm  *fakeLLM
	logs *testutil.SyncBuffer
}

func setup(t *testing.T, store objstore.Store, mutate func(*server.Server)) *env {
	t.Helper()
	logs := &testutil.SyncBuffer{}
	log := testutil.Logger(logs)
	fl := newFakeLLM(t)
	bs := entries.NewService(store, log)
	if err := bs.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	secret := fernet.Key{}
	secret.Generate()
	envLLM := settings.Defaults
	envLLM.BaseURL, envLLM.APIKey, envLLM.Model, envLLM.Streaming = fl.srv.URL+"/v1", envKey, "env-model", false
	ss, err := settings.NewService(store, envLLM, secret.Encode(), log)
	if err != nil {
		t.Fatal(err)
	}
	s := &server.Server{
		Entries: bs, Settings: ss, Store: store, Log: log,
		Static:     fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>Our new place</title>")}, "icon.svg": {Data: []byte("<svg/>")}},
		Agent:      &agent.Runner{Entries: bs, Loc: time.UTC, Log: log, Now: func() time.Time { return time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC) }},
		AuthHeader: "X-Forwarded-Email", AllowedEmails: []string{"zy@example.com", "partner@example.com"},
		SSEHeartbeat: 50 * time.Millisecond,
	}
	if mutate != nil {
		mutate(s)
	}
	hs := httptest.NewServer(s.Handler())
	t.Cleanup(hs.Close)
	return &env{srv: hs, ents: bs, llm: fl, logs: logs}
}

func (e *env) do(t *testing.T, method, path, body string, hdr ...string) (int, map[string]any, string) {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rd)
	req.Header.Set("X-Forwarded-Email", "zy@example.com")
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var m map[string]any
	json.Unmarshal(raw, &m)
	return resp.StatusCode, m, string(raw)
}

func TestHealth(t *testing.T) {
	e := setup(t, objstore.NewMemory(), nil)
	for _, p := range []string{"/healthz", "/readyz"} {
		resp, err := http.Get(e.srv.URL + p) // no auth header: probes must not need it
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("%s: %v %v", p, resp, err)
		}
	}
}

func TestAuth(t *testing.T) {
	e := setup(t, objstore.NewMemory(), nil)
	if code, _, _ := e.do(t, "GET", "/api/entries", "", "X-Forwarded-Email", ""); code != 401 {
		t.Fatalf("missing header: want 401, got %d", code)
	}
	if code, _, _ := e.do(t, "GET", "/api/entries", "", "X-Forwarded-Email", "stranger@example.com"); code != 403 {
		t.Fatalf("not allowed: want 403, got %d", code)
	}
	if code, _, _ := e.do(t, "GET", "/", "", "X-Forwarded-Email", "stranger@example.com"); code != 403 {
		t.Fatalf("page for stranger: want 403, got %d", code)
	}
	if code, _, _ := e.do(t, "GET", "/api/entries", "", "X-Forwarded-Email", "Partner@Example.com"); code != 200 {
		t.Fatalf("allowed (case-insensitive): want 200, got %d", code)
	}
	if code, _, _ := e.do(t, "GET", "/icon.svg", "", "X-Forwarded-Email", ""); code != 200 {
		t.Fatalf("icon must not need auth: got %d", code)
	}
	if code, _, body := e.do(t, "GET", "/", ""); code != 200 || !strings.Contains(body, "Our new place") {
		t.Fatalf("index: %d %s", code, body)
	}
}

func TestDevEmailFallback(t *testing.T) {
	e := setup(t, objstore.NewMemory(), func(s *server.Server) { s.DevEmail = "zy@example.com" })
	if code, m, _ := e.do(t, "GET", "/api/me", "", "X-Forwarded-Email", ""); code != 200 || m["email"] != "zy@example.com" {
		t.Fatalf("dev email: %d %v", code, m)
	}
}

func TestRESTCRUD(t *testing.T) {
	for name, store := range testutil.Stores(t) {
		t.Run(name, func(t *testing.T) {
			e := setup(t, store, nil)
			code, m, body := e.do(t, "POST", "/api/entries", `{"title":"Book movers","kind":"task","date":"2026-11-20","time":"10:00","cost":{"estimate":1200}}`)
			if code != 201 {
				t.Fatalf("create: %d %s", code, body)
			}
			entry := m["entry"].(map[string]any)
			id := entry["id"].(string)
			if entry["by"] != "zy@example.com" || entry["channel"] != "web" || entry["status"] != "todo" || m["etag"] == "" {
				t.Fatalf("create response: %s", body)
			}
			change := m["change"].(map[string]any)
			if change["id"] == "" || change["text"] != "Saved: task · Book movers · Fri, 20 Nov 10:00 · est $1,200" {
				t.Fatalf("create change line: %v", change)
			}

			if code, _, body := e.do(t, "POST", "/api/entries", `{"title":""}`); code != 400 {
				t.Fatalf("empty title: want 400, got %d %s", code, body)
			}
			if code, _, body := e.do(t, "POST", "/api/entries", `{"title":"x","date":"tomorrow"}`); code != 400 {
				t.Fatalf("bad date: want 400, got %d %s", code, body)
			}
			if code, _, body := e.do(t, "POST", "/api/entries", `{"title":"x","room":"garage"}`); code != 400 {
				t.Fatalf("bad room: want 400, got %d %s", code, body)
			}

			code, m, body = e.do(t, "PATCH", "/api/entries/"+id, `{"status":"done","cost":{"actual":1200}}`, "X-Forwarded-Email", "partner@example.com")
			if code != 200 || m["entry"].(map[string]any)["status"] != "done" || m["entry"].(map[string]any)["by"] != "partner@example.com" {
				t.Fatalf("patch: %d %s", code, body)
			}
			if code, _, _ := e.do(t, "PATCH", "/api/entries/nope", `{"status":"done"}`); code != 404 {
				t.Fatalf("patch missing: want 404, got %d", code)
			}

			if code, m, body := e.do(t, "PUT", "/api/meta", `{"moveDate":"2026-12-05","keyDate":"2026-10-29"}`); code != 200 ||
				m["doc"].(map[string]any)["meta"].(map[string]any)["moveDate"] != "2026-12-05" {
				t.Fatalf("meta: %d %s", code, body)
			}
			if code, _, _ := e.do(t, "PUT", "/api/meta", `{"moveDate":"5 Dec"}`); code != 400 {
				t.Fatalf("bad meta: want 400, got %d", code)
			}

			code, m, _ = e.do(t, "GET", "/api/entries", "")
			if code != 200 || len(m["doc"].(map[string]any)["entries"].([]any)) != 1 {
				t.Fatalf("entries: %d %v", code, m)
			}

			code, m, body = e.do(t, "DELETE", "/api/entries/"+id, "")
			if code != 200 || len(m["doc"].(map[string]any)["entries"].([]any)) != 0 {
				t.Fatalf("delete: %d %s", code, body)
			}
			delID := m["change"].(map[string]any)["id"].(string)
			if code, _, _ := e.do(t, "DELETE", "/api/entries/"+id, ""); code != 404 {
				t.Fatalf("delete twice: want 404, got %d", code)
			}

			// Undo the delete: the entry is back, stamped with the undoer.
			code, m, body = e.do(t, "POST", "/api/changes/"+delID+"/undo", "", "X-Forwarded-Email", "partner@example.com")
			if code != 200 || len(m["doc"].(map[string]any)["entries"].([]any)) != 1 || !strings.HasPrefix(m["change"].(map[string]any)["text"].(string), "Undone:") {
				t.Fatalf("undo delete: %d %s", code, body)
			}
			// The same change again: the entry no longer matches, so 409 with the latest doc.
			if code, m, body := e.do(t, "POST", "/api/changes/"+delID+"/undo", ""); code != 409 || m["doc"] == nil {
				t.Fatalf("undo twice: want 409 with doc, got %d %s", code, body)
			}
			if code, _, _ := e.do(t, "POST", "/api/changes/nope/undo", ""); code != 404 {
				t.Fatalf("undo unknown: want 404, got %d", code)
			}
		})
	}
}

// conflictStore lets the first n conditional PUTs lose, to drive a 409.
type conflictStore struct {
	objstore.Store
	mu   sync.Mutex
	lose int
}

func (c *conflictStore) Put(ctx context.Context, k string, b []byte, m string) (string, error) {
	c.mu.Lock()
	lose := c.lose > 0 && m != ""
	if lose {
		c.lose--
	}
	c.mu.Unlock()
	if lose {
		return "", objstore.ErrPrecondition
	}
	return c.Store.Put(ctx, k, b, m)
}

func TestConflictReturns409WithLatestDoc(t *testing.T) {
	cs := &conflictStore{Store: objstore.NewMemory()}
	e := setup(t, cs, nil)
	cs.mu.Lock()
	cs.lose = entries.MaxRetries + 1
	cs.mu.Unlock()
	code, m, body := e.do(t, "POST", "/api/entries", `{"title":"x"}`)
	if code != 409 || m["error"] != "Someone else just changed this. Showing the latest." || m["doc"] == nil {
		t.Fatalf("want 409 with doc, got %d %s", code, body)
	}
}

func TestSSEBroadcastsWrites(t *testing.T) {
	e := setup(t, objstore.NewMemory(), nil)
	req, _ := http.NewRequest("GET", e.srv.URL+"/api/events", nil)
	req.Header.Set("X-Forwarded-Email", "partner@example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type %q", ct)
	}
	events := make(chan entries.Snapshot, 10)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			if d, ok := strings.CutPrefix(sc.Text(), "data: "); ok {
				var s entries.Snapshot
				json.Unmarshal([]byte(d), &s)
				events <- s
			}
		}
	}()
	first := <-events
	if first.Doc == nil || len(first.Doc.Entries) != 0 {
		t.Fatalf("initial event: %+v", first)
	}
	e.do(t, "POST", "/api/entries", `{"title":"Lift booking"}`)
	select {
	case s := <-events:
		if len(s.Doc.Entries) != 1 || s.Doc.Entries[0].Title != "Lift booking" {
			t.Fatalf("pushed doc: %+v", s.Doc.Entries)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no SSE event within 5 s of a write")
	}
}

func TestChatToolLoop(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", stream), func(t *testing.T) {
			e := setup(t, objstore.NewMemory(), nil)
			// Save settings with the wanted streaming mode.
			body := fmt.Sprintf(`{"baseUrl":%q,"model":"model-a","temperature":0.2,"maxTokens":1024,"timeoutSec":30,"maxToolRounds":5,"streaming":%v}`, e.llm.srv.URL+"/v1", stream)
			if code, _, b := e.do(t, "PUT", "/api/settings/llm", body); code != 200 {
				t.Fatalf("save settings: %d %s", code, b)
			}
			turns := `{"turns":[{"role":"user","content":"We move in on 5 Dec"}]}`
			code, m, raw := e.do(t, "POST", "/api/chat", turns, "Accept", "text/event-stream, application/json")
			if code != 200 {
				t.Fatalf("chat: %d %s", code, raw)
			}
			var reply string
			var changes []any
			if stream {
				if !strings.Contains(raw, "event: change") || !strings.Contains(raw, "event: done") {
					t.Fatalf("stream missing events: %s", raw)
				}
				i := strings.Index(raw, "event: done\ndata: ")
				var done map[string]any
				json.Unmarshal([]byte(strings.SplitN(raw[i+len("event: done\ndata: "):], "\n", 2)[0]), &done)
				reply, _ = done["reply"].(string)
				changes, _ = done["changes"].([]any)
			} else {
				reply, _ = m["reply"].(string)
				changes, _ = m["changes"].([]any)
			}
			if reply != "Move-in is set to 5 Dec." {
				t.Fatalf("reply %q", reply)
			}
			if len(changes) != 1 || changes[0].(map[string]any)["text"] != "Move-in set to Sat, 5 Dec" {
				t.Fatalf("changes %v", changes)
			}
			snap, _ := e.ents.Current(context.Background())
			if snap.Doc.Meta.MoveDate == nil || *snap.Doc.Meta.MoveDate != "2026-12-05" {
				t.Fatalf("doc not changed: %+v", snap.Doc.Meta)
			}
			if !strings.Contains(e.logs.String(), `"msg":"agent tool call"`) || !strings.Contains(e.logs.String(), `"tool":"set_dates"`) || !strings.Contains(e.logs.String(), `"channel":"web"`) {
				t.Fatal("tool call was not logged")
			}
		})
	}
}

func TestChatForcedAnswerWhenModelKeepsCallingTools(t *testing.T) {
	e := setup(t, objstore.NewMemory(), nil)
	e.do(t, "PUT", "/api/settings/llm", fmt.Sprintf(`{"baseUrl":%q,"model":"m","temperature":0,"maxTokens":256,"timeoutSec":30,"maxToolRounds":1,"streaming":false}`, e.llm.srv.URL+"/v1"))
	code, m, raw := e.do(t, "POST", "/api/chat", `{"turns":[{"role":"user","content":"We move in on 5 Dec"}]}`)
	if code != 200 || m["reply"] == "" {
		t.Fatalf("%d %s", code, raw)
	}
}

// TestSettingsKeyNeverLeaks checks that the API key never appears in any
// API response or log line, across save, view, test, models and chat.
func TestSettingsKeyNeverLeaks(t *testing.T) {
	for name, store := range testutil.Stores(t) {
		t.Run(name, func(t *testing.T) {
			e := setup(t, store, nil)
			var bodies []string
			rec := func(code int, _ map[string]any, raw string) { bodies = append(bodies, raw) }

			save := fmt.Sprintf(`{"baseUrl":%q,"apiKey":%q,"model":"model-b","temperature":0.3,"maxTokens":2048,"timeoutSec":45,"maxToolRounds":4,"streaming":false}`, e.llm.srv.URL+"/v1", storedKey)
			code, m, raw := e.do(t, "PUT", "/api/settings/llm", save)
			rec(code, m, raw)
			if code != 200 || m["keySet"] != true || m["keyLast4"] != "7f3a" || m["by"] != "zy@example.com" {
				t.Fatalf("save: %d %s", code, raw)
			}
			rec(e.do(t, "GET", "/api/settings/llm", ""))
			rec(e.do(t, "POST", "/api/settings/llm/test", strings.Replace(save, storedKey, "", 1)))
			rec(e.do(t, "GET", "/api/settings/llm/models", ""))
			rec(e.do(t, "POST", "/api/chat", `{"turns":[{"role":"user","content":"We move in on 5 Dec"}]}`))

			// The stored key is what the endpoint receives.
			e.llm.mu.Lock()
			lastAuth := e.llm.auths[len(e.llm.auths)-1]
			e.llm.mu.Unlock()
			if lastAuth != "Bearer "+storedKey {
				t.Fatalf("endpoint got auth %q", lastAuth)
			}

			// At rest it is encrypted.
			raw2, _, err := store.Get(context.Background(), settings.Key)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(raw2), storedKey) || !strings.Contains(string(raw2), "apiKeyEnc") {
				t.Fatalf("settings.json holds the key in clear: %s", raw2)
			}

			for i, b := range bodies {
				if strings.Contains(b, storedKey) || strings.Contains(b, envKey) {
					t.Fatalf("response %d leaks a key: %s", i, b)
				}
			}
			logs := e.logs.String()
			for _, line := range strings.Split(logs, "\n") {
				if strings.Contains(line, storedKey) || strings.Contains(line, envKey) {
					t.Fatalf("log line leaks a key: %s", line)
				}
			}
			if !strings.Contains(logs, "LLM settings saved") {
				t.Fatal("expected settings save to be logged (to make the leak check meaningful)")
			}

			// Empty key keeps it; explicit clear removes it (falls back to env key).
			e.do(t, "PUT", "/api/settings/llm", strings.Replace(save, storedKey, "", 1))
			if _, m, _ := e.do(t, "GET", "/api/settings/llm", ""); m["keyLast4"] != "7f3a" {
				t.Fatalf("empty key must keep stored key: %v", m)
			}
			e.do(t, "PUT", "/api/settings/llm", strings.Replace(save, `"apiKey":"`+storedKey+`"`, `"apiKey":"","clearKey":true`, 1))
			if _, m, _ := e.do(t, "GET", "/api/settings/llm", ""); m["keyFromEnv"] != true || m["keyLast4"] != "aaaa" {
				t.Fatalf("clear must fall back to env key: %v", m)
			}
		})
	}
}

func TestSettingsEnvFallbackAndBounds(t *testing.T) {
	e := setup(t, objstore.NewMemory(), nil)
	code, m, _ := e.do(t, "GET", "/api/settings/llm", "")
	if code != 200 || m["model"] != "env-model" || m["keyFromEnv"] != true || m["temperature"] != 0.2 || m["maxToolRounds"] != float64(5) {
		t.Fatalf("env fallback: %v", m)
	}
	base := map[string]any{"baseUrl": e.llm.srv.URL + "/v1", "model": "m", "temperature": 0.2, "maxTokens": 1024, "timeoutSec": 60, "maxToolRounds": 5, "streaming": true}
	for field, bad := range map[string]any{"temperature": 1.5, "maxTokens": 100, "timeoutSec": 301, "maxToolRounds": 9, "baseUrl": "ftp://x", "model": ""} {
		in := map[string]any{}
		for k, v := range base {
			in[k] = v
		}
		in[field] = bad
		b, _ := json.Marshal(in)
		if code, _, raw := e.do(t, "PUT", "/api/settings/llm", string(b)); code != 400 {
			t.Errorf("%s=%v: want 400, got %d %s", field, bad, code, raw)
		}
	}

	// An unreadable settings.json must not break the app.
	store := objstore.NewMemory()
	store.Put(context.Background(), settings.Key, []byte("{not json"), "")
	e2 := setup(t, store, nil)
	if code, m, _ := e2.do(t, "GET", "/api/settings/llm", ""); code != 200 || m["model"] != "env-model" {
		t.Fatalf("corrupt settings.json: %d %v", code, m)
	}
}

// TestModelSwitchTakesEffectNextMessage: save a new model in the drawer and
// the very next chat call uses it, with no restart.
func TestModelSwitchTakesEffectNextMessage(t *testing.T) {
	e := setup(t, objstore.NewMemory(), nil)
	chatOnce := func() string {
		e.do(t, "POST", "/api/chat", `{"turns":[{"role":"user","content":"hello"}]}`)
		e.llm.mu.Lock()
		defer e.llm.mu.Unlock()
		return e.llm.models[len(e.llm.models)-1]
	}
	if got := chatOnce(); got != "env-model" {
		t.Fatalf("before save: %q", got)
	}
	e.do(t, "PUT", "/api/settings/llm", fmt.Sprintf(`{"baseUrl":%q,"model":"model-b","temperature":0.2,"maxTokens":1024,"timeoutSec":30,"maxToolRounds":5,"streaming":false}`, e.llm.srv.URL+"/v1"))
	if got := chatOnce(); got != "model-b" {
		t.Fatalf("after save: %q", got)
	}
}

func TestSettingsTestEndpoint(t *testing.T) {
	e := setup(t, objstore.NewMemory(), nil)
	in := fmt.Sprintf(`{"baseUrl":%q,"model":"model-a","temperature":0.2,"maxTokens":1024,"timeoutSec":30,"maxToolRounds":5,"streaming":true}`, e.llm.srv.URL+"/v1")
	code, m, raw := e.do(t, "POST", "/api/settings/llm/test", in)
	if code != 200 || m["ok"] != true || m["toolCalls"] != true || len(m["models"].([]any)) != 2 {
		t.Fatalf("test ok: %d %s", code, raw)
	}
	e.llm.noTools.Store(true)
	_, m, raw = e.do(t, "POST", "/api/settings/llm/test", in)
	if m["ok"] != false || !strings.Contains(m["error"].(string), "tool_calls") {
		t.Fatalf("test without tools: %s", raw)
	}
	// Testing does not save.
	if _, v, _ := e.do(t, "GET", "/api/settings/llm", ""); v["model"] != "env-model" {
		t.Fatalf("test must not save: %v", v)
	}
}

// denyDelete simulates an IAM policy without s3:DeleteObject.
type denyDelete struct{ objstore.Store }

func (denyDelete) Delete(context.Context, string) error {
	return fmt.Errorf("operation error S3: DeleteObject, StatusCode: 403, AccessDenied")
}

func (d denyDelete) Info(ctx context.Context) objstore.Info {
	return d.Store.(objstore.Describer).Info(ctx)
}

func TestStorageAdmin(t *testing.T) {
	for name, store := range testutil.Stores(t) {
		t.Run(name, func(t *testing.T) {
			e := setup(t, store, nil)
			code, m, body := e.do(t, "GET", "/api/admin/storage", "")
			if code != 200 || m["backend"] == nil {
				t.Fatalf("storage view: %d %s", code, body)
			}
			if name == "s3" && (m["bucket"] == "" || m["credentialSource"] != "env keys") {
				t.Fatalf("s3 view: %s", body)
			}
			first, _ := m["lastWrite"].(map[string]any)
			if first == nil || first["key"] != "entries.json" {
				t.Fatalf("lastWrite missing after load: %s", body)
			}
			// Key material must never reach the browser.
			for _, k := range []string{"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"} {
				if v := os.Getenv(k); len(v) >= 4 && strings.Contains(body, v) {
					t.Fatalf("%s value leaked into the storage view", k)
				}
			}

			// S3 LastModified has one-second resolution.
			time.Sleep(1100 * time.Millisecond)
			e.do(t, "POST", "/api/entries", `{"title":"after"}`)
			_, m, _ = e.do(t, "GET", "/api/admin/storage", "")
			second := m["lastWrite"].(map[string]any)
			if !(second["at"].(string) > first["at"].(string)) {
				t.Fatalf("lastWrite did not advance: %v → %v", first["at"], second["at"])
			}

			code, m, body = e.do(t, "POST", "/api/admin/storage/test", "")
			steps, _ := m["steps"].([]any)
			if code != 200 || m["ok"] != true || len(steps) != 6 {
				t.Fatalf("probe: %d %s", code, body)
			}
			if _, err := store.Stat(context.Background(), m["key"].(string)); err == nil {
				t.Fatal("probe left its scratch object behind")
			}
		})
	}
}

func TestStorageProbeReportsDeniedDelete(t *testing.T) {
	store := denyDelete{objstore.NewMemory()}
	e := setup(t, store, nil)
	code, m, body := e.do(t, "POST", "/api/admin/storage/test", "")
	steps := m["steps"].([]any)
	if code != 200 || m["ok"] != false || len(steps) != 6 {
		t.Fatalf("probe: %d %s", code, body)
	}
	for i, s := range steps {
		st := s.(map[string]any)
		if wantOK := i < 5; st["ok"] != wantOK {
			t.Errorf("step %d (%v) ok=%v, want %v", i, st["name"], st["ok"], wantOK)
		}
	}
	if last := steps[5].(map[string]any); last["name"] != "delete" || !strings.Contains(last["error"].(string), "AccessDenied") {
		t.Fatalf("delete step: %v", last)
	}
}

// staleAccepted simulates storage that ignores If-Match.
type staleAccepted struct{ *objstore.Memory }

func (s staleAccepted) Put(ctx context.Context, k string, b []byte, m string) (string, error) {
	if strings.HasPrefix(k, server.ProbePrefix) && m != "" {
		return s.Memory.Put(ctx, k, b, s.etag(ctx, k))
	}
	return s.Memory.Put(ctx, k, b, m)
}

func (s staleAccepted) etag(ctx context.Context, k string) string {
	e, _ := s.Memory.Head(ctx, k)
	return e
}

func TestStorageProbeCatchesIgnoredConditions(t *testing.T) {
	store := staleAccepted{objstore.NewMemory()}
	e := setup(t, store, nil)
	_, m, body := e.do(t, "POST", "/api/admin/storage/test", "")
	steps := m["steps"].([]any)
	if m["ok"] != false || steps[3].(map[string]any)["ok"] != false || steps[4].(map[string]any)["skipped"] != true || steps[5].(map[string]any)["ok"] != true {
		t.Fatalf("want stale-write step failed, write skipped, delete still run: %s", body)
	}
	if _, err := store.Stat(context.Background(), m["key"].(string)); err == nil {
		t.Fatal("a failed probe must still clean up")
	}
}
