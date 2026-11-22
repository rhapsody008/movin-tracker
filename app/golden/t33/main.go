//go:build ignore

// Command t33-golden prints Go's authoritative bytes for the T3.3 golden: the
// `tools` array of the OpenAI request golden
// (internal/agent/testdata/openai_requests.golden, line 2), re-encoded as
// json.RawMessage, plus a per-tool line on stderr so a diff shows which
// declaration moved. A golden generator of the v3 port (app/golden/README.md):
// it needs the Go code, so run it before T7 deletes it.
//
// Run from the repo root, in the Go tools container, and compare stdout with
// the committed fixture:
//
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t33/main.go' | cmp - app/src/agent/testdata/tools.go.json
//
// It writes no file itself: stdout is app/src/agent/testdata/tools.go.json.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

const golden = "internal/agent/testdata/openai_requests.golden"

func main() {
	body, err := os.ReadFile(golden)
	if err != nil {
		fail(err)
	}
	lines := strings.Split(string(body), "\n")
	if len(lines) < 2 {
		fail(fmt.Errorf("%s has %d lines, want at least 2", golden, len(lines)))
	}
	var req struct {
		Tools json.RawMessage `json:"tools"`
	}
	if err := json.Unmarshal([]byte(lines[1]), &req); err != nil {
		fail(err)
	}
	if len(req.Tools) == 0 {
		fail(fmt.Errorf("line 2 of %s has no tools", golden))
	}
	var tools []json.RawMessage
	if err := json.Unmarshal(req.Tools, &tools); err != nil {
		fail(err)
	}
	fmt.Fprintf(os.Stderr, "%d tools, %d bytes\n", len(tools), len(req.Tools))
	names := make([]string, 0, len(tools))
	for _, t := range tools {
		var one struct {
			Function struct{ Name string } `json:"function"`
		}
		if err := json.Unmarshal(t, &one); err != nil {
			fail(err)
		}
		names = append(names, one.Function.Name)
	}
	fmt.Fprintf(os.Stderr, "%s\n", strings.Join(names, " "))
	fmt.Print(string(req.Tools))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
