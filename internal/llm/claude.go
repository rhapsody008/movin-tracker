package llm

// The Claude provider: Anthropic's Messages API through the official Go SDK.
// It is built on the SDK's Beta messages namespace so refusal fallbacks
// (a beta) can be added without changing the request types.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"
	"github.com/anthropics/anthropic-sdk-go/v2/packages/param"

	"github.com/rhapsody008/movin-tracker/internal/settings"
)

// ClaudeMaxTokens is the output limit sent with every request (required by
// the API). Thinking counts towards it; 16000 leaves room for both without
// streaming the bot's replies.
const ClaudeMaxTokens = 16000

// claudeMaxRetries is how often the SDK retries 408/409/429/5xx and
// connection errors, all inside one call deadline.
const claudeMaxRetries = 2

type claude struct {
	cfg    settings.LLM
	client anthropic.Client
}

// cacheMark is the prompt-cache breakpoint: 5 minutes (ZY; revisit with
// the usage logs). An empty CacheControl would be omitted from the request.
var cacheMark = anthropic.BetaCacheControlEphemeralParam{TTL: anthropic.BetaCacheControlEphemeralTTLTTL5m}

func newClaude(cfg settings.LLM) *claude {
	opts := []option.RequestOption{
		// Never read ANTHROPIC_* from the environment: the key and the
		// origin come only from our settings, which bind keys to origins.
		option.WithoutEnvironmentDefaults(),
		option.WithBaseURL(strings.TrimRight(cfg.BaseURL, "/") + "/"),
		option.WithMaxRetries(claudeMaxRetries),
		option.WithHTTPClient(&http.Client{}), // the call deadline below bounds it
	}
	if cfg.APIKey != "" {
		opts = append(opts, option.WithAPIKey(cfg.APIKey))
	}
	return &claude{cfg: cfg, client: anthropic.NewClient(opts...)}
}

// deadline bounds one call, retries included.
func (c *claude) deadline(ctx context.Context) (context.Context, context.CancelFunc) {
	if c.cfg.TimeoutSec <= 0 {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, time.Duration(c.cfg.TimeoutSec)*time.Second)
}

func (c *claude) Models(ctx context.Context) ([]string, error) {
	ctx, cancel := c.deadline(ctx)
	defer cancel()
	pager := c.client.Models.ListAutoPaging(ctx, anthropic.ModelListParams{Limit: param.NewOpt(int64(1000))})
	var ids []string
	for pager.Next() {
		ids = append(ids, pager.Current().ID)
	}
	if err := pager.Err(); err != nil {
		return nil, c.mapErr(err)
	}
	sort.Strings(ids)
	return ids, nil
}

func (c *claude) Complete(ctx context.Context, in Request) (Response, error) {
	ctx, cancel := c.deadline(ctx)
	defer cancel()
	params, err := c.params(in)
	if err != nil {
		return Response{}, err
	}
	msg, err := c.call(ctx, params, in)
	if err != nil {
		return Response{}, err
	}
	if msg.StopReason == anthropic.BetaStopReasonPauseTurn {
		// The server paused a long turn; send it back once to continue.
		params.Messages = append(params.Messages, msg.ToParam())
		if msg, err = c.call(ctx, params, in); err != nil {
			return Response{}, err
		}
	}
	return claudeResponse(msg), nil
}

func (c *claude) call(ctx context.Context, params anthropic.BetaMessageNewParams, in Request) (*anthropic.BetaMessage, error) {
	if !in.Stream {
		msg, err := c.client.Beta.Messages.New(ctx, params)
		if err != nil {
			return nil, c.mapErr(err)
		}
		return msg, nil
	}
	stream := c.client.Beta.Messages.NewStreaming(ctx, params)
	defer stream.Close()
	var msg anthropic.BetaMessage
	for stream.Next() {
		ev := stream.Current()
		if err := msg.Accumulate(ev); err != nil {
			return nil, fmt.Errorf("read stream: %w", err)
		}
		// Only answer text is streamed; thinking stays hidden.
		if ev.Type == "content_block_delta" && ev.Delta.Type == "text_delta" && ev.Delta.Text != "" && in.OnText != nil {
			in.OnText(ev.Delta.Text)
		}
	}
	if err := stream.Err(); err != nil {
		return nil, c.mapErr(err)
	}
	return &msg, nil
}

