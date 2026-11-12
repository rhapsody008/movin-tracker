package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/sched"
)

// Checkin configures the morning check-in (nil on the Bot: off).
type Checkin struct {
	Hour, Minute int
	// Chat is where it goes; 0 = the first allowed group, else the first
	// allowed person.
	Chat  int64
	State *CheckinStore
}

const (
	// maxAskMessages caps the per-task messages; the rest are listed.
	maxAskMessages = 8
	// maxOverdueTitles caps the overdue titles in the summary.
	maxOverdueTitles = 5
	checkinPrefix    = "ci:"
)

// ErrNoCheckinChat means there is nowhere to send the check-in.
var ErrNoCheckinChat = errors.New("no group or person is allowed, and CHECKIN_CHAT is not set")

func (b *Bot) loc() *time.Location {
	if b.Agent != nil && b.Agent.Loc != nil {
		return b.Agent.Loc
	}
	return time.UTC
}

// checkinChat is where the scheduled check-in goes.
func (b *Bot) checkinChat(ctx context.Context) (int64, error) {
	if b.Checkin != nil && b.Checkin.Chat != 0 {
		return b.Checkin.Chat, nil
	}
	tg := b.Settings.ResolveTelegram(ctx)
	for _, g := range tg.Groups {
		if id, err := strconv.ParseInt(g, 10, 64); err == nil {
			return id, nil
		}
	}
	for _, u := range tg.Users {
		if id, err := strconv.ParseInt(u.ID, 10, 64); err == nil {
			return id, nil
		}
	}
	return 0, ErrNoCheckinChat
}

// shortDay is "Wed 11 Nov".
func shortDay(day string) string {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return day
	}
	return t.Format("Mon 2 Jan")
}

func agendaLine(e entries.Entry) string {
	s := e.Title
	if e.Time != nil {
		s = *e.Time + " " + s
	}
	if e.Room != nil {
		s += " (" + *e.Room + ")"
	}
	return s
}

// checkinText builds the summary and the per-task messages.
func checkinText(today string, ag entries.Agenda) (summary string, asks []entries.Entry) {
	var b strings.Builder
	fmt.Fprintf(&b, "Good morning! %s\n", shortDay(today))
	if len(ag.Today) > 0 {
		b.WriteString("\nToday:\n")
		for _, e := range ag.Today {
			b.WriteString("• " + agendaLine(e) + "\n")
		}
	} else {
		b.WriteString("\nNothing dated for today.\n")
	}
	asks = ag.Ask
	var more []entries.Entry
	if len(asks) > maxAskMessages {
		asks, more = asks[:maxAskMessages], asks[maxAskMessages:]
	}
	if len(asks) > 0 {
		fmt.Fprintf(&b, "\nNot marked done yet (%d), below. Tap a button or just tell me.\n", len(ag.Ask))
	}
	if len(more) > 0 {
		b.WriteString("Also open from earlier days:\n")
		for _, e := range more {
			b.WriteString("• " + agendaLine(e) + " — " + shortDay(*e.Date) + "\n")
		}
	}
	if n := len(ag.Overdue); n > 0 {
		fmt.Fprintf(&b, "\nStill overdue (%d):\n", n)
		for i, e := range ag.Overdue {
			if i == maxOverdueTitles {
				fmt.Fprintf(&b, "…and %d more\n", n-maxOverdueTitles)
				break
			}
			b.WriteString("• " + agendaLine(e) + " — " + shortDay(*e.Date) + "\n")
		}
	}
	b.WriteString("\nAnything else, just say it, e.g. \"move the tiler to Friday\".")
	return b.String(), asks
}

func askText(e entries.Entry, today string) string {
	when := shortDay(*e.Date)
	if *e.Date == sched.AddDays(today, -1) {
		when = "Yesterday"
	}
	return when + ": " + agendaLine(e) + "\nDone?"
}

func askKeyboard(id string) *InlineKeyboardMarkup {
	return &InlineKeyboardMarkup{InlineKeyboard: [][]InlineKeyboardButton{{
		{Text: "Done", CallbackData: checkinPrefix + "d:" + id},
		{Text: "Done ★", CallbackData: checkinPrefix + "m:" + id},
		{Text: "Tomorrow", CallbackData: checkinPrefix + "r:" + id + ":1"},
		{Text: "+1 week", CallbackData: checkinPrefix + "r:" + id + ":7"},
	}}}
}

