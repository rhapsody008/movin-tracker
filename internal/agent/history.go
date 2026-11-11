package agent

import "strings"

// MaxTurns is how many recent turns are sent to the model.
const MaxTurns = 12

// Turn is one message in a conversation. In a group chat the channel puts
// the speaker's name in front of user turns ("ZY: ...").
type Turn struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// CleanTurns keeps the last MaxTurns user/assistant turns, starting on a
// user turn, with each message cut to 4000 characters.
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
