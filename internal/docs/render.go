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
	pdfs  lru[[]byte]
	views lru[[]byte]
}

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
	v.views.put(key, png, 24)
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
	b, _, err := v.Sync.Store.Get(ctx, d.Key)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", d.Name(), err)
	}
	v.mu.Lock()
	v.pdfs.put(key, b, 3) // the largest PDF today is 14 MB
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

// lru is a tiny least-recently-used map (callers hold the lock).
type lru[T any] struct {
	keys []string
	vals map[string]T
}

func (c *lru[T]) get(k string) (T, bool) {
	v, ok := c.vals[k]
	if ok {
		c.touch(k)
	}
	return v, ok
}

func (c *lru[T]) put(k string, v T, max int) {
	if c.vals == nil {
		c.vals = map[string]T{}
	}
	if _, ok := c.vals[k]; !ok && len(c.keys) >= max {
		delete(c.vals, c.keys[0])
		c.keys = c.keys[1:]
	}
	c.vals[k] = v
	c.touch(k)
}

func (c *lru[T]) touch(k string) {
	for i, x := range c.keys {
		if x == k {
			c.keys = append(c.keys[:i], c.keys[i+1:]...)
			break
		}
	}
	c.keys = append(c.keys, k)
}
