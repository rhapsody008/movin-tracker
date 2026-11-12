package entries

import (
	"slices"
	"sort"
	"strings"
)

// Filter is a structured query over entries. Its JSON names are the agent's
// search_entries tool arguments. Empty fields match anything.
// List fields match any of their values (Kinds, Rooms, Statuses) except
// Tags, where an entry must carry every listed tag.
type Filter struct {
	Kinds           []string `json:"kinds,omitempty"`
	Rooms           []string `json:"rooms,omitempty"`
	Statuses        []string `json:"statuses,omitempty"`
	Category        string   `json:"category,omitempty"`
	Tags            []string `json:"tags,omitempty"`
	Vendor          string   `json:"vendor,omitempty"` // case-insensitive substring
	Text            string   `json:"text,omitempty"`   // every word must appear somewhere
	DateFrom        string   `json:"date_from,omitempty"`
	DateTo          string   `json:"date_to,omitempty"`
	IncludeArchived bool     `json:"include_archived,omitempty"`
	// Milestone true keeps only milestones (flagged and done); false leaves
	// them out.
	Milestone *bool `json:"milestone,omitempty"`
	Limit     int   `json:"limit,omitempty"`
}

const (
	DefaultLimit = 50
	MaxLimit     = 200
)

// SearchResult holds the first Limit matches, newest update first, and how
// many matched in total.
type SearchResult struct {
	Entries []Entry `json:"entries"`
	Total   int     `json:"total"`
}

func lowerAll(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s = strings.ToLower(strings.Join(strings.Fields(s), " ")); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// query is a Filter normalised once for matching.
type query struct {
	f                            Filter
	kinds, rooms, statuses, tags []string
	category, vendor             string
	words                        []string
}

func newQuery(f Filter) query {
	return query{
		f:     f,
		kinds: lowerAll(f.Kinds), rooms: lowerAll(f.Rooms), statuses: lowerAll(f.Statuses), tags: lowerAll(f.Tags),
		category: strings.ToLower(strings.TrimSpace(f.Category)),
		vendor:   strings.ToLower(strings.TrimSpace(f.Vendor)),
		words:    strings.Fields(strings.ToLower(f.Text)),
	}
}

func (q query) matches(e Entry) bool {
	f := q.f
	switch {
	case e.Archived && !f.IncludeArchived,
		len(q.kinds) > 0 && !slices.Contains(q.kinds, e.Kind),
		len(q.rooms) > 0 && (e.Room == nil || !slices.Contains(q.rooms, *e.Room)),
		len(q.statuses) > 0 && !slices.Contains(q.statuses, e.Status),
		f.Milestone != nil && e.IsMilestone() != *f.Milestone,
		q.category != "" && e.Category != q.category,
		!hasAll(e.Tags, q.tags),
		q.vendor != "" && !strings.Contains(strings.ToLower(e.Vendor), q.vendor),
		!q.inDates(e):
		return false
	}
	if len(q.words) == 0 {
		return true
	}
	hay := haystack(e)
	for _, w := range q.words {
		if !strings.Contains(hay, w) {
			return false
		}
	}
	return true
}

// inDates checks the date range; dates are YYYY-MM-DD, so string order is
// date order. With no range, undated entries match too.
func (q query) inDates(e Entry) bool {
	from, to := q.f.DateFrom, q.f.DateTo
	if from == "" && to == "" {
		return true
	}
	return e.Date != nil && (from == "" || *e.Date >= from) && (to == "" || *e.Date <= to)
}

// Search runs f over the document. It never errors: bad values simply
// match nothing.
func (d *Doc) Search(f Filter) SearchResult {
	q := newQuery(f)
	limit := f.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}
	limit = min(limit, MaxLimit)
	var hits []Entry
	for _, e := range d.Entries {
		if q.matches(e) {
			hits = append(hits, e)
		}
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Updated > hits[j].Updated })
	out := SearchResult{Total: len(hits), Entries: []Entry{}}
	for i := 0; i < len(hits) && i < limit; i++ {
		out.Entries = append(out.Entries, hits[i].Clone())
	}
	return out
}

func hasAll(have, want []string) bool {
	for _, w := range want {
		if !slices.Contains(have, w) {
			return false
		}
	}
	return true
}

func haystack(e Entry) string {
	parts := []string{e.Title, e.Notes, e.Vendor, e.Category, e.Source, e.Kind, strings.Join(e.Tags, " ")}
	if e.Room != nil {
		parts = append(parts, *e.Room)
	}
	return strings.ToLower(strings.Join(parts, "\n"))
}