// sendCheckin posts the summary and one message per task to answer. It
// fails only if the summary couldn't be sent; a later message failing is
// logged (the summary already reached the chat).
func (b *Bot) sendCheckin(ctx context.Context, chatID int64, today string, ag entries.Agenda) error {
	summary, asks := checkinText(today, ag)
	var lead string
	for i, p := range split(summary, maxMessage) {
		if _, err := b.API.SendMessage(ctx, SendMessage{ChatID: chatID, Text: p}); err != nil {
			b.setErr(err)
			if i == 0 {
				return err
			}
			b.Log.Warn("telegram check-in part failed", "chatId", chatID, "err", err)
		}
		lead += p
	}
	var asked []string
	for _, e := range asks {
		txt := askText(e, today)
		if _, err := b.API.SendMessage(ctx, SendMessage{ChatID: chatID, Text: txt, ReplyMarkup: askKeyboard(e.ID)}); err != nil {
			b.setErr(err)
			b.Log.Warn("telegram check-in task message failed", "chatId", chatID, "entryId", e.ID, "err", err)
			continue
		}
		asked = append(asked, "• "+strings.ReplaceAll(txt, "\nDone?", ""))
	}
	// Into the chat's history, so a reply in words ("the first one's done")
	// reaches the agent with the check-in it answers.
	reply := lead
	if len(asked) > 0 {
		reply += "\n\nAsked about:\n" + strings.Join(asked, "\n")
	}
	b.remember(chatID, agent.Turn{Role: "user", Content: "(morning check-in)"}, agent.Turn{Role: "assistant", Content: reply})
	return nil
}

// remember appends turns to a chat's history.
func (b *Bot) remember(chatID int64, turns ...agent.Turn) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.history == nil {
		b.history = map[int64]*chatHistory{}
	}
	h := b.history[chatID]
	if h == nil || b.now().Sub(h.last) > b.idleReset() {
		h = &chatHistory{}
		b.history[chatID] = h
	}
	h.turns = agent.CleanTurns(append(h.turns, turns...))
	h.last = b.now()
}

func (b *Bot) idleReset() time.Duration {
	if b.IdleReset > 0 {
		return b.IdleReset
	}
	return 2 * time.Hour
}

// checkinCommand sends the check-in to this chat now. It doesn't touch the
// day's record: the scheduled one still goes out.
func (b *Bot) checkinCommand(ctx context.Context, m *Message) {
	snap, err := b.Entries.Current(ctx)
	if err != nil {
		b.reply(ctx, m, "Couldn't read the entries right now.", nil)
		return
	}
	today := sched.Day(b.now(), b.loc())
	since := ""
	if b.Checkin != nil && b.Checkin.State != nil {
		// Days missed since the last check-in are asked about too.
		if r, _, err := b.Checkin.State.Load(ctx); err == nil {
			if s := r.Since(); s != "" && s < sched.AddDays(today, -1) {
				since = s
			}
		}
	}
	ag := snap.Doc.Agenda(today, since)
	if ag.Quiet() {
		b.reply(ctx, m, "Nothing dated for today, and no open tasks from before.", nil)
		return
	}
	if err := b.sendCheckin(ctx, m.Chat.ID, today, ag); err != nil {
		b.Log.Warn("telegram check-in failed", "chatId", m.Chat.ID, "err", err)
	}
}

// checkinCallback handles a check-in button: ci:d:<id> done, ci:m:<id>
// done + milestone, ci:r:<id>:<days> move the date to today + days.
func (b *Bot) checkinCallback(ctx context.Context, cb *CallbackQuery, name string) {
	m := cb.Message
	parts := strings.Split(strings.TrimPrefix(cb.Data, checkinPrefix), ":")
	if len(parts) < 2 {
		_ = b.API.AnswerCallbackQuery(ctx, cb.ID, "")
		return
	}
	op, id := parts[0], parts[1]
	snap, err := b.Entries.Current(ctx)
	if err != nil {
		_ = b.API.AnswerCallbackQuery(ctx, cb.ID, "Couldn't read the entries right now.")
		return
	}
	e, ok := snap.Doc.Find(id)
	switch {
	case !ok:
		b.closeAsk(ctx, cb, "That entry is gone.")
		return
	case e.Archived:
		b.closeAsk(ctx, cb, "That entry was archived.")
		return
	case e.Status == entries.StatusDone:
		b.closeAsk(ctx, cb, "Already done.")
		return
	}
	var patch map[string]any
	switch op {
	case "d":
		patch = map[string]any{"status": entries.StatusDone}
	case "m":
		patch = map[string]any{"status": entries.StatusDone, "milestone": true}
	case "r":
		days := 0
		if len(parts) == 3 {
			days, _ = strconv.Atoi(parts[2])
		}
		if days < 1 || days > 31 {
			_ = b.API.AnswerCallbackQuery(ctx, cb.ID, "")
			return
		}
		patch = map[string]any{"date": sched.AddDays(sched.Day(b.now(), b.loc()), days)}
	default:
		_ = b.API.AnswerCallbackQuery(ctx, cb.ID, "")
		return
	}
	raw, _ := json.Marshal(patch)
	var p entries.Patch
	_ = json.Unmarshal(raw, &p)
	res, err := b.Entries.Update(ctx, entries.Actor{By: name, Channel: "telegram"}, id, p)
	if err != nil {
		b.Log.Warn("telegram check-in update failed", "by", name, "entryId", id, "err", err)
		_ = b.API.AnswerCallbackQuery(ctx, cb.ID, "Couldn't save that; try again or tell me in words.")
		return
	}
	line := agent.ChangeText(res.Changes[0])
	b.closeAsk(ctx, cb, truncate(line, 190))
	who := ""
	if m.Chat.IsGroup() {
		who = name + ": "
	}
	b.reply(ctx, m, "✓ "+who+line, undoKeyboard([]agent.ChangeLine{{ID: res.Changes[0].ID, Text: line}}))
}

