//go:build ignore

// Command t31-golden writes Go's own answers for llm.StripSpecialTokens
// (internal/llm/openai.go:268-277), so the TypeScript port in
// app/src/llm/text.ts can be compared with the judge instead of with a guess.
// A golden generator of the v3 port (app/golden/README.md): it needs the Go
// code, so run it before T7 deletes it.
//
// Run from the repo root, in the Go tools container:
//
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t31/main.go'
//
// It writes app/src/llm/testdata/striptokens.go.json: one {"in","out"} row per
// case, in this file's order. The cases cover what the port could get wrong:
// tokens mid-text, repeated tokens, nothing but tokens, a lookalike token, the
// case-sensitive pattern, and the trim Go applies only when a token was there.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/rhapsody008/movin-tracker/internal/llm"
)

// row is one line of the golden file.
type row struct {
	In  string `json:"in"`
	Out string `json:"out"`
}

func main() {
	// The seven tokens specialTokenRe names, one case each; the rest are shapes.
	cases := []string{
		"Saved it.<|im_end|>",
		"Saved it. <|eot_id|>\n",
		"<|im_start|>assistant hi",
		"plain text",
		"a <|not_a_token|> stays",
		"<|im_end|>",
		"  spaces kept when no token  ",
		"one<|im_end|>two",
		"<|im_start|>a<|im_end|><|im_end|>b<|im_end|>",
		"<|im_start|><|im_end|><|eot_id|>",
		"<|im_end|><|im_start|><|eot_id|><|end_of_text|><|endoftext|><|end|><|eom_id|>",
		"x <|im_end|> y <|eot|> z",
		"<|IM_END|> keeps its case",
		"\t\n <|eom_id|> hi there <|end|> \n",
	}
	rows := make([]row, 0, len(cases))
	for _, in := range cases {
		rows = append(rows, row{In: in, Out: llm.StripSpecialTokens(in)})
	}
	out, err := json.MarshalIndent(rows, "", "\t")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	path := "app/src/llm/testdata/striptokens.go.json"
	if err := os.WriteFile(path, append(out, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, r := range rows {
		fmt.Printf("%q -> %q\n", r.In, r.Out)
	}
	fmt.Printf("\nwrote %s (%d rows)\n", path, len(rows))
}
