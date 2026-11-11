// Package llm talks to LLM endpoints through Provider. The types here are
// neutral (OpenAI-shaped, since that was the first wire); each provider
// maps them to its own API.
package llm

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/rhapsody008/movin-tracker/internal/settings"
)

// Message is one conversation message. Native carries a provider's own
// form of an assistant turn (for example content blocks that must be sent
// back unchanged in the next round); other providers ignore it.
type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	Native     any        `json:"-"`
	// Images go with a user message or a tool result (e.g. a drawing
	// crop). Only connections with vision get them.
	Images []Image `json:"-"`
}

// Image is a picture for the model.
type Image struct {
	MediaType string // image/png
	Data      []byte
}

type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function FunctionCall `json:"function"`
}

type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type Tool struct {
	Type     string       `json:"type"`
	Function FunctionDecl `json:"function"`
}

type FunctionDecl struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// APIError is a non-2xx answer from the endpoint, kept short for the UI.
type APIError struct {
	Status int
	Body   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("endpoint returned %d: %s", e.Status, e.Body)
}

// Provider is one kind of LLM connection. The agent, the tools and the
// channels only see this interface and the neutral types in this package.
type Provider interface {
	// Complete runs one model round.
	Complete(ctx context.Context, req Request) (Response, error)
	// Models lists the model ids the endpoint offers, sorted.
	Models(ctx context.Context) ([]string, error)
}

// Section is one part of the system prompt, most stable first.
// CacheBreak marks the end of a part worth caching on providers that
// cache prompt prefixes; providers without caching just join the texts.
type Section struct {
	Text       string
	CacheBreak bool
}

// Request is one model round.
type Request struct {
	System   []Section
	Messages []Message // user, assistant and tool messages; no system
	Tools    []Tool
	// ForceAnswer asks for words, not tool calls (the last round).
	ForceAnswer bool
	// Stream sends text deltas to OnText as they arrive.
	Stream bool
	// Think: the user asked for thinking (/think). It only matters when
	// the connection thinks on demand.
	Think  bool
	OnText func(string)
}

// Stop says why a round ended.
type Stop string

const (
	StopEnd       Stop = "end"        // a final answer
	StopTool      Stop = "tool"       // the model called tools
	StopMaxTokens Stop = "max_tokens" // cut off by the output limit
	StopRefusal   Stop = "refusal"    // the model declined
)

// Usage is the token count of one round, when the endpoint reports it.
type Usage struct {
	In, Out, CacheRead, CacheWrite int
}

// Response is the outcome of one round.
type Response struct {
	Message Message
	Stop    Stop
	Usage   Usage
}

// New returns the provider for a resolved connection.
func New(cfg settings.LLM) Provider {
	if cfg.Kind == settings.KindClaude {
		return newClaude(cfg)
	}
	return newOpenAI(cfg)
}

// joinSystem renders the sections as one string, as providers without
// prompt caching send it.
func joinSystem(secs []Section) string {
	n := 0
	for _, s := range secs {
		n += len(s.Text)
	}
	b := make([]byte, 0, n)
	for _, s := range secs {
		b = append(b, s.Text...)
	}
	return string(b)
}
