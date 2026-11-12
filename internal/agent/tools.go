package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/llm"
)

func tool(name, desc, params string) llm.Tool {
	return llm.Tool{Type: "function", Function: llm.FunctionDecl{Name: name, Description: desc, Parameters: json.RawMessage(params)}}
}

func enumJSON(vals []string) string {
	b, _ := json.Marshal(vals)
	return string(b)
}

var (
	allStatuses = append(append([]string{}, entries.PlanStatuses...), "todo", "doing")

	entryProps = `"kind":{"type":"string","enum":` + enumJSON(entries.Kinds) + `},` +
		`"title":{"type":"string","description":"short, specific"},` +
		`"room":{"type":"string","enum":` + enumJSON(append([]string{""}, entries.Rooms...)) + `},` +
		`"category":{"type":"string"},` +
		`"status":{"type":"string","enum":` + enumJSON(allStatuses) + `},` +
		`"estimate":{"type":"number","description":"SGD quote or expected price"},` +
		`"actual":{"type":"number","description":"SGD paid so far"},` +
		`"vendor":{"type":"string"},` +
		`"date":{"type":"string","description":"YYYY-MM-DD"},` +
		`"time":{"type":"string","description":"HH:MM 24h; needs a date"},` +
		`"source":{"type":"string"},` +
		`"notes":{"type":"string"},` +
		`"tags":{"type":"array","items":{"type":"string"}},` +
		`"milestone":{"type":"boolean","description":"a notable step for the milestones history"},` +
		`"completed":{"type":"string","description":"YYYY-MM-DD it was done; set automatically when status becomes done"}`
)

// Tools are the entry tools; DocTools join them when documents are on.
var Tools = []llm.Tool{
	tool("add_entry", "Record one or more new entries. Returns their ids.",
		`{"type":"object","properties":{"entries":{"type":"array","items":{"type":"object","properties":{`+entryProps+`},"required":["kind","title"]}}},"required":["entries"]}`),
	tool("update_entry", "Change fields of an existing entry by id. Only pass fields that change; null clears a field. archived=true drops it from view (recoverable).",
		`{"type":"object","properties":{"id":{"type":"string"},`+entryProps+`,"archived":{"type":"boolean"}},"required":["id"]}`),
	tool("search_entries", "Find entries by structured filters and/or words. All filters are optional and combine with AND; list filters match any of their values (tags must all match).",
		`{"type":"object","properties":{`+
			`"kinds":{"type":"array","items":{"type":"string","enum":`+enumJSON(entries.Kinds)+`}},`+
			`"rooms":{"type":"array","items":{"type":"string","enum":`+enumJSON(entries.Rooms)+`}},`+
			`"statuses":{"type":"array","items":{"type":"string","enum":`+enumJSON(allStatuses)+`}},`+
			`"category":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}},"vendor":{"type":"string"},`+
			`"text":{"type":"string","description":"words that must all appear in the entry"},`+
			`"date_from":{"type":"string","description":"YYYY-MM-DD"},"date_to":{"type":"string","description":"YYYY-MM-DD"},`+
			`"milestone":{"type":"boolean","description":"true: only milestones (flagged and done); false: leave them out"},`+
			`"include_archived":{"type":"boolean"},"limit":{"type":"integer"}}}`),
	tool("set_dates", "Set the move-in date and/or the key collection date (YYYY-MM-DD). Pass only the ones that change.",
		`{"type":"object","properties":{"move_in":{"type":"string"},"key_collection":{"type":"string"}}}`),
	tool("undo_change", "Undo a change. Without change_id, undoes the latest change by the person asking.",
		`{"type":"object","properties":{"change_id":{"type":"string"}}}`),
}

// exec runs one tool call and returns the JSON result for the model plus
// the change lines for the user.
func (r *Runner) exec(ctx context.Context, a entries.Actor, tc llm.ToolCall) (string, []llm.Image, []ChangeLine) {
	var args map[string]any
	var images []llm.Image
	result, lines, err := func() (any, []ChangeLine, error) {
		if err := json.Unmarshal([]byte(orEmptyObj(tc.Function.Arguments)), &args); err != nil {
			return nil, nil, fmt.Errorf("arguments are not valid JSON: %w", err)
		}
		switch tc.Function.Name {
		case "add_entry":
			return r.addEntry(ctx, a, args)
		case "update_entry":
			return r.updateEntry(ctx, a, args)
		case "search_entries":
			return r.searchEntries(ctx, args)
		case "set_dates":
			return r.setDates(ctx, args)
		case "undo_change":
			return r.undoChange(ctx, a, args)
		case "search_documents":
			return r.searchDocuments(ctx, args)
		case "read_document_page":
			return r.readDocumentPage(ctx, args)
		case "view_document_page":
			out, imgs, err := r.viewDocumentPage(ctx, args)
			images = imgs
			return out, nil, err
		}
		return nil, nil, fmt.Errorf("unknown tool %q", tc.Function.Name)
	}()
	var out []byte
	if err != nil {
		out, _ = json.Marshal(map[string]string{"error": err.Error()})
	} else {
		out, _ = json.Marshal(result)
	}
	r.Log.Info("agent tool call", "by", a.By, "channel", a.Channel, "tool", tc.Function.Name, "args", tc.Function.Arguments, "result", truncate(string(out), 2000))
	if err != nil {
		images = nil
	}
	return string(out), images, lines
}

