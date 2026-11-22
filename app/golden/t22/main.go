//go:build ignore

// Command t22-golden writes the Go answers the TypeScript admin, settings and
// documents routes (T2.2) must reproduce. A golden generator of the v3 port
// (app/golden/README.md): it needs the Go code, so run it before T7 deletes it.
//
// Run from the repo root, in the Go tools container:
//
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t22/main.go'
//
// It writes one fixture:
//
//	app/src/server/testdata/transcript-admin.go.json
//	  = the script, the bytes Go answered, and every request the fake LLM saw
//
// The TypeScript test replays the script against the TypeScript server — same
// clock, same memory store, same env LLM, and a fake endpoint that answers the
// same way — and compares status, the two headers recorded here and the body
// bytes. Five things are random and are masked on both sides by that test:
// latencyMs, the probe steps' ms, the probe's ULID, lastWrite.at, and the tail
// of a network error. The fake endpoint's base URL differs per run, so the
// harness writes it as <LLM>.
//
// v1-only behaviour (kind:"claude") is deliberately absent: v2 refuses it, so
// those requests are TypeScript-only tests (brief T2.2, server-spec §7).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing/fstest"
	"time"

	"github.com/fernet/fernet-go"

	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/server"
	"github.com/rhapsody008/movin-tracker/internal/settings"
)

// fixed is the clock both services use, so created/updated/completed and the
// settings' updated stamp are the same bytes in both apps.
var fixed = time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)

const zone = "Asia/Singapore"

// The Go tests' two fake keys (server_test.go:33-36).
const (
	envKey    = "sk-env-key-0000-aaaa"
	storedKey = "sk-drawer-secret-7f3a"
)

// guide is the bytes GET /api/admin/guide serves here. It has no trailing
// newline on purpose: a route that added one would show up in the fixture.
const guide = "# Admin guide\n\nSet TELEGRAM_BOT_TOKEN and keep it in the NKP namespace.\n\n" +
	"## Secrets in the NKP namespace\n\n## Troubleshooting\n\nAsk in the group. It ends here"

// ---------- the fixture ----------

type step struct {
	Name       string      `json:"name"`
	Method     string      `json:"method"`
	Path       string      `json:"path"`
	ReqHeaders [][2]string `json:"reqHeaders"`
	ReqBody    string      `json:"reqBody"`
	Status     int         `json:"status"`
	Answer     headers     `json:"headers"`
	AnswerBody string      `json:"body"`
}

// headers are the response headers both sides compare.
type headers struct {
	ContentType         string `json:"content-type"`
	CacheControl        string `json:"cache-control"`
	XContentTypeOptions string `json:"x-content-type-options"`
}

// llmCall is one request the fake endpoint received. The auth header is here
// because "the stored key only goes to its own origin" is part of the contract:
// an empty string means the request carried no Authorization header at all.
type llmCall struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Body   string `json:"body"`
	Auth   string `json:"auth"`
}

type fixture struct {
	Steps    []step    `json:"steps"`
	LLMCalls []llmCall `json:"llmCalls"`
}

// ---------- the fake endpoint ----------

// fakeLLM is the Go port of the TypeScript rig's fakeLLM: /v1/models answers
// model-b then model-a (deliberately unsorted), /v1/chat/completions answers a
// set_dates tool call when the user's text says "move in", and everything under
// /bad/ is a 404 with an OpenAI-shaped error so the models 502 needs no dead
// network.
type fakeLLM struct {
	mu    sync.Mutex
	calls []llmCall
}

const noToolsModel = "no-tools-model"

func (f *fakeLLM) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.calls = append(f.calls, llmCall{Method: r.Method, Path: r.URL.Path, Body: string(body), Auth: r.Header.Get("Authorization")})
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.URL.Path == "/bad/v1/models":
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":{"message":"Invalid API key"}}`)
	case strings.HasSuffix(r.URL.Path, "/v1/models"):
		_, _ = io.WriteString(w, `{"data":[{"id":"model-b"},{"id":"model-a"}]}`)
	case strings.HasSuffix(r.URL.Path, "/v1/chat/completions"):
		_, _ = io.WriteString(w, completion(body))
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, "404 page not found\n")
	}
}

// completion decides the answer the way the TypeScript fake does.
func completion(body []byte) string {
	var req struct {
		Model      string `json:"model"`
		ToolChoice string `json:"tool_choice"`
		Messages   []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	_ = json.Unmarshal(body, &req)
	text := ""
	if len(req.Messages) > 0 {
		text = messageText(req.Messages[len(req.Messages)-1].Content)
	}
	wantTool := strings.Contains(text, "move in") && req.Model != noToolsModel && req.ToolChoice != "none"
	if !wantTool {
		return `{"choices":[{"message":{"role":"assistant","content":"Nothing to change."}}]}`
	}
	return `{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[` +
		`{"id":"call_1","type":"function","function":{"name":"set_dates","arguments":"{\"move_in\":\"2026-12-05\"}"}}]}}]}`
}

// messageText reads one message's content: a string, or the text parts of the
// image-shaped content the vision probe sends.
func messageText(content json.RawMessage) string {
	var s string
	if err := json.Unmarshal(content, &s); err == nil {
		return s
	}
	var parts []struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(content, &parts); err != nil {
		return ""
	}
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		out = append(out, p.Text)
	}
	return strings.Join(out, " ")
}

