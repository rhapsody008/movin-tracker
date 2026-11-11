// Package llm is a minimal client for an OpenAI-compatible
// /chat/completions endpoint with tool calling.
package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/settings"
)

type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
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

type request struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	Tools       []Tool    `json:"tools,omitempty"`
	ToolChoice  string    `json:"tool_choice,omitempty"`
	Temperature float64   `json:"temperature"`
	MaxTokens   int       `json:"max_tokens"`
	Stream      bool      `json:"stream,omitempty"`
}

// APIError is a non-2xx answer from the endpoint, kept short for the UI.
type APIError struct {
	Status int
	Body   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("endpoint returned %d: %s", e.Status, e.Body)
}

type Client struct {
	cfg  settings.LLM
	http *http.Client
}

func New(cfg settings.LLM) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: time.Duration(cfg.TimeoutSec) * time.Second}}
}

func (c *Client) do(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.cfg.BaseURL, "/")+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, c.scrub(err)
	}
	if resp.StatusCode/100 != 2 {
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2000))
		msg := strings.TrimSpace(string(b))
		var e struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(b, &e) == nil && e.Error.Message != "" {
			msg = e.Error.Message
		}
		if len(msg) > 300 {
			msg = msg[:300] + "…"
		}
		return nil, c.scrub(&APIError{Status: resp.StatusCode, Body: msg})
	}
	return resp, nil
}

// scrub removes the API key from an error in case an endpoint echoes it.
func (c *Client) scrub(err error) error {
	if c.cfg.APIKey == "" || !strings.Contains(err.Error(), c.cfg.APIKey) {
		return err
	}
	return fmt.Errorf("%s", strings.ReplaceAll(err.Error(), c.cfg.APIKey, "[redacted]"))
}

// Models lists the model ids the endpoint offers.
func (c *Client) Models(ctx context.Context) ([]string, error) {
	resp, err := c.do(ctx, http.MethodGet, "/models", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode models list: %w", err)
	}
	ids := make([]string, 0, len(out.Data))
	for _, m := range out.Data {
		ids = append(ids, m.ID)
	}
	sort.Strings(ids)
	return ids, nil
}

// Complete runs one chat completion. With stream set, text deltas go to
// onText as they arrive and tool call fragments are reassembled.
// forceAnswer sends tool_choice "none" so the model has to reply in words.
func (c *Client) Complete(ctx context.Context, msgs []Message, tools []Tool, forceAnswer, stream bool, onText func(string)) (Message, error) {
	req := request{
		Model: c.cfg.Model, Messages: msgs, Tools: tools,
		Temperature: c.cfg.Temperature, MaxTokens: c.cfg.MaxTokens, Stream: stream,
	}
	if forceAnswer && len(tools) > 0 {
		req.ToolChoice = "none"
	}
	resp, err := c.do(ctx, http.MethodPost, "/chat/completions", req)
	if err != nil {
		return Message{}, err
	}
	defer resp.Body.Close()
	if !stream || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		var out struct {
			Choices []struct {
				Message Message `json:"message"`
			} `json:"choices"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			return Message{}, fmt.Errorf("decode completion: %w", err)
		}
		if len(out.Choices) == 0 {
			return Message{}, fmt.Errorf("endpoint returned no choices")
		}
		m := out.Choices[0].Message
		m.Role = "assistant"
		m.Content = StripSpecialTokens(m.Content)
		if onText != nil && m.Content != "" {
			onText(m.Content)
		}
		return m, nil
	}
	return readStream(resp.Body, onText)
}

// specialTokenRe matches chat-template control tokens that some local
// servers (e.g. vMLX) leak into the reply text.
var specialTokenRe = regexp.MustCompile(`<\|(?:im_end|im_start|eot_id|end_of_text|endoftext|end|eom_id)\|>`)

// StripSpecialTokens removes leaked chat-template tokens from model text.
func StripSpecialTokens(s string) string {
	if !strings.Contains(s, "<|") {
		return s
	}
	return strings.TrimSpace(specialTokenRe.ReplaceAllString(s, ""))
}

func readStream(r io.Reader, onText func(string)) (Message, error) {
	type delta struct {
		Content   string `json:"content"`
		ToolCalls []struct {
			Index    int    `json:"index"`
			ID       string `json:"id"`
			Type     string `json:"type"`
			Function struct {
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			} `json:"function"`
		} `json:"tool_calls"`
	}
	var text strings.Builder
	calls := map[int]*ToolCall{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta delta `json:"delta"`
			} `json:"choices"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if chunk.Error != nil {
			return Message{}, fmt.Errorf("endpoint error mid-stream: %s", chunk.Error.Message)
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		d := chunk.Choices[0].Delta
		d.Content = StripSpecialTokens(d.Content)
		if d.Content != "" {
			text.WriteString(d.Content)
			if onText != nil {
				onText(d.Content)
			}
		}
		for _, tc := range d.ToolCalls {
			c, ok := calls[tc.Index]
			if !ok {
				c = &ToolCall{Type: "function"}
				calls[tc.Index] = c
			}
			if tc.ID != "" {
				c.ID = tc.ID
			}
			if tc.Function.Name != "" {
				c.Function.Name += tc.Function.Name
			}
			c.Function.Arguments += tc.Function.Arguments
		}
	}
	if err := sc.Err(); err != nil {
		return Message{}, fmt.Errorf("read stream: %w", err)
	}
	m := Message{Role: "assistant", Content: StripSpecialTokens(text.String())}
	idx := make([]int, 0, len(calls))
	for i := range calls {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	for _, i := range idx {
		c := calls[i]
		if c.ID == "" {
			c.ID = fmt.Sprintf("call_%d", i)
		}
		m.ToolCalls = append(m.ToolCalls, *c)
	}
	return m, nil
}