// params maps a neutral request to the Messages API.
func (c *claude) params(in Request) (anthropic.BetaMessageNewParams, error) {
	p := anthropic.BetaMessageNewParams{
		Model:     c.cfg.Model,
		MaxTokens: ClaudeMaxTokens,
		// Cache the growing conversation as well as the marked system parts.
		CacheControl: cacheMark,
	}
	for _, s := range in.System {
		if s.Text == "" {
			continue
		}
		b := anthropic.BetaTextBlockParam{Text: s.Text}
		if s.CacheBreak {
			b.CacheControl = cacheMark
		}
		p.System = append(p.System, b)
	}
	tools, err := claudeTools(in.Tools)
	if err != nil {
		return p, err
	}
	p.Tools = tools
	if in.ForceAnswer && len(tools) > 0 {
		p.ToolChoice = anthropic.BetaToolChoiceUnionParam{OfNone: &anthropic.BetaToolChoiceNoneParam{}}
	}
	switch {
	case in.Think:
		p.OutputConfig.Effort = anthropic.BetaOutputConfigEffortHigh
	case c.cfg.ThinkOnDemand:
		p.OutputConfig.Effort = anthropic.BetaOutputConfigEffortLow
	}
	p.Messages, err = claudeMessages(in.Messages)
	return p, err
}

// claudeTools converts the OpenAI-shaped JSON schemas. Keys other than
// type/properties/required ride along as extra fields; json.Marshal sorts
// map keys, so the bytes are the same on every call (cache-friendly).
func claudeTools(tools []Tool) ([]anthropic.BetaToolUnionParam, error) {
	out := make([]anthropic.BetaToolUnionParam, 0, len(tools))
	for _, t := range tools {
		var schema map[string]any
		if len(t.Function.Parameters) > 0 {
			if err := json.Unmarshal(t.Function.Parameters, &schema); err != nil {
				return nil, fmt.Errorf("tool %s: parameters: %w", t.Function.Name, err)
			}
		}
		in := anthropic.BetaToolInputSchemaParam{Properties: schema["properties"]}
		if req, ok := schema["required"].([]any); ok {
			for _, r := range req {
				if s, ok := r.(string); ok {
					in.Required = append(in.Required, s)
				}
			}
		}
		for k, v := range schema {
			if k == "type" || k == "properties" || k == "required" {
				continue
			}
			if in.ExtraFields == nil {
				in.ExtraFields = map[string]any{}
			}
			in.ExtraFields[k] = v
		}
		tp := &anthropic.BetaToolParam{Name: t.Function.Name, InputSchema: in}
		if t.Function.Description != "" {
			tp.Description = param.NewOpt(t.Function.Description)
		}
		out = append(out, anthropic.BetaToolUnionParam{OfTool: tp})
	}
	return out, nil
}