// truncate cuts s to at most n runes (never inside a UTF-8 sequence).
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

func orEmptyObj(s string) string {
	if strings.TrimSpace(s) == "" {
		return "{}"
	}
	return s
}

var entryFields = []string{"kind", "title", "room", "category", "status", "vendor", "date", "time", "source", "notes", "tags", "milestone", "completed"}

// entryPatch keeps only the fields the tools allow, so stray keys from the
// model are ignored rather than rejected. estimate/actual become cost.
func entryPatch(m map[string]any, allowArchived bool) (entries.Patch, error) {
	keep := map[string]any{}
	for _, k := range entryFields {
		if v, ok := m[k]; ok {
			keep[k] = v
		}
	}
	cost := map[string]any{}
	for _, k := range []string{"estimate", "actual"} {
		if v, ok := m[k]; ok {
			cost[k] = v
		}
	}
	if len(cost) > 0 {
		keep["cost"] = cost
	}
	if v, ok := m["archived"]; ok && allowArchived {
		keep["archived"] = v
	}
	return entries.PatchFromMap(keep)
}

func lines(changes []entries.Change) []ChangeLine {
	out := make([]ChangeLine, 0, len(changes))
	for _, c := range changes {
		out = append(out, ChangeLine{ID: c.ID, Text: ChangeText(c)})
	}
	return out
}

func (r *Runner) addEntry(ctx context.Context, a entries.Actor, args map[string]any) (any, []ChangeLine, error) {
	raw, _ := args["entries"].([]any)
	if len(raw) == 0 {
		return nil, nil, errors.New("entries must be a non-empty array")
	}
	if len(raw) > 30 {
		raw = raw[:30]
	}
	var patches []entries.Patch
	for _, x := range raw {
		m, ok := x.(map[string]any)
		if !ok {
			return nil, nil, errors.New("each entry must be an object")
		}
		p, err := entryPatch(m, false)
		if err != nil {
			return nil, nil, err
		}
		patches = append(patches, p)
	}
	res, err := r.Entries.Create(ctx, a, patches)
	if err != nil {
		return nil, nil, err
	}
	created := []map[string]string{}
	for _, e := range res.Entries {
		created = append(created, map[string]string{"id": e.ID, "title": e.Title})
	}
	return map[string]any{"created": created}, lines(res.Changes), nil
}

func (r *Runner) updateEntry(ctx context.Context, a entries.Actor, args map[string]any) (any, []ChangeLine, error) {
	id, _ := args["id"].(string)
	if id == "" {
		return nil, nil, errors.New("id is required")
	}
	p, err := entryPatch(args, true)
	if err != nil {
		return nil, nil, err
	}
	if len(p) == 0 {
		return nil, nil, errors.New("pass at least one field to change")
	}
	res, err := r.Entries.Update(ctx, a, id, p)
	if err != nil {
		return nil, nil, err
	}
	return map[string]any{"ok": true, "entry": compact(res.Entries[0], 300)}, lines(res.Changes), nil
}

func (r *Runner) searchEntries(ctx context.Context, args map[string]any) (any, []ChangeLine, error) {
	// The tool's argument names are Filter's JSON names.
	raw, _ := json.Marshal(args)
	var f entries.Filter
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, nil, fmt.Errorf("bad search arguments: %w", err)
	}
	if f.Limit <= 0 {
		f.Limit = 30
	}
	snap, err := r.Entries.Current(ctx)
	if err != nil {
		return nil, nil, err
	}
	sr := snap.Doc.Search(f)
	list := make([]compactEntry, 0, len(sr.Entries))
	for _, e := range sr.Entries {
		list = append(list, compact(e, 300))
	}
	return map[string]any{"total": sr.Total, "entries": list}, nil, nil
}

func (r *Runner) setDates(ctx context.Context, args map[string]any) (any, []ChangeLine, error) {
	var mp entries.MetaPatch
	var out []ChangeLine
	if v, ok := args["move_in"].(string); ok && v != "" {
		if !entries.ValidDate(v) {
			return nil, nil, errors.New("move_in must be YYYY-MM-DD")
		}
		mp.MoveDate, mp.SetMove = &v, true
		out = append(out, ChangeLine{Text: "Move-in set to " + fmtDate(v)})
	}
	if v, ok := args["key_collection"].(string); ok && v != "" {
		if !entries.ValidDate(v) {
			return nil, nil, errors.New("key_collection must be YYYY-MM-DD")
		}
		mp.KeyDate, mp.SetKey = &v, true
		out = append(out, ChangeLine{Text: "Key collection set to " + fmtDate(v)})
	}
	if !mp.SetMove && !mp.SetKey {
		return nil, nil, errors.New("pass move_in or key_collection")
	}
	if _, err := r.Entries.SetMeta(ctx, mp); err != nil {
		return nil, nil, err
	}
	return "ok", out, nil
}

