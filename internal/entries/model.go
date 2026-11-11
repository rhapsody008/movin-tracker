// Package entries holds the renovation record: structured entries (ideas,
// decisions, tasks, notes, questions), the field rules every change must
// pass, and the service that all writes go through, whether they come from
// the web page, the web chat or the Telegram bot.
package entries

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

const SchemaVersion = 1

// Doc is the whole stored document, kept as one JSON object in S3.
type Doc struct {
	Schema  int      `json:"schema"`
	Meta    Meta     `json:"meta"`
	Entries []Entry  `json:"entries"`
	Changes []Change `json:"changes"`
}

type Meta struct {
	MoveDate *string `json:"moveDate"`
	KeyDate  *string `json:"keyDate"`
}

// Entry is one record. Its pointer and slice fields (Room, Date, Time, Cost,
// Tags) are only ever replaced, never changed in place (Patch.Apply builds
// new values), so a plain value copy of an Entry is safe to keep while the
// original moves on. Clone is only needed to hand copies outside the package.
type Entry struct {
	ID       string   `json:"id"`
	Kind     string   `json:"kind"`
	Title    string   `json:"title"`
	Room     *string  `json:"room"`
	Category string   `json:"category"`
	Status   string   `json:"status"`
	Cost     Cost     `json:"cost"`
	Vendor   string   `json:"vendor"`
	Date     *string  `json:"date"`
	Time     *string  `json:"time"`
	Source   string   `json:"source"`
	Notes    string   `json:"notes"`
	Tags     []string `json:"tags"`
	Archived bool     `json:"archived"`
	By       string   `json:"by"`
	Channel  string   `json:"channel"`
	Created  string   `json:"created"`
	Updated  string   `json:"updated"`
}

// Cost is in SGD. Estimate is the quote or expected price; Actual is what
// has been paid so far.
type Cost struct {
	Estimate *float64 `json:"estimate"`
	Actual   *float64 `json:"actual"`
}

// Change is one journal record: enough to show what happened and to undo it.
// Before is nil for a create; After is nil for a delete.
type Change struct {
	ID      string `json:"id"`
	At      string `json:"at"`
	By      string `json:"by"`
	Channel string `json:"channel"`
	Op      string `json:"op"` // create | update | delete | undo
	EntryID string `json:"entryId"`
	Before  *Entry `json:"before"`
	After   *Entry `json:"after"`
}

const (
	KindIdea     = "idea"
	KindDecision = "decision"
	KindTask     = "task"
	KindNote     = "note"
	KindQuestion = "question"
)

var (
	Kinds = []string{KindIdea, KindDecision, KindTask, KindNote, KindQuestion}

	// Rooms come from the Type C5 unit layout plan. Room is optional: an
	// entry with no clear room leaves it empty.
	Rooms = []string{
		"living", "dining", "dry kitchen", "wet kitchen", "flex",
		"master bedroom", "bedroom 2", "bedroom 3",
		"master bathroom", "bathroom 2", "balcony", "whole-house",
	}

	// TaskStatuses apply to kind=task; PlanStatuses to every other kind.
	// The two lists line up column by column on the kanban, except that
	// tasks have no "decided" stage.
	TaskStatuses = []string{"todo", "doing", "done"}
	PlanStatuses = []string{"idea", "shortlisted", "decided", "done"}

	Channels = []string{"web", "telegram", "system"}

	dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	timeRe = regexp.MustCompile(`^\d{2}:\d{2}$`)
)

// StatusesFor returns the statuses valid for a kind.
func StatusesFor(kind string) []string {
	if kind == KindTask {
		return TaskStatuses
	}
	return PlanStatuses
}

// DefaultStatus is the starting status for a new entry of that kind.
func DefaultStatus(kind string) string { return StatusesFor(kind)[0] }

