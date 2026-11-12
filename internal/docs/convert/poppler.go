package convert

import (
	"bytes"
	"context"
	"fmt"
	"html"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/docs"
)

// Poppler runs pdfinfo, pdftotext and pdftocairo as child processes: the
// PDF goes in on stdin, results come back on stdout, nothing is written to
// disk (the image's root filesystem is read-only). One call runs at a time,
// so a big render can't stack up memory; each is killed with its context.
type Poppler struct {
	// Timeout bounds one tool run (default 60 s).
	Timeout time.Duration
	// MaxOutput caps one tool's stdout (default 64 MiB).
	MaxOutput int

	mu sync.Mutex
}

func (p *Poppler) run(ctx context.Context, pdf []byte, name string, args ...string) ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	timeout := p.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin = bytes.NewReader(pdf)
	limit := p.MaxOutput
	if limit <= 0 {
		limit = 64 << 20
	}
	out := &capped{max: limit}
	var errb capped
	errb.max = 4096
	cmd.Stdout, cmd.Stderr = out, &errb
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("%s: %w", name, ctx.Err())
		}
		msg := strings.TrimSpace(errb.String())
		if i := strings.LastIndex(msg, "\n"); i >= 0 {
			msg = msg[i+1:]
		}
		return nil, fmt.Errorf("%s: %v: %s", name, err, msg)
	}
	if out.over {
		return nil, fmt.Errorf("%s: output larger than %d bytes", name, limit)
	}
	return out.Bytes(), nil
}

// capped is a buffer that stops growing at max and remembers it did.
type capped struct {
	bytes.Buffer
	max  int
	over bool
}

func (c *capped) Write(b []byte) (int, error) {
	if room := c.max - c.Len(); len(b) > room {
		c.over = true
		if room > 0 {
			c.Buffer.Write(b[:room])
		}
		return len(b), nil
	}
	return c.Buffer.Write(b)
}

var (
	sizeRe = regexp.MustCompile(`(?m)^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)`)
	rotRe  = regexp.MustCompile(`(?m)^Page\s+(\d+) rot:\s+(\d+)`)
	wordRe = regexp.MustCompile(`<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>`)
	pageRe = regexp.MustCompile(`<page width=`)
)

// sizes returns each page's as-displayed size (rotation applied).
func (p *Poppler) sizes(ctx context.Context, pdf []byte) ([][2]float64, error) {
	out, err := p.run(ctx, pdf, "pdfinfo", "-f", "1", "-l", "100000", "-")
	if err != nil {
		return nil, err
	}
	s := string(out)
	rot := map[int]int{}
	for _, m := range rotRe.FindAllStringSubmatch(s, -1) {
		n, _ := strconv.Atoi(m[1])
		r, _ := strconv.Atoi(m[2])
		rot[n] = r
	}
	var sizes [][2]float64
	for _, m := range sizeRe.FindAllStringSubmatch(s, -1) {
		n, _ := strconv.Atoi(m[1])
		w, _ := strconv.ParseFloat(m[2], 64)
		h, _ := strconv.ParseFloat(m[3], 64)
		if r := rot[n] % 180; r == 90 {
			w, h = h, w
		}
		sizes = append(sizes, [2]float64{w, h})
	}
	if len(sizes) == 0 {
		return nil, fmt.Errorf("pdfinfo: no pages found")
	}
	return sizes, nil
}

func (p *Poppler) Text(ctx context.Context, pdf []byte) ([]docs.Page, error) {
	sizes, err := p.sizes(ctx, pdf)
	if err != nil {
		return nil, err
	}
	out, err := p.run(ctx, pdf, "pdftotext", "-layout", "-enc", "UTF-8", "-", "-")
	if err != nil {
		return nil, err
	}
	texts := strings.Split(string(out), "\f") // one form feed after each page
	pages := make([]docs.Page, len(sizes))
	big := false
	for i, s := range sizes {
		pages[i] = docs.Page{N: i + 1, W: s[0], H: s[1]}
		if i < len(texts) {
			pages[i].Text = tidy(texts[i])
		}
		if s[0]*s[1] >= wordsMinArea {
			big = true
		}
	}
	if big {
		if err := p.words(ctx, pdf, pages); err != nil {
			return nil, err
		}
	}
	return pages, nil
}

// words fills word boxes for the big pages. pdftotext reports them in the
// rotated (as-displayed) space, matching the renders (spike 1.5.0).
func (p *Poppler) words(ctx context.Context, pdf []byte, pages []docs.Page) error {
	out, err := p.run(ctx, pdf, "pdftotext", "-bbox-layout", "-enc", "UTF-8", "-", "-")
	if err != nil {
		return err
	}
	s := string(out)
	starts := pageRe.FindAllStringIndex(s, -1)
	for i, st := range starts {
		if i >= len(pages) || pages[i].W*pages[i].H < wordsMinArea {
			continue
		}
		end := len(s)
		if i+1 < len(starts) {
			end = starts[i+1][0]
		}
		for _, m := range wordRe.FindAllStringSubmatch(s[st[0]:end], -1) {
			var b [4]float64
			for k := 0; k < 4; k++ {
				b[k], _ = strconv.ParseFloat(m[k+1], 64)
			}
			if t := html.UnescapeString(m[5]); strings.TrimSpace(t) != "" {
				pages[i].Words = append(pages[i].Words, docs.Word{T: t, Box: b})
			}
		}
	}
	return nil
}

// tidy trims trailing spaces on each line and drops runs of blank lines.
func tidy(s string) string {
	lines := strings.Split(s, "\n")
	out := lines[:0]
	blank := 0
	for _, l := range lines {
		l = strings.TrimRight(l, " \t\r")
		if l == "" {
			blank++
			if blank > 1 {
				continue
			}
		} else {
			blank = 0
		}
		out = append(out, l)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

func (p *Poppler) Render(ctx context.Context, pdf []byte, page int, region *Region, longEdge int) ([]byte, error) {
	if longEdge <= 0 || longEdge > MaxLongEdge {
		longEdge = MaxLongEdge
	}
	sizes, err := p.sizes(ctx, pdf)
	if err != nil {
		return nil, err
	}
	if page < 1 || page > len(sizes) {
		return nil, fmt.Errorf("%w %d (the document has %d)", ErrBadPage, page, len(sizes))
	}
	pg := strconv.Itoa(page)
	if region == nil {
		return p.run(ctx, pdf, "pdftocairo", "-png", "-singlefile", "-f", pg, "-l", pg, "-scale-to", strconv.Itoa(longEdge), "-", "-")
	}
	if !region.Valid() {
		return nil, fmt.Errorf("region must be inside the page: 0 ≤ x0 < x1 ≤ 1 and 0 ≤ y0 < y1 ≤ 1")
	}
	w, h := sizes[page-1][0], sizes[page-1][1]
	dpi, x, y, cw, ch := pixelBox(w, h, *region, longEdge)
	// pdftocairo renders only the cropped area, so memory stays flat at any
	// zoom (pdftoppm would rasterise the whole page first; spike 1.5.0).
	return p.run(ctx, pdf, "pdftocairo", "-png", "-singlefile", "-f", pg, "-l", pg,
		"-r", strconv.FormatFloat(dpi, 'f', 2, 64),
		"-x", strconv.Itoa(x), "-y", strconv.Itoa(y), "-W", strconv.Itoa(cw), "-H", strconv.Itoa(ch), "-", "-")
}

var (
	_ docs.Converter = (*Poppler)(nil)
	_ docs.Renderer  = (*Poppler)(nil)
)
