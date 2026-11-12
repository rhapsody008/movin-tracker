package telegram

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/rhapsody008/movin-tracker/internal/docs"
)

// syncReasonPrefix marks a sync started by /sync in a chat; that chat gets
// the result as a reply, so the change notice skips it.
const syncReasonPrefix = "telegram:"

// DocsChanged tells the allowed groups what a sync changed (the Syncer only
// calls it when something did, and never for the first import).
func (b *Bot) DocsChanged(ctx context.Context, res docs.Sync, changed []docs.Doc) {
	text := "Documents updated: " + counts(res) + "\n" + docList(changed, 10)
	skip := ""
	if strings.HasPrefix(res.Reason, syncReasonPrefix) {
		skip = strings.TrimPrefix(res.Reason, syncReasonPrefix)
	}
	for _, g := range b.Settings.ResolveTelegram(ctx).Groups {
		if g == skip {
			continue
		}
		id, err := strconv.ParseInt(g, 10, 64)
		if err != nil {
			continue
		}
		if _, err := b.API.SendMessage(ctx, SendMessage{ChatID: id, Text: text}); err != nil {
			b.setErr(err)
			b.Log.Warn("telegram documents notice failed", "chatId", id, "err", err)
		}
	}
}

// syncCommand runs /sync and replies with what changed.
func (b *Bot) syncCommand(ctx context.Context, m *Message) {
	if b.Docs == nil {
		b.reply(ctx, m, "Documents aren't switched on, so there's nothing to sync.", nil)
		return
	}
	if b.Docs.Running() {
		b.reply(ctx, m, "A sync is already running; I'll post the result when it's done.", nil)
	} else {
		b.reply(ctx, m, "Syncing the documents…", nil)
	}
	res, err := b.Docs.Sync(ctx, syncReasonPrefix+strconv.FormatInt(m.Chat.ID, 10))
	if err != nil {
		b.reply(ctx, m, "The sync didn't finish: "+truncate(err.Error(), 300), nil)
		return
	}
	ix, _ := b.Docs.Index(ctx)
	total := 0
	if ix != nil {
		for _, d := range ix.Docs {
			if d.Status == docs.StatusOK {
				total++
			}
		}
	}
	if !res.Changes() && res.Failed == 0 {
		b.reply(ctx, m, fmt.Sprintf("No changes. %d documents are readable.", total), nil)
		return
	}
	msg := "Synced: " + counts(res) + fmt.Sprintf(". %d documents are readable.", total)
	if ix != nil {
		var touched []docs.Doc
		for _, d := range ix.Docs {
			if d.SyncedAt == res.At || d.RemovedAt == res.At || d.ErrorAt == res.At {
				touched = append(touched, d)
			}
		}
		msg += "\n" + docList(touched, 15)
	}
	b.reply(ctx, m, msg, nil)
}

func counts(r docs.Sync) string {
	var p []string
	for _, c := range []struct {
		n    int
		what string
	}{{r.Added, "added"}, {r.Changed, "changed"}, {r.Removed, "removed"}, {r.Failed, "failed"}} {
		if c.n > 0 {
			p = append(p, fmt.Sprintf("%d %s", c.n, c.what))
		}
	}
	if len(p) == 0 {
		return "nothing changed"
	}
	return strings.Join(p, ", ")
}

func docList(ds []docs.Doc, max int) string {
	var lines []string
	for i, d := range ds {
		if i == max {
			lines = append(lines, fmt.Sprintf("…and %d more", len(ds)-max))
			break
		}
		state := ""
		switch {
		case d.Status == docs.StatusRemoved:
			state = " (removed)"
		case d.Status == docs.StatusFailed:
			state = " (couldn't be read)"
		case d.Error != "":
			state = " (the new version couldn't be read; the previous one is still used)"
		}
		if d.Class == docs.ClassScanned && d.Status == docs.StatusOK && d.Error == "" {
			state = " (pictures only: not searchable yet)"
		}
		lines = append(lines, "• "+d.Name()+state)
	}
	return strings.Join(lines, "\n")
}
