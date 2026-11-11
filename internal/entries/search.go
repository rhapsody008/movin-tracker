package entries

import (
	"slices"
	"sort"
	"strings"
)

// Filter is a structured query over entries. Empty fields match anything.
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
	DateFrom        string   `json:"dateFrom,omitempty"`
	DateTo          string   `json:"dateTo,omitempty"`
	IncludeArchived bool     `json:"includeArchived,omitempty"`
	Limit           int      `json:"limit,omitempty"`
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

// Search runs f over the document. It never errors: bad values simply
// match nothing.
func (d *Doc) Search(f Filter) SearchResult {
	kinds, rooms, statuses, tags := lowerAll(f.Kinds), lowerAll(f.Rooms), lowerAll(f.Statuses), lowerAll(f.Tags)
	category := strings.ToLower(strings.TrimSpace(f.Category))
	vendor := strings.ToLower(strings.TrimSpace(f.Vendor))
	words := strings.Fields(strings.ToLower(f.Text))
	limit := f.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}
	limit = min(limit, MaxLimit)

	var hits []Entry
	for _, e := range d.Entries {
		if e.Archived && !f.IncludeArchived {
			continue
		}
		if len(kinds) > 0 && !slices.Contains(kinds, e.Kind) {
			continue
		}
		if len(rooms) > 0 && (e.Room == nil || !slices.Contains(rooms, *e.Room)) {
			continue
		}
		if len(statuses) > 0 && !slices.Contains(statuses, e.Status) {
			continue
		}
		if category != "" && e.Category != category {
			continue
		}
		if !hasAll(e.Tags, tags) {
			continue
		}
		if vendor != "" && !strings.Contains(strings.ToLower(e.Vendor), vendor) {
			continue
		}
		if f.DateFrom != "" || f.DateTo != "" {
			// Dates are YYYY-MM-DD, so string order is date order.
			if e.Date == nil || (f.DateFrom != "" && *e.Date < f.DateFrom) || (f.DateTo != "" && *e.Date > f.DateTo) {
				continue
			}
		}
		if len(words) > 0 {
			hay := haystack(e)
			matched := true
			for _, w := range words {
				if !strings.Contains(hay, w) {
					matched = false
					break
				}
			}
			if !matched {
				continue
			}
		}
		hits = append(hits, e)
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
