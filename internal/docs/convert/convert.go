// Package convert turns PDFs into what the agent can use: page sizes, the
// text of each page (with word boxes for drawings) and PNG renders of a
// page or a region of it. Poppler runs the poppler command-line tools; Fake
// is for tests. Both satisfy the interfaces their users declare
// (docs.Converter for syncing, docs.Renderer for page views).
package convert

import (
	"errors"
	"fmt"

	"github.com/rhapsody008/movin-tracker/internal/docs"
)

// Region is part of a page (defined in docs so both packages share it).
type Region = docs.Region

// ErrBadPage is returned for a page number outside the document.
var ErrBadPage = errors.New("no such page")

// Words are kept for pages at least this big (0.95 × A3, as in docs.Classify).
const wordsMinArea = 0.95 * 842 * 1191

// MaxLongEdge caps renders: big enough to read a crop, small enough for a
// model's image input.
const MaxLongEdge = 2000

// pixelBox maps a region of a w×h-point page to a pdftocairo crop: the
// resolution (dpi) that makes the region's long edge longEdge pixels, and
// the crop's origin and size in pixels at that resolution.
func pixelBox(w, h float64, r Region, longEdge int) (dpi float64, x, y, cw, ch int) {
	rw, rh := (r.X1-r.X0)*w, (r.Y1-r.Y0)*h
	long := max(rw, rh)
	dpi = float64(longEdge) * 72 / long
	scale := dpi / 72
	x, y = int(r.X0*w*scale), int(r.Y0*h*scale)
	cw, ch = int(rw*scale+0.5), int(rh*scale+0.5)
	return
}

func checkPage(pages []docs.Page, n int) (docs.Page, error) {
	if n < 1 || n > len(pages) {
		return docs.Page{}, fmt.Errorf("%w %d (the document has %d)", ErrBadPage, n, len(pages))
	}
	return pages[n-1], nil
}
