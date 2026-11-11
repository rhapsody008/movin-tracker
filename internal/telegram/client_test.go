package telegram_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/telegram"
)

const token = "123456789:AAFakeTokenForTestsOnly-abcdefghijk"

// fakeAPI records each call's method and JSON body and answers from a
// per-method handler.
type fakeAPI struct {
	mu    sync.Mutex
	calls []call
	srv   *httptest.Server
	reply map[string]func(body map[string]any) (int, string)
	files map[string][]byte
}

type call struct {
	Method string
	Body   map[string]any
}

func newFake(t *testing.T) *fakeAPI {
	f := &fakeAPI{reply: map[string]func(map[string]any) (int, string){}, files: map[string][]byte{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p, ok := strings.CutPrefix(r.URL.Path, "/file/bot"+token+"/"); ok {
			data, ok := f.files[p]
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Write(data)
			return
		}
		method, ok := strings.CutPrefix(r.URL.Path, "/bot"+token+"/")
		if !ok {
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, `{"ok":false,"error_code":401,"description":"Unauthorized"}`)
			return
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.calls = append(f.calls, call{method, body})
		h := f.reply[method]
		f.mu.Unlock()
		code, out := http.StatusOK, `{"ok":true,"result":true}`
		if h != nil {
			code, out = h(body)
		}
		w.WriteHeader(code)
		io.WriteString(w, out)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAPI) last() call {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[len(f.calls)-1]
}

func TestGetUpdatesDecodesAndSendsOffset(t *testing.T) {
	f := newFake(t)
	f.reply["getUpdates"] = func(map[string]any) (int, string) {
		return 200, `{"ok":true,"result":[
		  {"update_id":10,"message":{"message_id":1,"from":{"id":111,"is_bot":false,"first_name":"ZY"},"chat":{"id":-1001,"type":"supergroup","title":"Reno"},"date":1,"text":"quartz for wet kitchen"}},
		  {"update_id":11,"callback_query":{"id":"cb1","from":{"id":222,"first_name":"P"},"message":{"message_id":2,"chat":{"id":-1001,"type":"supergroup"},"date":2},"data":"undo:01ABC"}},
		  {"update_id":12,"message":{"message_id":3,"from":{"id":111,"first_name":"ZY"},"chat":{"id":111,"type":"private"},"date":3,"document":{"file_id":"F1","file_unique_id":"U1","file_name":"E1 Electrical.pdf","mime_type":"application/pdf","file_size":2048}}}
		]}`
	}
	c := telegram.New(token, f.srv.URL)
	ups, err := c.GetUpdates(context.Background(), 10, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(ups) != 3 {
		t.Fatalf("got %d updates", len(ups))
	}
	m := ups[0].Message
	if m.Text != "quartz for wet kitchen" || m.From.ID != 111 || m.Chat.ID != -1001 || !m.Chat.IsGroup() {
		t.Fatalf("message: %+v", m)
	}
	if cb := ups[1].CallbackQuery; cb.Data != "undo:01ABC" || cb.From.ID != 222 || cb.Message.Chat.ID != -1001 {
		t.Fatalf("callback: %+v", cb)
	}
	if d := ups[2].Message.Document; d.FileName != "E1 Electrical.pdf" || d.FileSize != 2048 || ups[2].Message.Chat.IsGroup() {
		t.Fatalf("document: %+v", d)
	}
	body := f.last().Body
	if body["offset"] != float64(10) || body["timeout"] != float64(1) {
		t.Fatalf("getUpdates params: %v", body)
	}
	if fmt.Sprint(body["allowed_updates"]) != "[message callback_query]" {
		t.Fatalf("allowed_updates: %v", body["allowed_updates"])
	}
}

func TestSendMessageAndButtons(t *testing.T) {
	f := newFake(t)
	f.reply["sendMessage"] = func(b map[string]any) (int, string) {
		return 200, fmt.Sprintf(`{"ok":true,"result":{"message_id":77,"chat":{"id":%v,"type":"private"},"date":1,"text":%q}}`, b["chat_id"], b["text"])
	}
	c := telegram.New(token, f.srv.URL)
	ctx := context.Background()
	m, err := c.SendMessage(ctx, telegram.SendMessage{ChatID: -1001, Text: "Saved: wet kitchen · idea · Quartz top", ReplyToMessageID: 5,
		ReplyMarkup: &telegram.InlineKeyboardMarkup{InlineKeyboard: [][]telegram.InlineKeyboardButton{{{Text: "Undo", CallbackData: "undo:01ABC"}}}}})
	if err != nil || m.MessageID != 77 {
		t.Fatalf("send: %+v %v", m, err)
	}
	b := f.last().Body
	if b["chat_id"] != float64(-1001) || b["reply_to_message_id"] != float64(5) || b["parse_mode"] != nil {
		t.Fatalf("sendMessage params: %v", b)
	}
	kb := b["reply_markup"].(map[string]any)["inline_keyboard"].([]any)[0].([]any)[0].(map[string]any)
	if kb["text"] != "Undo" || kb["callback_data"] != "undo:01ABC" {
		t.Fatalf("keyboard: %v", kb)
	}

	if err := c.AnswerCallbackQuery(ctx, "cb1", "Undone"); err != nil || f.last().Body["text"] != "Undone" {
		t.Fatalf("answerCallbackQuery: %v %v", err, f.last().Body)
	}
	if err := c.EditMessageReplyMarkup(ctx, -1001, 77, nil); err != nil {
		t.Fatal(err)
	}
	if rm := f.last().Body["reply_markup"].(map[string]any); len(rm["inline_keyboard"].([]any)) != 0 {
		t.Fatalf("removing the keyboard must send an empty one: %v", rm)
	}
	if err := c.SendChatAction(ctx, -1001, "typing"); err != nil || f.last().Method != "sendChatAction" {
		t.Fatal(err)
	}
	if err := c.SetMyCommands(ctx, []telegram.BotCommand{{Command: "undo", Description: "Undo my last change"}}); err != nil || f.last().Method != "setMyCommands" {
		t.Fatal(err)
	}
}

func TestAPIErrors(t *testing.T) {
	f := newFake(t)
	f.reply["getUpdates"] = func(map[string]any) (int, string) {
		return 409, `{"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"}`
	}
	f.reply["sendMessage"] = func(map[string]any) (int, string) {
		return 429, `{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 7","parameters":{"retry_after":7}}`
	}
	f.reply["getMe"] = func(map[string]any) (int, string) {
		return 400, `{"ok":false,"error_code":400,"description":"Bad Request: group chat was upgraded to a supergroup chat","parameters":{"migrate_to_chat_id":-1009}}`
	}
	c := telegram.New(token, f.srv.URL)
	ctx := context.Background()

	_, err := c.GetUpdates(ctx, 0, 1)
	if !telegram.IsConflict(err) {
		t.Fatalf("want conflict, got %v", err)
	}
	_, err = c.SendMessage(ctx, telegram.SendMessage{ChatID: 1, Text: "x"})
	var ae *telegram.APIError
	if !errors.As(err, &ae) || ae.Code != 429 || ae.RetryAfter != 7 || telegram.IsConflict(err) {
		t.Fatalf("want 429 with retry_after, got %#v", err)
	}
	_, err = c.GetMe(ctx)
	if !errors.As(err, &ae) || ae.Code != 400 {
		t.Fatalf("want 400, got %#v", err)
	}
	// A wrong token is just another API error.
	_, err = telegram.New("999:wrong", f.srv.URL).GetMe(ctx)
	if !errors.As(err, &ae) || ae.Code != 401 {
		t.Fatalf("want 401, got %v", err)
	}
}

// TestTokenNeverInErrors covers every way a request can fail: connection
// refused, timeout, a non-JSON answer and a bad result body. The token is
// in the URL path, which Go's net/http errors quote in full.
func TestTokenNeverInErrors(t *testing.T) {
	ctx := context.Background()
	// Connection refused: a port nothing listens on.
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := "http://" + l.Addr().String()
	l.Close()

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(3 * time.Second):
		case <-r.Context().Done():
		}
	}))
	defer slow.Close()
	html := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(502)
		io.WriteString(w, "<html>bad gateway for "+r.URL.Path+"</html>")
	}))
	defer html.Close()
	badResult := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"ok":true,"result":"not a user"}`)
	}))
	defer badResult.Close()

	cases := map[string]func() error{
		"refused": func() error { _, err := telegram.New(token, dead).GetMe(ctx); return err },
		"timeout": func() error {
			c, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
			defer cancel()
			_, err := telegram.New(token, slow.URL).GetMe(c)
			if !errors.Is(err, context.DeadlineExceeded) {
				return fmt.Errorf("want DeadlineExceeded to survive scrubbing, got %w", err)
			}
			return err
		},
		"non-json":         func() error { _, err := telegram.New(token, html.URL).GetMe(ctx); return err },
		"bad result":       func() error { _, err := telegram.New(token, badResult.URL).GetMe(ctx); return err },
		"download refused": func() error { _, err := telegram.New(token, dead).Download(ctx, "documents/x.pdf", 0); return err },
		"download 404":     func() error { _, err := telegram.New(token, html.URL).Download(ctx, "documents/x.pdf", 0); return err },
	}
	for name, run := range cases {
		t.Run(name, func(t *testing.T) {
			err := run()
			if err == nil {
				t.Fatal("want an error")
			}
			msg := fmt.Sprintf("%v %+v %#v", err, err, err)
			for e := err; e != nil; e = errors.Unwrap(e) {
				msg += " " + e.Error()
			}
			if strings.Contains(msg, token) || strings.Contains(msg, "AAFakeToken") {
				t.Fatalf("token leaked: %s", msg)
			}
		})
	}
}

func TestGetFileAndDownload(t *testing.T) {
	f := newFake(t)
	f.files["documents/file_3.pdf"] = []byte("%PDF-1.7 fake")
	f.reply["getFile"] = func(b map[string]any) (int, string) {
		return 200, fmt.Sprintf(`{"ok":true,"result":{"file_id":%q,"file_size":13,"file_path":"documents/file_3.pdf"}}`, b["file_id"])
	}
	c := telegram.New(token, f.srv.URL)
	ctx := context.Background()
	fl, err := c.GetFile(ctx, "F1")
	if err != nil || fl.FilePath != "documents/file_3.pdf" {
		t.Fatalf("getFile: %+v %v", fl, err)
	}
	data, err := c.Download(ctx, fl.FilePath, 0)
	if err != nil || string(data) != "%PDF-1.7 fake" {
		t.Fatalf("download: %q %v", data, err)
	}
	if _, err := c.Download(ctx, fl.FilePath, 5); !errors.Is(err, telegram.ErrTooLarge) {
		t.Fatalf("want ErrTooLarge, got %v", err)
	}
}

// TestScrubControl proves the leak test is meaningful: an unscrubbed
// net/http error for the same URL does contain the token.
func TestScrubControl(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := "http://" + l.Addr().String()
	l.Close()
	_, err := http.Post(dead+"/bot"+token+"/getMe", "application/json", nil)
	if err == nil || !strings.Contains(err.Error(), token) {
		t.Fatalf("expected the raw error to quote the token, got %v", err)
	}
}