// closeAsk answers the button press and removes that message's buttons, so
// the task can't be answered twice.
func (b *Bot) closeAsk(ctx context.Context, cb *CallbackQuery, text string) {
	_ = b.API.AnswerCallbackQuery(ctx, cb.ID, text)
	if cb.Message.ReplyMarkup != nil {
		_ = b.API.EditMessageReplyMarkup(ctx, cb.Message.Chat.ID, cb.Message.MessageID, nil)
	}
}

// CheckinLoop sends the morning check-in at most once a day. It checks
// once at start and then every `every` (a minute in the app): a wall-clock
// check rather than one long timer, because timers drift while a laptop
// sleeps. So if the app wasn't running at the scheduled time, the check-in
// goes out when it starts, until CheckinCutoff. Returns when ctx ends.
func (b *Bot) CheckinLoop(ctx context.Context, every time.Duration) {
	if b.Checkin == nil || b.Checkin.State == nil {
		return
	}
	b.Log.Info("morning check-in on", "at", fmt.Sprintf("%02d:%02d", b.Checkin.Hour, b.Checkin.Minute), "until", fmt.Sprintf("%02d:00", CheckinCutoff))
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		b.CheckinTick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// CheckinTick sends today's check-in if it is due and nobody has yet.
func (b *Bot) CheckinTick(ctx context.Context) {
	now := b.now()
	ci := b.Checkin
	if !CheckinDue(now, ci.Hour, ci.Minute, b.loc()) {
		return
	}
	day := sched.Day(now, b.loc())
	b.mu.Lock()
	handled := b.checkinDay == day
	b.mu.Unlock()
	if handled {
		return
	}
	markHandled := func() {
		b.mu.Lock()
		b.checkinDay = day
		b.mu.Unlock()
	}
	chat, err := b.checkinChat(ctx)
	if err != nil {
		b.Log.Warn("morning check-in skipped today", "err", err)
		markHandled()
		return
	}
	prev, tag, ok, err := ci.State.Claim(ctx, day, strconv.FormatInt(chat, 10))
	if err != nil {
		b.Log.Warn("morning check-in: couldn't read or claim the day; will retry", "err", err)
		return
	}
	if !ok { // already sent, quiet, or another copy of the app is sending it
		markHandled()
		return
	}
	claim := CheckinRecord{Day: day, Chat: strconv.FormatInt(chat, 10)}
	snap, err := b.Entries.Current(ctx)
	if err != nil {
		b.Log.Warn("morning check-in: couldn't read the entries; will retry", "err", err)
		_ = ci.State.Release(ctx, tag, prev)
		return
	}
	ag := snap.Doc.Agenda(day, prev.Since())
	if ag.Quiet() {
		if err := ci.State.Finish(ctx, tag, claim, CheckinQuiet); err != nil {
			b.Log.Warn("morning check-in: couldn't record a quiet day", "err", err)
		}
		b.Log.Info("morning check-in: nothing to report today", "day", day)
		markHandled()
		return
	}
	if err := b.sendCheckin(ctx, chat, day, ag); err != nil {
		b.Log.Warn("morning check-in couldn't be sent; will retry", "chatId", chat, "err", err)
		if err := ci.State.Release(ctx, tag, prev); err != nil {
			b.Log.Warn("morning check-in: couldn't give the day back; it can be retaken in 10 minutes", "err", err)
		}
		return
	}
	if err := ci.State.Finish(ctx, tag, claim, CheckinSent); err != nil {
		b.Log.Warn("morning check-in sent but not recorded", "err", err)
	}
	b.Log.Info("morning check-in sent", "day", day, "chatId", chat, "today", len(ag.Today), "asked", len(ag.Ask), "overdue", len(ag.Overdue))
	markHandled()
}

// CheckinView is the check-in's state for the admin page.
type CheckinView struct {
	On    bool           `json:"on"`
	At    string         `json:"at,omitempty"`    // HH:MM
	Until string         `json:"until,omitempty"` // HH:MM cutoff
	Chat  string         `json:"chat,omitempty"`  // where it goes
	Error string         `json:"error,omitempty"` // why it can't go anywhere
	Last  *CheckinRecord `json:"last,omitempty"`
}

// CheckinStatus reports the check-in for the admin page (nil without a bot).
func (b *Bot) CheckinStatus(ctx context.Context) *CheckinView {
	if b == nil {
		return nil
	}
	if b.Checkin == nil || b.Checkin.State == nil {
		return &CheckinView{}
	}
	v := &CheckinView{On: true, At: fmt.Sprintf("%02d:%02d", b.Checkin.Hour, b.Checkin.Minute), Until: fmt.Sprintf("%02d:00", CheckinCutoff)}
	if chat, err := b.checkinChat(ctx); err != nil {
		v.Error = err.Error()
	} else {
		v.Chat = strconv.FormatInt(chat, 10)
	}
	if r, _, err := b.Checkin.State.Load(ctx); err == nil && r.Day != "" {
		v.Last = &r
	}
	return v
}
