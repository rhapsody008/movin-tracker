package server_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"github.com/fernet/fernet-go"

	"github.com/rhapsody008/movin-tracker/internal/board"
	"github.com/rhapsody008/movin-tracker/internal/chat"
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
	srv   *httptest.Server
	board *board.Service
	llm   *fakeLLM
	logs  *testutil.SyncBuffer
}

func setup(t *testing.T, store objstore.Store, mutate func(*server.Server)) *env {
	t.Helper()
	logs := &testutil.SyncBuffer{}
	log := testutil.Logger(logs)
	fl := newFakeLLM(t)
	bs := board.NewService(store, log)
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
		Board: bs, Settings: ss, Store: store, Log: log,
		Static:     fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>Our new place</title>")}, "icon.svg": {Data: []byte("<svg/>")}},
		Chat:       &chat.Runner{Board: bs, Loc: time.UTC, Log: log, Now: func() time.Time { return time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC) }},
		AuthHeader: "X-Forwarded-Email", AllowedEmails: []string{"zy@example.com", "partner@example.com"},
		SSEHeartbeat: 50 * time.Millisecond,
	}
	if mutate != nil {
		mutate(s)
	}
	hs := httptest.NewServer(s.Handler())
	t.Cleanup(hs.Close)
	return &env{srv: hs, board: bs, llm: fl, logs: logs}
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
	if code, _, _ := e.do(t, "GET", "/api/board", "", "X-Forwarded-Email", ""); code != 401 {
		t.Fatalf("missing header: want 401, got %d", code)
	}
	if code, _, _ := e.do(t, "GET", "/api/board", "", "X-Forwarded-Email", "stranger@example.com"); code != 403 {
		t.Fatalf("not allowed: want 403, got %d", code)
	}
	if code, _, _ := e.do(t, "GET", "/", "", "X-Forwarded-Email", "stranger@example.com"); code != 403 {
		t.Fatalf("page for stranger: want 403, got %d", code)
	}
	if code, _, _ := e.do(t, "GET", "/api/board", "", "X-Forwarded-Email", "Partner@Example.com"); code != 200 {
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
			code, m, body := e.do(t, "POST", "/api/items", `{"title":"Book movers","cat":"admin","due":"2026-11-20","time":"10:00","quoted":1200}`)
			if code != 201 {
				t.Fatalf("create: %d %s", code, body)
			}
			item := m["item"].(map[string]any)
			id := item["id"].(string)
			if item["by"] != "zy@example.com" || m["etag"] == "" {
				t.Fatalf("create response: %s", body)
			}

			if code, _, body := e.do(t, "POST", "/api/items", `{"title":""}`); code != 400 {
				t.Fatalf("empty title: want 400, got %d %s", code, body)
			}
			if code, _, body := e.do(t, "POST", "/api/items", `{"title":"x","due":"tomorrow"}`); code != 400 {
				t.Fatalf("bad date: want 400, got %d %s", code, body)
			}

			code, m, body = e.do(t, "PATCH", "/api/items/"+id, `{"status":"done","paid":1200}`, "X-Forwarded-Email", "partner@example.com")
			if code != 200 || m["item"].(map[string]any)["status"] != "done" || m["item"].(map[string]any)["by"] != "partner@example.com" {
				t.Fatalf("patch: %d %s", code, body)
			}
			if code, _, _ := e.do(t, "PATCH", "/api/items/nope", `{"status":"done"}`); code != 404 {
				t.Fatalf("patch missing: want 404, got %d", code)
			}

			if code, m, body := e.do(t, "PUT", "/api/meta", `{"moveDate":"2026-12-05","keyDate":"2026-10-29"}`); code != 200 ||
				m["board"].(map[string]any)["meta"].(map[string]any)["moveDate"] != "2026-12-05" {
				t.Fatalf("meta: %d %s", code, body)
			}
			if code, _, _ := e.do(t, "PUT", "/api/meta", `{"moveDate":"5 Dec"}`); code != 400 {
				t.Fatalf("bad meta: want 400, got %d", code)
			}

			code, m, _ = e.do(t, "GET", "/api/board", "")
			if code != 200 || len(m["board"].(map[string]any)["items"].([]any)) != 1 {
				t.Fatalf("board: %d %v", code, m)
			}

			if code, m, body := e.do(t, "DELETE", "/api/items/"+id, ""); code != 200 || len(m["board"].(map[string]any)["items"].([]any)) != 0 {
				t.Fatalf("delete: %d %s", code, body)
			}
			if code, _, _ := e.do(t, "DELETE", "/api/items/"+id, ""); code != 404 {
				t.Fatalf("delete twice: want 404, got %d", code)
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

func TestConflictReturns409WithLatestBoard(t *testing.T) {
	cs := &conflictStore{Store: objstore.NewMemory()}
	e := setup(t, cs, nil)
	cs.mu.Lock()
	cs.lose = board.MaxRetries + 1
	cs.mu.Unlock()
	code, m, body := e.do(t, "POST", "/api/items", `{"title":"x"}`)
	if code != 409 || m["error"] != "Someone else just changed this. Showing the latest." || m["board"] == nil {
		t.Fatalf("want 409 with board, got %d %s", code, body)
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
	events := make(chan board.Snapshot, 10)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			if d, ok := strings.CutPrefix(sc.Text(), "data: "); ok {
				var s board.Snapshot
				json.Unmarshal([]byte(d), &s)
				events <- s
			}
		}
	}()
	first := <-events
	if len(first.Board.Items) != 0 {
		t.Fatalf("initial event: %+v", first)
	}
	e.do(t, "POST", "/api/items", `{"title":"Lift booking"}`)
	select {
	case s := <-events:
		if len(s.Board.Items) != 1 || s.Board.Items[0].Title != "Lift booking" {
			t.Fatalf("pushed board: %+v", s.Board.Items)
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
			if len(changes) != 1 || changes[0] != "Move-in set to Sat, 5 Dec" {
				t.Fatalf("changes %v", changes)
			}
			snap, _ := e.board.Current(context.Background())
			if snap.Board.Meta.MoveDate == nil || *snap.Board.Meta.MoveDate != "2026-12-05" {
				t.Fatalf("board not changed: %+v", snap.Board.Meta)
			}
			if !strings.Contains(e.logs.String(), `"msg":"chat tool call"`) || !strings.Contains(e.logs.String(), `"tool":"set_dates"`) {
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
