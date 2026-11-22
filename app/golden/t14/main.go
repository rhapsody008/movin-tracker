//go:build ignore

// Command t14-golden writes the Go settings package's own bytes and prints the
// answers the TypeScript port must reproduce. A golden generator of the v3 port
// (app/golden/README.md): it needs the Go code, so run it before T7 deletes it.
//
// Every command runs from the repo root, in the Go tools container:
//
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t14/main.go save app/src/settings/testdata/settings-go.json'
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t14/main.go savebytes'
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t14/main.go sortkeys'
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t14/main.go rawtable'
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t14/main.go claude app/src/settings/testdata/settings-go-claude.json'
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t14/main.go load app/src/settings/testdata/settings-go.json'
//
// The modes and what they generate:
//
//	save <path>       app/src/settings/testdata/settings-go.json  (a saved settings.json)
//	savebytes         app/src/settings/testdata/save-telegram.go.json and save-checkin.go.json
//	sortkeys          app/src/testdata/sortkeys.go.json            (sort.Strings order)
//	rawtable          app/src/testdata/raw.go.json                (Go's json.MarshalIndent bytes)
//	claude <path>     app/src/settings/testdata/settings-go-claude.json
//	load <path>       prints what Go resolves from a settings.json (no file written)
//	decrypt <token>, keyerr <secret>  print (no file written)
//
// save and claude encrypt a key with a fresh Fernet IV, so their output differs
// byte-wise on every run; the tests decrypt them and compare the plaintext.
// savebytes, sortkeys and rawtable are byte-stable.
//
// resave is the T1 gate, not a golden generator: it reads the gate file that
// gate.ts wrote and writes gate-go.json back, both in the git-ignored scratch
// dir tmp/t14-golden/ next to gate.ts, so those two files stay there.
//
// Every secret here is a published Fernet test vector, not a real key.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/fernet/fernet-go"

	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/settings"
)

// Published Fernet spec vectors; test values only, never used by the app.
const (
	testSecret      = "cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4="
	otherTestSecret = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
)

var now = time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)

func logger() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }

// envLLM is the env layer the TS tests use (newRig): a different host than the
// file's, so its key must not follow the file's URL.
func envLLM() settings.LLM {
	l := settings.Defaults
	l.BaseURL, l.Model, l.APIKey = "https://env.example/v1", "env-model", "sk-env-0000-aaaa"
	return l
}

// writeDoc runs fn against a memory store holding raw (if not empty) and writes
// the resulting settings.json bytes to path.
func writeDoc(path string, secret string, raw string, fn func(*settings.Service)) {
	ctx := context.Background()
	mem := objstore.NewMemory()
	if raw != "" {
		if _, err := mem.Put(ctx, settings.Key, []byte(raw), ""); err != nil {
			fail(err)
		}
	}
	svc, err := settings.NewService(mem, envLLM(), secret, logger())
	if err != nil {
		fail(err)
	}
	svc.SetClock(func() time.Time { return now })
	fn(svc)
	body, _, err := mem.Get(ctx, settings.Key)
	if err != nil {
		fail(err)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		fail(err)
	}
	// A file holding a key would leak it; the apiKeyEnc is what we want to see,
	// and its plaintext is never printed.
	fmt.Printf("wrote %s (%d bytes, apiKeyEnc present: %v)\n", path, len(body), bytesContains(body, []byte(`"apiKeyEnc"`)))
	fmt.Println(string(body))
}

