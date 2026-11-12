package docs

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// Renderer draws PDF pages (internal/docs/convert.Poppler).
type Renderer interface {
	Render(ctx context.Context, pdf []byte, page int, region *Region, longEdge int) ([]byte, error)
}

// ViewEdge is the long edge of a view in pixels: enough to read room names
// on an overview and socket labels on a crop, and a size models take well.
const ViewEdge = 1568

// MaxViewWords caps the words returned with a view.
const MaxViewWords = 300

// MaxPDFBytes caps the PDFs the app reads into memory (to convert or to
// view): the app runs in 256 MiB and the largest PDF today is 14 MB.
const MaxPDFBytes = 32 << 20

// ErrNotViewable is returned for documents that can't be shown.
var ErrNotViewable = errors.New("not viewable")

// Viewer renders document pages on demand (nothing is pre-rendered or
// stored): the raw PDF is read once and kept for a few documents, and
// recent renders are kept too, so an overview followed by crops of the same
// sheet reads the bucket once.
type Viewer struct {
	Sync *Syncer
	Conv Renderer

	mu    sync.Mutex
	pdfs  byteLRU
	views byteLRU
}

// Cache limits: a few PDFs (the largest today is 14 MB) and a couple of
// dozen renders (each 0.1–1 MB), bounded in bytes so big uploads can't
// push the app past its memory limit.
const (
	maxCachedPDFs     = 3
	maxCachedPDFBytes = 32 << 20
	maxPDFToCache     = 16 << 20 // bigger PDFs are read again each time
	maxCachedViews    = 24
	maxCachedViewByte = 16 << 20
)

// View is one rendered page or region.
type View struct {
	Doc    Doc
	Page   int
	Region *Region
	PNG    []byte
	Words  []string // the words inside the region (drawings only)
	W, H   float64  // the page, in points as displayed
}

// View renders page n of document id, the whole page or a region of it.
func (v *Viewer) View(ctx context.Context, id string, n int, region *Region) (View, error) {
	ix, err := v.Sync.Index(ctx)
	if err != nil {
		return View{}, err
	}
	d := ix.Find(id)
	if d == nil || d.Status != StatusOK {
		return View{}, fmt.Errorf("%w: no document %q", ErrNotViewable, id)
	}
	if n < 1 || n > d.Pages {
		return View{}, fmt.Errorf("%w: %s has %d pages; there is no page %d", ErrNotViewable, d.Name(), d.Pages, n)
	}
	if region != nil && !region.Valid() {
		return View{}, fmt.Errorf("region must be inside the page: 0 ≤ x0 < x1 ≤ 1 and 0 ≤ y0 < y1 ≤ 1")
	}
	out := View{Doc: *d, Page: n, Region: region}
	if pt, err := v.Sync.PageText(ctx, *d); err == nil && n <= len(pt.Pages) {
		p := pt.Pages[n-1]
		out.W, out.H = p.W, p.H
		out.Words = wordsIn(p, region)
	}
	key := fmt.Sprintf("%s|%s|%d|%v", d.Key, d.ETag, n, region)
	v.mu.Lock()
	png, ok := v.views.get(key)
	v.mu.Unlock()
	if ok {
		out.PNG = png
		return out, nil
	}
	pdf, err := v.pdf(ctx, *d)
	if err != nil {
		return View{}, err
	}
	png, err = v.Conv.Render(ctx, pdf, n, region, ViewEdge)
	if err != nil {
		return View{}, err
	}
	v.mu.Lock()
	v.views.put(key, png, maxCachedViews, maxCachedViewByte)
	v.mu.Unlock()
	out.PNG = png
	return out, nil
}

func (v *Viewer) pdf(ctx context.Context, d Doc) ([]byte, error) {
	key := d.Key + "|" + d.ETag
	v.mu.Lock()
	b, ok := v.pdfs.get(key)
	v.mu.Unlock()
	if ok {
		return b, nil
	}
	if d.Size > MaxPDFBytes {
		return nil, fmt.Errorf("%w: %s is too large to view (%d MB; the limit is %d MB)", ErrNotViewable, d.Name(), d.Size>>20, MaxPDFBytes>>20)
	}
	b, etag, err := v.Sync.Store.Get(ctx, d.Key)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", d.Name(), err)
	}
	if etag != d.ETag {
		// A newer upload the index hasn't read yet (or failed to read): its
		// pages wouldn't match the stored text and word boxes.
		return nil, fmt.Errorf("%w: %s was replaced and is waiting to be re-read; try again after the next sync (/sync)", ErrNotViewable, d.Name())
	}
	v.mu.Lock()
	if len(b) <= maxPDFToCache {
		v.pdfs.put(key, b, maxCachedPDFs, maxCachedPDFBytes)
	}
	v.mu.Unlock()
	return b, nil
}

// wordsIn returns the words whose centre lies inside the region (all words
// without one), in reading order as extracted, capped.
func wordsIn(p Page, r *Region) []string {
	var out []string
	for _, w := range p.Words {
		if r != nil && p.W > 0 && p.H > 0 {
			cx, cy := (w.Box[0]+w.Box[2])/2/p.W, (w.Box[1]+w.Box[3])/2/p.H
			if cx < r.X0 || cx > r.X1 || cy < r.Y0 || cy > r.Y1 {
				continue
			}
		}
		out = append(out, w.T)
		if len(out) == MaxViewWords {
			break
		}
	}
	return out
}

// byteLRU is a small least-recently-used cache of byte slices, bounded by
// entries and by total bytes (callers hold the lock).
type byteLRU struct {
	keys  []string
	vals  map[string][]byte
	bytes int
}

func (c *byteLRU) get(k string) ([]byte, bool) {
	v, ok := c.vals[k]
	if ok {
		c.touch(k)
	}
	return v, ok
}

func (c *byteLRU) put(k string, v []byte, maxEntries, maxBytes int) {
	if len(v) > maxBytes {
		return
	}
	if c.vals == nil {
		c.vals = map[string][]byte{}
	}
	if old, ok := c.vals[k]; ok {
		c.bytes -= len(old)
		c.drop(k)
	}
	for len(c.keys) > 0 && (len(c.keys) >= maxEntries || c.bytes+len(v) > maxBytes) {
		oldest := c.keys[0]
		c.bytes -= len(c.vals[oldest])
		delete(c.vals, oldest)
		c.keys = c.keys[1:]
	}
	c.vals[k] = v
	c.bytes += len(v)
	c.keys = append(c.keys, k)
}

func (c *byteLRU) touch(k string) {
	c.drop(k)
	c.keys = append(c.keys, k)
}

func (c *byteLRU) drop(k string) {
	for i, x := range c.keys {
		if x == k {
			c.keys = append(c.keys[:i], c.keys[i+1:]...)
			return
		}
	}
}

// Size reports the cached PDFs and renders (entries, bytes), for tests.
func (v *Viewer) Size() (pdfs, pdfBytes, views, viewBytes int) {
	v.mu.Lock()
	defer v.mu.Unlock()
	return len(v.pdfs.keys), v.pdfs.bytes, len(v.views.keys), v.views.bytes
}
