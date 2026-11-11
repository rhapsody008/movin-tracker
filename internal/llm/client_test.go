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
		cl.Think = c.think
		if _, err := cl.Complete(context.Background(), []llm.Message{{Role: "user", Content: "hi"}}, nil, false, false, nil); err != nil {
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
