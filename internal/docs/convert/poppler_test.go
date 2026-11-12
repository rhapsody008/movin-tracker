package convert

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func needPoppler(t *testing.T) {
	t.Helper()
	for _, tool := range []string{"pdfinfo", "pdftotext", "pdftocairo"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s not installed", tool)
		}
	}
}

func sample(t *testing.T) []byte {
	b, err := os.ReadFile("testdata/sample.pdf")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func pngSize(t *testing.T, b []byte) (int, int) {
	t.Helper()
	if len(b) < 24 || !bytes.HasPrefix(b, []byte("\x89PNG")) {
		t.Fatalf("not a PNG (%d bytes)", len(b))
	}
	return int(binary.BigEndian.Uint32(b[16:20])), int(binary.BigEndian.Uint32(b[20:24]))
}

func TestPopplerText(t *testing.T) {
	needPoppler(t)
	p := &Poppler{}
	pages, err := p.Text(context.Background(), sample(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 3 {
		t.Fatalf("pages %d", len(pages))
	}
	// Page 1: A4 text, no word boxes (not a drawing-sized page).
	if pages[0].W != 595 || pages[0].H != 842 || !strings.Contains(pages[0].Text, "Kitchen countertop: sintered stone") || len(pages[0].Words) != 0 {
		t.Errorf("page 1 %+v", pages[0])
	}
	// Page 2: A3 rotated 90 → displayed landscape, with word boxes in that space.
	p2 := pages[1]
	if p2.W != 1191 || p2.H != 842 || !strings.Contains(p2.Text, "BALCONY") {
		t.Errorf("page 2 size %vx%v text %q", p2.W, p2.H, p2.Text)
	}
	found := false
	for _, w := range p2.Words {
		if w.T == "BALCONY" {
			found = true
			if w.Box[2] > p2.W || w.Box[3] > p2.H || w.Box[0] < 0 || w.Box[0] >= w.Box[2] {
				t.Errorf("BALCONY box %v outside the %vx%v page", w.Box, p2.W, p2.H)
			}
		}
	}
	if !found {
		t.Errorf("no BALCONY word on page 2: %+v", p2.Words)
	}
	// Page 3: blank.
	if pages[2].Text != "" {
		t.Errorf("page 3 text %q", pages[2].Text)
	}
}

func TestPopplerRender(t *testing.T) {
	needPoppler(t)
	p := &Poppler{}
	ctx := context.Background()
	pdf := sample(t)
	png, err := p.Render(ctx, pdf, 2, nil, 800)
	if err != nil {
		t.Fatal(err)
	}
	if w, h := pngSize(t, png); w != 800 || h < 560 || h > 570 { // 1191x842 → 800x566
		t.Errorf("overview %dx%d", w, h)
	}
	// A quarter of the page in each direction, scaled to a 400 px long edge.
	png, err = p.Render(ctx, pdf, 2, &Region{X0: 0.5, Y0: 0, X1: 1, Y1: 0.5}, 400)
	if err != nil {
		t.Fatal(err)
	}
	if w, h := pngSize(t, png); w != 400 || h < 280 || h > 285 {
		t.Errorf("crop %dx%d", w, h)
	}
	if _, err := p.Render(ctx, pdf, 9, nil, 400); !errors.Is(err, ErrBadPage) {
		t.Errorf("page 9: %v", err)
	}
	if _, err := p.Render(ctx, pdf, 1, &Region{X0: 0.5, Y0: 0, X1: 0.4, Y1: 1}, 400); err == nil {
		t.Errorf("inverted region accepted")
	}
	if _, err := p.Text(ctx, []byte("not a pdf")); err == nil {
		t.Errorf("garbage accepted")
	}
}

func TestPopplerTimeoutKillsTheTool(t *testing.T) {
	needPoppler(t)
	// A fake pdfinfo that hangs, first on PATH.
	dir := t.TempDir()
	script := filepath.Join(dir, "pdfinfo")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	p := &Poppler{TextTimeout: 300 * time.Millisecond} // pdfinfo is a text-side tool
	start := time.Now()
	_, err := p.Text(context.Background(), sample(t))
	if err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err %v", err)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("took %v", d)
	}
}

func TestPixelBox(t *testing.T) {
	// The right half of an A1 landscape sheet (2384x1684 pt) is 1192x1684 pt:
	// its long edge is the height, so that becomes 1568 px.
	dpi, x, y, w, h := pixelBox(2384, 1684, Region{X0: 0.5, Y0: 0, X1: 1, Y1: 1}, 1568)
	if h != 1568 || w < 1108 || w > 1111 || x < 1108 || x > 1111 || y != 0 || dpi < 67.0 || dpi > 67.1 {
		t.Fatalf("dpi %.2f box %d,%d %dx%d", dpi, x, y, w, h)
	}
	if !(Region{X0: 0, Y0: 0, X1: 1, Y1: 1}).Valid() || (Region{X0: 0.2, Y0: 0, X1: 0.2, Y1: 1}).Valid() || (Region{X0: -0.1, Y0: 0, X1: 1, Y1: 1}).Valid() {
		t.Fatal("Valid()")
	}
}

// Real documents only when a path is given (never committed).
func TestPopplerRealSample(t *testing.T) {
	path := os.Getenv("MOVIN_SAMPLE_PDF")
	if path == "" {
		t.Skip("set MOVIN_SAMPLE_PDF to a real PDF to run")
	}
	needPoppler(t)
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	pages, err := (&Poppler{}).Text(context.Background(), b)
	if err != nil || len(pages) == 0 {
		t.Fatalf("%v %d", err, len(pages))
	}
	t.Logf("%d pages, page 1 %vx%v, %d chars, %d words", len(pages), pages[0].W, pages[0].H, len(pages[0].Text), len(pages[0].Words))
}

// One run at a time, but a caller whose context ends stops waiting for its
// turn (a chat view isn't stuck behind a slow sync run).
func TestPopplerWaitRespectsContext(t *testing.T) {
	needPoppler(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "pdfinfo"), []byte("#!/bin/sh\nsleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	p := &Poppler{TextTimeout: 3 * time.Second}
	go p.Text(context.Background(), sample(t)) // holds the slot for 3 s
	time.Sleep(200 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := p.Render(ctx, sample(t), 1, nil, 200)
	if err == nil || !strings.Contains(err.Error(), "waiting for the PDF tools") || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err %v", err)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("waited %v for a slot after its context ended", d)
	}
}

func TestPopplerOutputCap(t *testing.T) {
	needPoppler(t)
	if _, err := (&Poppler{MaxOutput: 50}).Text(context.Background(), sample(t)); err == nil || !strings.Contains(err.Error(), "output larger than 50 bytes") {
		t.Fatalf("err %v", err)
	}
	if DefaultMaxOutput != 16<<20 || DefaultTextTimeout != 30*time.Second {
		t.Fatal("defaults changed")
	}
}
