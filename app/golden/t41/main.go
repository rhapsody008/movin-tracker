//go:build ignore

// Command t41-golden prints Go's authoritative request bytes for T4.1: the body
// the real internal/telegram Client sends for every method, recorded from a
// local server. A golden generator of the v3 port (app/golden/README.md): it
// needs the Go code, so run it before T7 deletes it.
//
// The bodies are not copied out of client.go: each one is what the real client
// marshalled, so the field order (Go's struct order for sendMessage and the
// keyboards, and a map's sorted keys for the rest) and every omitempty rule are
// Go's. The server answers `{"ok":true,"result":null}`, which json.Unmarshal
// turns into a no-op for every target type, so each call succeeds and only the
// request body is captured.
//
// Run from the repo root, in the Go tools container, and compare stdout with
// the committed fixture:
//
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t41/main.go' | cmp - app/src/telegram/testdata/requests.go.json
//
// It writes no file itself: stdout is app/src/telegram/testdata/requests.go.json.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"

	"github.com/rhapsody008/movin-tracker/internal/telegram"
)

// token is client_test.go's, with a different value from any real one.
const token = "123456789:AAFakeTokenForTestsOnly-abcdefghijk"

// golden is one recorded body per call, in the order the test replays them.
type golden struct {
	GetUpdates                string `json:"getUpdates"`
	GetMe                     string `json:"getMe"`
	SendMessage               string `json:"sendMessage"`
	SendMessagePlain          string `json:"sendMessagePlain"`
	SendChatAction            string `json:"sendChatAction"`
	AnswerCallbackQuery       string `json:"answerCallbackQuery"`
	AnswerCallbackQueryNoText string `json:"answerCallbackQueryNoText"`
	EditMessageReplyMarkup    string `json:"editMessageReplyMarkup"`
	EditMessageReplyMarkupNil string `json:"editMessageReplyMarkupNil"`
	SetMyCommands             string `json:"setMyCommands"`
	GetFile                   string `json:"getFile"`
}

func main() {
	var mu sync.Mutex
	body := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		read, err := io.ReadAll(r.Body)
		if err != nil {
			fail(err)
		}
		mu.Lock()
		body = string(read)
		mu.Unlock()
		io.WriteString(w, `{"ok":true,"result":null}`)
	}))
	defer srv.Close()
	c := telegram.New(token, srv.URL)
	ctx := context.Background()

	// take runs one client call and returns the body it sent.
	take := func(call func() error) string {
		mu.Lock()
		body = ""
		mu.Unlock()
		if err := call(); err != nil {
			fail(err)
		}
		mu.Lock()
		defer mu.Unlock()
		if body == "" {
			fail(fmt.Errorf("the client sent no body"))
		}
		return body
	}

	g := golden{
		GetUpdates: take(func() error {
			_, err := c.GetUpdates(ctx, 10, 1)
			return err
		}),
		GetMe: take(func() error {
			_, err := c.GetMe(ctx)
			return err
		}),
		// The reply of client_test.go: a threaded group message with one button.
		SendMessage: take(func() error {
			_, err := c.SendMessage(ctx, telegram.SendMessage{
				ChatID:           -1001,
				Text:             "Saved: wet kitchen · idea · Quartz top",
				ReplyToMessageID: 5,
				ReplyMarkup: &telegram.InlineKeyboardMarkup{InlineKeyboard: [][]telegram.InlineKeyboardButton{
					{{Text: "Undo", CallbackData: "undo:01ABC"}},
				}},
			})
			return err
		}),
		// What omitempty leaves out, and Go's HTML escaping of <, > and &.
		SendMessagePlain: take(func() error {
			_, err := c.SendMessage(ctx, telegram.SendMessage{
				ChatID: 111,
				Text:   `plain "quotes" & <angle> brackets`,
			})
			return err
		}),
		SendChatAction: take(func() error {
			return c.SendChatAction(ctx, -1001, "typing")
		}),
		AnswerCallbackQuery: take(func() error {
			return c.AnswerCallbackQuery(ctx, "cb1", "Undone: removed Fluted glass door")
		}),
		AnswerCallbackQueryNoText: take(func() error {
			return c.AnswerCallbackQuery(ctx, "cb1", "")
		}),
		// Two rows, so the nested array shape is pinned.
		EditMessageReplyMarkup: take(func() error {
			return c.EditMessageReplyMarkup(ctx, -1001, 77, &telegram.InlineKeyboardMarkup{
				InlineKeyboard: [][]telegram.InlineKeyboardButton{
					{{Text: "Undo", CallbackData: "undo:01ABC"}},
					{{Text: "Undo 2", CallbackData: "undo:0DEF"}},
				},
			})
		}),
		// A nil markup is the empty keyboard, which the Bot API removes a keyboard with.
		EditMessageReplyMarkupNil: take(func() error {
			return c.EditMessageReplyMarkup(ctx, -1001, 77, nil)
		}),
		SetMyCommands: take(func() error {
			return c.SetMyCommands(ctx, []telegram.BotCommand{
				{Command: "undo", Description: "Undo my last change"},
				{Command: "help", Description: "What I can do"},
			})
		}),
		GetFile: take(func() error {
			_, err := c.GetFile(ctx, "F1")
			return err
		}),
	}

	out, err := json.MarshalIndent(g, "", "  ")
	if err != nil {
		fail(err)
	}
	fmt.Println(string(out))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
