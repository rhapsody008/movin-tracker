package telegram_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/entries"
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
		want := []string{"ci:d:" + id, "ci:m:" + id, "ci:r:" + id + ":1", "ci:r:" + id + ":7"}
		for i, b := range a.Buttons {
			if b.CallbackData != want[i] {
				t.Fatalf("%s button %d = %q, want %q", title, i, b.CallbackData, want[i])
			}
		}
	}

	// Done, Done ★, +1 week: one journaled change each, with an Undo.
	press(r, zyID, "Zhou", "ci:d:"+ids["Book movers"], groupID, 2001)
	press(r, partnerID, "Pat", "ci:m:"+ids["Order tiles"], groupID, 2002)
	press(r, zyID, "Zhou", "ci:r:"+ids["Measure windows"]+":7", groupID, 2003)
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
	press(r, zyID, "Zhou", "ci:d:"+ids["Book movers"], groupID, 2001)
	if a := r.tg.waitAnswers(t, 4); a[3] != "Already done." {
		t.Errorf("stale press answer %q", a[3])
	}
	// A stranger in the group can't press them.
	press(r, 333, "Stranger", "ci:d:"+ids["Old one"], groupID, 2004)
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
