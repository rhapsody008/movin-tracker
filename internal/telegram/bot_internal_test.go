package telegram

import (
	"strings"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/agent"
)

func TestSplit(t *testing.T) {
	if got := split("short", 10); len(got) != 1 || got[0] != "short" {
		t.Fatalf("short: %q", got)
	}
	if got := split("", 10); len(got) != 1 {
		t.Fatalf("empty: %q", got)
	}
	// Prefers a line break in the second half of the window.
	got := split("aaaaaaa\nbbbbbbbbb\ncc", 10)
	if strings.Join(got, "|") != "aaaaaaa|bbbbbbbbb|cc" {
		t.Fatalf("lines: %q", got)
	}
	// No break: hard cut, by runes not bytes.
	got = split(strings.Repeat("é", 25), 10)
	if len(got) != 3 || len([]rune(got[0])) != 10 || len([]rune(got[2])) != 5 {
		t.Fatalf("runes: %q", got)
	}
}

func TestUndoKeyboard(t *testing.T) {
	if undoKeyboard(nil) != nil || undoKeyboard([]agent.ChangeLine{{Text: "Move-in set"}}) != nil {
		t.Fatal("no journaled change, no keyboard")
	}
	kb := undoKeyboard([]agent.ChangeLine{{ID: "a", Text: "x"}})
	if len(kb.InlineKeyboard) != 1 || kb.InlineKeyboard[0][0].Text != "Undo" || kb.InlineKeyboard[0][0].CallbackData != "undo:a" {
		t.Fatalf("one: %+v", kb)
	}
	var many []agent.ChangeLine
	for i := 0; i < 10; i++ {
		many = append(many, agent.ChangeLine{ID: string(rune('a' + i)), Text: "x"})
	}
	kb = undoKeyboard(many)
	if len(kb.InlineKeyboard) != 2 || len(kb.InlineKeyboard[0]) != 4 || len(kb.InlineKeyboard[1]) != 4 || kb.InlineKeyboard[1][3].Text != "Undo 8" {
		t.Fatalf("many: %+v", kb)
	}
}
