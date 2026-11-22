//go:build ignore

// Command t43-golden prints Go's authoritative Telegram reply bytes for T4.3a:
// what split, truncate, changeText and undoKeyboard answer, and the sendMessage
// bodies Go's own reply sent for a turn's answer and for its failure line. A
// golden generator of the v3 port (app/golden/README.md): it needs the Go code,
// so run it before T7 deletes it.
//
// These are unexported functions in internal/telegram, so they are copied here
// verbatim from internal/telegram/bot.go with the lines they come from:
//
//	changeText    :496-503
//	undoKeyboard  :505-534
//	reply         :596-613 (the sending loop; the real method also logs and
//	              records the error, and reads the address off a *Message)
//	split         :615-636
//	truncate      :638-644
//
// and the two text assemblies out of converse, also verbatim:
//
//	the failure line  :440-447
//	the answer        :449-456
//
// The bodies are not re-typed either: each message is what the real
// telegram.Client marshalled, recorded by a local server, so field order and
// every omitempty rule are Go's (the way app/golden/t41 does it).
//
// Run from the repo root, in the Go tools container, and compare stdout with
// the committed fixture:
//
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t43/main.go' | cmp - app/src/telegram/testdata/format.go.json
//
// It writes no file itself: stdout is app/src/telegram/testdata/format.go.json.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"

	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/telegram"
)

// bot.go:85-94.
const (
	maxMessage     = 4000
	maxUndoButtons = 8
)

// token is t41's, with a different value from any real one.
const token = "123456789:AAFakeTokenForTestsOnly-abcdefghijk"

type golden struct {
	MaxMessage   int                 `json:"max_message"`
	Split        []splitCase         `json:"split"`
	Truncate     []truncateCase      `json:"truncate"`
	ChangeText   []changeCase        `json:"change_text"`
	UndoKeyboard []keyboardCase      `json:"undo_keyboard"`
	Messages     map[string][]string `json:"messages"`
}

type splitCase struct {
	Text  string   `json:"text"`
	N     int      `json:"n"`
	Parts []string `json:"parts"`
}

type truncateCase struct {
	Text string `json:"text"`
	N    int    `json:"n"`
	Out  string `json:"out"`
}

type changeCase struct {
	Changes []agent.ChangeLine `json:"changes"`
	Out     string             `json:"out"`
}

// keyboardCase keeps the keyboard as compact JSON text, so the comparison in
// the port is byte for byte ("null" for no keyboard).
type keyboardCase struct {
	Changes  []agent.ChangeLine `json:"changes"`
	Keyboard string             `json:"keyboard"`
}

// twoParts is 5001 runes with its only break at 3000: two parts at maxMessage.
var twoParts = strings.Repeat("a", 3000) + "\n" + strings.Repeat("b", 2000)

// savedOne is a journaled write; savedTwo adds the key dates, which have no id
// and so get no button.
var (
	savedOne = []agent.ChangeLine{{ID: "01K8ZQ4R7S9T2V5W8X1Y3Z5A6B", Text: "Saved: note · Fluted glass door"}}
	savedTwo = []agent.ChangeLine{
		{ID: "01K8ZQ4R7S9T2V5W8X1Y3Z5A6B", Text: "Saved: note · Fluted glass door"},
		{Text: "Move-in set to Sat, 5 Dec"},
	}
)

