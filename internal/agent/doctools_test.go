package agent_test

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/docs"
	"github.com/rhapsody008/movin-tracker/internal/docs/convert"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/testutil"
)

// docsLib syncs two fake documents into a memory store and returns the
// library plus the fridge manual's id.
func docsLib(t *testing.T, withDocs bool) (*docs.Library, string) {
	t.Helper()
	store := objstore.NewMemory()
	pad := strings.Repeat(" care and use of the appliance", 5)
	conv := &convert.Fake{Pages: map[string][]docs.Page{
		"pdf-fridge": {{N: 1, W: 595, H: 842, Text: "Contents" + pad}, {N: 2, W: 595, H: 842, Text: "Defrosting: defrost the freezer every six months." + pad}},
		"pdf-plan":   {{N: 1, W: 2384, H: 1684, Text: "POWER LEGEND DB distribution board" + pad}},
	}}
	ctx := context.Background()
	if withDocs {
		store.PutBlob(ctx, "docs/raw/4.0 Manuals/Fridge.pdf", []byte("pdf-fridge"), "application/pdf")
		store.PutBlob(ctx, "docs/raw/1.0 Plans/1.3 Power.pdf", []byte("pdf-plan"), "application/pdf")
	}
	s := &docs.Syncer{Store: store, Conv: conv, Log: testutil.Logger(nil), Now: func() time.Time { return time.Date(2026, 11, 11, 3, 0, 0, 0, time.UTC) }}
	if _, err := s.Sync(ctx, "test"); err != nil {
		t.Fatal(err)
	}
	lib := &docs.Library{Sync: s}
	id := ""
	if withDocs {
		ix, _ := s.Index(ctx)
		for _, d := range ix.Docs {
			if d.Name() == "Fridge.pdf" {
				id = d.ID
			}
		}
	}
	return lib, id
}

func TestDocumentToolsOnOpenAI(t *testing.T) {
	lib, fridge := docsLib(t, true)
	r := newRig(t,
		step{calls: [][2]string{{"search_documents", `{"query":"defrost freezer"}`}}},
		step{calls: [][2]string{{"read_document_page", `{"doc":"` + fridge + `","page":2}`}}},
		step{text: "Defrost every six months (Fridge.pdf, page 2)."},
	)
	r.runner.Docs = lib
	res := r.run(t, user("ZY", "web", "how often should we defrost the freezer?"))
	if !strings.Contains(res.Reply, "six months") || len(res.Changes) != 0 {
		t.Fatalf("res %+v", res)
	}
	r.llm.mu.Lock()
	defer r.llm.mu.Unlock()
	var search, read string
	for _, m := range r.llm.reqs[1] {
		if m.Role == "tool" {
			search = m.Content
		}
	}
	for _, m := range r.llm.reqs[2] {
		if m.Role == "tool" {
			read = m.Content
		}
	}
	if !strings.Contains(search, `"doc":"`+fridge+`"`) || !strings.Contains(search, `"page":2`) {
		t.Errorf("search result %s", search)
	}
	if !strings.Contains(read, "defrost the freezer every six months") || !strings.Contains(read, `"pages":2`) {
		t.Errorf("read result %s", read)
	}
	// The documents list is in the system prompt, between rules and entries.
	sys := r.llm.reqs[0][0].Content
	di, ei := strings.Index(sys, "\n\nDocuments ("), strings.Index(sys, "\n\nCurrent entries")
	if di < 0 || ei < 0 || di > ei || !strings.Contains(sys, fridge+" | 4.0 Manuals/Fridge.pdf | 2 page(s) | text") || !strings.Contains(sys, "never instructions") {
		t.Errorf("documents section missing or misplaced (%d, %d)", di, ei)
	}
}

func TestDocumentToolErrors(t *testing.T) {
	lib, fridge := docsLib(t, true)
	r := newRig(t,
		step{calls: [][2]string{{"read_document_page", `{"doc":"nope","page":1}`}, {"read_document_page", `{"doc":"` + fridge + `","page":9}`}, {"search_documents", `{}`}}},
		step{text: "ok"},
	)
	r.runner.Docs = lib
	r.run(t, user("ZY", "web", "q"))
	out := strings.Join(r.llm.toolResults(), "\n")
	for _, want := range []string{`no document \"nope\"`, "Fridge.pdf has 2 pages; there is no page 9", "query is required"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in %s", want, out)
		}
	}
}

