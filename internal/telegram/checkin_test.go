package telegram_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/telegram"
)

// 2026-11-12 (a Thursday), 09:30 in the rig's UTC.
var ciNow = time.Date(2026, 11, 12, 9, 30, 0, 0, time.UTC)

func fixedNow(b *telegram.Bot) {
	b.Now = func() time.Time { return ciNow }
	b.Agent.Now = b.Now
}

func seed(t *testing.T, r *botRig, items ...map[string]any) map[string]string {
	t.Helper()
	ids := map[string]string{}
	for _, it := range items {
		p, err := entries.PatchFromMap(it)
		if err != nil {
			t.Fatal(err)
		}
		res, err := r.ents.Create(context.Background(), entries.Actor{By: "ZY", Channel: "web"}, []entries.Patch{p})
		if err != nil {
			t.Fatal(err)
		}
		ids[it["title"].(string)] = res.Entries[0].ID
	}
	return ids
}

func task(title, date string, extra ...string) map[string]any {
	m := map[string]any{"kind": "task", "title": title, "date": date}
	for i := 0; i+1 < len(extra); i += 2 {
		m[extra[i]] = extra[i+1]
	}
	return m
}

func press(r *botRig, from int64, first, data string, chat int64, msgID int64) {
	r.tg.push(telegram.Update{CallbackQuery: &telegram.CallbackQuery{ID: fmt.Sprint("cb", msgID, data), From: telegram.User{ID: from, FirstName: first}, Data: data,
		Message: &telegram.Message{MessageID: msgID, Chat: telegram.Chat{ID: chat, Type: "supergroup"},
			ReplyMarkup: &telegram.InlineKeyboardMarkup{InlineKeyboard: [][]telegram.InlineKeyboardButton{{{Text: "x", CallbackData: data}}}}}}})
}

func (f *fakeTG) waitAnswers(t *testing.T, n int) []string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		a := append([]string{}, f.answers...)
		f.mu.Unlock()
		if len(a) >= n {
			return a
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("waited for %d callback answers", n)
	return nil
}