// ---------- the script ----------

type request struct {
	name    string
	method  string
	path    string
	headers [][2]string
	body    string
}

// script is the whole conversation: every T2.2 route's success and error paths.
// <LLM> is the fake endpoint's origin, substituted when the fixture is written.
var script = []request{
	{name: "storage-view", method: "GET", path: "/api/admin/storage"},
	{name: "storage-probe", method: "POST", path: "/api/admin/storage/test"},

	{name: "telegram-get", method: "GET", path: "/api/admin/telegram"},
	{
		name: "telegram-save", method: "PUT", path: "/api/settings/telegram",
		body: `{"users":[{"id":"111","name":"ZY"},{"id":" 222 ","name":"  Partner   Lim "}],"groups":["-1001"]}`,
	},
	{
		name: "telegram-save-invalid", method: "PUT", path: "/api/settings/telegram",
		body: `{"users":[{"id":"-5","name":"x"}]}`,
	},
	{name: "telegram-use-env", method: "PUT", path: "/api/settings/telegram", body: `{"useEnv":true}`},
	{name: "telegram-get-after", method: "GET", path: "/api/admin/telegram"},

	{name: "checkin-save", method: "PUT", path: "/api/settings/checkin", body: `{"schedule":"8:05","chat":""}`},
	{name: "checkin-late-is-400", method: "PUT", path: "/api/settings/checkin", body: `{"schedule":"21:00"}`},
	{name: "checkin-format-is-400", method: "PUT", path: "/api/settings/checkin", body: `{"schedule":"9am"}`},
	{name: "checkin-chat-is-400", method: "PUT", path: "/api/settings/checkin", body: `{"schedule":"09:30","chat":"group"}`},
	{name: "checkin-use-env", method: "PUT", path: "/api/settings/checkin", body: `{"useEnv":true}`},
	{name: "checkin-empty-body-is-400", method: "PUT", path: "/api/settings/checkin"},

	{name: "docs-off-list", method: "GET", path: "/api/docs"},
	{name: "docs-off-sync", method: "POST", path: "/api/docs/sync"},

	{name: "guide", method: "GET", path: "/api/admin/guide"},

	{name: "settings-get", method: "GET", path: "/api/settings/llm"},
	{
		name: "settings-save", method: "PUT", path: "/api/settings/llm",
		body: `{"baseUrl":"<LLM>/v1","apiKey":"` + storedKey + `","model":"model-b","streaming":false}`,
	},
	{name: "settings-get-after-save", method: "GET", path: "/api/settings/llm"},
	{
		name: "settings-save-bad-url", method: "PUT", path: "/api/settings/llm",
		body: `{"baseUrl":"ftp://x","model":"m"}`,
	},
	{
		name: "settings-save-empty-model", method: "PUT", path: "/api/settings/llm",
		body: `{"baseUrl":"<LLM>/v1","model":""}`,
	},
	{
		name: "settings-save-bad-kind", method: "PUT", path: "/api/settings/llm",
		body: `{"kind":"gpt","baseUrl":"<LLM>/v1","model":"m"}`,
	},
	{name: "settings-save-empty-body", method: "PUT", path: "/api/settings/llm"},

	{
		name: "settings-test-ok", method: "POST", path: "/api/settings/llm/test",
		body: `{"baseUrl":"<LLM>/v1","model":"model-a","streaming":true}`,
	},
	{
		name: "settings-test-no-tools", method: "POST", path: "/api/settings/llm/test",
		body: `{"baseUrl":"<LLM>/v1","model":"` + noToolsModel + `"}`,
	},
	{
		name: "settings-test-think", method: "POST", path: "/api/settings/llm/test",
		body: `{"baseUrl":"<LLM>/v1","model":"think-model","thinkOnDemand":true}`,
	},
	{
		name: "settings-test-bad-url", method: "POST", path: "/api/settings/llm/test",
		body: `{"baseUrl":"ftp://x","model":"m"}`,
	},

	{name: "models-ok", method: "POST", path: "/api/settings/llm/models", body: `{}`},
	{
		name: "models-with-url", method: "POST", path: "/api/settings/llm/models",
		body: `{"baseUrl":"<LLM>/other/v1"}`,
	},
	{name: "models-bad-kind", method: "POST", path: "/api/settings/llm/models", body: `{"kind":"gpt"}`},
	{
		name: "models-502", method: "POST", path: "/api/settings/llm/models",
		body: `{"baseUrl":"<LLM>/bad/v1"}`,
	},
	{name: "models-dead-endpoint", method: "POST", path: "/api/settings/llm/models", body: `{"baseUrl":"http://127.0.0.1:1/v1"}`},
	{name: "models-empty-body", method: "POST", path: "/api/settings/llm/models"},

	{name: "settings-get-final", method: "GET", path: "/api/settings/llm"},
}

