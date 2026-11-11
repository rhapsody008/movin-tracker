package telegram

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/docs"
	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/settings"
)

// Bot long-polls Telegram and hands each allowed message to the agent.
// Only one Bot may poll per token (Telegram answers a second poller with
// 409), which is why the deployment runs a single replica.
//
// Every chat gets its own worker goroutine: turns in one chat run strictly
// in order (two people typing at once in the group never race), while
// different chats run in parallel.
type Bot struct {
	API      *Client
	Agent    *agent.Runner
	Entries  *entries.Service
	Settings *settings.Service
	Docs     *docs.Syncer // nil: documents are off
	Log      *slog.Logger

	// PollSeconds is how long getUpdates may wait for news (default 50).
	PollSeconds int
	// IdleReset forgets a chat's conversation after this much silence
	// (default 2h); the entries are the memory, not the chat history.
	IdleReset time.Duration
	// ConflictWait is the pause after a 409 (another poller), default 15s.
	ConflictWait time.Duration
	// Now is the clock (tests).
	Now func() time.Time

	mu      sync.Mutex
	workers map[int64]chan Update
	history map[int64]*chatHistory
	st      Status
	wg      sync.WaitGroup // running workers
}

type chatHistory struct {
	turns []agent.Turn
	last  time.Time
}

// Rejected is a chat or person the bot ignored, kept so the admin page can
// offer to add them (that is how the group's ID is found).
type Rejected struct {
	ChatID    int64     `json:"chatId,string"`
	ChatType  string    `json:"chatType"`
	ChatTitle string    `json:"chatTitle,omitempty"`
	FromID    int64     `json:"fromId,string"`
	FromName  string    `json:"fromName,omitempty"`
	Reason    string    `json:"reason"`
	At        time.Time `json:"at"`
}

// Status is what the admin page shows about the bot. It never carries the
// token.
type Status struct {
	TokenSet     bool       `json:"tokenSet"`
	Running      bool       `json:"running"`
	BotUsername  string     `json:"botUsername,omitempty"`
	LastPollAt   time.Time  `json:"lastPollAt,omitzero"`
	LastUpdateAt time.Time  `json:"lastUpdateAt,omitzero"`
	LastError    string     `json:"lastError,omitempty"`
	LastErrorAt  time.Time  `json:"lastErrorAt,omitzero"`
	Rejected     []Rejected `json:"rejected"`
}

const (
	maxRejected    = 10
	maxMessage     = 4000 // Telegram allows 4096; leave room
	maxUndoButtons = 8
	// turnTimeout bounds one message's work, which is not cancelled on
	// shutdown (Telegram won't redeliver an update once polled past). A
	// local thinking model can take minutes per round.
	turnTimeout = 15 * time.Minute
)

func (b *Bot) now() time.Time {
	if b.Now != nil {
		return b.Now()
	}
	return time.Now()
}

