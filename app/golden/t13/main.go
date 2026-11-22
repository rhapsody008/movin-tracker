//go:build ignore

// Command t13-golden writes the Go app's own bytes for each input document, so
// the TypeScript port can be compared with the judge instead of with a guess.
// A golden generator of the v3 port (app/golden/README.md): it needs the Go
// code, so run it before T7 deletes it.
//
// It generates app/src/entries/testdata/<input>.go.json (Decode then
// json.Marshal, the bytes the app would store) or <input>.go.err (the decode
// error text), next to each input. Both are output names, so they are skipped
// as inputs.
//
// Run from the repo root, in the Go tools container:
//
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t13/main.go app/src/entries/testdata/*.json'
//
// The build tag keeps this directory out of `go list ./...`; an explicit file
// argument ignores the tag, which is why it runs as `go run <file>`.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/rhapsody008/movin-tracker/internal/entries"
)

func main() {
	for _, path := range os.Args[1:] {
		if strings.HasSuffix(path, ".go.json") {
			continue
		}
		name := strings.TrimSuffix(path, ".json")
		data, err := os.ReadFile(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "read %s: %v\n", path, err)
			os.Exit(1)
		}
		doc, err := entries.Decode(data)
		if err != nil {
			write(name+".go.err", []byte(err.Error()))
			continue
		}
		body, err := json.Marshal(doc)
		if err != nil {
			fmt.Fprintf(os.Stderr, "marshal %s: %v\n", path, err)
			os.Exit(1)
		}
		write(name+".go.json", body)
	}
}

func write(path string, body []byte) {
	if err := os.WriteFile(path, body, 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "write %s: %v\n", path, err)
		os.Exit(1)
	}
	fmt.Printf("wrote %s (%d bytes)\n", path, len(body))
}
