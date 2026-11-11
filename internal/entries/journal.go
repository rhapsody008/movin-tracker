package entries

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/oklog/ulid/v2"
)

// MaxChanges caps the journal kept inside entries.json. Older changes drop
// off and can no longer be undone from the app.
const MaxChanges = 200

var (
	ErrChangeNotFound = errors.New("that change is no longer in the history")
	// ErrUndoStale means the entry was changed again after the change being
	// undone, so undoing it would silently throw the later edit away.
	ErrUndoStale = errors.New("that entry has changed since, so undo was refused")
)

// record appends a journal entry to d and returns it. Value copies of the
// entries are enough (see Entry).
func (s *Service) record(d *Doc, a Actor, op, entryID string, before, after *Entry) Change {
	c := Change{ID: ulid.Make().String(), At: s.stamp(), By: a.By, Channel: a.Channel, Op: op, EntryID: entryID}
	if before != nil {
		b := *before
		c.Before = &b
	}
	if after != nil {
		x := *after
		c.After = &x
	}
	d.Changes = append(d.Changes, c)
	if over := len(d.Changes) - MaxChanges; over > 0 {
		d.Changes = append([]Change(nil), d.Changes[over:]...)
	}
	return c
}

func sameEntry(a, b *Entry) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	ja, _ := json.Marshal(a.Clone())
	jb, _ := json.Marshal(b.Clone())
	return bytes.Equal(ja, jb)
}

// Undo reverses one change, provided the entry still looks exactly as that
// change left it. The undo is itself journaled, so it can be undone too.
func (s *Service) Undo(ctx context.Context, a Actor, changeID string) (Result, error) {
	var res Result
	snap, err := s.mutate(ctx, func(d *Doc) error {
		res = Result{}
		var ch *Change
		for i := range d.Changes {
			if d.Changes[i].ID == changeID {
				ch = &d.Changes[i]
				break
			}
		}
		if ch == nil {
			return fmt.Errorf("%w: %s", ErrChangeNotFound, changeID)
		}
		entryID, before, after := ch.EntryID, ch.Before, ch.After
		if before == nil && after == nil {
			// Never written by the app; a hand-edited file could hold one.
			return fmt.Errorf("%w: %s (empty record)", ErrChangeNotFound, changeID)
		}

		i := d.find(entryID)
		var cur *Entry
		if i >= 0 {
			c := d.Entries[i]
			cur = &c
		}
		if !sameEntry(cur, after) {
			return ErrUndoStale
		}

		var restored *Entry
		switch {
		case before == nil: // undo a create: remove it
			d.Entries = append(d.Entries[:i], d.Entries[i+1:]...)
		case i < 0: // undo a delete: put it back
			r := *before
			d.Entries = append(d.Entries, r)
			restored = &r
		default: // undo an update: restore the old fields
			r := *before
			r.Updated, r.By, r.Channel = s.stamp(), a.By, a.Channel
			d.Entries[i] = r
			restored = &r
		}
		if restored != nil {
			res.Entries = []Entry{*restored}
		} else {
			res.Entries = []Entry{*cur}
		}
		res.Changes = []Change{s.record(d, a, "undo", entryID, cur, restored)}
		return nil
	})
	res.Snapshot = snap
	return res, err
}

// Recent returns up to n journal records, newest first. With by set, only
// that person's changes.
func (s *Service) Recent(ctx context.Context, n int, by string) ([]Change, error) {
	snap, err := s.Current(ctx)
	if err != nil {
		return nil, err
	}
	var out []Change
	for i := len(snap.Doc.Changes) - 1; i >= 0 && len(out) < n; i-- {
		c := snap.Doc.Changes[i]
		if by != "" && c.By != by {
			continue
		}
		out = append(out, c)
	}
	return out, nil
}
