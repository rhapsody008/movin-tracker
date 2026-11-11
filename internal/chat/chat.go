// Package chat runs one chat turn: it shows the LLM the board, lets it
// change the board through four tools, and returns the reply plus a list of
// human-readable change lines.
package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/board"
	"github.com/rhapsody008/movin-tracker/internal/llm"
	"github.com/rhapsody008/movin-tracker/internal/settings"
)

// MaxTurns is how many recent turns are sent to the model.
const MaxTurns = 12

type Turn struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type Result struct {
	Reply   string   `json:"reply"`
	Changes []string `json:"changes"`
	Model   string   `json:"model"`
}

// Event is streamed to the browser while a turn runs.
type Event struct {
	Type string `json:"type"` // "delta", "reset", "change"
	Text string `json:"text,omitempty"`
}

type Runner struct {
	Board *board.Service
	Loc   *time.Location
	Log   *slog.Logger
	Now   func() time.Time
}

var cats = []struct{ id, hint string }{
	{"admin", "utilities, MCST, GIRO, insurance, tax, access cards, defects inspection and claims, movers, lift booking, deliveries"},
	{"reno", "ID, contractors, quotes, permits, works"},
	{"shopping", "furniture, appliances, household items to buy; put the price in quoted"},
}

const itemProps = `"title":{"type":"string"},"cat":{"type":"string","enum":["admin","reno","shopping"]},"status":{"type":"string","enum":["todo","doing","done"]},` +
	`"due":{"type":"string","description":"YYYY-MM-DD"},"time":{"type":"string","description":"HH:MM"},"vendor":{"type":"string"},` +
	`"quoted":{"type":"number"},"paid":{"type":"number"},"notes":{"type":"string"}`

// Tools mirrors the four tools in reference/condo-board.html.
var Tools = []llm.Tool{
	tool("add_items", "Add one or more new items to the board. Returns the new item ids.",
		`{"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{`+itemProps+`},"required":["title","cat"]}}},"required":["items"]}`),
	tool("update_item", "Change fields of an existing item by id (title, cat, status, due, time, vendor, quoted, paid, notes). Only pass fields that change.",
		`{"type":"object","properties":{"id":{"type":"string"},`+itemProps+`},"required":["id"]}`),
	tool("archive_item", "Archive an item that is no longer relevant (recoverable). Use only when the user asks to remove or drop something.",
		`{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}`),
	tool("set_dates", "Set the move-in date and/or the key collection date (YYYY-MM-DD). Pass only the ones that change.",
		`{"type":"object","properties":{"move_in":{"type":"string"},"key_collection":{"type":"string"}}}`),
}

func tool(name, desc, params string) llm.Tool {
	return llm.Tool{Type: "function", Function: llm.FunctionDecl{Name: name, Description: desc, Parameters: json.RawMessage(params)}}
}

func fmtDate(s string) string {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return s
	}
	return t.Format("Mon, 2 Jan")
}

func orNotSet(p *string) string {
	if p == nil {
		return "not set"
	}
	return *p
}

// SystemPrompt carries the rules from the reference board, plus the live
// items as compact JSON (non-archived only, notes cut to 200 characters).
func (r *Runner) SystemPrompt(b *board.Board) string {
	now := r.Now().In(r.Loc)
	type compact struct {
		ID     string   `json:"id"`
		Title  string   `json:"title"`
		Cat    string   `json:"cat"`
		Status string   `json:"status"`
		Due    *string  `json:"due"`
		Time   *string  `json:"time"`
		Vendor string   `json:"vendor,omitempty"`
		Quoted *float64 `json:"quoted,omitempty"`
		Paid   *float64 `json:"paid,omitempty"`
		Notes  string   `json:"notes,omitempty"`
	}
	items := []compact{}
	for _, it := range b.Items {
		if it.Archived {
			continue
		}
		notes := it.Notes
		if r := []rune(notes); len(r) > 200 {
			notes = string(r[:200])
		}
		items = append(items, compact{it.ID, it.Title, board.NormCat(it.Cat), it.Status, it.Due, it.Time, it.Vendor, it.Quoted, it.Paid, notes})
	}
	itemsJSON, _ := json.Marshal(items)
	var catLines []string
	for _, c := range cats {
		catLines = append(catLines, fmt.Sprintf("%s (%s)", c.id, c.hint))
	}
	return fmt.Sprintf(`You help a couple in Singapore run the shared board for their new condo handover. Today is %s (%s). Key collection date: %s. Move-in date: %s.
Categories: %s.
Current board items as JSON: %s
When the message states or implies a change (a new task, a date, a quote, a payment, progress), use the tools to make it. Put several new items in one add_items call. Update an existing item instead of adding a duplicate. Dates are YYYY-MM-DD, times HH:MM 24h, amounts plain SGD numbers ("18k" is 18000). Resolve relative dates like "Friday" from today. Never invent dates, amounts or vendors the user didn't give. When asked to suggest a checklist, add items without dates.
Reply in one to three short plain-text sentences: say what you changed, or answer the question from the board data.`,
		now.Format("2006-01-02"), now.Format("Monday"), orNotSet(b.Meta.KeyDate), orNotSet(b.Meta.MoveDate),
		strings.Join(catLines, "; "), itemsJSON)
}

