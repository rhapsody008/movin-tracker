package llm_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/llm"
	"github.com/rhapsody008/movin-tracker/internal/settings"
)

var png = llm.Image{MediaType: "image/png", Data: []byte("\x89PNG-fake")}

func TestOpenAIImages(t *testing.T) {
	var raw string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		raw = string(b)
		w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer srv.Close()
	p := llm.New(settings.LLM{BaseURL: srv.URL, Model: "m", TimeoutSec: 5})
	msgs := []llm.Message{
		{Role: "user", Content: "look", Images: []llm.Image{png}},
		{Role: "assistant", ToolCalls: []llm.ToolCall{{ID: "c1", Type: "function", Function: llm.FunctionCall{Name: "view_document_page", Arguments: "{}"}}, {ID: "c2", Type: "function", Function: llm.FunctionCall{Name: "view_document_page", Arguments: "{}"}}}},
		{Role: "tool", ToolCallID: "c1", Content: `{"page":1}`, Images: []llm.Image{png}},
		{Role: "tool", ToolCallID: "c2", Content: `{"page":2}`, Images: []llm.Image{png}},
	}
	if _, err := p.Complete(context.Background(), llm.Request{Messages: msgs}); err != nil {
		t.Fatal(err)
	}
	var req struct {
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	json.Unmarshal([]byte(raw), &req)
	roles := []string{}
	for _, m := range req.Messages {
		roles = append(roles, m.Role)
	}
	// Both tool results stay text; their two images follow in one user message.
	if strings.Join(roles, ",") != "user,assistant,tool,tool,user" {
		t.Fatalf("roles %v", roles)
	}
	if !strings.HasPrefix(string(req.Messages[0].Content), `[{"type":"text","text":"look"},{"type":"image_url","image_url":{"url":"data:image/png;base64,`) {
		t.Errorf("user image parts %s", req.Messages[0].Content)
	}
	if string(req.Messages[2].Content) != `"{\"page\":1}"` {
		t.Errorf("tool content %s", req.Messages[2].Content)
	}
	if strings.Count(string(req.Messages[4].Content), `"type":"image_url"`) != 2 {
		t.Errorf("tool images message %s", req.Messages[4].Content)
	}
}

func TestClaudeImages(t *testing.T) {
	f := newFakeClaude(t, jsonReply(message("end_turn", text("ok"))))
	msgs := []llm.Message{
		{Role: "user", Content: "look", Images: []llm.Image{png}},
		{Role: "assistant", ToolCalls: []llm.ToolCall{{ID: "toolu_1", Type: "function", Function: llm.FunctionCall{Name: "view_document_page", Arguments: "{}"}}}},
		{Role: "tool", ToolCallID: "toolu_1", Content: `{"page":1}`, Images: []llm.Image{png}},
	}
	if _, err := llm.New(f.cfg()).Complete(context.Background(), llm.Request{Messages: msgs}); err != nil {
		t.Fatal(err)
	}
	raw := f.req(0).raw
	if strings.Count(raw, `"type":"image"`) != 2 || strings.Count(raw, `"media_type":"image/png"`) != 2 || !strings.Contains(raw, `"type":"tool_result"`) {
		t.Fatalf("image blocks missing: %s", raw)
	}
	var body struct {
		Messages []struct {
			Content []struct {
				Type    string `json:"type"`
				Content []struct {
					Type string `json:"type"`
				} `json:"content"`
			} `json:"content"`
		} `json:"messages"`
	}
	json.Unmarshal([]byte(raw), &body)
	tr := body.Messages[2].Content[0]
	if tr.Type != "tool_result" || len(tr.Content) != 2 || tr.Content[1].Type != "image" {
		t.Fatalf("tool_result content %+v", tr)
	}
}