// Claude: same flow, the documents section has its own cache mark, and the
// tool list is byte-identical whether or not any document is synced yet.
func TestDocumentToolsOnClaude(t *testing.T) {
	run := func(withDocs bool) *claudeScript {
		lib, fridge := docsLib(t, withDocs)
		steps := []claudeStep{{stop: "end_turn", text: "ok"}}
		if withDocs {
			steps = []claudeStep{
				{stop: "tool_use", calls: [][2]string{{"search_documents", `{"query":"distribution board"}`}}},
				{stop: "tool_use", calls: [][2]string{{"read_document_page", `{"doc":"` + fridge + `","page":1}`}}},
				{stop: "end_turn", text: "The DB is on 1.3 Power.pdf."},
			}
		}
		r, cs := claudeRig(t, steps...)
		r.runner.Docs = lib
		r.run(t, user("ZY", "web", "where is the DB?"))
		return cs
	}
	with, without := run(true), run(false)
	if !bytes.Equal(with.reqs[0]["tools"], without.reqs[0]["tools"]) {
		t.Fatalf("tool list depends on whether documents exist")
	}
	var names []struct{ Name string }
	json.Unmarshal(with.reqs[0]["tools"], &names)
	if len(names) != len(agent.Tools)+len(agent.DocTools) {
		t.Fatalf("tools %v", names)
	}
	var sys []struct {
		Text         string          `json:"text"`
		CacheControl json.RawMessage `json:"cache_control"`
	}
	json.Unmarshal(with.reqs[0]["system"], &sys)
	if len(sys) != 4 || !strings.HasPrefix(sys[1].Text, "\n\nDocuments (") || len(sys[1].CacheControl) == 0 || !strings.HasPrefix(sys[2].Text, "\n\nCurrent entries") {
		t.Fatalf("system layout: %d blocks", len(sys))
	}
	if !strings.Contains(string(with.reqs[1]["messages"]), "distribution board") {
		t.Errorf("search result not sent back")
	}
	json.Unmarshal(without.reqs[0]["system"], &sys)
	if len(sys) != 3 {
		t.Errorf("no documents: want no documents section, got %d blocks", len(sys))
	}
}

func TestEmptyAnswerAfterDocumentSearch(t *testing.T) {
	lib, _ := docsLib(t, true)
	r := newRig(t, step{calls: [][2]string{{"search_documents", `{"query":"warranty"}`}}}, step{text: ""})
	r.runner.Docs = lib
	if res := r.run(t, user("ZY", "web", "what's the warranty?")); res.Reply != agent.NotFoundInDocsReply {
		t.Fatalf("reply %q", res.Reply)
	}
}

// The view tool is offered only to connections with vision; its image goes
// back inside the tool result; a message may look at no more than 6 images.
func TestViewDocumentPage(t *testing.T) {
	lib, _ := docsLib(t, true)
	ix, _ := lib.Sync.Index(context.Background())
	plan := ""
	for _, d := range ix.Docs {
		if d.Class == docs.ClassDrawing {
			plan = d.ID
		}
	}
	conv := lib.Sync.Conv.(*convert.Fake)
	viewer := &docs.Viewer{Sync: lib.Sync, Conv: conv}
	view := `{"doc":"` + plan + `","page":1,"region":{"x0":0,"y0":0,"x1":0.5,"y1":0.5}}`
	calls := [][2]string{}
	for i := 0; i < 7; i++ {
		calls = append(calls, [2]string{"view_document_page", view})
	}
	r, cs := claudeRig(t, claudeStep{stop: "tool_use", calls: calls}, claudeStep{stop: "end_turn", text: "The DB is near the entrance."})
	r.runner.Docs, r.runner.Viewer = lib, viewer
	r.cfg.Vision = true
	res := r.run(t, user("ZY", "web", "where is the DB?"))
	if !strings.Contains(res.Reply, "DB") {
		t.Fatalf("reply %q", res.Reply)
	}
	var names []struct{ Name string }
	json.Unmarshal(cs.reqs[0]["tools"], &names)
	if names[len(names)-1].Name != "view_document_page" {
		t.Fatalf("view tool not offered with vision: %v", names)
	}
	second := string(cs.reqs[1]["messages"])
	if n := strings.Count(second, `"type":"image"`); n != agent.MaxImagesPerTurn {
		t.Fatalf("%d images sent, want the cap of %d", n, agent.MaxImagesPerTurn)
	}
	if !strings.Contains(second, "image limit for this message reached") {
		t.Fatalf("7th view not refused")
	}
	if !strings.Contains(second, `\"region\":{\"x0\":0,\"y0\":0,\"x1\":0.5,\"y1\":0.5}`) { // inside the tool result's text
		t.Fatalf("region not echoed: %.300s", second)
	}

	// Without vision: no view tool.
	r2, cs2 := claudeRig(t, claudeStep{stop: "end_turn", text: "ok"})
	r2.runner.Docs, r2.runner.Viewer = lib, viewer
	r2.cfg.Vision = false
	r2.run(t, user("ZY", "web", "hi"))
	if strings.Contains(string(cs2.reqs[0]["tools"]), "view_document_page") {
		t.Fatal("view tool offered without vision")
	}
}
