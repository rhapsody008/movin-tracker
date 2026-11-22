//go:build ignore

// Command t2x-golden answers two questions the T2 review asked the Go code
// directly (brief T2-fixes F15 and F2). A golden generator of the v3 port
// (app/golden/README.md): it needs the Go code, so run it before T7 deletes it.
//
// Run from the repo root, in the Go tools container:
//
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t2x/main.go'
//
// It writes no file: it prints, and the TypeScript tests quote its lines.
//
// F15: how encoding/json matches a JSON key to a struct field. It folds ASCII
// case, and when two keys match the same field the LAST one in the document
// wins. The bodies below are the ones the TypeScript helpers must agree with.
//
// F2: net/http's urlErrorOp, which names the verb in a network error.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/settings"
)

func main() {
	fmt.Println("== settings.Input (a struct: encoding/json folds the key case)")
	for _, body := range []string{
		`{"apikey":"a","APIKEY":"b"}`,
		`{"APIKEY":"b","apikey":"a"}`,
		`{"apiKey":"exact","APIKEY":"folded"}`,
		`{"APIKEY":"folded","apiKey":"exact"}`,
		`{"ApiKey":"mixed"}`,
		`{"thinkondemand":true,"THINKONDEMAND":false}`,
		`{"clearKey":true,"CLEARKEY":false}`,
	} {
		var in settings.Input
		err := json.Unmarshal([]byte(body), &in)
		fmt.Printf("%-46s apiKey=%q kind=%q thinkOnDemand=%v clearKey=%v err=%v\n",
			body, in.APIKey, in.Kind, in.ThinkOnDemand, in.ClearKey, err)
	}

	fmt.Println("== settings.CheckinInput (G2: a repeated exact key, and U+017F)")
	for _, body := range []string{
		// Go assigns in document order, so the LAST occurrence wins — even though
		// it comes first in a JS object's key order, whose value is the last one.
		`{"SCHEDULE":"8:05","schedule":"7:00","SCHEDULE":"9:00"}`,
		// U+017F (long s) simple-folds to "s" in Go (strings.EqualFold).
		`{"\u017fchedule":"long-s"}`,
	} {
		var in settings.CheckinInput
		err := json.Unmarshal([]byte(body), &in)
		fmt.Printf("%-52s schedule=%q err=%v\n", body, in.Schedule, err)
	}

	fmt.Println("== settings.TelegramInput (a struct of structs)")
	for _, body := range []string{
		`{"USERS":[{"ID":"7","NAME":"n"}],"useenv":true}`,
		`{"Users":[{"id":"1","name":"a"}],"Users":[{"id":"2","name":"b"}]}`,
	} {
		var in settings.TelegramInput
		err := json.Unmarshal([]byte(body), &in)
		fmt.Printf("%-58s users=%v useEnv=%v err=%v\n", body, in.Users, in.UseEnv, err)
	}

	fmt.Println("== entries.Patch (a map: keys are taken as written)")
	for _, body := range []string{`{"Title":"x","title":"y"}`, `{"TITLE":"x"}`} {
		var p entries.Patch
		err := json.Unmarshal([]byte(body), &p)
		keys := make([]string, 0, len(p))
		for k := range p {
			keys = append(keys, k)
		}
		fmt.Printf("%-30s keys=%v err=%v\n", body, keys, err)
	}
	// And what the model makes of a case-different key.
	for _, body := range []string{`{"title":"x"}`, `{"Title":"x"}`, `{"TITLE":"x"}`} {
		var p entries.Patch
		_ = json.Unmarshal([]byte(body), &p)
		e := &entries.Entry{}
		if err := p.Apply(e); err != nil {
			fmt.Printf("%-20s Apply error: %v\n", body, err)
			continue
		}
		fmt.Printf("%-20s Apply ok: title=%q\n", body, e.Title)
	}

	fmt.Println("== urlErrorOp (net/http/client.go:546-553)")
	for _, m := range []string{"GET", "POST", "PATCH", "DELETE", "PUT", "HEAD", ""} {
		fmt.Printf("%-8s -> %s\n", fmt.Sprintf("%q", m), urlErrorOp(m))
	}

	// What an actual url.Error prints, so the port's shape is checked, not guessed.
	_, err := (&http.Client{Transport: &brokenTransport{}}).Get("http://127.0.0.1:1/v1/models")
	fmt.Printf("url.Error: %v\n", err)
}

// brokenTransport fails every request with a canned dial error.
type brokenTransport struct{}

func (*brokenTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, fmt.Errorf("dial tcp 127.0.0.1:1: connect: connection refused")
}

// urlErrorOp is copied verbatim from Go's net/http/client.go:546-553 so the
// printed table is Go's own rule, not a paraphrase of it.
func urlErrorOp(method string) string {
	if method == "" {
		return "Get"
	}
	if lowerMethod, ok := ascii.ToLower(method); ok {
		return method[:1] + lowerMethod[1:]
	}
	return method
}

var ascii = asciiSet{}

// asciiSet is the tiny slice of internal/ascii that ToLower needs.
type asciiSet struct{}

func (asciiSet) ToLower(s string) (string, bool) {
	return strings.ToLower(s), true
}