func TestCheckinCommandAndButtons(t *testing.T) {
	r := startBot(t, fixedNow)
	r.ents.SetClock(func() time.Time { return ciNow })
	ids := seed(t, r,
		task("Electrician", "2026-11-12", "time", "14:00"),
		map[string]any{"kind": "question", "title": "Pick grout colour", "date": "2026-11-12"},
		task("Book movers", "2026-11-11"),
		task("Order tiles", "2026-11-11"),
		task("Measure windows", "2026-11-11", "room", "living"),
		task("Already done", "2026-11-11", "status", "done"),
		task("Old one", "2026-11-07"),
		task("Next week", "2026-11-19"),
	)
	r.tg.push(inGroup(groupID, zyID, "Zhou", "/checkin", 50))
	sent := r.tg.waitSent(t, 4)
	sum := sent[0].Text
	for _, want := range []string{"Good morning! Thu 12 Nov", "• 14:00 Electrician", "• Pick grout colour", "Not marked done yet (3)", "Still overdue (1):\n• Old one — Sat 7 Nov"} {
		if !strings.Contains(sum, want) {
			t.Errorf("summary lacks %q:\n%s", want, sum)
		}
	}
	if strings.Contains(sum, "Already done") || strings.Contains(sum, "Next week") {
		t.Errorf("summary lists done or future tasks:\n%s", sum)
	}
	asks := sent[1:4]
	for _, a := range asks {
		if a.ChatID != groupID || !strings.HasPrefix(a.Text, "Yesterday: ") || len(a.Buttons) != 4 {
			t.Fatalf("ask message: %+v", a)
		}
		title := strings.TrimSuffix(strings.TrimPrefix(strings.SplitN(a.Text, "\n", 2)[0], "Yesterday: "), " (living)")
		id := ids[title]
		base := id + ":20261111"
		want := []string{"ci:d:" + base, "ci:m:" + base, "ci:r:" + base + ":1", "ci:r:" + base + ":7"}
		for i, b := range a.Buttons {
			if b.CallbackData != want[i] {
				t.Fatalf("%s button %d = %q, want %q", title, i, b.CallbackData, want[i])
			}
		}
	}

	// Done, Done ★, +1 week: one journaled change each, with an Undo.
	press(r, zyID, "Zhou", "ci:d:"+ids["Book movers"]+":20261111", groupID, 2001)
	press(r, partnerID, "Pat", "ci:m:"+ids["Order tiles"]+":20261111", groupID, 2002)
	press(r, zyID, "Zhou", "ci:r:"+ids["Measure windows"]+":20261111:7", groupID, 2003)
	sent = r.tg.waitSent(t, 7)
	wantReplies := []string{
		"✓ ZY: Updated: Book movers (status done)",
		"✓ Partner: Updated: Order tiles (status done, ★ milestone)",
		"✓ ZY: Updated: Measure windows (date 2026-11-19)",
	}
	for i, w := range wantReplies {
		if got := sent[4+i]; got.Text != w || len(got.Buttons) != 1 || !strings.HasPrefix(got.Buttons[0].CallbackData, "undo:") {
			t.Errorf("reply %d = %+v, want %q with Undo", i, got, w)
		}
	}
	d := r.doc(t)
	get := func(title string) entries.Entry { e, _ := d.Find(ids[title]); return e }
	if e := get("Book movers"); e.Status != "done" || e.Milestone || e.By != "ZY" || e.Channel != "telegram" || e.Completed == nil || *e.Completed != "2026-11-12" {
		t.Errorf("Book movers: %+v", e)
	}
	if e := get("Order tiles"); !e.IsMilestone() || e.By != "Partner" {
		t.Errorf("Order tiles: %+v", e)
	}
	if e := get("Measure windows"); *e.Date != "2026-11-19" || e.Status != "todo" {
		t.Errorf("Measure windows: %+v", e)
	}
	r.tg.mu.Lock()
	edits := len(r.tg.edits)
	r.tg.mu.Unlock()
	if edits != 3 {
		t.Errorf("each pressed message should lose its buttons: %d edits", edits)
	}

	// A second press on an answered task writes nothing.
	changes := len(r.doc(t).Changes)
	press(r, zyID, "Zhou", "ci:d:"+ids["Book movers"]+":20261111", groupID, 2001)
	if a := r.tg.waitAnswers(t, 4); a[3] != "Already done." {
		t.Errorf("stale press answer %q", a[3])
	}
	// A stranger in the group can't press them.
	press(r, 333, "Stranger", "ci:d:"+ids["Old one"]+":20261107", groupID, 2004)
	if a := r.tg.waitAnswers(t, 5); !strings.Contains(a[4], "not on this bot's list") {
		t.Errorf("stranger: %q", a[4])
	}
	if n := len(r.doc(t).Changes); n != changes {
		t.Errorf("stale or refused presses changed something: %d → %d", changes, n)
	}
	// The Undo under a Done reply puts the task back.
	press(r, zyID, "Zhou", sent[4].Buttons[0].CallbackData, groupID, 2005)
	r.tg.waitSent(t, 8)
	if e, _ := r.doc(t).Find(ids["Book movers"]); e.Status != "todo" || e.Completed != nil {
		t.Errorf("undo of Done: %+v", e)
	}
	// None of this asked the model.
	r.llm.mu.Lock()
	calls := len(r.llm.requests)
	r.llm.mu.Unlock()
	if calls != 0 {
		t.Errorf("check-in called the LLM %d times", calls)
	}
}

func TestCheckinCapsAskMessages(t *testing.T) {
	r := startBot(t, fixedNow)
	var items []map[string]any
	for i := 1; i <= 10; i++ {
		items = append(items, task(fmt.Sprintf("Task %02d", i), "2026-11-11"))
	}
	seed(t, r, items...)
	r.tg.push(private(zyID, "Zhou", "/checkin"))
	sent := r.tg.waitSent(t, 9)
	time.Sleep(200 * time.Millisecond)
	if n := len(r.tg.sentCopy()); n != 9 {
		t.Fatalf("want summary + 8 asks, got %d messages", n)
	}
	if s := sent[0].Text; !strings.Contains(s, "Not marked done yet (10)") || !strings.Contains(s, "Also open from earlier days:\n• Task 09 — Wed 11 Nov\n• Task 10 — Wed 11 Nov") {
		t.Fatalf("summary:\n%s", s)
	}
}