// ---------- the run ----------

func setup(llmURL string) *server.Server {
	store := objstore.NewMemory()
	log := slog.New(slog.NewJSONHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelDebug}))
	ents := entries.NewService(store, log)
	loc, err := time.LoadLocation(zone)
	if err != nil {
		panic(err)
	}
	ents.SetLocation(loc)
	ents.SetClock(func() time.Time { return fixed })
	if err := ents.Load(context.Background()); err != nil {
		panic(err)
	}
	secret := fernet.Key{}
	secret.Generate()
	envLLM := settings.Defaults
	envLLM.BaseURL, envLLM.APIKey, envLLM.Model, envLLM.Streaming = llmURL+"/v1", envKey, "env-model", false
	sets, err := settings.NewService(store, envLLM, secret.Encode(), log)
	if err != nil {
		panic(err)
	}
	sets.SetClock(func() time.Time { return fixed })
	tg, err := settings.ParseTelegramEnv("111=ZY, 222=Partner", "-1001234")
	if err != nil {
		panic(err)
	}
	sets.WithTelegramEnv(tg)
	return &server.Server{
		Entries:  ents,
		Settings: sets,
		Store:    store,
		Log:      log,
		Static: fstest.MapFS{
			"index.html": {Data: []byte("<!doctype html><title>Our new place</title>")},
			"icon.svg":   {Data: []byte("<svg/>")},
		},
		AuthHeader:    "X-Forwarded-Email",
		AllowedEmails: []string{"zy@example.com", "partner@example.com"},
		Guide:         func() ([]byte, error) { return []byte(guide), nil },
		// No Agent, Bot or Docs: T2 has no chat, no bot and the documents off.
	}
}

func runScript(ts *httptest.Server, llmURL string) []step {
	out := make([]step, 0, len(script))
	client := &http.Client{}
	for _, r := range script {
		path := strings.ReplaceAll(r.path, "<LLM>", llmURL)
		sent := strings.ReplaceAll(r.body, "<LLM>", llmURL)
		var body io.Reader
		if sent != "" {
			body = strings.NewReader(sent)
		}
		req, err := http.NewRequest(r.method, ts.URL+path, body)
		if err != nil {
			panic(err)
		}
		req.Header.Set("X-Forwarded-Email", "zy@example.com")
		for _, h := range r.headers {
			req.Header.Set(h[0], h[1])
		}
		resp, err := client.Do(req)
		if err != nil {
			panic(fmt.Sprintf("%s: %v", r.name, err))
		}
		raw, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			panic(err)
		}
		sentHeaders := r.headers
		if sentHeaders == nil {
			sentHeaders = [][2]string{}
		}
		out = append(out, step{
			Name: r.name, Method: r.method, Path: fix(path, llmURL), ReqHeaders: sentHeaders,
			ReqBody: r.body,
			Status:  resp.StatusCode,
			Answer: headers{
				ContentType:         resp.Header.Get("Content-Type"),
				CacheControl:        resp.Header.Get("Cache-Control"),
				XContentTypeOptions: resp.Header.Get("X-Content-Type-Options"),
			},
			AnswerBody: fix(string(raw), llmURL),
		})
	}
	return out
}

// fix hides the fake endpoint's per-run origin.
func fix(s, llmURL string) string {
	return strings.ReplaceAll(s, llmURL, "<LLM>")
}

func main() {
	out := flag.String("out", "app/src/server/testdata/transcript-admin.go.json", "where the fixture goes")
	flag.Parse()

	fake := &fakeLLM{}
	llm := httptest.NewServer(http.HandlerFunc(fake.handler))
	defer llm.Close()

	srv := setup(llm.URL)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	steps := runScript(ts, llm.URL)
	fake.mu.Lock()
	calls := make([]llmCall, 0, len(fake.calls))
	for _, c := range fake.calls {
		c.Body = fix(c.Body, llm.URL)
		c.Path = fix(c.Path, llm.URL)
		calls = append(calls, c)
	}
	fake.mu.Unlock()

	b, err := json.MarshalIndent(fixture{Steps: steps, LLMCalls: calls}, "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		panic(err)
	}
	if err := os.WriteFile(*out, b, 0o644); err != nil {
		panic(err)
	}
	fmt.Printf("transcript: %d requests, %d endpoint calls → %s (%d bytes)\n", len(steps), len(calls), *out, len(b))
	for _, s := range steps {
		fmt.Printf("%-26s %-5s %-34s %d %6d\n", s.Name, s.Method, s.Path, s.Status, len(s.AnswerBody))
	}
	for _, c := range calls {
		fmt.Printf("  llm %-5s %-24s auth=%-28s %d bytes\n", c.Method, c.Path, c.Auth, len(c.Body))
	}
}
