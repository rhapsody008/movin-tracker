// Package board holds the board document, its field rules, and the service
// that every change (by hand or by the chat) goes through.
package board

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const SchemaVersion = 1

type Board struct {
	Schema int    `json:"schema"`
	Meta   Meta   `json:"meta"`
	Items  []Item `json:"items"`
}

type Meta struct {
	MoveDate *string `json:"moveDate"`
	KeyDate  *string `json:"keyDate"`
}

type Item struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Cat      string   `json:"cat"`
	Status   string   `json:"status"`
	Due      *string  `json:"due"`
	Time     *string  `json:"time"`
	Vendor   string   `json:"vendor"`
	Quoted   *float64 `json:"quoted"`
	Paid     *float64 `json:"paid"`
	Notes    string   `json:"notes"`
	Archived bool     `json:"archived"`
	Created  string   `json:"created"`
	Updated  string   `json:"updated"`
	By       string   `json:"by"`
}

var (
	Cats     = []string{"admin", "reno", "shopping"}
	Statuses = []string{"todo", "doing", "done"}

	dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	timeRe = regexp.MustCompile(`^\d{2}:\d{2}$`)
)

// NormCat applies the "anything else is read as admin" rule.
func NormCat(c string) string {
	for _, k := range Cats {
		if c == k {
			return c
		}
	}
	return "admin"
}

// ValidationError is a field rule violation; the API maps it to 400.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, a ...any) error { return &ValidationError{Msg: fmt.Sprintf(format, a...)} }

func ValidDate(s string) bool {
	if !dateRe.MatchString(s) {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

func validTime(s string) bool {
	if !timeRe.MatchString(s) {
		return false
	}
	_, err := time.Parse("15:04", s)
	return err == nil
}

// Patch is a set of field changes. A key that is present with JSON null
// clears a nullable field; an absent key leaves the field alone.
type Patch map[string]json.RawMessage

var patchable = map[string]bool{
	"title": true, "cat": true, "status": true, "due": true, "time": true,
	"vendor": true, "quoted": true, "paid": true, "notes": true, "archived": true,
}

// PatchFromMap builds a Patch from already-decoded values (used by chat tools).
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

// Apply validates every field in p and writes it onto it. On error, it is
// left in an unspecified state, so callers apply to a copy.
func (p Patch) Apply(it *Item) error {
	for k, raw := range p {
		if !patchable[k] {
			return invalid("unknown field %q", k)
		}
		null := isNull(raw)
		switch k {
		case "title", "vendor", "notes", "cat", "status":
			var s string
			if !null {
				if err := json.Unmarshal(raw, &s); err != nil {
					return invalid("%s must be a string", k)
				}
			}
			switch k {
			case "title":
				s = strings.TrimSpace(s)
				if n := utf8.RuneCountInString(s); n < 1 || n > 200 {
					return invalid("title must be 1–200 characters")
				}
				it.Title = s
			case "vendor":
				if utf8.RuneCountInString(s) > 200 {
					return invalid("vendor must be at most 200 characters")
				}
				it.Vendor = s
			case "notes":
				if utf8.RuneCountInString(s) > 4000 {
					return invalid("notes must be at most 4000 characters")
				}
				it.Notes = s
			case "cat":
				it.Cat = NormCat(s)
			case "status":
				if s != "todo" && s != "doing" && s != "done" {
					return invalid("status must be todo, doing or done")
				}
				it.Status = s
			}
		case "due", "time":
			var s string
			if !null {
				if err := json.Unmarshal(raw, &s); err != nil {
					return invalid("%s must be a string or null", k)
				}
			}
			// An empty string clears the field, same as null; date and
			// time inputs in the browser send "" when blank.
			var v *string
			if s != "" {
				if k == "due" && !ValidDate(s) {
					return invalid("due must be YYYY-MM-DD")
				}
				if k == "time" && !validTime(s) {
					return invalid("time must be HH:MM (24h)")
				}
				v = &s
			}
			if k == "due" {
				it.Due = v
			} else {
				it.Time = v
			}
		case "quoted", "paid":
			var v *float64
			if !null {
				var f float64
				if err := json.Unmarshal(raw, &f); err != nil {
					return invalid("%s must be a number or null", k)
				}
				if f < 0 {
					return invalid("%s must be 0 or more", k)
				}
				v = &f
			}
			if k == "quoted" {
				it.Quoted = v
			} else {
				it.Paid = v
			}
		case "archived":
			var b bool
			if null || json.Unmarshal(raw, &b) != nil {
				return invalid("archived must be true or false")
			}
			it.Archived = b
		}
	}
	return nil
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

// Clone deep-copies the board so a failed change never touches the cache.
func (b *Board) Clone() *Board {
	out := &Board{Schema: b.Schema, Meta: Meta{MoveDate: clonePtr(b.Meta.MoveDate), KeyDate: clonePtr(b.Meta.KeyDate)}}
	out.Items = make([]Item, len(b.Items))
	for i, it := range b.Items {
		it.Due, it.Time = clonePtr(it.Due), clonePtr(it.Time)
		it.Quoted, it.Paid = clonePtr(it.Quoted), clonePtr(it.Paid)
		out.Items[i] = it
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

func (b *Board) find(id string) int {
	for i := range b.Items {
		if b.Items[i].ID == id {
			return i
		}
	}
	return -1
}

// Find returns a copy of the item with that id.
func (b *Board) Find(id string) (Item, bool) {
	if i := b.find(id); i >= 0 {
		return b.Items[i], true
	}
	return Item{}, false
}

// Decode parses a stored board and normalises fields written by older or
// hand-edited files, so the rest of the app can trust it.
func Decode(data []byte) (*Board, error) {
	var b Board
	if err := json.Unmarshal(data, &b); err != nil {
		return nil, fmt.Errorf("decode board.json: %w", err)
	}
	if b.Schema == 0 {
		b.Schema = SchemaVersion
	}
	if b.Items == nil {
		b.Items = []Item{}
	}
	for i := range b.Items {
		it := &b.Items[i]
		it.Cat = NormCat(it.Cat)
		if it.Status != "doing" && it.Status != "done" {
			it.Status = "todo"
		}
	}
	return &b, nil
}

func Empty() *Board { return &Board{Schema: SchemaVersion, Items: []Item{}} }
