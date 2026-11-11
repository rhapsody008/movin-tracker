package telegram

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/entries"
)

// Commands is the menu Telegram shows when typing "/".
var Commands = []BotCommand{
	{Command: "think", Description: "Think it through first (slower), e.g. /think compare the quotes"},
	{Command: "recent", Description: "Show the last 10 changes"},
	{Command: "undo", Description: "Undo my last change"},
	{Command: "sync", Description: "Re-read the documents now"},
	{Command: "help", Description: "What I can do"},
}

const helpText = `Tell me what's happening with the renovation and I'll keep the record: ideas, decisions, quotes, payments, dates, open questions. Ask me anything about it too.

Examples:
• Thinking of fluted glass for the dry kitchen sliding door
• Lim quoted 18k for carpentry, paid 30% today
• Electrician coming Friday 2pm to check the DB
• What did we decide for the kitchen and what did it cost?

Every change comes back with an Undo button.
/think   start a message with it when I should think it through first (slower), e.g. /think compare the two zip blind quotes
/recent  the last 10 changes
/undo    undo your last change
/sync    re-read the documents now (they also sync every night)
/help    this message`

// command handles a /command. In groups, "/cmd@otherbot" is for another bot
// and is ignored.
func (b *Bot) command(ctx context.Context, m *Message, name, text string) {
	word := strings.Fields(text)[0]
	rest := strings.TrimSpace(text[len(word):])
	cmd, target, _ := strings.Cut(strings.TrimPrefix(word, "/"), "@")
	b.mu.Lock()
	me := b.st.BotUsername
	b.mu.Unlock()
	if target != "" && me != "" && !strings.EqualFold(target, me) {
		return
	}
	switch strings.ToLower(cmd) {
	case "think":
		if rest == "" {
			b.reply(ctx, m, "Put your question after /think, e.g. /think which countertop fits our budget better?", nil)
			return
		}
		b.converse(ctx, m, name, rest, true)
	case "start", "help":
		b.reply(ctx, m, helpText, nil)
	case "recent":
		b.recent(ctx, m)
	case "undo":
		b.undoLast(ctx, m, name)
	case "sync":
		b.syncCommand(ctx, m)
	default:
		b.reply(ctx, m, "I don't know /"+cmd+". Send /help to see what I can do.", nil)
	}
}

func (b *Bot) recent(ctx context.Context, m *Message) {
	changes, err := b.Entries.Recent(ctx, 10, "")
	if err != nil {
		b.reply(ctx, m, "Couldn't read the history right now.", nil)
		return
	}
	if len(changes) == 0 {
		b.reply(ctx, m, "Nothing has been recorded yet.", nil)
		return
	}
	var lines []string
	for _, c := range changes {
		at := c.At
		if t, err := time.Parse(time.RFC3339, c.At); err == nil {
			at = t.In(b.Agent.Loc).Format("Mon 2 Jan 15:04")
		}
		via := ""
		if c.Channel == "web" {
			via = " (web)"
		}
		lines = append(lines, fmt.Sprintf("• %s — %s%s, %s", agent.ChangeText(c), c.By, via, at))
	}
	b.reply(ctx, m, "Last changes, newest first:\n"+strings.Join(lines, "\n"), nil)
}

// undoLast undoes the caller's own latest change, never someone else's.
func (b *Bot) undoLast(ctx context.Context, m *Message, name string) {
	mine, err := b.Entries.Recent(ctx, 1, name)
	if err != nil || len(mine) == 0 {
		b.reply(ctx, m, "You have no recent change to undo.", nil)
		return
	}
	res, err := b.Entries.Undo(ctx, entries.Actor{By: name, Channel: "telegram"}, mine[0].ID)
	switch {
	case errors.Is(err, entries.ErrUndoStale):
		b.reply(ctx, m, "Your last change was to an entry that has been changed again since, so I left it alone.", nil)
	case err != nil:
		b.reply(ctx, m, "Couldn't undo that right now.", nil)
	default:
		line := agent.ChangeText(res.Changes[0])
		b.reply(ctx, m, "↩ "+line, undoKeyboard([]agent.ChangeLine{{ID: res.Changes[0].ID, Text: line}}))
	}
}