func main() {
	var mu sync.Mutex
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			fail(err)
		}
		mu.Lock()
		bodies = append(bodies, string(raw))
		mu.Unlock()
		io.WriteString(w, `{"ok":true,"result":null}`)
	}))
	defer srv.Close()
	c := telegram.New(token, srv.URL)

	// sent runs one turn's reply and returns the bodies it sent, in order.
	sent := func(fn func() error) []string {
		mu.Lock()
		bodies = nil
		mu.Unlock()
		if err := fn(); err != nil {
			fail(err)
		}
		mu.Lock()
		defer mu.Unlock()
		out := make([]string, len(bodies))
		copy(out, bodies)
		return out
	}

	// nineThousand is 9000 runes without a break, and the same length broken
	// every 100 runes.
	nineThousand := strings.Repeat("a", 9000)
	var broken strings.Builder
	for i := 0; i < 90; i++ {
		broken.WriteString(strings.Repeat("b", 99))
		broken.WriteString("\n")
	}

	// The inputs are listed once; every answer below is Go's own.
	splits := []splitCase{
		{Text: "short", N: 10},
		{Text: "", N: 10},
		// bot_internal_test.go:16-20: the last break in the second half wins.
		{Text: "aaaaaaa\nbbbbbbbbb\ncc", N: 10},
		// bot_internal_test.go:21-25: a hard cut by runes, not bytes.
		{Text: strings.Repeat("é", 25), N: 10},
		// One code point, two UTF-16 units.
		{Text: strings.Repeat("\U0001F600", 25), N: 10},
		{Text: strings.Repeat("装", 25), N: 10},
		{Text: strings.Repeat("\U0001F600", 3) + "\n" + strings.Repeat("x", 30), N: 10},
		{Text: nineThousand, N: maxMessage},
		{Text: broken.String(), N: maxMessage},
		// A break exactly at n/2 is outside the window (i > n/2), so the cut
		// is the hard one at n.
		{Text: strings.Repeat("c", 2000) + "\n" + strings.Repeat("d", 2999), N: maxMessage},
		// A break exactly at n/2+1 is one the window holds.
		{Text: strings.Repeat("e", 2001) + "\n" + strings.Repeat("f", 2999), N: maxMessage},
		// A run of newlines at the cut: the chunk loses its trailing one and
		// the rest loses its leading one.
		{Text: strings.Repeat("g", 3003) + "\n\n" + strings.Repeat("h", 1000), N: maxMessage},
	}
	for i := range splits {
		splits[i].Parts = split(splits[i].Text, splits[i].N)
	}
	truncations := []truncateCase{
		{Text: "short", N: 300},
		{Text: strings.Repeat("i", 300), N: 300},
		{Text: strings.Repeat("j", 301), N: 300},
		{Text: strings.Repeat("\U0001F600", 301), N: 300},
		{Text: strings.Repeat("k", 200), N: 190},
		{Text: "one", N: 1},
	}
	for i := range truncations {
		truncations[i].Out = truncate(truncations[i].Text, truncations[i].N)
	}
	lines := []changeCase{
		{Changes: []agent.ChangeLine{}},
		{Changes: []agent.ChangeLine{{ID: "01K", Text: "Saved: note · Fluted glass door"}}},
		{Changes: []agent.ChangeLine{{Text: "Move-in set to Sat, 5 Dec"}}},
		{Changes: []agent.ChangeLine{
			{ID: "01K", Text: "Saved: note · Fluted glass door"},
			{Text: "Move-in set to Sat, 5 Dec"},
			{ID: "01M", Text: "Updated: Nook (status done, room flex)"},
		}},
	}
	for i := range lines {
		lines[i].Out = changeText(lines[i].Changes)
	}
	keyboards := []keyboardCase{
		{Changes: []agent.ChangeLine{}},
		{Changes: []agent.ChangeLine{{Text: "Move-in set to Sat, 5 Dec"}}},
		{Changes: []agent.ChangeLine{{ID: "a", Text: "x"}}},
		{Changes: []agent.ChangeLine{{ID: "a", Text: "x"}, {Text: "no id"}}},
		{Changes: ids(8)},
		{Changes: ids(9)},
		{Changes: ids(10)},
		// A 26-character change id, v3's shape: 31 bytes of callback data.
		{Changes: []agent.ChangeLine{{ID: "01K8ZQ4R7S9T2V5W8X1Y3Z5A6B", Text: "Saved: note · Fluted glass door"}}},
	}
	for i := range keyboards {
		raw, err := json.Marshal(undoKeyboard(keyboards[i].Changes))
		if err != nil {
			fail(err)
		}
		keyboards[i].Keyboard = string(raw)
	}

	g := golden{
		MaxMessage:   maxMessage,
		Split:        splits,
		Truncate:     truncations,
		ChangeText:   lines,
		UndoKeyboard: keyboards,
		// T4.1's requests.go.json shape: a name per case, the raw bodies it sent.
		Messages: map[string][]string{
			// The success half of converse (:449-456) through reply (:596-613).
			"group_reply_with_changes": sent(func() error {
				return reply(c, -1001, 7, true, answer("Looks good.", savedOne), savedOne)
			}),
			// Two parts: the thread on the first, the keyboard on the last.
			"group_two_parts_with_changes": sent(func() error {
				return reply(c, -1001, 7, true, answer(twoParts, savedTwo), savedTwo)
			}),
			// A private chat: no reply_to_message_id.
			"private_reply_with_changes": sent(func() error {
				return reply(c, 111, 7, false, answer("Looks good.", savedOne), savedOne)
			}),
			"reply_without_changes": sent(func() error {
				return reply(c, 111, 7, false, answer("No answer came back. Try rephrasing.", nil), nil)
			}),
			// The failure half of converse (:440-447).
			"failure_with_changes": sent(func() error {
				return reply(c, -1001, 7, true, failure("context deadline exceeded", savedTwo), savedTwo)
			}),
			// A 301-rune detail: truncate(detail, 300), ellipsis included.
			"failure_with_long_detail": sent(func() error {
				return reply(c, 111, 7, false, failure(strings.Repeat("l", 301), nil), nil)
			}),
			// Go's group silence: converse returns before any send.
			"silent": sent(func() error { return nil }),
		},
	}

	out, err := json.MarshalIndent(g, "", "  ")
	if err != nil {
		fail(err)
	}
	fmt.Println(string(out))
}