// remapStatus carries a status across a kind change, keeping the entry in
// the same kanban column where one exists.
func remapStatus(status, toKind string) string {
	if slices.Contains(StatusesFor(toKind), status) {
		return status
	}
	if toKind == KindTask {
		switch status {
		case "shortlisted":
			return "doing"
		case "done":
			return "done"
		default: // idea, decided: there is still work to do
			return "todo"
		}
	}
	switch status {
	case "doing":
		return "shortlisted"
	case "done":
		return "done"
	default:
		return "idea"
	}
}

// ValidationError is a field rule violation; the API maps it to 400.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, a ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, a...)}
}

func ValidDate(s string) bool {
	if !dateRe.MatchString(s) {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

func ValidTime(s string) bool {
	if !timeRe.MatchString(s) {
		return false
	}
	_, err := time.Parse("15:04", s)
	return err == nil
}

// NormRoom lowercases and trims a room name and reports whether it is one
// of Rooms.
func NormRoom(s string) (string, bool) {
	r := strings.ToLower(strings.Join(strings.Fields(s), " "))
	return r, slices.Contains(Rooms, r)
}

// Patch is a set of field changes. A key that is present with JSON null
// clears a nullable field; an absent key leaves the field alone.
type Patch map[string]json.RawMessage

var textLimits = map[string]int{"vendor": 200, "source": 500, "notes": 4000, "category": 40}

var patchable = map[string]bool{
	"kind": true, "title": true, "room": true, "category": true, "status": true,
	"cost": true, "vendor": true, "date": true, "time": true, "source": true,
	"notes": true, "tags": true, "archived": true,
}

// PatchFromMap builds a Patch from already-decoded values (used by agent tools).
func PatchFromMap(m map[string]any) (Patch, error) {
	p := Patch{}
	for k, v := range m {
		b, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		p[k] = b
	}
	return p, nil
}

func isNull(raw json.RawMessage) bool { return bytes.Equal(bytes.TrimSpace(raw), []byte("null")) }

// str decodes a string field; null reads as "".
func str(k string, raw json.RawMessage) (string, error) {
	if isNull(raw) {
		return "", nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", invalid("%s must be a string", k)
	}
	return s, nil
}

func maxLen(k, s string, n int) error {
	if utf8.RuneCountInString(s) > n {
		return invalid("%s must be at most %d characters", k, n)
	}
	return nil
}

// Apply validates every field in p and writes it onto e. Kind is applied
// first so a status in the same patch is checked against the new kind; a
// kind change without a status remaps the old one. On error, e is left in
// an unspecified state, so callers apply to a copy.
func (p Patch) Apply(e *Entry) error {
	for k := range p {
		if !patchable[k] {
			return invalid("unknown field %q", k)
		}
	}
	if raw, ok := p["kind"]; ok {
		s, err := str("kind", raw)
		if err != nil {
			return err
		}
		s = strings.ToLower(strings.TrimSpace(s))
		if !slices.Contains(Kinds, s) {
			return invalid("kind must be one of %s", strings.Join(Kinds, ", "))
		}
		if e.Kind != s {
			e.Kind = s
			if _, ok := p["status"]; !ok {
				e.Status = remapStatus(e.Status, s)
			}
		}
	}
	for k, raw := range p {
		null := isNull(raw)
		switch k {
		case "kind":
			// done above
		case "title":
			s, err := str(k, raw)
			if err != nil {
				return err
			}
			s = strings.TrimSpace(s)
			if n := utf8.RuneCountInString(s); n < 1 || n > 200 {
				return invalid("title must be 1–200 characters")
			}
			e.Title = s
		case "vendor", "source", "notes", "category":
			s, err := str(k, raw)
			if err != nil {
				return err
			}
			s = strings.TrimSpace(s)
			if err := maxLen(k, s, textLimits[k]); err != nil {
				return err
			}
			switch k {
			case "vendor":
				e.Vendor = s
			case "source":
				e.Source = s
			case "notes":
				e.Notes = s
			case "category":
				e.Category = strings.ToLower(s)
			}
		case "room":
			s, err := str(k, raw)
			if err != nil {
				return err
			}
			if strings.TrimSpace(s) == "" {
				e.Room = nil
				continue
			}
			r, ok := NormRoom(s)
			if !ok {
				return invalid("room must be one of %s, or empty", strings.Join(Rooms, ", "))
			}
			e.Room = &r
		case "status":
			s, err := str(k, raw)
			if err != nil {
				return err
			}
			s = strings.ToLower(strings.TrimSpace(s))
			if !slices.Contains(StatusesFor(e.Kind), s) {
				return invalid("status for a %s must be one of %s", kindOrNote(e.Kind), strings.Join(StatusesFor(e.Kind), ", "))
			}
			e.Status = s
		case "date", "time":
			s, err := str(k, raw)
			if err != nil {
				return err
			}
			// An empty string clears the field, same as null; date and time
			// inputs in the browser send "" when blank.
			var v *string
			if s != "" {
				if k == "date" && !ValidDate(s) {
					return invalid("date must be YYYY-MM-DD")
				}
				if k == "time" && !ValidTime(s) {
					return invalid("time must be HH:MM (24h)")
				}
				v = &s
			}
			if k == "date" {
				e.Date = v
				// Clearing the date clears its time too, unless the same
				// patch sets a time (rejected below).
				if v == nil {
					if _, ok := p["time"]; !ok {
						e.Time = nil
					}
				}
			} else {
				e.Time = v
			}
		case "cost":
			if null {
				e.Cost = Cost{}
				continue
			}
			var c map[string]json.RawMessage
			if err := json.Unmarshal(raw, &c); err != nil {
				return invalid("cost must be an object with estimate and/or actual")
			}
			for ck, cv := range c {
				if ck != "estimate" && ck != "actual" {
					return invalid("unknown cost field %q", ck)
				}
				var v *float64
				if !isNull(cv) {
					var f float64
					if err := json.Unmarshal(cv, &f); err != nil {
						return invalid("cost.%s must be a number or null", ck)
					}
					if f < 0 {
						return invalid("cost.%s must be 0 or more", ck)
					}
					v = &f
				}
				if ck == "estimate" {
					e.Cost.Estimate = v
				} else {
					e.Cost.Actual = v
				}
			}
		case "tags":
			var tags []string
			if !null {
				if err := json.Unmarshal(raw, &tags); err != nil {
					return invalid("tags must be a list of strings")
				}
			}
			out, err := normTags(tags)
			if err != nil {
				return err
			}
			e.Tags = out
		case "archived":
			var b bool
			if null || json.Unmarshal(raw, &b) != nil {
				return invalid("archived must be true or false")
			}
			e.Archived = b
		}
	}
	if e.Time != nil && e.Date == nil {
		return invalid("time needs a date")
	}
	return nil
}

func kindOrNote(k string) string {
	if k == "" {
		return KindNote
	}
	return k
}

func normTags(in []string) ([]string, error) {
	out := []string{}
	for _, t := range in {
		t = strings.ToLower(strings.Join(strings.Fields(t), " "))
		if t == "" || slices.Contains(out, t) {
			continue
		}
		if err := maxLen("each tag", t, 40); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	if len(out) > 20 {
		return nil, invalid("at most 20 tags")
	}
	return out, nil
}

// NewEntry returns an entry with defaults for its kind, before a patch is
// applied. An empty kind means note.
func NewEntry(kind string) Entry {
	if kind == "" {
		kind = KindNote
	}
	return Entry{Kind: kind, Status: DefaultStatus(kind), Tags: []string{}}
}

// MetaPatch changes the key dates; an empty string or null clears one.
type MetaPatch struct {
	MoveDate *string
	KeyDate  *string
	SetMove  bool
	SetKey   bool
}

func (mp MetaPatch) Apply(m *Meta) error {
	set := func(dst **string, v *string, name string) error {
		if v == nil || *v == "" {
			*dst = nil
			return nil
		}
		if !ValidDate(*v) {
			return invalid("%s must be YYYY-MM-DD", name)
		}
		s := *v
		*dst = &s
		return nil
	}
	if mp.SetMove {
		if err := set(&m.MoveDate, mp.MoveDate, "moveDate"); err != nil {
			return err
		}
	}
	if mp.SetKey {
		if err := set(&m.KeyDate, mp.KeyDate, "keyDate"); err != nil {
			return err
		}
	}
	return nil
}

// Clone deep-copies an entry.
func (e Entry) Clone() Entry {
	e.Room, e.Date, e.Time = clonePtr(e.Room), clonePtr(e.Date), clonePtr(e.Time)
	e.Cost = Cost{Estimate: clonePtr(e.Cost.Estimate), Actual: clonePtr(e.Cost.Actual)}
	e.Tags = slices.Clone(e.Tags)
	if e.Tags == nil {
		e.Tags = []string{}
	}
	return e
}

// Clone deep-copies the document so a failed change never touches the cache.
func (d *Doc) Clone() *Doc {
	out := &Doc{Schema: d.Schema, Meta: Meta{MoveDate: clonePtr(d.Meta.MoveDate), KeyDate: clonePtr(d.Meta.KeyDate)}}
	out.Entries = make([]Entry, len(d.Entries))
	for i, e := range d.Entries {
		out.Entries[i] = e.Clone()
	}
	out.Changes = make([]Change, len(d.Changes))
	for i, c := range d.Changes {
		if c.Before != nil {
			b := c.Before.Clone()
			c.Before = &b
		}
		if c.After != nil {
			a := c.After.Clone()
			c.After = &a
		}
		out.Changes[i] = c
	}
	return out
}

func clonePtr[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func (d *Doc) find(id string) int {
	for i := range d.Entries {
		if d.Entries[i].ID == id {
			return i
		}
	}
	return -1
}

// Find returns a copy of the entry with that id.
func (d *Doc) Find(id string) (Entry, bool) {
	if i := d.find(id); i >= 0 {
		return d.Entries[i].Clone(), true
	}
	return Entry{}, false
}

// Decode parses a stored document and normalises fields written by older or
// hand-edited files, so the rest of the app can trust it.
func Decode(data []byte) (*Doc, error) {
	var d Doc
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, fmt.Errorf("decode entries.json: %w", err)
	}
	if d.Schema == 0 {
		d.Schema = SchemaVersion
	}
	if d.Entries == nil {
		d.Entries = []Entry{}
	}
	if d.Changes == nil {
		d.Changes = []Change{}
	}
	for i := range d.Entries {
		normalise(&d.Entries[i])
	}
	return &d, nil
}

func normalise(e *Entry) {
	if !slices.Contains(Kinds, e.Kind) {
		e.Kind = KindNote
	}
	if !slices.Contains(StatusesFor(e.Kind), e.Status) {
		e.Status = remapStatus(e.Status, e.Kind)
	}
	if e.Room != nil {
		if r, ok := NormRoom(*e.Room); ok {
			e.Room = &r
		} else {
			e.Room = nil
		}
	}
	if e.Date != nil && !ValidDate(*e.Date) {
		e.Date = nil
	}
	if e.Time != nil && (e.Date == nil || !ValidTime(*e.Time)) {
		e.Time = nil
	}
	if tags, err := normTags(e.Tags); err == nil {
		e.Tags = tags
	} else {
		e.Tags = []string{}
	}
	if !slices.Contains(Channels, e.Channel) {
		e.Channel = "web"
	}
}

// View is the document as the web page receives it: without the journal,
// which the page never reads (undo handles travel with each change line).
type View struct {
	Schema  int     `json:"schema"`
	Meta    Meta    `json:"meta"`
	Entries []Entry `json:"entries"`
}

func (d *Doc) View() *View {
	if d == nil {
		return nil
	}
	return &View{Schema: d.Schema, Meta: d.Meta, Entries: d.Entries}
}

func Empty() *Doc {
	return &Doc{Schema: SchemaVersion, Entries: []Entry{}, Changes: []Change{}}
}