// CleanTurns keeps the last MaxTurns user/assistant turns, starting on a user turn.
func CleanTurns(in []Turn) []Turn {
	var out []Turn
	for _, t := range in {
		if (t.Role != "user" && t.Role != "assistant") || strings.TrimSpace(t.Content) == "" {
			continue
		}
		if r := []rune(t.Content); len(r) > 4000 {
			t.Content = string(r[:4000])
		}
		out = append(out, t)
	}
	if len(out) > MaxTurns {
		out = out[len(out)-MaxTurns:]
	}
	for len(out) > 0 && out[0].Role != "user" {
		out = out[1:]
	}
	return out
}

// Run executes one chat turn. emit may be nil.
func (r *Runner) Run(ctx context.Context, by string, cfg settings.LLM, turns []Turn, emit func(Event)) (Result, error) {
	if emit == nil {
		emit = func(Event) {}
	}
	turns = CleanTurns(turns)
	if len(turns) == 0 || turns[len(turns)-1].Role != "user" {
		return Result{}, errors.New("the last turn must be a user message")
	}
	if cfg.BaseURL == "" || cfg.Model == "" {
		return Result{}, errors.New("no LLM endpoint or model is configured; open chat settings (the gear) to set one")
	}
	snap, err := r.Board.Current(ctx)
	if err != nil {
		return Result{}, err
	}
	msgs := []llm.Message{{Role: "system", Content: r.SystemPrompt(snap.Board)}}
	for _, t := range turns {
		msgs = append(msgs, llm.Message{Role: t.Role, Content: t.Content})
	}

	client := llm.New(cfg)
	res := Result{Changes: []string{}, Model: cfg.Model}
	// MaxToolRounds counts rounds that may call tools. If the model is still
	// calling tools after that, one more round is forced to answer in words,
	// so even a setting of 1 can edit the board.
	rounds := max(cfg.MaxToolRounds, 1) + 1
	for round := 1; round <= rounds; round++ {
		force := round == rounds
		m, err := client.Complete(ctx, msgs, Tools, force, cfg.Streaming, func(s string) { emit(Event{Type: "delta", Text: s}) })
		if err != nil {
			return res, err
		}
		if len(m.ToolCalls) == 0 || force {
			res.Reply = strings.TrimSpace(m.Content)
			break
		}
		if m.Content != "" {
			// Text before a tool call is a preamble; the final answer replaces it.
			emit(Event{Type: "reset"})
		}
		msgs = append(msgs, llm.Message{Role: "assistant", Content: m.Content, ToolCalls: m.ToolCalls})
		for _, tc := range m.ToolCalls {
			out, lines := r.exec(ctx, by, tc)
			for _, l := range lines {
				res.Changes = append(res.Changes, l)
				emit(Event{Type: "change", Text: l})
			}
			msgs = append(msgs, llm.Message{Role: "tool", ToolCallID: tc.ID, Content: out})
		}
	}
	if res.Reply == "" {
		if len(res.Changes) > 0 {
			res.Reply = "Done."
		} else {
			res.Reply = "No answer came back. Try rephrasing."
		}
	}
	return res, nil
}

