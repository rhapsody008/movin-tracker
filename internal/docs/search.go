package docs

import (
	"context"
	"math"
	"sort"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

// Library answers questions about the documents' text: a BM25 index over
// pages, built from docs/text/ on first use and rebuilt after each sync.
// Scanned documents (no text layer) are left out until the OCR phase.
type Library struct {
	Sync *Syncer

	mu    sync.Mutex
	built *Index // the index the search data was built from
	pages []indexedPage
	df    map[string]int
	avg   float64
}

type indexedPage struct {
	doc   Doc
	n     int
	text  string
	tf    map[string]int
	terms int
}

// Hit is one search result.
type Hit struct {
	Doc     string  `json:"doc"`  // id
	Name    string  `json:"name"` // file name
	Folder  string  `json:"folder,omitempty"`
	Page    int     `json:"page"`
	Score   float64 `json:"score"`
	Snippet string  `json:"snippet"`
}

// SearchOptions narrows a search.
type SearchOptions struct {
	Doc    string // document id
	Folder string // folder under docs/raw/ (prefix match, case-insensitive)
	Limit  int    // default 8, max 20
}

const (
	bm25K1 = 1.2
	bm25B  = 0.75
)

// ensure builds the search data for the current index if it is stale.
func (l *Library) ensure(ctx context.Context) error {
	ix, err := l.Sync.Index(ctx)
	if err != nil {
		return err
	}
	l.mu.Lock()
	fresh := l.built == ix
	l.mu.Unlock()
	if fresh {
		return nil
	}
	var pages []indexedPage
	df := map[string]int{}
	total := 0
	for _, d := range ix.Docs {
		if d.Status != StatusOK || d.Class == ClassScanned {
			continue
		}
		pt, err := l.Sync.PageText(ctx, d)
		if err != nil {
			l.Sync.Log.Warn("document text unreadable; left out of search", "key", d.Key, "err", err)
			continue
		}
		for _, p := range pt.Pages {
			toks := tokens(p.Text)
			if len(toks) == 0 {
				continue
			}
			tf := map[string]int{}
			for _, t := range toks {
				tf[t]++
			}
			for t := range tf {
				df[t]++
			}
			total += len(toks)
			pages = append(pages, indexedPage{doc: d, n: p.N, text: p.Text, tf: tf, terms: len(toks)})
		}
	}
	avg := 0.0
	if len(pages) > 0 {
		avg = float64(total) / float64(len(pages))
	}
	l.mu.Lock()
	l.built, l.pages, l.df, l.avg = ix, pages, df, avg
	l.mu.Unlock()
	return nil
}

// Search ranks pages by BM25 for the query's words.
func (l *Library) Search(ctx context.Context, query string, o SearchOptions) ([]Hit, error) {
	if err := l.ensure(ctx); err != nil {
		return nil, err
	}
	limit := o.Limit
	if limit <= 0 {
		limit = 8
	}
	limit = min(limit, 20)
	q := uniq(tokens(query))
	l.mu.Lock()
	defer l.mu.Unlock()
	n := float64(len(l.pages))
	folder := strings.ToLower(strings.Trim(o.Folder, "/"))
	var hits []Hit
	for _, p := range l.pages {
		if o.Doc != "" && p.doc.ID != o.Doc {
			continue
		}
		if folder != "" && !strings.HasPrefix(strings.ToLower(p.doc.Folder()), folder) {
			continue
		}
		score := 0.0
		for _, t := range q {
			f := float64(p.tf[t])
			if f == 0 {
				continue
			}
			idf := math.Log(1 + (n-float64(l.df[t])+0.5)/(float64(l.df[t])+0.5))
			score += idf * f * (bm25K1 + 1) / (f + bm25K1*(1-bm25B+bm25B*float64(p.terms)/l.avg))
		}
		if score > 0 {
			hits = append(hits, Hit{Doc: p.doc.ID, Name: p.doc.Name(), Folder: p.doc.Folder(), Page: p.n, Score: math.Round(score*100) / 100, Snippet: snippet(p.text, q)})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		if hits[i].Name != hits[j].Name {
			return hits[i].Name < hits[j].Name
		}
		return hits[i].Page < hits[j].Page
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits, nil
}

// Page returns one page of a document in the current index, or ok=false.
func (l *Library) Page(ctx context.Context, docID string, n int) (Doc, Page, bool, error) {
	ix, err := l.Sync.Index(ctx)
	if err != nil {
		return Doc{}, Page{}, false, err
	}
	d := ix.Find(docID)
	if d == nil || d.Status != StatusOK {
		return Doc{}, Page{}, false, nil
	}
	pt, err := l.Sync.PageText(ctx, *d)
	if err != nil {
		return *d, Page{}, false, err
	}
	for _, p := range pt.Pages {
		if p.N == n {
			return *d, p, true, nil
		}
	}
	return *d, Page{}, false, nil
}

var stopwords = map[string]bool{
	"the": true, "a": true, "an": true, "and": true, "or": true, "of": true, "to": true, "in": true, "on": true,
	"for": true, "is": true, "are": true, "be": true, "with": true, "by": true, "it": true, "at": true, "as": true,
	"this": true, "that": true, "from": true, "what": true, "where": true, "how": true, "do": true, "does": true,
	"our": true, "we": true, "my": true, "i": true, "you": true, "your": true, "can": true, "which": true,
}

// tokens lowercases, splits on anything but letters and digits, drops
// stopwords and folds simple plurals ("sockets" finds "socket").
func tokens(s string) []string {
	var out []string
	for _, f := range strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if stopwords[f] {
			continue
		}
		out = append(out, stem(f))
	}
	return out
}

func stem(t string) string {
	switch {
	case len(t) > 4 && strings.HasSuffix(t, "ies"):
		return t[:len(t)-3] + "y"
	case len(t) > 3 && strings.HasSuffix(t, "s") && !strings.HasSuffix(t, "ss") && !strings.HasSuffix(t, "us"):
		return t[:len(t)-1]
	}
	return t
}

func uniq(ts []string) []string {
	seen := map[string]bool{}
	out := ts[:0:0]
	for _, t := range ts {
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

// snippet returns about 240 characters around the first query word on the
// page, whitespace collapsed.
func snippet(text string, q []string) string {
	r := []rune(strings.Join(strings.Fields(text), " "))
	// Lowercase rune by rune so positions match r exactly (lowercasing a
	// string can change its byte length, e.g. Ⱥ → ⱥ).
	low := make([]rune, len(r))
	for i, c := range r {
		low[i] = unicode.ToLower(c)
	}
	lows := string(low)
	at := -1
	for _, t := range q {
		if i := strings.Index(lows, t); i >= 0 {
			if ri := utf8.RuneCountInString(lows[:i]); at < 0 || ri < at {
				at = ri
			}
		}
	}
	if at < 0 {
		at = 0
	}
	start := max(0, at-80)
	end := min(len(r), start+240)
	out := string(r[start:end])
	if start > 0 {
		out = "…" + out
	}
	if end < len(r) {
		out += "…"
	}
	return out
}