// ids is n journaled change lines, labelled a, b, c … like TestUndoKeyboard.
func ids(n int) []agent.ChangeLine {
	var out []agent.ChangeLine
	for i := 0; i < n; i++ {
		out = append(out, agent.ChangeLine{ID: string(rune('a' + i)), Text: "x"})
	}
	return out
}

// answer is the success half of converse (bot.go:449-456), verbatim.
func answer(repl string, changes []agent.ChangeLine) string {
	out := repl
	if len(changes) > 0 {
		out += "\n\n" + changeText(changes)
	}
	return out
}

// failure is the failure line of converse (bot.go:440-447), verbatim.
func failure(detail string, changes []agent.ChangeLine) string {
	msg := "Sorry, that didn't go through: " + truncate(detail, 300)
	if len(changes) > 0 {
		msg += "\n\nSome changes were saved before it failed:\n" + changeText(changes)
	}
	return msg
}

// reply is Bot.reply (bot.go:596-613), verbatim apart from taking the client
// and the address a *Message would carry; converse hands it undoKeyboard of the
// turn's changes, which is what the two lines below do.
func reply(c *telegram.Client, chatID, messageID int64, group bool, text string, changes []agent.ChangeLine) error {
	kb := undoKeyboard(changes)
	parts := split(text, maxMessage)
	for i, p := range parts {
		sm := telegram.SendMessage{ChatID: chatID, Text: p}
		if i == 0 && group {
			sm.ReplyToMessageID = messageID
		}
		if i == len(parts)-1 {
			sm.ReplyMarkup = kb
		}
		if _, err := c.SendMessage(context.Background(), sm); err != nil {
			return err
		}
	}
	return nil
}

// changeText is bot.go:496-503, verbatim.
func changeText(changes []agent.ChangeLine) string {
	var lines []string
	for _, c := range changes {
		lines = append(lines, "• "+c.Text)
	}
	return strings.Join(lines, "\n")
}

// undoKeyboard is bot.go:505-534, verbatim.
func undoKeyboard(changes []agent.ChangeLine) *telegram.InlineKeyboardMarkup {
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
	var row []telegram.InlineKeyboardButton
	for i, id := range ids {
		label := "Undo"
		if len(ids) > 1 {
			label = fmt.Sprintf("Undo %d", i+1)
		}
		row = append(row, telegram.InlineKeyboardButton{Text: label, CallbackData: "undo:" + id})
	}
	// Four buttons per row keeps them tappable on a phone.
	kb := &telegram.InlineKeyboardMarkup{}
	for len(row) > 0 {
		n := min(4, len(row))
		kb.InlineKeyboard = append(kb.InlineKeyboard, row[:n])
		row = row[n:]
	}
	return kb
}

// split is bot.go:615-636, verbatim.
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

// truncate is bot.go:638-644, verbatim.
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
