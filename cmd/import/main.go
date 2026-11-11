// Command import turns an export of the Claude-hosted board into board.json.
//
//	go run ./cmd/import -in export.json -out board.import.json -by zy@example.com
//
// Then upload it with `movin seed board.import.json` (ETag-guarded), or for
// the local stack: docker compose run --rm -v $PWD:/x bucket-init seed /x/board.import.json
//
// Accepted export shapes (the Claude board keeps items in an "items"
// collection and the dates in a "meta/settings" document):
//
//	{"items": [{"id": "...", "title": "...", ...}], "meta": {"moveDate": "...", "keyDate": "..."}}
//	{"items": [{"id": "...", "data": {"title": "...", ...}}], "meta": {...}}
//	[{"id": "...", "title": "...", ...}, ...]
//
// created/updated may be epoch milliseconds (as the Claude board stores
// them) or RFC 3339 strings. Every item is run through the same field rules
// as the API; anything that fails is reported and the import stops.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/rhapsody008/movin-tracker/internal/board"
)

func main() {
	in := flag.String("in", "", "export JSON file (required)")
	out := flag.String("out", "board.import.json", "where to write board.json")
	by := flag.String("by", "import", `value for "by" on items that lack one (the Claude board stored user ids, not emails)`)
	flag.Parse()
	if *in == "" {
		flag.Usage()
		os.Exit(2)
	}
	if err := run(*in, *out, *by); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

type export struct {
	Items []map[string]any `json:"items"`
	Meta  map[string]any   `json:"meta"`
}

func run(in, out, by string) error {
	raw, err := os.ReadFile(in)
	if err != nil {
		return err
	}
	var ex export
	if err := json.Unmarshal(raw, &ex); err != nil {
		var arr []map[string]any
		if err2 := json.Unmarshal(raw, &arr); err2 != nil {
			return fmt.Errorf("not an export object or item array: %w", err)
		}
		ex.Items = arr
	}
	// meta may itself be wrapped as {"data": {...}} or {"settings": {...}}.
	for _, k := range []string{"data", "settings"} {
		if inner, ok := ex.Meta[k].(map[string]any); ok {
			ex.Meta = inner
		}
	}

	b := board.Empty()
	for k, dst := range map[string]**string{"moveDate": &b.Meta.MoveDate, "keyDate": &b.Meta.KeyDate} {
		if s, ok := ex.Meta[k].(string); ok && board.ValidDate(s) {
			*dst = &s
		}
	}

	seen := map[string]bool{}
	for n, doc := range ex.Items {
		if data, ok := doc["data"].(map[string]any); ok {
			id := doc["id"]
			doc = data
			if id != nil {
				doc["id"] = id
			}
		}
		id, _ := doc["id"].(string)
		if id == "" || seen[id] {
			id = ulid.Make().String()
		}
		seen[id] = true

		fields := map[string]any{}
		for _, k := range []string{"title", "cat", "status", "due", "time", "vendor", "quoted", "paid", "notes", "archived"} {
			if v, ok := doc[k]; ok {
				fields[k] = v
			}
		}
		if t, _ := fields["title"].(string); t == "" {
			fields["title"] = "Untitled"
		}
		p, err := board.PatchFromMap(fields)
		if err != nil {
			return err
		}
		it := board.Item{ID: id, Cat: "admin", Status: "todo", By: by}
		if err := p.Apply(&it); err != nil {
			return fmt.Errorf("item %d (%v): %w", n+1, doc["title"], err)
		}
		it.Created = stamp(doc["created"])
		it.Updated = stamp(doc["updated"])
		if it.Updated == "" {
			it.Updated = it.Created
		}
		if s, ok := doc["by"].(string); ok && strings.Contains(s, "@") {
			it.By = s
		}
		b.Items = append(b.Items, it)
	}

	body, _ := json.MarshalIndent(b, "", "  ")
	if err := os.WriteFile(out, append(body, '\n'), 0o644); err != nil {
		return err
	}
	archived := 0
	for _, it := range b.Items {
		if it.Archived {
			archived++
		}
	}
	fmt.Printf("wrote %s: %d items (%d archived), moveDate=%v keyDate=%v\n", out, len(b.Items), archived, ptr(b.Meta.MoveDate), ptr(b.Meta.KeyDate))
	return nil
}

func ptr(p *string) string {
	if p == nil {
		return "null"
	}
	return *p
}

// stamp turns epoch milliseconds or an RFC 3339 string into RFC 3339 UTC.
func stamp(v any) string {
	switch x := v.(type) {
	case float64:
		return time.UnixMilli(int64(x)).UTC().Format(time.RFC3339)
	case string:
		if t, err := time.Parse(time.RFC3339, x); err == nil {
			return t.UTC().Format(time.RFC3339)
		}
	}
	return time.Now().UTC().Format(time.RFC3339)
}
