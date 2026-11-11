package llm_test

import (
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/llm"
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
