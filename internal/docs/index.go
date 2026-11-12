// Package docs keeps the documents under docs/raw/ readable for the agent:
// an index of every document (docs/index.json), the text of each page
// (docs/text/<same path>.json) and, later, page images rendered on demand.
// The raw PDFs in the bucket stay the source of truth; everything here can
// be deleted and rebuilt by a sync.
package docs

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strings"
	"time"
)

// Key layout in the bucket (no prefix: dev and production share it).
const (
	RawPrefix  = "docs/raw/"  // ZY's uploads: the source of truth
	TextPrefix = "docs/text/" // per-page text, mirrors the raw path + ".json"
	IndexKey   = "docs/index.json"
	Schema     = 1
)

// Classes of document.
const (
	ClassText    = "text"    // a text layer on most pages: searchable
	ClassDrawing = "drawing" // A3 or larger pages: also viewable as images
	ClassScanned = "scanned" // mostly pages without text: a later phase
)

// Statuses of a document in the index.
const (
	StatusOK      = "ok"
	StatusFailed  = "failed"  // conversion failed; retried next sync
	StatusRemoved = "removed" // the raw file is gone; kept so links explain themselves
	StatusSkipped = "skipped" // not a document we read (Reason says why)
)

// ConvertVersion goes up when how documents are read or classified
// changes; documents read with an older version are read again at the next
// sync ("refreshed", which is not announced).
const ConvertVersion = 3 // 3: garbled text layers count as no text

// MinTextChars is how many non-space characters a page needs to count as
// having text; below it the page is treated as an image.
const MinTextChars = 100

// a3Area is the area of an A3 page in PDF points (842 x 1191); a drawing
// has a page at least about this big.
const a3Area = 842.0 * 1191.0

// Index is docs/index.json.
type Index struct {
	Schema   int    `json:"schema"`
	Docs     []Doc  `json:"docs"`
	LastSync *Sync  `json:"lastSync,omitempty"`
	Updated  string `json:"updated,omitempty"`
}

// Doc is one file under docs/raw/.
type Doc struct {
	ID        string `json:"id"`  // short, stable: what tools refer to
	Key       string `json:"key"` // full bucket key: the identity
	ETag      string `json:"etag"`
	Size      int64  `json:"size"`
	Pages     int    `json:"pages,omitempty"`
	Class     string `json:"class,omitempty"`
	Status    string `json:"status"`
	Reason    string `json:"reason,omitempty"`    // why skipped or failed
	TextPages int    `json:"textPages,omitempty"` // pages with at least MinTextChars
	Summary   string `json:"summary,omitempty"`   // one line, from the model
	SyncedAt  string `json:"syncedAt,omitempty"`
	Version   int    `json:"v,omitempty"` // ConvertVersion it was read with
	RemovedAt string `json:"removedAt,omitempty"`
	// Error is the last failed read (cleared by the next good one); a
	// readable document keeps its old record and status meanwhile.
	Error   string `json:"error,omitempty"`
	ErrorAt string `json:"errorAt,omitempty"`
}

// Sync is the outcome of one sync run, kept as lastSync.
type Sync struct {
	At        string `json:"at"`
	Reason    string `json:"reason"` // startup, daily, /sync, web
	Added     int    `json:"added"`
	Changed   int    `json:"changed"`
	Removed   int    `json:"removed"`
	Failed    int    `json:"failed"`
	Skipped   int    `json:"skipped"`
	Refreshed int    `json:"refreshed,omitempty"` // re-read for a new ConvertVersion
	Error     string `json:"error,omitempty"`
}

// Changes reports whether the run changed anything worth telling people.
func (s Sync) Changes() bool { return s.Added+s.Changed+s.Removed > 0 }

// Name is the file name without folders.
func (d Doc) Name() string { return path.Base(d.Key) }

// Folder is the folder path under docs/raw/ ("" at the top level).
func (d Doc) Folder() string {
	rel := strings.TrimPrefix(d.Key, RawPrefix)
	if i := strings.LastIndex(rel, "/"); i >= 0 {
		return rel[:i]
	}
	return ""
}

// TextKey is where the document's per-page text is stored.
func (d Doc) TextKey() string { return TextKeyFor(d.Key) }

// TextKeyFor maps docs/raw/<path> to docs/text/<path>.json.
func TextKeyFor(rawKey string) string {
	return TextPrefix + strings.TrimPrefix(rawKey, RawPrefix) + ".json"
}

// SkipReason says why a key under docs/raw/ is not read, or "" if it is.
func SkipReason(key string) string {
	name := path.Base(key)
	switch {
	case strings.HasSuffix(key, "/"):
		return "folder marker"
	case strings.HasPrefix(name, "._"):
		return "macOS metadata file, not a document"
	case !strings.EqualFold(path.Ext(name), ".pdf"):
		return "not a PDF (" + strings.ToLower(strings.TrimPrefix(path.Ext(name), ".")) + ")"
	}
	return ""
}

