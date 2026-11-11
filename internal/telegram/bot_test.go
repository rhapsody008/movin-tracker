package telegram_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/settings"
	"github.com/rhapsody008/movin-tracker/internal/telegram"
	"github.com/rhapsody008/movin-tracker/internal/testutil"
)

const (
	zyID      = 111
	partnerID = 222
	groupID   = -1001
)

// ---------- fake Telegram ----------

type fakeTG struct {
	t        *testing.T
	mu       sync.Mutex
	pending  []telegram.Update
	conflict int // answer this many getUpdates with 409 first
	sent     []sentMsg
	answers  []string
	edits    []map[string]any
	srv      *httptest.Server
	nextID   int64
	msgID    int64
}

type sentMsg struct {
	ChatID  int64
	Text    string
	ReplyTo int64
	Buttons []telegram.InlineKeyboardButton
}

func newFakeTG(t *testing.T) *fakeTG {
	f := &fakeTG{t: t, nextID: 1, msgID: 1000}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func ok(w io.Writer, v any) {
	b, _ := json.Marshal(map[string]any{"ok": true, "result": v})
	w.Write(b)
}

func (f *fakeTG) handle(w http.ResponseWriter, r *http.Request) {
	method, _ := strings.CutPrefix(r.URL.Path, "/bot"+token+"/")
	var body map[string]json.RawMessage
	json.NewDecoder(r.Body).Decode(&body)
	switch method {
	case "getMe":
		ok(w, map[string]any{"id": 999, "is_bot": true, "first_name": "Movin", "username": "movin_test_bot"})
	case "getUpdates":
		var offset int64
		json.Unmarshal(body["offset"], &offset)
		deadline := time.Now().Add(300 * time.Millisecond)
		for {
			f.mu.Lock()
			if f.conflict > 0 {
				f.conflict--
				f.mu.Unlock()
				w.WriteHeader(409)
				io.WriteString(w, `{"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request"}`)
				return
			}
			var out []telegram.Update
			for _, u := range f.pending {
				if u.UpdateID >= offset {
					out = append(out, u)
				}
			}
			f.pending = nil
			f.mu.Unlock()
			if len(out) > 0 || time.Now().After(deadline) || r.Context().Err() != nil {
				ok(w, out)
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	case "sendMessage":
		var m struct {
			ChatID      int64                          `json:"chat_id"`
			Text        string                         `json:"text"`
			ReplyTo     int64                          `json:"reply_to_message_id"`
			ReplyMarkup *telegram.InlineKeyboardMarkup `json:"reply_markup"`
		}
		raw, _ := json.Marshal(body)
		json.Unmarshal(raw, &m)
		sm := sentMsg{ChatID: m.ChatID, Text: m.Text, ReplyTo: m.ReplyTo}
		if m.ReplyMarkup != nil {
			for _, row := range m.ReplyMarkup.InlineKeyboard {
				sm.Buttons = append(sm.Buttons, row...)
			}
		}
		f.mu.Lock()
		f.sent = append(f.sent, sm)
		f.msgID++
		id := f.msgID
		f.mu.Unlock()
		ok(w, map[string]any{"message_id": id, "chat": map[string]any{"id": m.ChatID, "type": "private"}, "date": 1, "text": m.Text})
	case "answerCallbackQuery":
		var text string
		json.Unmarshal(body["text"], &text)
		f.mu.Lock()
		f.answers = append(f.answers, text)
		f.mu.Unlock()
		ok(w, true)
	case "editMessageReplyMarkup":
		raw, _ := json.Marshal(body)
		var m map[string]any
		json.Unmarshal(raw, &m)
		f.mu.Lock()
		f.edits = append(f.edits, m)
		f.mu.Unlock()
		ok(w, true)
	default: // setMyCommands, sendChatAction
		ok(w, true)
	}
}

func (f *fakeTG) push(us ...telegram.Update) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := range us {
		if us[i].UpdateID == 0 {
			us[i].UpdateID = f.nextID
			f.nextID++
		}
	}
	f.pending = append(f.pending, us...)
}

func (f *fakeTG) sentCopy() []sentMsg {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sentMsg{}, f.sent...)
}

// waitSent waits until at least n messages were sent.
func (f *fakeTG) waitSent(t *testing.T, n int) []sentMsg {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if s := f.sentCopy(); len(s) >= n {
			return s
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("waited for %d sent messages, have %+v", n, f.sentCopy())
	return nil
}

func private(from int64, first, text string) telegram.Update {
	return telegram.Update{Message: &telegram.Message{MessageID: 1, From: &telegram.User{ID: from, FirstName: first},
		Chat: telegram.Chat{ID: from, Type: "private"}, Text: text}}
}

func inGroup(chat, from int64, first, text string, msgID int64) telegram.Update {
	return telegram.Update{Message: &telegram.Message{MessageID: msgID, From: &telegram.User{ID: from, FirstName: first},
		Chat: telegram.Chat{ID: chat, Type: "supergroup", Title: "Reno"}, Text: text}}
}

// ---------- scripted LLM ----------

// stubLLM answers by the last user message: "record <title>" adds a note,
// "chat" in a group gets NO_REPLY, anything else gets "ok". Each request
// can be slowed down to test ordering; it tracks in-flight requests.
type stubLLM struct {
	srv      *httptest.Server
	delay    time.Duration
	inFlight atomic.Int32
	maxSeen  atomic.Int32
	mu       sync.Mutex
	requests [][]map[string]any
	kwargs   []map[string]any // chat_template_kwargs per request
}

func newLLM(t *testing.T) *stubLLM {
	s := &stubLLM{}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := s.inFlight.Add(1)
		defer s.inFlight.Add(-1)
		for {
			m := s.maxSeen.Load()
			if n <= m || s.maxSeen.CompareAndSwap(m, n) {
				break
			}
		}
		time.Sleep(s.delay)
		var req struct {
			Messages []map[string]any `json:"messages"`
			Kwargs   map[string]any   `json:"chat_template_kwargs"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		s.mu.Lock()
		s.requests = append(s.requests, req.Messages)
		s.kwargs = append(s.kwargs, req.Kwargs)
		s.mu.Unlock()
		last := req.Messages[len(req.Messages)-1]
		content, _ := last["content"].(string)
		msg := map[string]any{"role": "assistant", "content": "ok"}
		switch {
		case last["role"] == "tool":
			msg["content"] = "Saved."
		case strings.Contains(content, "record "):
			title := content[strings.Index(content, "record ")+7:]
			args, _ := json.Marshal(map[string]any{"entries": []map[string]any{{"kind": "note", "title": title}}})
			msg["content"] = ""
			msg["tool_calls"] = []any{map[string]any{"id": "c1", "type": "function", "function": map[string]string{"name": "add_entry", "arguments": string(args)}}}
		case strings.Contains(content, "chat"):
			msg["content"] = agent.SilentReply
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": msg}}})
	}))
	t.Cleanup(s.srv.Close)
	return s
}

// ---------- rig ----------

type botRig struct {
	tg   *fakeTG
	llm  *stubLLM
	bot  *telegram.Bot
	ents *entries.Service
	sets *settings.Service
	logs *testutil.SyncBuffer
}

func startBot(t *testing.T) *botRig {
	t.Helper()
	logs := &testutil.SyncBuffer{}
	log := testutil.Logger(logs)
	store := objstore.NewMemory()
	ents := entries.NewService(store, log)
	if err := ents.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	llm := newLLM(t)
	env := settings.Defaults
	env.BaseURL, env.Model, env.MaxToolRounds = llm.srv.URL+"/v1", "m", 3
	env.ThinkOnDemand = true
	sets, _ := settings.NewService(store, env, "", log)
	tgEnv, _ := settings.ParseTelegramEnv(fmt.Sprintf("%d=ZY,%d=Partner", zyID, partnerID), fmt.Sprint(groupID))
	sets.WithTelegramEnv(tgEnv)
	tg := newFakeTG(t)
	bot := &telegram.Bot{
		API: telegram.New(token, tg.srv.URL), Entries: ents, Settings: sets, Log: log,
		Agent:       &agent.Runner{Entries: ents, Loc: time.UTC, Log: log, Now: time.Now},
		PollSeconds: 1, ConflictWait: 50 * time.Millisecond,
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { bot.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	// Wait until it is polling.
	for i := 0; i < 200 && !bot.Status().Running; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	return &botRig{tg: tg, llm: llm, bot: bot, ents: ents, sets: sets, logs: logs}
}

func (r *botRig) doc(t *testing.T) *entries.Doc {
	t.Helper()
	s, _ := r.ents.Current(context.Background())
	return s.Doc
}

// ---------- tests ----------

func TestPrivateMessageSavesEntryAndUndoButtonWorks(t *testing.T) {
	r := startBot(t)
	if st := r.bot.Status(); !st.Running || st.BotUsername != "movin_test_bot" || !st.TokenSet {
		t.Fatalf("status: %+v", st)
	}
	r.tg.push(private(zyID, "Zhou", "record Fluted glass door"))
	sent := r.tg.waitSent(t, 1)
	m := sent[0]
	if m.ChatID != zyID || !strings.Contains(m.Text, "Saved.") || !strings.Contains(m.Text, "• Saved: note · Fluted glass door") || m.ReplyTo != 0 {
		t.Fatalf("reply: %+v", m)
	}
	d := r.doc(t)
	if len(d.Entries) != 1 || d.Entries[0].By != "ZY" || d.Entries[0].Channel != "telegram" {
		t.Fatalf("entry: %+v", d.Entries)
	}
	if len(m.Buttons) != 1 || m.Buttons[0].Text != "Undo" || m.Buttons[0].CallbackData != "undo:"+d.Changes[0].ID {
		t.Fatalf("buttons: %+v", m.Buttons)
	}

	// Partner presses Undo in... no: only people in the chat can press it;
	// here ZY presses it in the private chat.
	r.tg.push(telegram.Update{CallbackQuery: &telegram.CallbackQuery{ID: "cb1", From: telegram.User{ID: zyID, FirstName: "Zhou"}, Data: m.Buttons[0].CallbackData,
		Message: &telegram.Message{MessageID: 1001, Chat: telegram.Chat{ID: zyID, Type: "private"},
			ReplyMarkup: &telegram.InlineKeyboardMarkup{InlineKeyboard: [][]telegram.InlineKeyboardButton{m.Buttons}}}}})
	sent = r.tg.waitSent(t, 2)
	if !strings.HasPrefix(sent[1].Text, "↩ Undone: removed Fluted glass door") {
		t.Fatalf("undo reply: %+v", sent[1])
	}
	if len(r.doc(t).Entries) != 0 {
		t.Fatal("undo should remove the entry")
	}
	r.tg.mu.Lock()
	answers, edits := append([]string{}, r.tg.answers...), append([]map[string]any{}, r.tg.edits...)
	r.tg.mu.Unlock()
	if len(answers) != 1 || !strings.Contains(answers[0], "Undone") {
		t.Fatalf("callback answer: %v", answers)
	}
	if len(edits) != 1 || len(edits[0]["reply_markup"].(map[string]any)["inline_keyboard"].([]any)) != 0 {
		t.Fatalf("the pressed button should be removed: %v", edits)
	}
	if d := r.doc(t); d.Changes[len(d.Changes)-1].By != "ZY" || d.Changes[len(d.Changes)-1].Channel != "telegram" {
		t.Fatalf("undo actor: %+v", d.Changes[len(d.Changes)-1])
	}
}

func TestAuthorisation(t *testing.T) {
	r := startBot(t)
	r.tg.push(
		private(333, "Stranger", "record should not happen"),             // unknown user, private
		inGroup(-2002, zyID, "Zhou", "record wrong group", 5),            // allowed user, unlisted group
		inGroup(groupID, 333, "Stranger", "record stranger in group", 6), // stranger in the allowed group
		inGroup(groupID, partnerID, "P", "record Lift booking", 7),       // allowed user in the allowed group
	)
	sent := r.tg.waitSent(t, 1)
	time.Sleep(300 * time.Millisecond) // give any wrongly accepted message time to show up
	sent = r.tg.sentCopy()
	if len(sent) != 1 || sent[0].ChatID != groupID || sent[0].ReplyTo != 7 {
		t.Fatalf("only the allowed group message should get a reply, threaded: %+v", sent)
	}
	d := r.doc(t)
	if len(d.Entries) != 1 || d.Entries[0].Title != "Lift booking" || d.Entries[0].By != "Partner" {
		t.Fatalf("entries: %+v", d.Entries)
	}
	rej := r.bot.Status().Rejected
	reasons := map[string]string{}
	for _, x := range rej {
		reasons[fmt.Sprintf("%d/%d", x.ChatID, x.FromID)] = x.Reason
	}
	want := map[string]string{
		"333/333":   "user not on the allowlist",
		"-2002/111": "group not on the allowlist",
		"-1001/333": "user not on the allowlist",
	}
	for k, v := range want {
		if reasons[k] != v {
			t.Errorf("rejected %s: got %q, want %q (all: %+v)", k, reasons[k], v, rej)
		}
	}
	if !strings.Contains(r.logs.String(), `"msg":"telegram message ignored"`) {
		t.Fatal("rejections must be logged")
	}
}

func TestConflictBacksOffThenRecovers(t *testing.T) {
	r := startBot(t)
	r.tg.mu.Lock()
	r.tg.conflict = 2
	r.tg.mu.Unlock()
	r.tg.push(private(zyID, "Zhou", "record After conflict"))
	r.tg.waitSent(t, 1)
	st := r.bot.Status()
	if !strings.Contains(st.LastError, "409") || !strings.Contains(r.logs.String(), "another poller") {
		t.Fatalf("409 should be recorded and logged: %+v", st)
	}
}

func TestBotWritesReachSubscribers(t *testing.T) {
	r := startBot(t)
	ch, cancel := r.ents.Subscribe()
	defer cancel()
	r.tg.push(private(partnerID, "P", "record Sofa from Castlery"))
	select {
	case s := <-ch:
		if len(s.Doc.Entries) != 1 || s.Doc.Entries[0].Channel != "telegram" {
			t.Fatalf("snapshot: %+v", s.Doc.Entries)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no snapshot pushed for a bot write (the web page would not update)")
	}
}

func TestOneChatIsSerialisedTwoChatsRunInParallel(t *testing.T) {
	r := startBot(t)
	r.llm.delay = 250 * time.Millisecond
	// Two people in the group at once: must run one after the other.
	r.tg.push(inGroup(groupID, zyID, "Zhou", "first thought", 10), inGroup(groupID, partnerID, "P", "second thought", 11))
	r.tg.waitSent(t, 2)
	if m := r.llm.maxSeen.Load(); m != 1 {
		t.Fatalf("turns in one chat overlapped (max in flight %d)", m)
	}
	// The second turn saw the first in the shared history, with speakers.
	r.llm.mu.Lock()
	lastReq := r.llm.requests[len(r.llm.requests)-1]
	r.llm.mu.Unlock()
	var users []string
	for _, m := range lastReq {
		if m["role"] == "user" {
			users = append(users, m["content"].(string))
		}
	}
	if strings.Join(users, " | ") != "ZY: first thought | Partner: second thought" {
		t.Fatalf("shared history: %v", users)
	}

	// Two different chats: may overlap.
	r.llm.maxSeen.Store(0)
	r.tg.push(private(zyID, "Zhou", "private one"), private(partnerID, "P", "private two"))
	r.tg.waitSent(t, 4)
	if m := r.llm.maxSeen.Load(); m < 2 {
		t.Fatalf("different chats should run in parallel (max in flight %d)", m)
	}
}

func TestGroupChatterGetsNoReply(t *testing.T) {
	r := startBot(t)
	r.tg.push(inGroup(groupID, partnerID, "P", "chat about dinner", 20), inGroup(groupID, zyID, "Zhou", "what's up?", 21))
	sent := r.tg.waitSent(t, 1)
	time.Sleep(200 * time.Millisecond)
	sent = r.tg.sentCopy()
	if len(sent) != 1 || sent[0].ReplyTo != 21 {
		t.Fatalf("only the question should get an answer: %+v", sent)
	}
}

func TestAllowlistChangeAppliesWithoutRestart(t *testing.T) {
	r := startBot(t)
	r.tg.push(private(444, "Helper", "record too early"))
	time.Sleep(400 * time.Millisecond)
	if len(r.tg.sentCopy()) != 0 {
		t.Fatal("not yet allowed")
	}
	_, err := r.sets.SaveTelegram(context.Background(), "zy@example.com", settings.TelegramInput{
		Users: []settings.TelegramUser{{ID: "444", Name: "Helper"}, {ID: fmt.Sprint(zyID), Name: "ZY"}}})
	if err != nil {
		t.Fatal(err)
	}
	r.tg.push(private(444, "Helper", "record Paint samples"))
	r.tg.waitSent(t, 1)
	if d := r.doc(t); len(d.Entries) != 1 || d.Entries[0].By != "Helper" {
		t.Fatalf("entries: %+v", d.Entries)
	}
	// Partner was dropped from the saved list, so is now refused.
	r.tg.push(private(partnerID, "P", "record dropped"))
	time.Sleep(400 * time.Millisecond)
	if len(r.tg.sentCopy()) != 1 {
		t.Fatal("removed user must be refused right away")
	}
}

func TestCommands(t *testing.T) {
	r := startBot(t)
	ctx := context.Background()
	r.ents.Create(ctx, entries.Actor{By: "ZY", Channel: "telegram"}, []entries.Patch{{"title": json.RawMessage(`"Mine"`)}})
	r.ents.Create(ctx, entries.Actor{By: "zy@example.com", Channel: "web"}, []entries.Patch{{"title": json.RawMessage(`"From web"`)}})
	r.ents.Create(ctx, entries.Actor{By: "Partner", Channel: "telegram"}, []entries.Patch{{"title": json.RawMessage(`"Theirs"`)}})

	r.tg.push(private(zyID, "Zhou", "/help"))
	if s := r.tg.waitSent(t, 1); !strings.Contains(s[0].Text, "Undo button") {
		t.Fatalf("/help: %q", s[0].Text)
	}
	r.tg.push(private(zyID, "Zhou", "/recent"))
	s := r.tg.waitSent(t, 2)
	if !strings.Contains(s[1].Text, "Saved: note · Theirs — Partner") || !strings.Contains(s[1].Text, "From web — zy@example.com (web)") {
		t.Fatalf("/recent: %q", s[1].Text)
	}
	// /undo undoes the caller's own latest change, not Partner's newer one.
	r.tg.push(private(zyID, "Zhou", "/undo"))
	s = r.tg.waitSent(t, 3)
	if !strings.Contains(s[2].Text, "Undone: removed Mine") || len(s[2].Buttons) != 1 {
		t.Fatalf("/undo: %+v", s[2])
	}
	titles := []string{}
	for _, e := range r.doc(t).Entries {
		titles = append(titles, e.Title)
	}
	if strings.Join(titles, ",") != "From web,Theirs" {
		t.Fatalf("entries after /undo: %v", titles)
	}
	// A command for another bot in the group is ignored; one for us works.
	r.tg.push(inGroup(groupID, zyID, "Zhou", "/recent@some_other_bot", 30), inGroup(groupID, zyID, "Zhou", "/sync@movin_test_bot", 31))
	s = r.tg.waitSent(t, 4)
	time.Sleep(200 * time.Millisecond)
	if s = r.tg.sentCopy(); len(s) != 4 || s[3].ReplyTo != 31 || !strings.Contains(s[3].Text, "Drawings") {
		t.Fatalf("group commands: %+v", s[3:])
	}
}

func TestNonTextAndStatusHasNoToken(t *testing.T) {
	r := startBot(t)
	doc := private(zyID, "Zhou", "")
	doc.Message.Document = &telegram.Document{FileID: "F", FileName: "E1.pdf"}
	r.tg.push(doc)
	r.tg.waitSent(t, 1)
	time.Sleep(200 * time.Millisecond)
	if s := r.tg.sentCopy(); len(s) != 1 || !strings.Contains(s[0].Text, "only read text") {
		t.Fatalf("non-text reply: %+v", s)
	}
	if len(r.doc(t).Entries) != 0 {
		t.Fatal("a document must not create an entry")
	}
	b, _ := json.Marshal(r.bot.Status())
	if strings.Contains(string(b), token) || strings.Contains(string(b), "AAFake") {
		t.Fatalf("status leaks the token: %s", b)
	}
	if strings.Contains(r.logs.String(), token) {
		t.Fatal("logs contain the token")
	}
}

// TestUndoButtonRefusedForStrangerInGroup: a person not on the list, in the
// allowed group, presses someone's Undo button. Nothing may change.
func TestUndoButtonRefusedForStrangerInGroup(t *testing.T) {
	r := startBot(t)
	r.tg.push(inGroup(groupID, zyID, "Zhou", "record Keep me", 40))
	sent := r.tg.waitSent(t, 1)
	btn := sent[0].Buttons[0]
	r.tg.push(telegram.Update{CallbackQuery: &telegram.CallbackQuery{ID: "cbx", From: telegram.User{ID: 333, FirstName: "Stranger"}, Data: btn.CallbackData,
		Message: &telegram.Message{MessageID: 1001, Chat: telegram.Chat{ID: groupID, Type: "supergroup"}}}})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r.tg.mu.Lock()
		n := len(r.tg.answers)
		r.tg.mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	r.tg.mu.Lock()
	answers := append([]string{}, r.tg.answers...)
	r.tg.mu.Unlock()
	if len(answers) != 1 || !strings.Contains(answers[0], "not on this bot's list") {
		t.Fatalf("stranger's press should be refused: %v", answers)
	}
	if d := r.doc(t); len(d.Entries) != 1 || d.Entries[0].Title != "Keep me" {
		t.Fatalf("entry changed: %+v", d.Entries)
	}
}

// TestShutdownFinishesTakenTurns: messages already polled (and so confirmed
// to Telegram) are still answered after the bot is told to stop.
func TestShutdownFinishesTakenTurns(t *testing.T) {
	logs := &testutil.SyncBuffer{}
	log := testutil.Logger(logs)
	store := objstore.NewMemory()
	ents := entries.NewService(store, log)
	ents.Load(context.Background())
	llm := newLLM(t)
	llm.delay = 300 * time.Millisecond
	env := settings.Defaults
	env.BaseURL, env.Model, env.MaxToolRounds = llm.srv.URL+"/v1", "m", 3
	env.ThinkOnDemand = true
	sets, _ := settings.NewService(store, env, "", log)
	tgEnv, _ := settings.ParseTelegramEnv(fmt.Sprintf("%d=ZY", zyID), "")
	sets.WithTelegramEnv(tgEnv)
	tg := newFakeTG(t)
	bot := &telegram.Bot{API: telegram.New(token, tg.srv.URL), Entries: ents, Settings: sets, Log: log,
		Agent: &agent.Runner{Entries: ents, Loc: time.UTC, Log: log, Now: time.Now}, PollSeconds: 1}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { bot.Run(ctx); close(done) }()
	for i := 0; i < 200 && !bot.Status().Running; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	tg.push(private(zyID, "Zhou", "record First"), private(zyID, "Zhou", "record Second"))
	// Stop as soon as the first turn is running (both are already polled).
	for i := 0; i < 300 && llm.inFlight.Load() == 0; i++ {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if !bot.Wait(10 * time.Second) {
		t.Fatal("workers did not finish")
	}
	if s := tg.sentCopy(); len(s) != 2 {
		t.Fatalf("both taken turns should be answered, got %d replies", len(s))
	}
	snap, _ := ents.Current(context.Background())
	if len(snap.Doc.Entries) != 2 {
		t.Fatalf("both entries should be saved, got %d", len(snap.Doc.Entries))
	}
}

// /think turns thinking on for that one message; every other message asks
// the server not to think. "/think" alone gets a hint, not a model call.
func TestThinkCommand(t *testing.T) {
	r := startBot(t)
	r.tg.push(private(zyID, "Zhou", "hello"))
	r.tg.waitSent(t, 1)
	r.tg.push(private(zyID, "Zhou", "/think\nrecord Compare quotes"))
	r.tg.waitSent(t, 2)
	r.tg.push(private(zyID, "Zhou", "/think"))
	if s := r.tg.waitSent(t, 3); !strings.Contains(s[2].Text, "Put your question after /think") {
		t.Fatalf("bare /think: %q", s[2].Text)
	}
	r.llm.mu.Lock()
	defer r.llm.mu.Unlock()
	// hello: 1 request; /think record: tool round + answer = 2 requests.
	if len(r.llm.kwargs) != 3 {
		t.Fatalf("requests: %d", len(r.llm.kwargs))
	}
	if r.llm.kwargs[0]["enable_thinking"] != false {
		t.Fatalf("plain message should ask for no thinking: %v", r.llm.kwargs[0])
	}
	for i := 1; i < 3; i++ {
		if r.llm.kwargs[i] != nil {
			t.Fatalf("/think request %d sent kwargs %v", i, r.llm.kwargs[i])
		}
	}
	msgs := r.llm.requests[1]
	if c := msgs[len(msgs)-1]["content"]; c != "record Compare quotes" {
		t.Fatalf("/think should reach the model without the command: %q", c)
	}
	if got := r.doc(t).Entries; len(got) != 1 || got[0].Title != "Compare quotes" {
		t.Fatalf("entries: %+v", got)
	}
}

// On a Claude connection /think asks for high effort and a plain message
// for low effort (think only when asked).
func TestThinkCommandOnClaude(t *testing.T) {
	r := startBot(t)
	var mu sync.Mutex
	var efforts []string
	claude := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodGet { // fallback lookup: none
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"id":"claude-opus-5-5","type":"model","allowed_fallback_models":[]}`)
			return
		}
		var body struct {
			OutputConfig struct {
				Effort string `json:"effort"`
			} `json:"output_config"`
		}
		json.NewDecoder(req.Body).Decode(&body)
		mu.Lock()
		efforts = append(efforts, body.OutputConfig.Effort)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"m","type":"message","role":"assistant","model":"claude-opus-5-5","stop_reason":"end_turn","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer claude.Close()
	r.sets.WithClaudeBaseURL(claude.URL)
	if _, err := r.sets.Save(context.Background(), "zy", settings.Input{Kind: settings.KindClaude, Model: "claude-opus-5-5", ThinkOnDemand: true}); err != nil {
		t.Fatal(err)
	}
	r.tg.push(private(zyID, "Zhou", "hello"))
	r.tg.waitSent(t, 1)
	r.tg.push(private(zyID, "Zhou", "/think compare the quotes"))
	r.tg.waitSent(t, 2)
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(efforts, ",") != "low,high" {
		t.Fatalf("efforts %v, want low then high", efforts)
	}
}
