package server_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/server"
)

// fakeAnthropic answers /v1/models and /v1/messages and records which
// key each request carried.
type fakeAnthropic struct {
	srv  *httptest.Server
	mu   sync.Mutex
	auth []string
}

func newFakeAnthropic(t *testing.T) *fakeAnthropic {
	f := &fakeAnthropic{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.auth = append(f.auth, r.URL.Path+" "+r.Header.Get("Authorization")+r.Header.Get("X-Api-Key"))
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/models":
			fmt.Fprint(w, `{"data":[{"id":"claude-opus-5-5","type":"model"},{"id":"claude-sonnet-5-5","type":"model"}],"has_more":false}`)
		case "/v1/messages":
			fmt.Fprint(w, `{"id":"m","type":"message","role":"assistant","model":"claude-opus-5-5","stop_reason":"tool_use",`+
				`"content":[{"type":"tool_use","id":"toolu_1","name":"set_dates","input":{"move_in":"2026-12-05"}}],"usage":{"input_tokens":5,"output_tokens":5}}`)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAnthropic) last() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.auth) == 0 {
		return ""
	}
	return f.auth[len(f.auth)-1]
}

func TestClaudeKindThroughTheAPI(t *testing.T) {
	fa := newFakeAnthropic(t)
	e := setup(t, objstore.NewMemory(), func(s *server.Server) { s.Settings.WithClaudeBaseURL(fa.srv.URL) })

	// A key saved for the OpenAI-compatible endpoint, and the env key, never go to Claude.
	saveOpenAI := fmt.Sprintf(`{"baseUrl":%q,"apiKey":"sk-vmlx-saved-1111","model":"m","streaming":false}`, e.llm.srv.URL+"/v1")
	if code, _, raw := e.do(t, "PUT", "/api/settings/llm", saveOpenAI); code != 200 {
		t.Fatalf("save openai: %d %s", code, raw)
	}
	code, m, raw := e.do(t, "POST", "/api/settings/llm/models", `{"kind":"claude","baseUrl":"https://evil.example"}`)
	if code != 200 || fmt.Sprint(m["models"]) != "[claude-opus-5-5 claude-sonnet-5-5]" {
		t.Fatalf("models: %d %s", code, raw)
	}
	if got := fa.last(); got != "/v1/models " {
		t.Fatalf("Claude got a key it doesn't own: %q", got)
	}
	// A typed key is used for this call only.
	e.do(t, "POST", "/api/settings/llm/models", `{"kind":"claude","apiKey":"sk-ant-typed-2222"}`)
	if got := fa.last(); got != "/v1/models Bearer sk-ant-typed-2222" {
		t.Fatalf("typed key: %q", got)
	}

	// Save as Claude with a key; the page never gets it back.
	code, v, raw := e.do(t, "PUT", "/api/settings/llm", `{"kind":"claude","apiKey":"sk-ant-saved-3333","model":"claude-opus-5-5","streaming":true,"thinkOnDemand":true}`)
	if code != 200 || v["kind"] != "claude" || v["baseUrl"] != fa.srv.URL || strings.Contains(raw, "sk-ant-saved-3333") || v["keyLast4"] != "3333" {
		t.Fatalf("save claude: %d %s", code, raw)
	}
	// Test connection on Claude uses the saved key and reports tool calling.
	code, tr, raw := e.do(t, "POST", "/api/settings/llm/test", `{"kind":"claude","model":"claude-opus-5-5","thinkOnDemand":true}`)
	if code != 200 || tr["ok"] != true {
		t.Fatalf("test: %d %s", code, raw)
	}
	if got := fa.last(); got != "/v1/messages Bearer sk-ant-saved-3333" {
		t.Fatalf("test call auth %q", got)
	}
	// Back to OpenAI-compatible without typing a key: the Claude key stays home.
	if code, _, raw := e.do(t, "POST", "/api/settings/llm/models", fmt.Sprintf(`{"kind":"openai","baseUrl":%q}`, e.llm.srv.URL+"/v1")); code != 200 {
		t.Fatalf("openai models after claude: %d %s", code, raw)
	}
	e.llm.mu.Lock()
	sentToOpenAI := strings.Join(e.llm.auths, " ")
	e.llm.mu.Unlock()
	if strings.Contains(sentToOpenAI, "sk-ant-saved-3333") {
		t.Fatalf("Claude key sent to the OpenAI endpoint")
	}
	if code, _, _ := e.do(t, "POST", "/api/settings/llm/models", `{"kind":"gpt"}`); code != 400 {
		t.Fatalf("bad kind: %d", code)
	}
	if strings.Contains(e.logs.String(), "sk-ant-saved-3333") || strings.Contains(e.logs.String(), "sk-ant-typed-2222") {
		t.Fatalf("key in logs")
	}
}