func bytesContains(b, sub []byte) bool {
	for i := 0; i+len(sub) <= len(b); i++ {
		if string(b[i:i+len(sub)]) == string(sub) {
			return true
		}
	}
	return false
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func saveDoc(path string) {
	// A v1-shaped file with an llm section and a section this version does not
	// know ("stt"), so the save has to keep both.
	raw := `{
  "schema": 1,
  "llm": {"baseUrl": "https://llm.example/v1", "model": "qwen", "temperature": 0.1, "maxTokens": 2048},
  "stt": {"model": "whisper", "notes": ["a < b", "c & d"]},
  "updated": "2026-10-14T00:00:00Z",
  "by": "zy@example.com"
}`
	writeDoc(path, testSecret, raw, func(s *settings.Service) {
		ctx := context.Background()
		if _, err := s.Save(ctx, "zy@example.com", settings.Input{
			BaseURL: "https://llm.example/v1/", APIKey: "sk-test-go-written-7f3a", Model: " m2 ", Vision: true,
			Streaming: true, ThinkOnDemand: true,
		}); err != nil {
			fail(err)
		}
		if _, err := s.SaveTelegram(ctx, "zy@example.com", settings.TelegramInput{
			Users:  []settings.TelegramUser{{ID: "111", Name: "ZY"}, {ID: "222", Name: "Partner"}},
			Groups: []string{"-1001234"},
		}); err != nil {
			fail(err)
		}
		if _, err := s.SaveCheckin(ctx, "zy@example.com", settings.CheckinInput{Schedule: "7:05", Chat: "-1001234"}); err != nil {
			fail(err)
		}
	})
}

func claudeDoc(path string) {
	// The key is encrypted with the *other* test secret: a v2 build that tries
	// to decrypt this section fails, which the TS test can see in the log.
	writeDoc(path, otherTestSecret, "", func(s *settings.Service) {
		if _, err := s.Save(context.Background(), "zy@example.com", settings.Input{
			Kind: settings.KindClaude, APIKey: "sk-test-claude-legacy-0000", Model: "claude-opus-5-5",
		}); err != nil {
			fail(err)
		}
	})
}

// saveBytes runs the two saves the TS byte golden repeats, each from the shared
// fixture, and writes the bytes Go produced after each one: app/src/settings/
// testdata/save-telegram.go.json and save-checkin.go.json. Both saves are section
// saves, so the apiKeyEnc (a random IV) is never involved: the fixture has none.
func saveBytes() {
	ctx := context.Background()
	fixture := "app/src/settings/testdata/save-fixture.json"
	body, err := os.ReadFile(fixture)
	if err != nil {
		fail(err)
	}
	mem := objstore.NewMemory()
	if _, err := mem.Put(ctx, settings.Key, body, ""); err != nil {
		fail(err)
	}
	svc, err := settings.NewService(mem, envLLM(), testSecret, logger())
	if err != nil {
		fail(err)
	}
	svc.SetClock(func() time.Time { return now })

	dump := func(path string) {
		out, _, err := mem.Get(ctx, settings.Key)
		if err != nil {
			fail(err)
		}
		if err := os.WriteFile(path, out, 0o644); err != nil {
			fail(err)
		}
		fmt.Printf("wrote %s (%d bytes)\n%s\n", path, len(out), out)
	}

	if _, err := svc.SaveTelegram(ctx, "zy@example.com", settings.TelegramInput{
		Users:  []settings.TelegramUser{{ID: "333", Name: " Helper  Lim "}},
		Groups: []string{"-1009"},
	}); err != nil {
		fail(err)
	}
	dump("app/src/settings/testdata/save-telegram.go.json")

	// An empty chat is the omitempty case.
	if _, err := svc.SaveCheckin(ctx, "zy@example.com", settings.CheckinInput{Schedule: "7:05", Chat: ""}); err != nil {
		fail(err)
	}
	dump("app/src/settings/testdata/save-checkin.go.json")
}

// resave is F1's gate (settings-spec §9 trap 1): read the file the TS writer
// produced, save the same two sections again from Go, and print whether the
// bytes are unchanged. A difference is a formatting difference, not a value one.
// Its two files stay in the scratch dir with gate.ts (tmp/ is git-ignored), so
// this mode is the T1 gate, not a golden generator: it reads what gate.ts wrote.
func resave() {
	ctx := context.Background()
	in := "tmp/t14-golden/gate-ts.json"
	body, err := os.ReadFile(in)
	if err != nil {
		fail(err)
	}
	mem := objstore.NewMemory()
	if _, err := mem.Put(ctx, settings.Key, body, ""); err != nil {
		fail(err)
	}
	svc, err := settings.NewService(mem, envLLM(), testSecret, logger())
	if err != nil {
		fail(err)
	}
	svc.SetClock(func() time.Time { return now })
	if _, err := svc.SaveTelegram(ctx, "zy@example.com", settings.TelegramInput{
		Users:  []settings.TelegramUser{{ID: "333", Name: " Helper  Lim "}},
		Groups: []string{"-1009"},
	}); err != nil {
		fail(err)
	}
	if _, err := svc.SaveCheckin(ctx, "zy@example.com", settings.CheckinInput{Schedule: "7:05", Chat: ""}); err != nil {
		fail(err)
	}
	out, _, err := mem.Get(ctx, settings.Key)
	if err != nil {
		fail(err)
	}
	if err := os.WriteFile("tmp/t14-golden/gate-go.json", out, 0o644); err != nil {
		fail(err)
	}
	if string(out) == string(body) {
		fmt.Printf("gate: TS file and Go re-save are byte-identical (%d bytes)\n", len(out))
		return
	}
	fmt.Printf("gate: DIFFERENT (ts %d bytes, go %d bytes)\n", len(body), len(out))
	os.Exit(1)
}

// sortKeys is F2 row g's golden: the order Go's sort.Strings (byte order) puts
// a set of keys in, including a non-BMP character and U+E000-U+FFFF ones, which
// JavaScript's UTF-16 order would place differently.
func sortKeys() {
	keys := []string{"\U0001F004", "\uE000x", "a", "\uFFFF", "\U0001F600 chapter.pdf", "\uFFFD", "Z"}
	sort.Strings(keys)
	out, err := json.Marshal(keys)
	if err != nil {
		fail(err)
	}
	if err := os.WriteFile("app/src/testdata/sortkeys.go.json", out, 0o644); err != nil {
		fail(err)
	}
	fmt.Printf("wrote app/src/testdata/sortkeys.go.json: %s\n", out)
}

// rawCase is one row of the golden table: the bytes a settings.json may hold,
// and what Go's `modify` writes for them (or that Unmarshal refused them).
type rawCase struct {
	Name string `json:"name"`
	// Input is base64 of the file's bytes, so control characters, U+2028 and
	// invalid UTF-8 survive being written into a JSON file by hand.
	Input string `json:"input"`
	Ok    bool   `json:"ok"`
	// Output is Go's bytes; empty when Ok is false.
	Output string `json:"output"`
}

// rawTable is A1's golden: every row goes through the same three steps the Go
// service's modify does — Unmarshal into map[string]json.RawMessage, set
// schema=1, MarshalIndent — and the result is written to
// app/src/testdata/raw.go.json. The TS RawObject must produce the same bytes,
// and must refuse exactly the rows Go refuses.
func rawTable() {
	valid := []struct{ name, input string }{
		{"escaped quotes, backslashes and brackets inside strings", `{"a":"say \"hi\" \\ {[1]}","b":"{\"x\":[1,2]}"}`},
		// Tabs also inside a section, which is the text compact() has to strip.
		{"CRLF, tab and space whitespace", "{\r\n\t\"a\" :\t1 ,\r\n\r\n \"b\"  :\t{\t\"c\"\t:\t2\t,\r\n\t\t\"d\" : [ 1 ,\t2 ]\r\n\t}\r\n}"},
		{"empty object and array at depth 1 and 2", `{"o1":{},"a1":[],"o2":{"in":{}},"a2":{"in":[]}}`},
		{"duplicate top-level keys: the last wins", `{"dup":1,"dup":2}`},
		{"an escaped key next to the plain one it equals, and an HTML key", `{"\u0061":1,"a":2,"<k>&":3}`},
		{"keys outside the BMP and in the private and FFFF planes", "{\"\U0001F600\":1,\"\uE000\":2,\"\uFFFF\":3}"},
		{"escapes kept as written: slash, u00E9 and a lone surrogate", `{"s":"a\/b\u00E9\ud800"}`},
		{"number literals kept", `{"n":[1.50,12345678901234567890,1E3,-0,-0.0e+5,-1.5E-3]}`},
		{"U+2028, U+2029 and the HTML characters", "{\"s\":\"a\u2028b\u2029c<>&\"}"},
		// The empty root, which has its own branch in parse (N5).
		{"an empty object", `{}`},
		{"an empty object with space around it", ` { } `},
	}
	invalid := []struct{ name, input string }{
		{"a trailing comma", `{"a":1,}`},
		{"an array at the top level", `[1]`},
		{"a string at the top level", `"x"`},
		{"tru", `{"a":tru}`},
		{"a leading zero", `{"a":01}`},
		{"a trailing decimal point", `{"a":1.}`},
		{"an empty exponent", `{"a":1e+}`},
		{"a bare minus", `{"a":-}`},
		{"text after the object", `{"a":1}x`},
		{"a missing colon", `{"a" 1}`},
		{"a missing comma", `{"a":1 "b":2}`},
		{"a raw control character in a string", "{\"a\":\"x\u0001y\"}"},
		{"the escape \\x", `{"a":"\x41"}`},
		{"the escape \\u12G4", `{"a":"\u12G4"}`},
		{"nullx", `{"a":nullx}`},
		{"empty input", ""},
		{"whitespace-only input", " \r\n\t "},
		// Nested structure: scanContainer's own separator and colon checks (N1, N2).
		{"a missing comma in an array", `{"a":[1 2]}`},
		{"a missing comma in a nested object", `{"a":{"b":1 "c":2}}`},
		{"a missing colon in a nested object", `{"a":{"b" 1}}`},
		{"a missing colon before the value, no space", `{"a":{"b"x1}}`},
		// The top-level colon check (N3), and the root must be an object (N4).
		{"a missing top-level colon", `{"a"x1}`},
		{"an object inside an array bracket", `["a":1}`},
	}
	out := make([]rawCase, 0, len(valid)+len(invalid))
	add := func(name, input string, ok bool) {
		row := rawCase{Name: name, Input: base64.StdEncoding.EncodeToString([]byte(input)), Ok: ok}
		raw := map[string]json.RawMessage{}
		err := json.Unmarshal([]byte(input), &raw)
		if !ok {
			if err == nil {
				fail(fmt.Errorf("invalid case %q: Go accepted it", name))
			}
			out = append(out, row)
			return
		}
		if err != nil {
			fail(fmt.Errorf("valid case %q: %w", name, err))
		}
		if raw == nil {
			// Unmarshalling the literal null gives a nil map; modify would panic.
			fail(fmt.Errorf("valid case %q: a nil map, Go's modify panics on it", name))
		}
		raw["schema"] = json.RawMessage("1")
		body, merr := json.MarshalIndent(raw, "", "  ")
		if merr != nil {
			fail(merr)
		}
		row.Output = string(body)
		out = append(out, row)
	}
	for _, c := range valid {
		add(c.name, c.input, true)
	}
	for _, c := range invalid {
		add(c.name, c.input, false)
	}
	body, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		fail(err)
	}
	body = append(body, '\n')
	path := "app/src/testdata/raw.go.json"
	if err := os.WriteFile(path, body, 0o644); err != nil {
		fail(err)
	}
	fmt.Printf("wrote %s: %d rows (%d valid, %d refused), %d bytes\n", path, len(out), len(valid), len(invalid), len(body))
	for _, row := range out {
		fmt.Printf("  ok=%-5v %-62s %s\n", row.Ok, row.Name, strings.SplitN(row.Output, "\n", 2)[0])
	}
}

