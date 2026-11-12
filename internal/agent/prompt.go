package agent

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/llm"
)

// PromptEntries is how many recently updated entries the system prompt
// lists; older ones are reached through search_entries.
const PromptEntries = 150

// SilentReply is what the model answers in a group chat when a message
// needs no record and asks nothing. The channel then stays quiet.
const SilentReply = "NO_REPLY"

// Categories are suggestions for the model; category stays free text.
var Categories = []string{
	"carpentry", "electrical", "lighting", "plumbing", "flooring", "painting", "aircon",
	"windows & doors", "appliances", "furniture", "admin", "other",
}

type compactEntry struct {
	ID       string   `json:"id"`
	Kind     string   `json:"kind"`
	Title    string   `json:"title"`
	Room     *string  `json:"room,omitempty"`
	Category string   `json:"category,omitempty"`
	Status   string   `json:"status"`
	Date     *string  `json:"date,omitempty"`
	Time     *string  `json:"time,omitempty"`
	Vendor   string   `json:"vendor,omitempty"`
	Estimate *float64 `json:"estimate,omitempty"`
	Actual   *float64 `json:"actual,omitempty"`
	Notes    string   `json:"notes,omitempty"`
	Archived bool     `json:"archived,omitempty"`
	// Last, so entries without them keep their exact line (prompt cache).
	Milestone bool    `json:"milestone,omitempty"`
	Completed *string `json:"completed,omitempty"`
}

func compact(e entries.Entry, notesLen int) compactEntry {
	notes := e.Notes
	if r := []rune(notes); len(r) > notesLen {
		notes = string(r[:notesLen])
	}
	return compactEntry{e.ID, e.Kind, e.Title, e.Room, e.Category, e.Status, e.Date, e.Time, e.Vendor, e.Cost.Estimate, e.Cost.Actual, notes, e.Archived, e.Milestone, e.Completed}
}

func orNotSet(p *string) string {
	if p == nil {
		return "not set"
	}
	return *p
}

// SystemSections carries the rules, the room list and the most recently
// updated entries as compact JSON (non-archived only, notes left out),
// most stable part first.
func (r *Runner) SystemSections(d *entries.Doc, req Request) []llm.Section {
	now := r.Now().In(r.Loc)
	live := make([]entries.Entry, 0, len(d.Entries))
	for _, e := range d.Entries {
		if !e.Archived {
			live = append(live, e)
		}
	}
	// Pick the most recently updated, then list them in creation order: an
	// edit then changes only that entry's line, so the prompt prefix stays
	// the same between turns and servers that cache prefixes can reuse it.
	sort.SliceStable(live, func(i, j int) bool { return live[i].Updated > live[j].Updated })
	more := ""
	if len(live) > PromptEntries {
		more = fmt.Sprintf(" (the %d most recently updated of %d; use search_entries for the rest)", PromptEntries, len(live))
		live = live[:PromptEntries]
	}
	sort.SliceStable(live, func(i, j int) bool { return live[i].Created < live[j].Created })
	list := make([]compactEntry, 0, len(live))
	for _, e := range live {
		list = append(list, compact(e, 0))
	}
	listJSON, _ := json.Marshal(list)

	var b strings.Builder
	fmt.Fprintf(&b, `You are the renovation assistant for a couple in Singapore fitting out their new condo (unit type C5: 3 bedrooms + flex). You keep their record of ideas, decisions, tasks, notes and questions, and answer questions from it.

Entry fields:
- kind: idea (something they might do or buy), decision (something chosen), task (something to get done, often with a date), note (a fact or thought worth keeping), question (an open question to resolve).
- room (optional): %s. Leave it empty when no room applies; use whole-house for things that apply everywhere.
- category (free text; prefer one of): %s.
- status: tasks use todo, doing, done; every other kind uses idea, shortlisted, decided, done.
- estimate / actual: SGD numbers. estimate is the quote or expected price, actual is what has been paid so far. "18k" is 18000.
- date YYYY-MM-DD and time HH:MM (24h); a time needs a date.
- vendor, source (where it came from: a link, a shop, a site visit), notes, tags.
- milestone: marks a notable step (keys collected, kitchen installed); a done milestone is listed in their milestones history. completed: the day it was done, set automatically when status becomes done; pass it only when the user names another day.

Rules:
- When a message states something worth keeping (an idea, a decision, a quote, a payment, a date, progress), record it with the tools. Put several new entries in one add_entry call.
- Update an existing entry instead of adding a duplicate: a payment or new quote for something already listed is an update.
- Never invent dates, amounts, vendors or rooms the user didn't give. Resolve relative dates like "Friday" from today.
- If you can't tell what to record (for example which room, or whether something was decided), ask one short question and record nothing yet.
- Questions about past decisions, costs or plans: answer from the entries; call search_entries when the list above is not enough.
- Set milestone only when the user calls something a milestone or asks for one. To list milestones, call search_entries with milestone=true.
- "Drop", "remove" or "forget" means archive (update_entry with archived=true). "Undo that" means undo_change.
- Reply in one to three short plain-text sentences. Don't repeat the saved fields; the app shows them.`,
		strings.Join(entries.Rooms, ", "), strings.Join(Categories, ", "))
	if req.Group {
		fmt.Fprintf(&b, `
This is a group chat; each user message starts with the speaker's name. If a message needs nothing recorded and asks you nothing (chat between the two of them), reply with exactly %s.`, SilentReply)
	}
	// Most stable first, so a prompt cache keeps as much as possible: the
	// rules change only with a new build, the entries with a write, the
	// date every day (and is tiny, so it is never cached).
	entriesPart := fmt.Sprintf("\n\nCurrent entries%s: %s", more, listJSON)
	datePart := fmt.Sprintf("\nToday is %s (%s). Key collection: %s. Move-in: %s.",
		now.Format("2006-01-02"), now.Format("Monday"), orNotSet(d.Meta.KeyDate), orNotSet(d.Meta.MoveDate))
	return []llm.Section{
		{Text: b.String(), CacheBreak: true},
		{Text: entriesPart, CacheBreak: true},
		{Text: datePart},
	}
}