func TestCheckinQuietDayAndTypedReply(t *testing.T) {
	r := startBot(t, fixedNow)
	r.tg.push(private(zyID, "Zhou", "/checkin"))
	if s := r.tg.waitSent(t, 1); !strings.Contains(s[0].Text, "Nothing dated for today, and no open tasks") {
		t.Fatalf("quiet: %+v", s[0])
	}
	seed(t, r, task("Book movers", "2026-11-11"))
	r.tg.push(inGroup(groupID, zyID, "Zhou", "/checkin", 60))
	r.tg.waitSent(t, 3)
	// A reply in words reaches the agent together with the check-in.
	r.tg.push(inGroup(groupID, zyID, "Zhou", "booked them yesterday", 61))
	r.tg.waitSent(t, 4)
	r.llm.mu.Lock()
	reqs := r.llm.requests
	r.llm.mu.Unlock()
	if len(reqs) != 1 {
		t.Fatalf("llm requests %d", len(reqs))
	}
	var sawCheckin bool
	for _, m := range reqs[0] {
		if c, _ := m["content"].(string); m["role"] == "assistant" && strings.Contains(c, "Good morning!") && strings.Contains(c, "Asked about:\n• Yesterday: Book movers") {
			sawCheckin = true
		}
	}
	if !sawCheckin {
		t.Fatalf("check-in not in the agent's history: %+v", reqs[0])
	}
}

// scheduled sets up the 09:30 check-in on a clock the test moves (SGT).
func scheduled(t *testing.T, now *time.Time) (*botRig, objstore.Store) {
	t.Helper()
	state := objstore.NewMemory()
	sg, _ := time.LoadLocation("Asia/Singapore")
	r := startBot(t, func(b *telegram.Bot) {
		b.Now = func() time.Time { return *now }
		b.Agent.Now, b.Agent.Loc = b.Now, sg
		b.Checkin = &telegram.Checkin{Hour: 9, Minute: 30, State: &telegram.CheckinStore{Store: state}}
	})
	return r, state
}

func sgt(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s+"+08:00")
	if err != nil {
		panic(err)
	}
	return t
}