// Status returns a snapshot for the admin page.
func (b *Bot) Status() Status {
	if b == nil {
		return Status{Rejected: []Rejected{}}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	s := b.st
	s.TokenSet = b.API != nil && b.API.token != ""
	s.Rejected = append([]Rejected{}, b.st.Rejected...)
	return s
}

func (b *Bot) setErr(err error) {
	b.mu.Lock()
	b.st.LastError, b.st.LastErrorAt = err.Error(), b.now()
	b.mu.Unlock()
}

// Run polls until ctx ends. It returns only on ctx end or a bad token.
func (b *Bot) Run(ctx context.Context) error {
	if b.PollSeconds <= 0 {
		b.PollSeconds = 50
	}
	if b.IdleReset <= 0 {
		b.IdleReset = 2 * time.Hour
	}
	if b.ConflictWait <= 0 {
		b.ConflictWait = 15 * time.Second
	}
	b.mu.Lock()
	b.workers, b.history = map[int64]chan Update{}, map[int64]*chatHistory{}
	b.st.Rejected = []Rejected{}
	b.mu.Unlock()

	backoff := time.Second
	for {
		me, err := b.API.GetMe(ctx)
		if err == nil {
			b.mu.Lock()
			b.st.BotUsername, b.st.Running = me.Username, true
			b.mu.Unlock()
			b.Log.Info("telegram bot started", "username", me.Username)
			break
		}
		b.setErr(err)
		var ae *APIError
		if errors.As(err, &ae) && ae.Code == 401 {
			b.Log.Error("telegram bot token rejected; the bot is off", "err", err)
			return err
		}
		b.Log.Warn("telegram getMe failed, retrying", "err", err, "in", backoff)
		if !sleep(ctx, backoff) {
			return ctx.Err()
		}
		backoff = min(backoff*2, time.Minute)
	}
	defer func() {
		b.mu.Lock()
		b.st.Running = false
		b.mu.Unlock()
	}()
	if err := b.API.SetMyCommands(ctx, Commands); err != nil {
		b.Log.Warn("telegram setMyCommands failed", "err", err)
	}

	var offset int64
	backoff = time.Second
	for {
		ups, err := b.API.GetUpdates(ctx, offset, b.PollSeconds)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			b.setErr(err)
			wait := backoff
			var ae *APIError
			switch {
			case IsConflict(err):
				wait = b.ConflictWait
				b.Log.Warn("another poller is using this bot token (409); is a second replica or a local copy running?", "retryIn", wait)
			case errors.As(err, &ae) && ae.RetryAfter > 0:
				wait = time.Duration(ae.RetryAfter) * time.Second
			default:
				backoff = min(backoff*2, time.Minute)
				b.Log.Warn("telegram getUpdates failed", "err", err, "retryIn", wait)
			}
			if !sleep(ctx, wait) {
				return ctx.Err()
			}
			continue
		}
		backoff = time.Second
		b.mu.Lock()
		b.st.LastPollAt = b.now()
		if len(ups) > 0 {
			b.st.LastUpdateAt = b.now()
		}
		b.mu.Unlock()
		// The next getUpdates with this offset confirms these to Telegram,
		// so each update is handed out once.
		for _, u := range ups {
			if u.UpdateID >= offset {
				offset = u.UpdateID + 1
			}
			b.dispatch(ctx, u)
		}
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func displayName(u *User) string {
	if u == nil {
		return ""
	}
	n := strings.TrimSpace(u.FirstName + " " + u.LastName)
	if u.Username != "" {
		n += " (@" + u.Username + ")"
	}
	return n
}

// authorise decides whether a message in chat from user may be handled,
// returning the configured name. Private chats need an allowed user; groups
// need an allowed group and an allowed user. Everything else is refused.
func (b *Bot) authorise(ctx context.Context, chat Chat, from *User) (string, string) {
	if from == nil || from.IsBot {
		return "", "not from a person"
	}
	tg := b.Settings.ResolveTelegram(ctx)
	name, userOK := tg.UserName(from.ID)
	switch {
	case chat.Type == "private":
		if !userOK || chat.ID != from.ID {
			return "", "user not on the allowlist"
		}
	case chat.IsGroup():
		if !tg.GroupAllowed(chat.ID) {
			return "", "group not on the allowlist"
		}
		if !userOK {
			return "", "user not on the allowlist"
		}
	default:
		return "", "unsupported chat type " + chat.Type
	}
	return name, ""
}

func (b *Bot) reject(chat Chat, from *User, reason string) {
	r := Rejected{ChatID: chat.ID, ChatType: chat.Type, ChatTitle: chat.Title, Reason: reason, At: b.now()}
	if from != nil {
		r.FromID, r.FromName = from.ID, displayName(from)
	}
	b.Log.Warn("telegram message ignored", "reason", reason, "chatId", chat.ID, "chatType", chat.Type, "chatTitle", chat.Title, "fromId", r.FromID, "from", r.FromName)
	b.mu.Lock()
	defer b.mu.Unlock()
	list := []Rejected{r}
	for _, x := range b.st.Rejected {
		if (x.ChatID != r.ChatID || x.FromID != r.FromID) && len(list) < maxRejected {
			list = append(list, x)
		}
	}
	b.st.Rejected = list
}

// dispatch authorises an update and queues it on its chat's worker.
func (b *Bot) dispatch(ctx context.Context, u Update) {
	var chat Chat
	var from *User
	switch {
	case u.Message != nil:
		m := u.Message
		if m.MigrateToChatID != 0 {
			b.Log.Warn("telegram group was upgraded to a supergroup; its chat ID changed. Add the new ID on the admin page.", "oldChatId", m.Chat.ID, "newChatId", m.MigrateToChatID)
			b.reject(Chat{ID: m.MigrateToChatID, Type: "supergroup", Title: m.Chat.Title}, m.From, "group upgraded: new chat ID")
			return
		}
		chat, from = m.Chat, m.From
	case u.CallbackQuery != nil && u.CallbackQuery.Message != nil:
		chat, from = u.CallbackQuery.Message.Chat, &u.CallbackQuery.From
	default:
		return // anything else: ignored on purpose
	}
	if _, why := b.authorise(ctx, chat, from); why != "" {
		if from == nil || !from.IsBot {
			b.reject(chat, from, why)
		}
		if u.CallbackQuery != nil {
			_ = b.API.AnswerCallbackQuery(ctx, u.CallbackQuery.ID, "You're not on this bot's list.")
		}
		return
	}
	b.mu.Lock()
	ch, ok := b.workers[chat.ID]
	if !ok {
		ch = make(chan Update, 64)
		b.workers[chat.ID] = ch
		b.wg.Add(1)
		go b.work(ctx, ch)
	}
	b.mu.Unlock()
	select {
	case ch <- u:
	default:
		b.Log.Warn("telegram chat queue full, dropping update", "chatId", chat.ID)
	}
}

// work runs one chat's turns in order. Turns run detached from ctx (with
// their own timeout): once polled, Telegram won't redeliver an update, so on
// shutdown the worker finishes what it already took, then exits.
func (b *Bot) work(ctx context.Context, ch chan Update) {
	defer b.wg.Done()
	run := func(u Update) {
		tctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), turnTimeout)
		defer cancel()
		b.handle(tctx, u)
	}
	for {
		select {
		case <-ctx.Done():
			for {
				select {
				case u := <-ch:
					run(u)
				default:
					return
				}
			}
		case u := <-ch:
			run(u)
		}
	}
}