// claudeMessages maps neutral messages: tool results become tool_result
// blocks in a user message, consecutive same-role messages merge (the API
// wants alternating roles), and an assistant turn the provider produced is
// sent back exactly as received (its Native blocks, thinking included).
func claudeMessages(msgs []Message) ([]anthropic.BetaMessageParam, error) {
	var out []anthropic.BetaMessageParam
	push := func(role string, blocks []anthropic.BetaContentBlockParamUnion) {
		if len(blocks) == 0 {
			return
		}
		if n := len(out); n > 0 {
			last := &out[n-1]
			if role == "user" && last.OfUser != nil {
				last.OfUser.Content = append(last.OfUser.Content, blocks...)
				return
			}
			if role == "assistant" && last.OfAssistant != nil {
				last.OfAssistant.Content = append(last.OfAssistant.Content, blocks...)
				return
			}
		}
		if role == "user" {
			out = append(out, anthropic.BetaMessageParam{OfUser: &anthropic.BetaUserMessageParam{Content: blocks}})
		} else {
			out = append(out, anthropic.BetaMessageParam{OfAssistant: &anthropic.BetaAssistantMessageParam{Content: blocks}})
		}
	}
	text := func(s string) []anthropic.BetaContentBlockParamUnion {
		if strings.TrimSpace(s) == "" {
			return nil // the API rejects empty text blocks
		}
		return []anthropic.BetaContentBlockParamUnion{{OfText: &anthropic.BetaTextBlockParam{Text: s}}}
	}
	for _, m := range msgs {
		switch m.Role {
		case "user":
			push("user", text(m.Content))
		case "tool":
			push("user", []anthropic.BetaContentBlockParamUnion{{OfToolResult: &anthropic.BetaToolResultBlockParam{
				ToolUseID: m.ToolCallID,
				Content:   []anthropic.BetaToolResultBlockParamContentUnion{{OfText: &anthropic.BetaTextBlockParam{Text: nonEmpty(m.Content)}}},
			}}})
		case "assistant":
			if native, ok := m.Native.([]anthropic.BetaContentBlockParamUnion); ok {
				push("assistant", native)
				continue
			}
			blocks := text(m.Content)
			for _, tc := range m.ToolCalls {
				args := json.RawMessage(tc.Function.Arguments)
				if !json.Valid(args) || len(strings.TrimSpace(tc.Function.Arguments)) == 0 {
					args = json.RawMessage(`{}`)
				}
				blocks = append(blocks, anthropic.BetaContentBlockParamUnion{OfToolUse: &anthropic.BetaToolUseBlockParam{
					ID: tc.ID, Name: tc.Function.Name, Input: args,
				}})
			}
			push("assistant", blocks)
		default:
			return nil, fmt.Errorf("claude: unsupported message role %q", m.Role)
		}
	}
	return out, nil
}

func nonEmpty(s string) string {
	if s == "" {
		return "(empty)"
	}
	return s
}

// claudeResponse maps the reply back: text blocks joined, tool_use blocks
// as tool calls, and the whole content kept as Native for the next round.
func claudeResponse(msg *anthropic.BetaMessage) Response {
	var text strings.Builder
	m := Message{Role: "assistant"}
	for _, b := range msg.Content {
		switch b.Type {
		case "text":
			text.WriteString(b.Text)
		case "tool_use":
			args := string(b.Input)
			if args == "" {
				args = "{}"
			}
			m.ToolCalls = append(m.ToolCalls, ToolCall{ID: b.ID, Type: "function", Function: FunctionCall{Name: b.Name, Arguments: args}})
		}
	}
	m.Content = strings.TrimSpace(text.String())
	if p := msg.ToParam(); p.OfAssistant != nil {
		m.Native = p.OfAssistant.Content
	}
	stop := StopEnd
	switch msg.StopReason {
	case anthropic.BetaStopReasonToolUse:
		stop = StopTool
	case anthropic.BetaStopReasonMaxTokens:
		stop = StopMaxTokens
	case anthropic.BetaStopReasonRefusal:
		stop = StopRefusal
	}
	if len(m.ToolCalls) > 0 && stop == StopEnd {
		stop = StopTool
	}
	u := msg.Usage
	return Response{Message: m, Stop: stop, Usage: Usage{
		In: int(u.InputTokens), Out: int(u.OutputTokens),
		CacheRead: int(u.CacheReadInputTokens), CacheWrite: int(u.CacheCreationInputTokens),
	}}
}

// mapErr turns SDK errors into our short APIError; the key never appears.
func (c *claude) mapErr(err error) error {
	var ae *anthropic.Error
	if errors.As(err, &ae) {
		msg := http.StatusText(ae.StatusCode)
		var body struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(ae.RawJSON()), &body) == nil && body.Error.Message != "" {
			msg = body.Error.Message
		}
		if len(msg) > 300 {
			msg = msg[:300] + "…"
		}
		if ae.RequestID != "" {
			msg += " (request " + ae.RequestID + ")"
		}
		return c.scrub(&APIError{Status: ae.StatusCode, Body: msg})
	}
	return c.scrub(err)
}

func (c *claude) scrub(err error) error {
	if c.cfg.APIKey == "" || !strings.Contains(err.Error(), c.cfg.APIKey) {
		return err
	}
	return fmt.Errorf("%s", strings.ReplaceAll(err.Error(), c.cfg.APIKey, "[redacted]"))
}
