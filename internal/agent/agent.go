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

	"github.com/rhapsody008/movin-tracker/internal/docs"
	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/llm"
	"github.com/rhapsody008/movin-tracker/internal/settings"
)

// InputError is a problem with the request itself (not the model or the
// endpoint); the web chat answers it with 400.
type InputError struct{ Msg string }

func (e *InputError) Error() string { return e.Msg }

// Request is one turn from a channel.
type Request struct {
	By      string // who is asking; stamped on every change
	Channel string // web, telegram
	Group   bool   // a group chat: the model may choose to stay silent
	Think   bool   // the user asked for thinking (/think); see settings.LLM.ThinkOnDemand
	Turns   []Turn
}

// ThinkCommand starts a message that asks the model to think first.
const ThinkCommand = "/think"

// ParseThink reports whether text starts with /think (any case, as its own
// word) and returns the rest of the message.
func ParseThink(text string) (string, bool) {
	t := strings.TrimSpace(text)
	if len(t) < len(ThinkCommand) || !strings.EqualFold(t[:len(ThinkCommand)], ThinkCommand) {
		return text, false
	}
	rest := t[len(ThinkCommand):]
	if rest != "" && rest[0] != ' ' && rest[0] != '\n' && rest[0] != '\t' {
		return text, false
	}
	return strings.TrimSpace(rest), true
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
	// Usage totals the turn's model calls (for logs and chateval).
	Usage llm.Usage `json:"-"`
}

// RefusalReply is what the user sees when the model declines a message.
// Changes made earlier in the turn stay (each has its own Undo).
const RefusalReply = "The model declined to answer this message. Try rephrasing it."

// NotFoundInDocsReply is the reply when the model searched the documents
// and then said nothing.
const NotFoundInDocsReply = "I looked in the documents but couldn't find an answer to that. Try other words, or name the document."

// CutOffNote ends a reply that hit the output limit.
const CutOffNote = " (cut off: the reply hit the length limit)"

// ErrCutOff is returned when the output limit stopped a round before it
// produced any usable text or complete tool calls.
var ErrCutOff = errors.New("the model's reply was cut off by the output limit before it said anything; try a shorter question")

// Event is streamed while a turn runs.
type Event struct {
	Type string `json:"type"` // "delta", "reset", "change"
	Text string `json:"text,omitempty"`
	ID   string `json:"id,omitempty"`
}

type Runner struct {
	Entries *entries.Service
	Docs    *docs.Library // nil: the documents feature is off
	Viewer  *docs.Viewer  // nil: pages can't be shown as images
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
		return Result{}, &InputError{"the last turn must be a user message"}
	}
	if cfg.BaseURL == "" || cfg.Model == "" {
		return Result{}, &InputError{"no LLM endpoint or model is configured; set one in Settings → LLM"}
	}
	snap, err := r.Entries.Current(ctx)
	if err != nil {
		return Result{}, err
	}
	system := r.SystemSections(snap.Doc, req)
	if ds := r.docsSection(ctx, cfg); ds != "" {
		// Between the rules and the entries: it changes only with a sync.
		system = append([]llm.Section{system[0], {Text: ds, CacheBreak: true}}, system[1:]...)
	}
	tools := r.tools(cfg)
	images := 0
	msgs := make([]llm.Message, 0, len(turns))
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
	lookedInDocs := false
	for round := 1; round <= rounds; round++ {
		force := round == rounds
		out, err := client.Complete(ctx, llm.Request{
			System: system, Messages: msgs, Tools: tools, ForceAnswer: force, Stream: cfg.Streaming, Think: req.Think,
			OnText: func(s string) { emit(Event{Type: "delta", Text: s}) },
		})
		if err != nil {
			return res, err
		}
		u := out.Usage
		res.Usage.In += u.In
		res.Usage.Out += u.Out
		res.Usage.CacheRead += u.CacheRead
		res.Usage.CacheWrite += u.CacheWrite
		r.Log.Info("llm call", "kind", cfg.Kind, "model", cfg.Model, "round", round, "stop", string(out.Stop),
			"in", u.In, "out", u.Out, "cacheRead", u.CacheRead, "cacheWrite", u.CacheWrite)
		m := out.Message
		switch out.Stop {
		case llm.StopRefusal:
			emit(Event{Type: "reset"}) // drop any partial streamed text
			res.Reply = RefusalReply
			return res, nil
		case llm.StopMaxTokens:
			// Tool calls cut off mid-way can't be trusted; keep only text.
			if strings.TrimSpace(m.Content) == "" {
				return res, ErrCutOff
			}
			res.Reply = strings.TrimSpace(m.Content) + CutOffNote
			return res, nil
		}
		if len(m.ToolCalls) == 0 || force {
			res.Reply = strings.TrimSpace(m.Content)
			break
		}
		if m.Content != "" {
			// Text before a tool call is a preamble; the final answer replaces it.
			emit(Event{Type: "reset"})
		}
		msgs = append(msgs, llm.Message{Role: "assistant", Content: m.Content, ToolCalls: m.ToolCalls, Native: m.Native})
		for _, tc := range m.ToolCalls {
			if tc.Function.Name == "search_documents" || tc.Function.Name == "read_document_page" {
				lookedInDocs = true
			}
			out, imgs, lines := r.exec(ctx, actor, tc)
			for _, l := range lines {
				res.Changes = append(res.Changes, l)
				emit(Event{Type: "change", Text: l.Text, ID: l.ID})
			}
			if images+len(imgs) > MaxImagesPerTurn {
				out, imgs = `{"error":"image limit for this message reached; answer from what you have seen"}`, nil
			}
			images += len(imgs)
			msgs = append(msgs, llm.Message{Role: "tool", ToolCallID: tc.ID, Content: out, Images: imgs})
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
		} else if lookedInDocs {
			res.Reply = NotFoundInDocsReply
		} else {
			res.Reply = "No answer came back. Try rephrasing."
		}
	}
	return res, nil
}
