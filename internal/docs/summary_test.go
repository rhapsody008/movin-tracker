package docs_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/docs"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/settings"
	"github.com/rhapsody008/movin-tracker/internal/testutil"
)

type fakeSummaries struct {
	mu    sync.Mutex
	calls []string
	fail  bool
}

func (f *fakeSummaries) Summarise(_ context.Context, d docs.Doc, text string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, d.Name())
	if f.fail {
		return "", errors.New("model down")
	}
	return "About " + d.Name(), nil
}

func (f *fakeSummaries) n() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.calls) }

func TestSummaries(t *testing.T) {
	r := newRig(t)
	sum := &fakeSummaries{fail: true}
	r.sync.Summarise = sum
	r.conv.Pages["pdf-scan"] = []docs.Page{{N: 1, W: 595, H: 842}}
	r.put(t, manual, "pdf-manual-v1")
	r.put(t, "docs/raw/scan.pdf", "pdf-scan")

	// The model is down: the document is still synced, without a summary.
	r.run(t)
	if d := r.doc(t, manual); d.Status != docs.StatusOK || d.Summary != "" || sum.n() != 1 {
		t.Fatalf("down: %+v calls %d", d, sum.n())
	}
	// Next sync: one retry for the missing summary, no reconversion; never for scans.
	sum.fail = false
	calls := r.conv.CallCount()
	r.run(t)
	if d := r.doc(t, manual); d.Summary != "About Fridge.pdf" || sum.n() != 2 || r.conv.CallCount() != calls {
		t.Fatalf("retry: %+v calls %d conv %d→%d", d, sum.n(), calls, r.conv.CallCount())
	}
	// Unchanged with a summary: no model call.
	r.run(t)
	if sum.n() != 2 {
		t.Fatalf("unchanged document summarised again (%d calls)", sum.n())
	}
	// A new version gets a new summary.
	r.put(t, manual, "pdf-manual-v2")
	r.run(t)
	if sum.n() != 3 {
		t.Fatalf("changed document: %d calls", sum.n())
	}
}

func TestLLMSummariser(t *testing.T) {
	var got struct {
		Messages []struct{ Role, Content string } `json:"messages"`
		Stream   bool                             `json:"stream"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&got)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"\"SMEG fridge manual: settings, defrosting and cleaning.\"\nSecond line."}}]}`))
	}))
	defer srv.Close()
	env := settings.Defaults
	env.BaseURL, env.Model = srv.URL+"/v1", "m"
	sets, _ := settings.NewService(objstore.NewMemory(), env, "", testutil.Logger(nil))
	s := &docs.LLMSummariser{Settings: sets}
	out, err := s.Summarise(context.Background(), docs.Doc{Key: "docs/raw/4.0 Manuals/Fridge.pdf"}, "Defrosting…")
	if err != nil || out != "SMEG fridge manual: settings, defrosting and cleaning." {
		t.Fatalf("%q %v", out, err)
	}
	if got.Stream || len(got.Messages) != 2 || !strings.Contains(got.Messages[1].Content, "File: 4.0 Manuals/Fridge.pdf") || !strings.Contains(got.Messages[0].Content, "no personal details") {
		t.Fatalf("request %+v", got)
	}
	// No connection configured: an error, not a call.
	empty, _ := settings.NewService(objstore.NewMemory(), settings.Defaults, "", testutil.Logger(nil))
	if _, err := (&docs.LLMSummariser{Settings: empty}).Summarise(context.Background(), docs.Doc{Key: "docs/raw/x.pdf"}, "t"); err == nil {
		t.Fatal("want an error without a connection")
	}
}