// Garbled reports whether a page's text layer is unusable: fonts without a
// proper character map come out as control characters and shifted letters
// ("Dimensions" → "'LPHQVLRQV"). Such pages count as having no text (found
// in one of ZY's manuals; OCR is the later phase for them).
func Garbled(text string) bool {
	chars, ctrl := 0, 0
	for _, r := range text {
		switch {
		case r == '\n' || r == '\t' || r == '\r' || r == '\f' || r == ' ':
		case r < 0x20:
			ctrl++
			chars++
		default:
			chars++
		}
	}
	if chars == 0 {
		return false
	}
	if float64(ctrl)/float64(chars) > 0.02 {
		return true
	}
	words, novowel := 0, 0
	for _, w := range strings.FieldsFunc(text, func(r rune) bool { return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') }) {
		if len(w) < 3 {
			continue
		}
		words++
		if !strings.ContainsAny(w, "aeiouyAEIOUY") {
			novowel++
		}
	}
	return words >= 10 && float64(novowel)/float64(words) > 0.3
}

// PageInfo is what classification needs to know about a page.
type PageInfo struct {
	W, H  float64 // points, as displayed (rotation applied)
	Chars int     // non-space characters of text
}

// Classify decides a document's class from its pages and counts the pages
// with text. A big sheet with some text is a drawing to look at; big pages
// with no text at all (a scanned leaflet) are a scan.
func Classify(pages []PageInfo) (class string, textPages int) {
	big := false
	for _, p := range pages {
		if p.Chars >= MinTextChars {
			textPages++
		}
		if p.W*p.H >= 0.95*a3Area {
			big = true
		}
	}
	switch {
	case len(pages) == 0:
		return ClassScanned, 0
	case big && textPages > 0:
		return ClassDrawing, textPages
	case textPages*2 < len(pages):
		return ClassScanned, textPages
	}
	return ClassText, textPages
}

// AssignID gives a key its short id: the first 8 hex digits of its SHA-256,
// with -2, -3… on the rare collision with an id another key already has.
// The same key always gets the same id within an index.
func AssignID(key string, taken map[string]string) string {
	sum := sha256.Sum256([]byte(key))
	base := hex.EncodeToString(sum[:4])
	id := base
	for n := 2; ; n++ {
		owner, used := taken[id]
		if !used || owner == key {
			return id
		}
		id = fmt.Sprintf("%s-%d", base, n)
	}
}

// Decode reads docs/index.json; an empty body is an empty index.
func Decode(b []byte) (*Index, error) {
	ix := &Index{Schema: Schema, Docs: []Doc{}}
	if len(b) == 0 {
		return ix, nil
	}
	if err := json.Unmarshal(b, ix); err != nil {
		return nil, fmt.Errorf("decode %s: %w", IndexKey, err)
	}
	if ix.Schema != Schema {
		return nil, fmt.Errorf("%s: schema %d, this build reads %d", IndexKey, ix.Schema, Schema)
	}
	if ix.Docs == nil {
		ix.Docs = []Doc{}
	}
	return ix, nil
}

// Encode writes the index with documents sorted by key.
func (ix *Index) Encode(now time.Time) ([]byte, error) {
	ix.Schema = Schema
	ix.Updated = now.UTC().Format(time.RFC3339)
	sort.Slice(ix.Docs, func(i, j int) bool { return ix.Docs[i].Key < ix.Docs[j].Key })
	return json.MarshalIndent(ix, "", "  ")
}

// ByKey returns the documents keyed by their bucket key.
func (ix *Index) ByKey() map[string]*Doc {
	m := make(map[string]*Doc, len(ix.Docs))
	for i := range ix.Docs {
		m[ix.Docs[i].Key] = &ix.Docs[i]
	}
	return m
}

// Find returns the document with this id, or nil.
func (ix *Index) Find(id string) *Doc {
	for i := range ix.Docs {
		if ix.Docs[i].ID == id {
			return &ix.Docs[i]
		}
	}
	return nil
}

// PageText is docs/text/<path>.json: the text of each page.
type PageText struct {
	Key   string `json:"key"`  // the raw document
	ETag  string `json:"etag"` // of the raw document this was made from
	Pages []Page `json:"pages"`
}

// Page is one page's size (as displayed) and text. Words are kept for
// drawings so a crop can say what is written inside it.
type Page struct {
	N     int     `json:"n"`
	W     float64 `json:"w"`
	H     float64 `json:"h"`
	Text  string  `json:"text"`
	Words []Word  `json:"words,omitempty"`
}

// Word is one word with its box in points, origin top-left, in the same
// rotated space as the rendered page.
type Word struct {
	T   string     `json:"t"`
	Box [4]float64 `json:"b"` // x0, y0, x1, y1
}

// Region is part of a page as fractions of its as-displayed width and
// height, origin top-left: {0, 0, 1, 1} is the whole page.
type Region struct {
	X0 float64 `json:"x0"`
	Y0 float64 `json:"y0"`
	X1 float64 `json:"x1"`
	Y1 float64 `json:"y1"`
}

// Valid reports whether the region is inside the page and not empty.
func (r Region) Valid() bool {
	return r.X0 >= 0 && r.Y0 >= 0 && r.X1 <= 1 && r.Y1 <= 1 && r.X1-r.X0 > 0.001 && r.Y1-r.Y0 > 0.001
}
