package llm

// The OpenAI-compatible provider: /chat/completions with tool calling and
// SSE streaming, /models for the list. vMLX on the Mac today, NAI later.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/settings"
)

type request struct {
	Model      string    `json:"model"`
	Messages   []wireMsg `json:"messages"`
	Tools      []Tool    `json:"tools,omitempty"`
	ToolChoice string    `json:"tool_choice,omitempty"`
	Stream     bool      `json:"stream,omitempty"`
	// ChatTemplateKwargs carries enable_thinking=false when thinking is
	// on demand and this turn didn't ask for it.
	ChatTemplateKwargs map[string]any `json:"chat_template_kwargs,omitempty"`
}

type openAI struct {
	cfg  settings.LLM
	http *http.Client
}

func newOpenAI(cfg settings.LLM) *openAI {
	return &openAI{cfg: cfg, http: &http.Client{Timeout: time.Duration(cfg.TimeoutSec) * time.Second}}
}

func (c *openAI) do(ctx context.Context, method, path string, body any) (*http.Response, error) {
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
	if c.anthropic() {
		// Anthropic's OpenAI layer covers /chat/completions only; /models
		// is its native Models API, which wants these headers instead.
		req.Header.Set("anthropic-version", "2023-06-01")
		if c.cfg.APIKey != "" {
			req.Header.Set("x-api-key", c.cfg.APIKey)
		}
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, c.scrub(err)
	}
	if resp.StatusCode/100 != 2 {
		defer func() { _ = resp.Body.Close() }()
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
func (c *openAI) scrub(err error) error {
	if c.cfg.APIKey == "" || !strings.Contains(err.Error(), c.cfg.APIKey) {
		return err
	}
	return fmt.Errorf("%s", strings.ReplaceAll(err.Error(), c.cfg.APIKey, "[redacted]"))
}

// anthropic reports whether the endpoint is Anthropic's own API.
func (c *openAI) anthropic() bool {
	u, err := url.Parse(c.cfg.BaseURL)
	return err == nil && strings.EqualFold(u.Hostname(), "api.anthropic.com")
}

// Models lists the model ids the endpoint offers.
func (c *openAI) Models(ctx context.Context) ([]string, error) {
	path := "/models"
	if c.anthropic() {
		path += "?limit=1000" // it pages, 20 by default
	}
	resp, err := c.do(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
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

// Complete runs one chat completion. The system sections are joined into
// one system message. With Stream set, text deltas go to OnText as they
// arrive and tool call fragments are reassembled. ForceAnswer sends
// tool_choice "none" so the model has to reply in words.
func (c *openAI) Complete(ctx context.Context, in Request) (Response, error) {
	msgs := in.Messages
	if sys := joinSystem(in.System); sys != "" {
		msgs = append([]Message{{Role: "system", Content: sys}}, in.Messages...)
	}
	req := request{
		Model: c.cfg.Model, Messages: toWire(msgs), Tools: in.Tools,
		Stream: in.Stream,
	}
	if in.ForceAnswer && len(in.Tools) > 0 {
		req.ToolChoice = "none"
	}
	if c.cfg.ThinkOnDemand && !in.Think {
		req.ChatTemplateKwargs = map[string]any{"enable_thinking": false}
	}
	resp, err := c.do(ctx, http.MethodPost, "/chat/completions", req)
	if err != nil {
		return Response{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if !in.Stream || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		var out struct {
			Choices []struct {
				Message      Message `json:"message"`
				FinishReason string  `json:"finish_reason"`
			} `json:"choices"`
			Usage struct {
				PromptTokens        int `json:"prompt_tokens"`
				CompletionTokens    int `json:"completion_tokens"`
				PromptTokensDetails struct {
					CachedTokens int `json:"cached_tokens"`
				} `json:"prompt_tokens_details"`
			} `json:"usage"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			return Response{}, fmt.Errorf("decode completion: %w", err)
		}
		if len(out.Choices) == 0 {
			return Response{}, fmt.Errorf("endpoint returned no choices")
		}
		m := out.Choices[0].Message
		m.Role = "assistant"
		m.Content = StripSpecialTokens(m.Content)
		if in.OnText != nil && m.Content != "" {
			in.OnText(m.Content)
		}
		u := out.Usage
		return Response{
			Message: m, Stop: stopOf(m, out.Choices[0].FinishReason),
			Usage: Usage{In: u.PromptTokens, Out: u.CompletionTokens, CacheRead: u.PromptTokensDetails.CachedTokens},
		}, nil
	}
	m, finish, err := readStream(resp.Body, in.OnText)
	if err != nil {
		return Response{}, err
	}
	return Response{Message: m, Stop: stopOf(m, finish)}, nil
}

// wireMsg is a message as /chat/completions takes it: the same fields as
// Message (same order, so text-only requests are byte-identical), with
// content either a string or, when there are images, a list of parts.
type wireMsg struct {
	Role       string     `json:"role"`
	Content    any        `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type part struct {
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	ImageURL *imageURL `json:"image_url,omitempty"`
}

type imageURL struct {
	URL string `json:"url"`
}

func imageParts(text string, imgs []Image) []part {
	parts := []part{{Type: "text", Text: text}}
	for _, im := range imgs {
		parts = append(parts, part{Type: "image_url", ImageURL: &imageURL{URL: "data:" + im.MediaType + ";base64," + base64.StdEncoding.EncodeToString(im.Data)}})
	}
	return parts
}

// toWire maps messages. Tool results can only carry text here, so their
// images follow the run of tool messages as one user message.
func toWire(msgs []Message) []wireMsg {
	out := make([]wireMsg, 0, len(msgs))
	var pending []Image
	flush := func() {
		if len(pending) > 0 {
			out = append(out, wireMsg{Role: "user", Content: imageParts("Images returned by the tools above.", pending)})
			pending = nil
		}
	}
	for _, m := range msgs {
		if m.Role != "tool" {
			flush()
		}
		w := wireMsg{Role: m.Role, Content: m.Content, ToolCalls: m.ToolCalls, ToolCallID: m.ToolCallID}
		switch {
		case m.Role == "tool":
			pending = append(pending, m.Images...)
		case len(m.Images) > 0:
			w.Content = imageParts(m.Content, m.Images)
		}
		out = append(out, w)
	}
	flush()
	return out
}

// stopOf maps an OpenAI finish_reason; tool calls win over the reason.
func stopOf(m Message, finish string) Stop {
	switch {
	case len(m.ToolCalls) > 0:
		return StopTool
	case finish == "length":
		return StopMaxTokens
	case finish == "content_filter":
		return StopRefusal
	}
	return StopEnd
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

// streamDelta is one streamed chunk's delta (OpenAI wire format).
type streamDelta struct {
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

type streamChunk struct {
	Choices []struct {
		Delta        streamDelta `json:"delta"`
		FinishReason string      `json:"finish_reason"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// streamAcc assembles the reply from deltas: text in order, tool calls by
// index (their names and arguments arrive in pieces).
type streamAcc struct {
	text  strings.Builder
	calls map[int]*ToolCall
}

func (a *streamAcc) add(d streamDelta, onText func(string)) {
	if d.Content = StripSpecialTokens(d.Content); d.Content != "" {
		a.text.WriteString(d.Content)
		if onText != nil {
			onText(d.Content)
		}
	}
	for _, tc := range d.ToolCalls {
		c, ok := a.calls[tc.Index]
		if !ok {
			c = &ToolCall{Type: "function"}
			a.calls[tc.Index] = c
		}
		if tc.ID != "" {
			c.ID = tc.ID
		}
		c.Function.Name += tc.Function.Name
		c.Function.Arguments += tc.Function.Arguments
	}
}

func (a *streamAcc) message() Message {
	m := Message{Role: "assistant", Content: StripSpecialTokens(a.text.String())}
	idx := make([]int, 0, len(a.calls))
	for i := range a.calls {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	for _, i := range idx {
		c := a.calls[i]
		if c.ID == "" {
			c.ID = fmt.Sprintf("call_%d", i)
		}
		m.ToolCalls = append(m.ToolCalls, *c)
	}
	return m
}

func readStream(r io.Reader, onText func(string)) (Message, string, error) {
	acc := &streamAcc{calls: map[int]*ToolCall{}}
	var finish string
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		data, ok := strings.CutPrefix(sc.Text(), "data:")
		if !ok {
			continue
		}
		if data = strings.TrimSpace(data); data == "[DONE]" {
			break
		}
		var chunk streamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if chunk.Error != nil {
			return Message{}, "", fmt.Errorf("endpoint error mid-stream: %s", chunk.Error.Message)
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		if f := chunk.Choices[0].FinishReason; f != "" {
			finish = f
		}
		acc.add(chunk.Choices[0].Delta, onText)
	}
	if err := sc.Err(); err != nil {
		return Message{}, "", fmt.Errorf("read stream: %w", err)
	}
	return acc.message(), finish, nil
}