func record(t *testing.T, store objstore.Store) telegram.CheckinRecord {
	t.Helper()
	r, _, err := (&telegram.CheckinStore{Store: store}).Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestCheckinScheduleCatchUpOncePerDay(t *testing.T) {
	ctx := context.Background()
	now := sgt("2026-11-12T08:00:00")
	r, state := scheduled(t, &now)
	seed(t, r, task("Book movers", "2026-11-11"), task("Electrician", "2026-11-12"))

	r.bot.CheckinTick(ctx) // 08:00: not yet
	now = sgt("2026-11-12T14:00:00")
	r.bot.CheckinTick(ctx) // the Mac woke at 14:00: catch up
	sent := r.tg.waitSent(t, 2)
	if sent[0].ChatID != groupID || !strings.Contains(sent[0].Text, "Good morning! Thu 12 Nov") || !strings.HasPrefix(sent[1].Text, "Yesterday: Book movers") {
		t.Fatalf("check-in: %+v", sent)
	}
	if rec := record(t, state); rec.Day != "2026-11-12" || rec.Status != telegram.CheckinSent || rec.Chat != fmt.Sprint(groupID) {
		t.Fatalf("record: %+v", rec)
	}
	r.bot.CheckinTick(ctx) // same process, later tick
	now = sgt("2026-11-12T14:05:00")
	// Another copy of the app (production) on the same bucket.
	other := &telegram.Bot{API: r.bot.API, Entries: r.ents, Settings: r.sets, Agent: r.bot.Agent, Log: r.bot.Log, Now: r.bot.Now,
		Checkin: &telegram.Checkin{Hour: 9, Minute: 30, State: &telegram.CheckinStore{Store: state}}}
	other.CheckinTick(ctx)
	time.Sleep(100 * time.Millisecond)
	if n := len(r.tg.sentCopy()); n != 2 {
		t.Fatalf("sent twice: %d messages", n)
	}

	// The next morning asks about the 12th's task (it was "today" on the
	// 12th); the 11th's, already asked about, is overdue.
	now = sgt("2026-11-13T09:30:00")
	r.bot.CheckinTick(ctx)
	sent = r.tg.waitSent(t, 4)
	if !strings.HasPrefix(sent[3].Text, "Yesterday: Electrician") || !strings.Contains(sent[2].Text, "Not marked done yet (1)") || !strings.Contains(sent[2].Text, "Still overdue (1):\n• Book movers") {
		t.Fatalf("back-to-back day: %q / %q", sent[2].Text, sent[3].Text)
	}

	// The 14th and 15th are missed (Mac off); on the 16th both days' tasks
	// are asked about, and the older ones are overdue.
	seed(t, r, task("Paint touch-up", "2026-11-14"), task("Sweep", "2026-11-15"))
	now = sgt("2026-11-16T09:31:00")
	r.bot.CheckinTick(ctx)
	sent = r.tg.waitSent(t, 7)
	if !strings.HasPrefix(sent[5].Text, "Sat 14 Nov: Paint touch-up") || !strings.HasPrefix(sent[6].Text, "Yesterday: Sweep") {
		t.Fatalf("missed days not asked: %+v", sent[4:])
	}
	if s := sent[4].Text; !strings.Contains(s, "Not marked done yet (2)") || !strings.Contains(s, "Still overdue (2)") || !strings.Contains(s, "Book movers") || !strings.Contains(s, "Electrician") {
		t.Fatalf("summary on the 16th:\n%s", s)
	}
}

// Another copy claimed the day and died mid-send: this one keeps checking
// and takes over after StaleClaim, asking about the crashed claim's days.
func TestCheckinTakesOverACrashedClaim(t *testing.T) {
	ctx := context.Background()
	now := sgt("2026-11-13T09:30:00")
	r, state := scheduled(t, &now)
	seed(t, r, task("Electrician", "2026-11-12"))
	st := &telegram.CheckinStore{Store: state}
	// The 12th went out (from another copy), then the 13th was claimed and lost.
	c, _, _ := st.Claim(ctx, "2026-11-12", fmt.Sprint(groupID), now.Add(-24*time.Hour))
	st.Finish(ctx, c, telegram.CheckinSent, now.Add(-24*time.Hour))
	if c, _, _ = st.Claim(ctx, "2026-11-13", fmt.Sprint(groupID), now); c == nil {
		t.Fatal("no crash claim")
	}
	r.bot.CheckinTick(ctx)
	now = now.Add(5 * time.Minute)
	r.bot.CheckinTick(ctx)
	time.Sleep(100 * time.Millisecond)
	if n := len(r.tg.sentCopy()); n != 0 {
		t.Fatalf("sent while the other claim was fresh: %d", n)
	}
	now = now.Add(6 * time.Minute)
	r.bot.CheckinTick(ctx)
	sent := r.tg.waitSent(t, 2)
	if !strings.HasPrefix(sent[1].Text, "Yesterday: Electrician") {
		t.Fatalf("takeover asked: %+v", sent)
	}
	if rec := record(t, state); rec.Status != telegram.CheckinSent || rec.Since != "2026-11-12" {
		t.Fatalf("record after takeover: %+v", rec)
	}
}

func TestCheckinTooLateQuietAndFailure(t *testing.T) {
	ctx := context.Background()
	now := sgt("2026-11-12T21:00:00")
	r, state := scheduled(t, &now)
	seed(t, r, task("Book movers", "2026-11-11"))
	r.bot.CheckinTick(ctx) // started at 21:00: skip the day
	time.Sleep(100 * time.Millisecond)
	if n := len(r.tg.sentCopy()); n != 0 || record(t, state).Day != "" {
		t.Fatalf("sent after the cutoff: %d, %+v", n, record(t, state))
	}

	// Telegram down at 09:30: the day is given back and retried.
	now = sgt("2026-11-13T09:30:00")
	r.tg.mu.Lock()
	r.tg.failSend = true
	r.tg.mu.Unlock()
	r.bot.CheckinTick(ctx)
	if rec := record(t, state); rec.Status == telegram.CheckinSent || rec.Day == "2026-11-13" {
		t.Fatalf("a failed send kept the day: %+v", rec)
	}
	r.tg.mu.Lock()
	r.tg.failSend = false
	r.tg.mu.Unlock()
	now = sgt("2026-11-13T09:31:00")
	r.bot.CheckinTick(ctx)
	sent := r.tg.waitSent(t, 1)
	if !strings.Contains(sent[0].Text, "Good morning! Fri 13 Nov") || record(t, state).Status != telegram.CheckinSent {
		t.Fatalf("retry: %+v %+v", sent, record(t, state))
	}

	// A quiet day: nothing sent, recorded as quiet.
	if _, err := r.ents.Update(ctx, entries.Actor{By: "ZY", Channel: "web"}, r.doc(t).Entries[0].ID, mustPatchMap(t, map[string]any{"status": "done"})); err != nil {
		t.Fatal(err)
	}
	n := len(r.tg.sentCopy())
	now = sgt("2026-11-14T10:00:00")
	r.bot.CheckinTick(ctx)
	time.Sleep(100 * time.Millisecond)
	if got := len(r.tg.sentCopy()); got != n {
		t.Fatalf("quiet day sent %d messages", got-n)
	}
	if rec := record(t, state); rec.Day != "2026-11-14" || rec.Status != telegram.CheckinQuiet {
		t.Fatalf("quiet record: %+v", rec)
	}
}

func mustPatchMap(t *testing.T, m map[string]any) entries.Patch {
	t.Helper()
	p, err := entries.PatchFromMap(m)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// A task moved elsewhere after the check-in asked about it: its buttons
// change nothing.
func TestCheckinButtonAfterTheTaskMoved(t *testing.T) {
	r := startBot(t, fixedNow)
	ids := seed(t, r, task("Book movers", "2026-11-11"))
	r.tg.push(inGroup(groupID, zyID, "Zhou", "/checkin", 70))
	sent := r.tg.waitSent(t, 2)
	tomorrow := sent[1].Buttons[2].CallbackData
	if tomorrow != "ci:r:"+ids["Book movers"]+":20261111:1" {
		t.Fatalf("button data %q", tomorrow)
	}
	// Moved to Friday in the chat or on the web page.
	if _, err := r.ents.Update(context.Background(), entries.Actor{By: "Partner", Channel: "web"}, ids["Book movers"], mustPatchMap(t, map[string]any{"date": "2026-11-13"})); err != nil {
		t.Fatal(err)
	}
	changes := len(r.doc(t).Changes)
	press(r, zyID, "Zhou", tomorrow, groupID, 3001)
	if a := r.tg.waitAnswers(t, 1); a[0] != "That task was moved since (Fri 13 Nov), so I left it." {
		t.Fatalf("answer %q", a[0])
	}
	press(r, zyID, "Zhou", "ci:d:"+ids["Book movers"]+":20261111", groupID, 3002)
	r.tg.waitAnswers(t, 2)
	if e, _ := r.doc(t).Find(ids["Book movers"]); len(r.doc(t).Changes) != changes || *e.Date != "2026-11-13" || e.Status != "todo" {
		t.Fatalf("a moved task was changed: %+v", e)
	}
	// Malformed data (an old button without the date) does nothing either.
	press(r, zyID, "Zhou", "ci:d:"+ids["Book movers"], groupID, 3003)
	r.tg.waitAnswers(t, 3)
	if len(r.doc(t).Changes) != changes {
		t.Fatal("malformed button changed something")
	}
}

// The check-in arrives while the agent is still answering a message in the
// same chat: both end up in the chat's history.
func TestCheckinDuringAnAgentTurnKeepsBoth(t *testing.T) {
	ctx := context.Background()
	now := sgt("2026-11-12T09:30:00")
	r, _ := scheduled(t, &now)
	r.llm.delay = 400 * time.Millisecond
	seed(t, r, task("Book movers", "2026-11-11"))
	r.tg.push(inGroup(groupID, zyID, "Zhou", "hello there", 80))
	for i := 0; i < 100 && r.llm.inFlight.Load() == 0; i++ {
		time.Sleep(5 * time.Millisecond)
	}
	r.bot.CheckinTick(ctx) // lands mid-turn
	r.tg.waitSent(t, 3)    // summary, ask, and the "ok" reply
	r.tg.push(inGroup(groupID, zyID, "Zhou", "booked them", 81))
	r.tg.waitSent(t, 4)
	r.llm.mu.Lock()
	last := r.llm.requests[len(r.llm.requests)-1]
	r.llm.mu.Unlock()
	var hello, checkin bool
	for _, m := range last {
		c, _ := m["content"].(string)
		hello = hello || (m["role"] == "user" && strings.Contains(c, "hello there"))
		checkin = checkin || (m["role"] == "assistant" && strings.Contains(c, "Good morning!"))
	}
	if !hello || !checkin {
		t.Fatalf("history lost a part (hello %v, check-in %v): %+v", hello, checkin, last)
	}
}

// CHECKIN_CHAT must be on the allowlist: elsewhere every button would be refused.
func TestCheckinChatMustBeAllowed(t *testing.T) {
	ctx := context.Background()
	now := sgt("2026-11-12T09:30:00")
	r, state := scheduled(t, &now)
	seed(t, r, task("Book movers", "2026-11-11"))
	r.bot.Checkin.Chat = -999
	if v := r.bot.CheckinStatus(ctx); !strings.Contains(v.Error, "CHECKIN_CHAT -999 is not an allowed group or person") {
		t.Fatalf("status: %+v", v)
	}
	r.bot.CheckinTick(ctx)
	time.Sleep(100 * time.Millisecond)
	if n := len(r.tg.sentCopy()); n != 0 || record(t, state).Day != "" {
		t.Fatalf("sent to a chat that isn't allowed: %d", n)
	}
	r.bot.Checkin.Chat = zyID // a person on the list: fine (private chat)
	if v := r.bot.CheckinStatus(ctx); v.Error != "" || v.Chat != fmt.Sprint(zyID) {
		t.Fatalf("allowed person: %+v", v)
	}
}