// exec runs one tool call through the board service and returns the JSON
// result for the model plus the change lines for the user.
func (r *Runner) exec(ctx context.Context, by string, tc llm.ToolCall) (string, []string) {
	var args map[string]any
	result, lines, err := func() (any, []string, error) {
		if err := json.Unmarshal([]byte(orEmptyObj(tc.Function.Arguments)), &args); err != nil {
			return nil, nil, fmt.Errorf("arguments are not valid JSON: %w", err)
		}
		switch tc.Function.Name {
		case "add_items":
			return r.addItems(ctx, by, args)
		case "update_item":
			return r.updateItem(ctx, by, args, false)
		case "archive_item":
			return r.updateItem(ctx, by, args, true)
		case "set_dates":
			return r.setDates(ctx, args)
		}
		return nil, nil, fmt.Errorf("unknown tool %q", tc.Function.Name)
	}()
	var out []byte
	if err != nil {
		out, _ = json.Marshal(map[string]string{"error": err.Error()})
	} else {
		out, _ = json.Marshal(result)
	}
	r.Log.Info("chat tool call", "by", by, "tool", tc.Function.Name, "args", tc.Function.Arguments, "result", string(out))
	return string(out), lines
}

func orEmptyObj(s string) string {
	if strings.TrimSpace(s) == "" {
		return "{}"
	}
	return s
}

var itemFields = []string{"title", "cat", "status", "due", "time", "vendor", "quoted", "paid", "notes"}

// itemPatch keeps only the item fields the tools allow, so stray keys from
// the model are ignored rather than rejected.
func itemPatch(m map[string]any) (board.Patch, error) {
	keep := map[string]any{}
	for _, k := range itemFields {
		if v, ok := m[k]; ok {
			keep[k] = v
		}
	}
	return board.PatchFromMap(keep)
}

func (r *Runner) addItems(ctx context.Context, by string, args map[string]any) (any, []string, error) {
	raw, _ := args["items"].([]any)
	if len(raw) == 0 {
		return nil, nil, errors.New("items must be a non-empty array")
	}
	if len(raw) > 30 {
		raw = raw[:30]
	}
	var patches []board.Patch
	for _, x := range raw {
		m, ok := x.(map[string]any)
		if !ok {
			return nil, nil, errors.New("each item must be an object")
		}
		p, err := itemPatch(m)
		if err != nil {
			return nil, nil, err
		}
		patches = append(patches, p)
	}
	created, _, err := r.Board.Create(ctx, by, patches)
	if err != nil {
		return nil, nil, err
	}
	ids := []string{}
	var lines []string
	for _, it := range created {
		ids = append(ids, it.ID)
		lines = append(lines, "Added: "+it.Title)
	}
	return map[string]any{"ids": ids}, lines, nil
}

func (r *Runner) updateItem(ctx context.Context, by string, args map[string]any, archive bool) (any, []string, error) {
	id, _ := args["id"].(string)
	if id == "" {
		return nil, nil, errors.New("id is required")
	}
	var p board.Patch
	var err error
	if archive {
		p = board.Patch{"archived": json.RawMessage("true")}
	} else if p, err = itemPatch(args); err != nil {
		return nil, nil, err
	}
	if len(p) == 0 {
		return nil, nil, errors.New("pass at least one field to change")
	}
	it, _, err := r.Board.Update(ctx, by, id, p)
	if err != nil {
		return nil, nil, err
	}
	verb := "Updated: "
	if archive {
		verb = "Archived: "
	}
	return "ok", []string{verb + it.Title}, nil
}

func (r *Runner) setDates(ctx context.Context, args map[string]any) (any, []string, error) {
	var mp board.MetaPatch
	var lines []string
	if v, ok := args["move_in"].(string); ok && v != "" {
		if !board.ValidDate(v) {
			return nil, nil, errors.New("move_in must be YYYY-MM-DD")
		}
		mp.MoveDate, mp.SetMove = &v, true
		lines = append(lines, "Move-in set to "+fmtDate(v))
	}
	if v, ok := args["key_collection"].(string); ok && v != "" {
		if !board.ValidDate(v) {
			return nil, nil, errors.New("key_collection must be YYYY-MM-DD")
		}
		mp.KeyDate, mp.SetKey = &v, true
		lines = append(lines, "Key collection set to "+fmtDate(v))
	}
	if !mp.SetMove && !mp.SetKey {
		return nil, nil, errors.New("pass move_in or key_collection")
	}
	if _, err := r.Board.SetMeta(ctx, mp); err != nil {
		return nil, nil, err
	}
	return "ok", lines, nil
}
