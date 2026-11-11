package llm_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/llm"
	"github.com/rhapsody008/movin-tracker/internal/settings"
)

func TestStripSpecialTokens(t *testing.T) {
	cases := map[string]string{
		"Saved it.<|im_end|>":           "Saved it.",
		"Saved it. <|eot_id|>\n":        "Saved it.",
		"<|im_start|>assistant hi":      "assistant hi",
		"plain text":                    "plain text",
		"a <|not_a_token|> stays":       "a <|not_a_token|> stays",
		"<|im_end|>":                    "",
		"  spaces kept when no token  ": "  spaces kept when no token  ",
	}
	for in, want := range cases {
		if got := llm.StripSpecialTokens(in); got != want {
			t.Errorf("StripSpecialTokens(%q) = %q, want %q", in, got, want)
		}
	}
}

// enable_thinking=false goes out only when thinking is on demand and this
// turn didn't ask for it; otherwise the field is absent. Temperature and
// max_tokens are never sent.
func TestThinkOnDemandKwargs(t *testing.T) {
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]json.RawMessage
		json.NewDecoder(r.Body).Decode(&raw)
		got = append(got, string(raw["chat_template_kwargs"]))
		for _, k := range []string{"temperature", "max_tokens"} {
			if _, ok := raw[k]; ok {
				t.Errorf("request sends %s; it is left to the model server", k)
			}
		}
		w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer srv.Close()
	for _, c := range []struct{ onDemand, think bool }{{true, false}, {true, true}, {false, false}} {
		cl := llm.New(settings.LLM{BaseURL: srv.URL, Model: "m", TimeoutSec: 5, ThinkOnDemand: c.onDemand})
		if _, err := cl.Complete(context.Background(), llm.Request{Messages: []llm.Message{{Role: "user", Content: "hi"}}, Think: c.think}); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{`{"enable_thinking":false}`, "", ""}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("case %d: chat_template_kwargs = %q, want %q", i, got[i], want[i])
		}
	}
}

// Only api.anthropic.com gets the native headers; the key goes nowhere
// else as x-api-key.
func TestAnthropicHeadersOnlyForAnthropic(t *testing.T) {
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.Write([]byte(`{"data":[{"id":"m1"}]}`))
	}))
	defer srv.Close()
	if _, err := llm.New(settings.LLM{BaseURL: srv.URL + "/v1", APIKey: "k", TimeoutSec: 5}).Models(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got.Get("x-api-key") != "" || got.Get("anthropic-version") != "" || got.Get("Authorization") != "Bearer k" {
		t.Fatalf("other endpoint got %v", got)
	}
}

// Stop and Usage come from finish_reason and usage, streamed or not; tool
// calls win over the finish reason.
func TestOpenAIStopAndUsage(t *testing.T) {
	var reply string
	var sse bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if sse {
			w.Header().Set("Content-Type", "text/event-stream")
		}
		w.Write([]byte(reply))
	}))
	defer srv.Close()
	p := llm.New(settings.LLM{BaseURL: srv.URL, Model: "m", TimeoutSec: 5})
	for _, c := range []struct {
		name, body string
		sse        bool
		stop       llm.Stop
		usage      llm.Usage
	}{
		{"end", `{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":100}}}`, false, llm.StopEnd, llm.Usage{In: 120, Out: 7, CacheRead: 100}},
		{"length", `{"choices":[{"message":{"content":"cut"},"finish_reason":"length"}]}`, false, llm.StopMaxTokens, llm.Usage{}},
		{"tool", `{"choices":[{"message":{"content":"","tool_calls":[{"id":"c","type":"function","function":{"name":"x","arguments":"{}"}}]},"finish_reason":"stop"}]}`, false, llm.StopTool, llm.Usage{}},
		{"stream length", "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n", true, llm.StopMaxTokens, llm.Usage{}},
	} {
		reply, sse = c.body, c.sse
		res, err := p.Complete(context.Background(), llm.Request{Messages: []llm.Message{{Role: "user", Content: "q"}}, Stream: c.sse})
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if res.Stop != c.stop || res.Usage != c.usage {
			t.Errorf("%s: stop %q usage %+v; want %q %+v", c.name, res.Stop, res.Usage, c.stop, c.usage)
		}
	}
}
