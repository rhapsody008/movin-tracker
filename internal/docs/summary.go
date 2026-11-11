package docs

import (
	"context"
	"errors"
	"strings"

	"github.com/rhapsody008/movin-tracker/internal/llm"
	"github.com/rhapsody008/movin-tracker/internal/settings"
)

// MaxSummaryLen caps a summary (runes): it is one line in every prompt.
const MaxSummaryLen = 160

// LLMSummariser writes summaries with the connection saved in Settings
// (the same one the chat uses), without streaming or thinking.
type LLMSummariser struct {
	Settings *settings.Service
}

const summaryPrompt = "You write one-line descriptions of a family's household documents (a new condo: drawings, checklists, letters, appliance manuals). " +
	"Given a file name and the start of its text, answer with one plain line of at most 20 words saying what the document is and what it is useful for. " +
	"No quotes, no lead-in, no personal details such as names, phone numbers, emails or passwords."

func (s *LLMSummariser) Summarise(ctx context.Context, d Doc, text string) (string, error) {
	cfg := s.Settings.Resolve(ctx)
	if cfg.BaseURL == "" || cfg.Model == "" {
		return "", errors.New("no LLM connection configured")
	}
	cfg.Streaming = false
	name := d.Name()
	if f := d.Folder(); f != "" {
		name = f + "/" + name
	}
	res, err := llm.New(cfg).Complete(ctx, llm.Request{
		System:   []llm.Section{{Text: summaryPrompt}},
		Messages: []llm.Message{{Role: "user", Content: "File: " + name + "\n\nStart of the text:\n" + text}},
	})
	if err != nil {
		return "", err
	}
	return tidySummary(res.Message.Content), nil
}

// tidySummary keeps the first non-empty line, without quotes, capped.
func tidySummary(s string) string {
	for _, line := range strings.Split(s, "\n") {
		line = strings.Trim(strings.TrimSpace(line), `"'“”`)
		if line == "" {
			continue
		}
		if r := []rune(line); len(r) > MaxSummaryLen {
			line = strings.TrimSpace(string(r[:MaxSummaryLen-1])) + "…"
		}
		return line
	}
	return ""
}
