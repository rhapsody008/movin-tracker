// Package agent runs one conversational turn against the entries: it shows
// the model the record, lets it read and change entries through tools, and
// returns the reply plus one line per change, each with an undo handle. It
// knows nothing about HTTP or Telegram; every channel calls Run.
package agent

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/llm"
	"github.com/rhapsody008/movin-tracker/internal/settings"
)

// Request is one turn from a channel.
type Request struct {
	By      string // who is asking; stamped on every change
	Channel string // web, telegram
	Group   bool   // a group chat: the model may choose to stay silent
	Turns   []Turn
}

// ChangeLine is one change shown to the user. ID is the journal change ID
// to undo it; empty for changes that are not journaled (key dates).
type ChangeLine struct {
	ID   string `json:"id,omitempty"`
	Text string `json:"text"`
}

type Result struct {
	Reply   string       `json:"reply"`
	Changes []ChangeLine `json:"changes"`
	Model   string       `json:"model"`
	// Silent is true when, in a group chat, the model decided the message
	// needed no answer and nothing was changed. The channel sends nothing.
	Silent bool `json:"silent,omitempty"`
}

// Event is streamed while a turn runs.
type Event struct {
	Type string `json:"type"` // "delta", "reset", "change"
	Text string `json:"text,omitempty"`
	ID   string `json:"id,omitempty"`
}

type Runner struct {
	Entries *entries.Service
	Loc     *time.Location
	Log     *slog.Logger
	Now     func() time.Time
}

// Run executes one turn. emit may be nil.
func (r *Runner) Run(ctx context.Context, req Request, cfg settings.LLM, emit func(Event)) (Result, error) {
	if emit == nil {
		emit = func(Event) {}
	}
	turns := CleanTurns(req.Turns)
	if len(turns) == 0 || turns[len(turns)-1].Role != "user" {
		return Result{}, errors.New("the last turn must be a user message")
	}
	if cfg.BaseURL == "" || cfg.Model == "" {
		return Result{}, errors.New("no LLM endpoint or model is configured; set one in the admin page (LLM tab)")
	}
	snap, err := r.Entries.Current(ctx)
	if err != nil {
		return Result{}, err
	}
	msgs := []llm.Message{{Role: "system", Content: r.SystemPrompt(snap.Doc, req)}}
	for _, t := range turns {
		msgs = append(msgs, llm.Message{Role: t.Role, Content: t.Content})
	}

	actor := entries.Actor{By: req.By, Channel: req.Channel}
	client := llm.New(cfg)
	res := Result{Changes: []ChangeLine{}, Model: cfg.Model}
	// MaxToolRounds counts rounds that may call tools. If the model is still
	// calling tools after that, one more round is forced to answer in words,
	// so even a setting of 1 can make changes.
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
			out, lines := r.exec(ctx, actor, tc)
			for _, l := range lines {
				res.Changes = append(res.Changes, l)
				emit(Event{Type: "change", Text: l.Text, ID: l.ID})
			}
			msgs = append(msgs, llm.Message{Role: "tool", ToolCallID: tc.ID, Content: out})
		}
	}
	if strings.Contains(res.Reply, SilentReply) {
		if req.Group && len(res.Changes) == 0 {
			res.Reply, res.Silent = "", true
			return res, nil
		}
		res.Reply = strings.TrimSpace(strings.ReplaceAll(res.Reply, SilentReply, ""))
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
