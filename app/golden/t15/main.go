//go:build ignore

// Command t15-golden writes the Go docs package's own bytes for each input, so
// the TypeScript port can be compared with the judge instead of with a guess.
// A golden generator of the v3 port (app/golden/README.md): it needs the Go
// code, so run it before T7 deletes it.
//
// It generates app/src/docs/testdata/<input>.go.json for each input: the four
// index inputs (empty.json, index.json, nulls.json, tricky.json, -kind=index,
// the default) and the page text blob (pages.json, -kind=pages). Run from the
// repo root, in the Go tools container:
//
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t15/main.go app/src/docs/testdata/index.json app/src/docs/testdata/tricky.json app/src/docs/testdata/empty.json app/src/docs/testdata/nulls.json'
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t15/main.go -kind=pages app/src/docs/testdata/pages.json'
//
// Mode 1 (default) decodes each input with Go's own package and writes
// <input>.go.json: for -kind=index docs.Decode then Index.Encode, for
// -kind=pages json.Unmarshal then json.Marshal. Mode 2 reads an index the
// TypeScript side wrote and prints what Go makes of it, which is the
// "TS writes, Go reads" half of the round trip.
//
// For <input>.json it writes <input>.go.json; *.go.json is skipped as an input,
// so the program can be given a glob. The build tag keeps this directory out of
// `go list ./...`; an explicit file argument ignores the tag, which is why it
// runs as `go run <file>`.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/docs"
)

// fixed is the clock the TypeScript tests pass to encodeIndex: the sync rig's
// Now, 2026-11-11T03:00:00Z. It is the `updated` stamp of every golden file.
var fixed = time.Date(2026, 11, 11, 3, 0, 0, 0, time.UTC)

func main() {
	kind := flag.String("kind", "index", "index (docs.Index) or pages (docs.PageText)")
	mode := flag.Int("mode", 1, "1: write the .go.json for each input; 2: read a TS-written index and print what Go sees")
	flag.Parse()
	for _, path := range flag.Args() {
		if strings.HasSuffix(path, ".go.json") {
			continue // our own output
		}
		data, err := os.ReadFile(path)
		if err != nil {
			die("read %s: %v", path, err)
		}
		switch *mode {
		case 1:
			encode(path, *kind, data)
		case 2:
			read(path, data)
		default:
			die("unknown mode %d", *mode)
		}
	}
}

// encode decodes the input the way the app does and writes the bytes it would
// store next to it.
func encode(path, kind string, data []byte) {
	var body []byte
	var err error
	switch kind {
	case "index":
		ix, derr := docs.Decode(data)
		if derr != nil {
			die("%s: %v", path, derr)
		}
		body, err = ix.Encode(fixed)
	case "pages":
		var pt docs.PageText
		if derr := json.Unmarshal(data, &pt); derr != nil {
			die("%s: %v", path, derr)
		}
		body, err = json.Marshal(pt)
	default:
		die("unknown kind %q", kind)
	}
	if err != nil {
		die("encode %s: %v", path, err)
	}
	out := strings.TrimSuffix(path, ".json") + ".go.json"
	if err := os.WriteFile(out, body, 0o644); err != nil {
		die("write %s: %v", out, err)
	}
	fmt.Printf("wrote %s (%d bytes)\n", out, len(body))
}

// read prints what Go's own decoder makes of an index the TypeScript side wrote.
func read(path string, data []byte) {
	ix, err := docs.Decode(data)
	if err != nil {
		die("%s: %v", path, err)
	}
	fmt.Printf("%s: schema=%d docs=%d updated=%q\n", path, ix.Schema, len(ix.Docs), ix.Updated)
	for _, d := range ix.Docs {
		fmt.Printf("  %+v\n", d)
	}
	if ix.LastSync != nil {
		fmt.Printf("  lastSync=%+v\n", *ix.LastSync)
	}
	// Go must also be able to write it back: that is what a sync does.
	if _, err := ix.Encode(fixed); err != nil {
		die("%s: %v", path, err)
	}
	fmt.Printf("  go re-encodes it: ok\n")
}

func die(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