func (r *Runner) undoChange(ctx context.Context, a entries.Actor, args map[string]any) (any, []ChangeLine, error) {
	id, _ := args["change_id"].(string)
	if id == "" {
		recent, err := r.Entries.Recent(ctx, 1, a.By)
		if err != nil {
			return nil, nil, err
		}
		if len(recent) == 0 {
			return nil, nil, errors.New("there is no recent change by you to undo")
		}
		id = recent[0].ID
	}
	res, err := r.Entries.Undo(ctx, a, id)
	if err != nil {
		return nil, nil, err
	}
	l := lines(res.Changes)
	return map[string]any{"ok": true, "undone": l[0].Text}, l, nil
}

// ---- change lines ----

func fmtDate(s string) string {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return s
	}
	return t.Format("Mon, 2 Jan")
}

// Money formats SGD as "$3,000" or "$1,234.50".
func Money(f float64) string {
	whole := int64(math.Floor(f))
	cents := int64(math.Round((f - float64(whole)) * 100))
	if cents == 100 {
		whole, cents = whole+1, 0
	}
	s := strconv.FormatInt(whole, 10)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	if cents > 0 {
		s += fmt.Sprintf(".%02d", cents)
	}
	return "$" + s
}

// Summary is the one-line description of an entry used in confirmations:
// "wet kitchen · idea · Quartz countertop · est $3,000".
func Summary(e entries.Entry) string {
	parts := []string{}
	if e.Room != nil {
		parts = append(parts, *e.Room)
	}
	parts = append(parts, e.Kind, e.Title)
	if e.Date != nil {
		d := fmtDate(*e.Date)
		if e.Time != nil {
			d += " " + *e.Time
		}
		parts = append(parts, d)
	}
	if e.Cost.Estimate != nil {
		parts = append(parts, "est "+Money(*e.Cost.Estimate))
	}
	if e.Cost.Actual != nil {
		parts = append(parts, "paid "+Money(*e.Cost.Actual))
	}
	if e.Vendor != "" {
		parts = append(parts, e.Vendor)
	}
	if e.Completed != nil {
		parts = append(parts, "done "+fmtDate(*e.Completed))
	}
	if e.Milestone {
		parts = append(parts, "★ milestone")
	}
	return strings.Join(parts, " · ")
}

func ptrStr(p *string) string {
	if p == nil {
		return "none"
	}
	return *p
}

func money(p *float64) string {
	if p == nil {
		return "none"
	}
	return Money(*p)
}

// ChangeText is the human line for one journal change.
func ChangeText(c entries.Change) string {
	switch c.Op {
	case "create":
		return "Saved: " + Summary(*c.After)
	case "delete":
		return "Deleted: " + c.Before.Title
	case "undo":
		switch {
		case c.After == nil:
			return "Undone: removed " + c.Before.Title
		case c.Before == nil:
			return "Undone: restored " + c.After.Title
		default:
			return "Undone: " + c.After.Title
		}
	}
	b, a := c.Before, c.After
	if a.Archived && !b.Archived {
		return "Archived: " + a.Title
	}
	if !a.Archived && b.Archived {
		return "Restored: " + a.Title
	}
	var diff []string
	add := func(changed bool, s string) {
		if changed {
			diff = append(diff, s)
		}
	}
	add(a.Title != b.Title, "renamed from "+b.Title)
	add(a.Kind != b.Kind, "now a "+a.Kind)
	add(a.Status != b.Status, "status "+a.Status)
	add(ptrStr(a.Room) != ptrStr(b.Room), "room "+ptrStr(a.Room))
	add(a.Category != b.Category, "category "+a.Category)
	add(money(a.Cost.Estimate) != money(b.Cost.Estimate), "est "+money(a.Cost.Estimate))
	add(money(a.Cost.Actual) != money(b.Cost.Actual), "paid "+money(a.Cost.Actual))
	add(ptrStr(a.Date) != ptrStr(b.Date), "date "+ptrStr(a.Date))
	add(ptrStr(a.Time) != ptrStr(b.Time), "time "+ptrStr(a.Time))
	add(a.Vendor != b.Vendor, "vendor "+a.Vendor)
	add(a.Source != b.Source, "source")
	add(a.Notes != b.Notes, "notes")
	add(strings.Join(a.Tags, ",") != strings.Join(b.Tags, ","), "tags")
	add(a.Milestone && !b.Milestone, "★ milestone")
	add(!a.Milestone && b.Milestone, "no longer a milestone")
	// The done day moves with the status; only a day changed by itself is news.
	add(a.Status == b.Status && ptrStr(a.Completed) != ptrStr(b.Completed), "done on "+ptrStr(a.Completed))
	if len(diff) == 0 {
		return "Updated: " + a.Title
	}
	return "Updated: " + a.Title + " (" + strings.Join(diff, ", ") + ")"
}