type summary struct {
	LLM      map[string]any `json:"llm"`
	View     map[string]any `json:"view"`
	Telegram any            `json:"telegram"`
	Checkin  map[string]any `json:"checkin"`
	TopKeys  []string       `json:"topKeys"`
}

func loadDoc(path string) {
	ctx := context.Background()
	body, err := os.ReadFile(path)
	if err != nil {
		fail(err)
	}
	mem := objstore.NewMemory()
	if _, err := mem.Put(ctx, settings.Key, body, ""); err != nil {
		fail(err)
	}
	tg, err := settings.ParseTelegramEnv("111=ZY, 222=Partner", "-1001234")
	if err != nil {
		fail(err)
	}
	ci, err := settings.ParseCheckin("off", "-100")
	if err != nil {
		fail(err)
	}
	svc, err := settings.NewService(mem, envLLM(), testSecret, logger())
	if err != nil {
		fail(err)
	}
	svc.WithTelegramEnv(tg).WithCheckinEnv(ci)
	svc.SetClock(func() time.Time { return now })

	l := svc.Resolve(ctx)
	v := svc.View(ctx)
	gotTG := svc.ResolveTelegram(ctx)
	c, err := svc.ResolveCheckin(ctx)
	if err != nil {
		fail(err)
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		fail(err)
	}
	keys := make([]string, 0, len(top))
	for k := range top {
		keys = append(keys, k)
	}
	out := summary{
		LLM: map[string]any{"kind": l.Kind, "baseUrl": l.BaseURL, "model": l.Model, "apiKey": l.APIKey, "vision": l.Vision, "streaming": l.Streaming, "thinkOnDemand": l.ThinkOnDemand},
		View: map[string]any{
			"kind": v.Kind, "baseUrl": v.BaseURL, "model": v.Model, "keySet": v.KeySet, "keyLast4": v.KeyLast4,
			"keyFromEnv": v.KeyFromEnv, "canStoreKey": v.CanStoreKey, "updated": v.Updated, "by": v.By,
		},
		Telegram: gotTG,
		Checkin:  map[string]any{"schedule": c.Schedule, "chat": c.Chat, "on": c.On, "fromEnv": c.FromEnv},
		TopKeys:  keys,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		fail(err)
	}
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: go run ./app/golden/t14/main.go save|savebytes|sortkeys|rawtable|claude|load|resave|decrypt|keyerr …")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "save":
		saveDoc(os.Args[2])
	case "savebytes":
		saveBytes()
	case "resave":
		resave()
	case "sortkeys":
		sortKeys()
	case "rawtable":
		rawTable()
	case "claude":
		claudeDoc(os.Args[2])
	case "load":
		loadDoc(os.Args[2])
	case "decrypt":
		k, err := fernet.DecodeKey(testSecret)
		if err != nil {
			fail(err)
		}
		msg := fernet.VerifyAndDecrypt([]byte(os.Args[2]), 0, []*fernet.Key{k})
		fmt.Printf("plaintext=%q ok=%v\n", string(msg), msg != nil)
	case "keyerr":
		k, err := fernet.DecodeKey(os.Args[2])
		fmt.Printf("err=%v key=%v\n", err, k != nil)
	default:
		fmt.Fprintln(os.Stderr, "unknown mode", os.Args[1])
		os.Exit(2)
	}
}