// Wait blocks until every worker has finished after Run's ctx ended, or
// timeout passes. It reports whether they all finished.
func (b *Bot) Wait(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() { b.wg.Wait(); close(done) }()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (b *Bot) handle(ctx context.Context, u Update) {
	defer func() {
		if r := recover(); r != nil {
			b.Log.Error("telegram handler panicked", "panic", fmt.Sprint(r))
		}
	}()
	if u.CallbackQuery != nil {
		b.handleCallback(ctx, u.CallbackQuery)
		return
	}
	m := u.Message
	// Re-check: the allowlist may have changed while this sat in the queue.
	name, why := b.authorise(ctx, m.Chat, m.From)
	if why != "" {
		b.reject(m.Chat, m.From, why)
		return
	}
	text := strings.TrimSpace(m.Text)
	if text == "" {
		if m.Document != nil || len(m.Photo) > 0 || m.Voice != nil {
			b.reply(ctx, m, "I can only read text for now. Drawings, photos and voice notes are coming.", nil)
		}
		return
	}
	if strings.HasPrefix(text, "/") {
		b.command(ctx, m, name, text)
		return
	}
	b.converse(ctx, m, name, text, false)
}

// converse runs one agent turn for a text message; think asks the model to
// think first (/think).
func (b *Bot) converse(ctx context.Context, m *Message, name, text string, think bool) {
	group := m.Chat.IsGroup()
	content := text
	if group {
		content = name + ": " + text
	}
	b.mu.Lock()
	h := b.history[m.Chat.ID]
	if h == nil || b.now().Sub(h.last) > b.IdleReset {
		h = &chatHistory{}
		b.history[m.Chat.ID] = h
	}
	turns := append(append([]agent.Turn{}, h.turns...), agent.Turn{Role: "user", Content: content})
	b.mu.Unlock()

	stop := b.typing(ctx, m.Chat.ID)
	cfg := b.Settings.Resolve(ctx)
	cfg.Streaming = false
	res, err := b.Agent.Run(ctx, agent.Request{By: name, Channel: "telegram", Group: group, Think: think, Turns: turns}, cfg, nil)
	stop()

	b.mu.Lock()
	h.last = b.now()
	if err == nil {
		h.turns = turns // the user turn stays even when the bot keeps quiet
		if !res.Silent {
			h.turns = append(h.turns, agent.Turn{Role: "assistant", Content: res.Reply})
		}
		h.turns = agent.CleanTurns(h.turns)
	}
	b.mu.Unlock()

	if err != nil {
		b.Log.Warn("telegram agent turn failed", "by", name, "chatId", m.Chat.ID, "err", err)
		msg := "Sorry, that didn't go through: " + truncate(err.Error(), 300)
		if len(res.Changes) > 0 {
			msg += "\n\nSome changes were saved before it failed:\n" + changeText(res.Changes)
		}
		b.reply(ctx, m, msg, undoKeyboard(res.Changes))
		return
	}
	if res.Silent {
		return
	}
	out := res.Reply
	if len(res.Changes) > 0 {
		out += "\n\n" + changeText(res.Changes)
	}
	b.reply(ctx, m, out, undoKeyboard(res.Changes))
}

// typing shows "typing…" until the returned stop is called (Telegram drops
// the indicator after about five seconds, so it is refreshed).
func (b *Bot) typing(ctx context.Context, chatID int64) func() {
	ctx, cancel := context.WithCancel(ctx)
	go func() {
		t := time.NewTicker(4 * time.Second)
		defer t.Stop()
		for {
			_ = b.API.SendChatAction(ctx, chatID, "typing")
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	return cancel
}

func changeText(changes []agent.ChangeLine) string {
	var lines []string
	for _, c := range changes {
		lines = append(lines, "• "+c.Text)
	}
	return strings.Join(lines, "\n")
}

// undoKeyboard has one Undo button per journaled change.
func undoKeyboard(changes []agent.ChangeLine) *InlineKeyboardMarkup {
	var ids []string
	for _, c := range changes {
		if c.ID != "" {
			ids = append(ids, c.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	if len(ids) > maxUndoButtons {
		ids = ids[:maxUndoButtons]
	}
	var row []InlineKeyboardButton
	for i, id := range ids {
		label := "Undo"
		if len(ids) > 1 {
			label = fmt.Sprintf("Undo %d", i+1)
		}
		row = append(row, InlineKeyboardButton{Text: label, CallbackData: "undo:" + id})
	}
	// Four buttons per row keeps them tappable on a phone.
	kb := &InlineKeyboardMarkup{}
	for len(row) > 0 {
		n := min(4, len(row))
		kb.InlineKeyboard = append(kb.InlineKeyboard, row[:n])
		row = row[n:]
	}
	return kb
}

func (b *Bot) handleCallback(ctx context.Context, cb *CallbackQuery) {
	m := cb.Message
	name, why := b.authorise(ctx, m.Chat, &cb.From)
	if why != "" {
		_ = b.API.AnswerCallbackQuery(ctx, cb.ID, "You're not on this bot's list.")
		return
	}
	id, ok := strings.CutPrefix(cb.Data, "undo:")
	if !ok {
		_ = b.API.AnswerCallbackQuery(ctx, cb.ID, "")
		return
	}
	res, err := b.Entries.Undo(ctx, entries.Actor{By: name, Channel: "telegram"}, id)
	if err != nil {
		msg := "Couldn't undo that."
		switch {
		case errors.Is(err, entries.ErrUndoStale):
			msg = "That entry was changed again since, so it can't be undone."
		case errors.Is(err, entries.ErrChangeNotFound):
			msg = "That change is too old to undo."
		default:
			b.Log.Warn("telegram undo failed", "by", name, "err", err)
		}
		_ = b.API.AnswerCallbackQuery(ctx, cb.ID, msg)
		return
	}
	line := agent.ChangeText(res.Changes[0])
	_ = b.API.AnswerCallbackQuery(ctx, cb.ID, truncate(line, 190))
	// Drop the pressed button so it can't be pressed twice.
	if m.ReplyMarkup != nil {
		kb := &InlineKeyboardMarkup{}
		for _, row := range m.ReplyMarkup.InlineKeyboard {
			var keep []InlineKeyboardButton
			for _, btn := range row {
				if btn.CallbackData != cb.Data {
					keep = append(keep, btn)
				}
			}
			if len(keep) > 0 {
				kb.InlineKeyboard = append(kb.InlineKeyboard, keep)
			}
		}
		if len(kb.InlineKeyboard) == 0 {
			kb = nil
		}
		_ = b.API.EditMessageReplyMarkup(ctx, m.Chat.ID, m.MessageID, kb)
	}
	who := ""
	if m.Chat.IsGroup() {
		who = name + ": "
	}
	b.reply(ctx, m, "↩ "+who+line, undoKeyboard([]agent.ChangeLine{{ID: res.Changes[0].ID, Text: line}}))
}

// reply sends text to the message's chat, threaded under it in groups, in
// as many parts as needed; the keyboard goes on the last part.
func (b *Bot) reply(ctx context.Context, m *Message, text string, kb *InlineKeyboardMarkup) {
	parts := split(text, maxMessage)
	for i, p := range parts {
		sm := SendMessage{ChatID: m.Chat.ID, Text: p}
		if i == 0 && m.Chat.IsGroup() {
			sm.ReplyToMessageID = m.MessageID
		}
		if i == len(parts)-1 {
			sm.ReplyMarkup = kb
		}
		if _, err := b.API.SendMessage(ctx, sm); err != nil {
			b.setErr(err)
			b.Log.Warn("telegram sendMessage failed", "chatId", m.Chat.ID, "err", err)
			return
		}
	}
}

// split cuts text into parts of at most n runes, preferring line breaks.
func split(text string, n int) []string {
	r := []rune(text)
	var out []string
	for len(r) > n {
		cut := n
		for i := n; i > n/2; i-- {
			if r[i] == '\n' {
				cut = i
				break
			}
		}
		out = append(out, strings.TrimRight(string(r[:cut]), "\n"))
		r = r[cut:]
		for len(r) > 0 && r[0] == '\n' {
			r = r[1:]
		}
	}
	if len(r) > 0 || len(out) == 0 {
		out = append(out, string(r))
	}
	return out
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
