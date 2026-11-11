package server_test

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/docs"
	"github.com/rhapsody008/movin-tracker/internal/docs/convert"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/server"
	"github.com/rhapsody008/movin-tracker/internal/testutil"
)

func TestDocsOff(t *testing.T) {
	e := setup(t, objstore.NewMemory(), nil)
	if code, m, _ := e.do(t, "GET", "/api/docs", ""); code != 200 || m["on"] != false {
		t.Fatalf("off: %d %v", code, m)
	}
	if code, _, _ := e.do(t, "POST", "/api/docs/sync", ""); code != 404 {
		t.Fatalf("sync when off: %d", code)
	}
}

func TestDocsListSyncAndEvent(t *testing.T) {
	store := objstore.NewMemory()
	pad := strings.Repeat(" words on the page", 10)
	conv := &convert.Fake{Pages: map[string][]docs.Page{"pdf-1": {{N: 1, W: 595, H: 842, Text: "Manual" + pad}}}, Delay: 150 * time.Millisecond}
	syncer := &docs.Syncer{Store: store, Conv: conv, Log: testutil.Logger(nil)}
	e := setup(t, store, func(s *server.Server) { s.Docs = syncer })
	ctx := context.Background()
	store.PutBlob(ctx, "docs/raw/4.0 Manuals/Fridge.pdf", []byte("pdf-1"), "application/pdf")
	store.PutBlob(ctx, "docs/raw/4.0 Manuals/._Fridge.pdf", []byte("x"), "application/octet-stream")

	// Listen for the docs event first.
	req, _ := http.NewRequest("GET", e.srv.URL+"/api/events", nil)
	req.Header.Set("X-Forwarded-Email", "zy@example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	got := make(chan map[string]any, 4)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		kind := ""
		for sc.Scan() {
			if k, ok := strings.CutPrefix(sc.Text(), "event: "); ok {
				kind = k
			}
			if d, ok := strings.CutPrefix(sc.Text(), "data: "); ok && kind == "docs" {
				var m map[string]any
				json.Unmarshal([]byte(d), &m)
				got <- m
			}
		}
	}()

	code, m, raw := e.do(t, "POST", "/api/docs/sync", "")
	if code != 202 || m["started"] != true {
		t.Fatalf("sync: %d %s", code, raw)
	}
	time.Sleep(30 * time.Millisecond)
	if code, m, _ := e.do(t, "POST", "/api/docs/sync", ""); code != 202 || m["joined"] != true {
		t.Fatalf("second sync should join: %d %v", code, m)
	}
	select {
	case v := <-got:
		ds := v["docs"].([]any)
		if v["on"] != true || len(ds) != 2 || v["running"] != false {
			t.Fatalf("docs event %v", v)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no docs event after the sync")
	}
	if conv.CallCount() != 1 {
		t.Fatalf("converter ran %d times; the second request should have joined", conv.CallCount())
	}
	code, m, _ = e.do(t, "GET", "/api/docs", "")
	if code != 200 {
		t.Fatalf("list %d", code)
	}
	var fridge map[string]any
	for _, d := range m["docs"].([]any) {
		if d.(map[string]any)["name"] == "Fridge.pdf" {
			fridge = d.(map[string]any)
		}
	}
	if fridge == nil || fridge["folder"] != "4.0 Manuals" || fridge["status"] != "ok" || fridge["class"] != "text" || m["lastSync"].(map[string]any)["reason"] != "web" {
		t.Fatalf("list %v", m)
	}
}
