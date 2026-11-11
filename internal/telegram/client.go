// Package telegram is the Telegram front door: a small Bot API client
// (this file) and, from step 1.9, the long-polling bot that hands messages
// to the agent.
//
// The client is hand-written on net/http to keep dependencies at zero. The
// Bot API puts the bot token in the URL path, so every error that could
// carry a URL is scrubbed before it leaves this package.
package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const DefaultBaseURL = "https://api.telegram.org"

// MaxDownload is the Bot API's limit for files a bot can download.
const MaxDownload = 20 << 20

// ---------- types (only the fields the bot uses) ----------

type Update struct {
	UpdateID      int64          `json:"update_id"`
	Message       *Message       `json:"message,omitempty"`
	CallbackQuery *CallbackQuery `json:"callback_query,omitempty"`
}

type Message struct {
	MessageID int64       `json:"message_id"`
	From      *User       `json:"from,omitempty"`
	Chat      Chat        `json:"chat"`
	Date      int64       `json:"date"`
	Text      string      `json:"text,omitempty"`
	Caption   string      `json:"caption,omitempty"`
	Document  *Document   `json:"document,omitempty"`
	Photo     []PhotoSize `json:"photo,omitempty"`
	Voice     *Voice      `json:"voice,omitempty"`
	// The message's inline keyboard (present on the bot's own messages
	// when they come back inside a callback query).
	ReplyMarkup *InlineKeyboardMarkup `json:"reply_markup,omitempty"`
	// Set on the service message Telegram sends when a group becomes a
	// supergroup (the chat ID changes).
	MigrateToChatID int64 `json:"migrate_to_chat_id,omitempty"`
}

type User struct {
	ID        int64  `json:"id"`
	IsBot     bool   `json:"is_bot"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name,omitempty"`
	Username  string `json:"username,omitempty"`
}

type Chat struct {
	ID        int64  `json:"id"`
	Type      string `json:"type"` // private | group | supergroup | channel
	Title     string `json:"title,omitempty"`
	Username  string `json:"username,omitempty"`
	FirstName string `json:"first_name,omitempty"`
}

// IsGroup reports whether the chat is a group or supergroup.
func (c Chat) IsGroup() bool { return c.Type == "group" || c.Type == "supergroup" }

type CallbackQuery struct {
	ID      string   `json:"id"`
	From    User     `json:"from"`
	Message *Message `json:"message,omitempty"`
	Data    string   `json:"data,omitempty"`
}

type Document struct {
	FileID       string `json:"file_id"`
	FileUniqueID string `json:"file_unique_id"`
	FileName     string `json:"file_name,omitempty"`
	MimeType     string `json:"mime_type,omitempty"`
	FileSize     int64  `json:"file_size,omitempty"`
}

type PhotoSize struct {
	FileID   string `json:"file_id"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	FileSize int64  `json:"file_size,omitempty"`
}

type Voice struct {
	FileID   string `json:"file_id"`
	Duration int    `json:"duration"`
	MimeType string `json:"mime_type,omitempty"`
	FileSize int64  `json:"file_size,omitempty"`
}

type File struct {
	FileID   string `json:"file_id"`
	FileSize int64  `json:"file_size,omitempty"`
	FilePath string `json:"file_path,omitempty"`
}

type InlineKeyboardMarkup struct {
	InlineKeyboard [][]InlineKeyboardButton `json:"inline_keyboard"`
}

type InlineKeyboardButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data,omitempty"`
}

type BotCommand struct {
	Command     string `json:"command"`
	Description string `json:"description"`
}

// SendMessage is the subset of sendMessage parameters the bot uses. Text is
// sent as plain text (no parse_mode), so nothing in it needs escaping.
type SendMessage struct {
	ChatID           int64                 `json:"chat_id"`
	Text             string                `json:"text"`
	ReplyToMessageID int64                 `json:"reply_to_message_id,omitempty"`
	ReplyMarkup      *InlineKeyboardMarkup `json:"reply_markup,omitempty"`
}

// ---------- errors ----------

// APIError is a Bot API answer with ok=false.
type APIError struct {
	Method      string
	Code        int // error_code: 409 another poller, 429 flood control, 403 blocked, ...
	Description string
	RetryAfter  int // seconds, on 429
}

func (e *APIError) Error() string {
	return fmt.Sprintf("telegram %s: %d %s", e.Method, e.Code, e.Description)
}

// IsConflict reports a 409: another getUpdates poller (or a webhook) is
// active for the same token.
func IsConflict(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Code == http.StatusConflict
}

// scrubbedError carries a message with the token removed. It unwraps only
// to context errors, never to the original (which may contain the URL).
type scrubbedError struct {
	msg   string
	cause error
}

func (e *scrubbedError) Error() string { return e.msg }
func (e *scrubbedError) Unwrap() error { return e.cause }

// ---------- client ----------

type Client struct {
	token   string
	baseURL string
	http    *http.Client
}

// New returns a client for the token. baseURL may be empty for the real
// Bot API (tests point it at a fake server).
func New(token, baseURL string) *Client {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{token: token, baseURL: strings.TrimRight(baseURL, "/"), http: &http.Client{}}
}

func (c *Client) scrub(method string, err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if c.token != "" {
		msg = strings.ReplaceAll(msg, c.token, "<token>")
	}
	var cause error
	switch {
	case errors.Is(err, context.Canceled):
		cause = context.Canceled
	case errors.Is(err, context.DeadlineExceeded):
		cause = context.DeadlineExceeded
	}
	return &scrubbedError{msg: "telegram " + method + ": " + msg, cause: cause}
}

// call POSTs params as JSON to method and decodes result into out.
func (c *Client) call(ctx context.Context, method string, params, out any, timeout time.Duration) error {
	body, err := json.Marshal(params)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/bot"+c.token+"/"+method, bytes.NewReader(body))
	if err != nil {
		return c.scrub(method, err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return c.scrub(method, err)
	}
	defer resp.Body.Close()
	var env struct {
		OK          bool            `json:"ok"`
		Result      json.RawMessage `json:"result"`
		ErrorCode   int             `json:"error_code"`
		Description string          `json:"description"`
		Parameters  *struct {
			RetryAfter int `json:"retry_after"`
		} `json:"parameters"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&env); err != nil {
		return c.scrub(method, fmt.Errorf("HTTP %d, unreadable answer: %w", resp.StatusCode, err))
	}
	if !env.OK {
		ae := &APIError{Method: method, Code: env.ErrorCode, Description: env.Description}
		if ae.Code == 0 {
			ae.Code = resp.StatusCode
		}
		if env.Parameters != nil {
			ae.RetryAfter = env.Parameters.RetryAfter
		}
		if c.token != "" {
			ae.Description = strings.ReplaceAll(ae.Description, c.token, "<token>")
		}
		return ae
	}
	if out != nil {
		if err := json.Unmarshal(env.Result, out); err != nil {
			return c.scrub(method, fmt.Errorf("decode result: %w", err))
		}
	}
	return nil
}

const callTimeout = 30 * time.Second

// GetUpdates long-polls for updates after offset. pollSeconds is how long
// Telegram may hold the request open when there is nothing new.
func (c *Client) GetUpdates(ctx context.Context, offset int64, pollSeconds int) ([]Update, error) {
	var out []Update
	params := map[string]any{
		"offset": offset, "timeout": pollSeconds,
		"allowed_updates": []string{"message", "callback_query"},
	}
	err := c.call(ctx, "getUpdates", params, &out, time.Duration(pollSeconds)*time.Second+15*time.Second)
	return out, err
}

func (c *Client) GetMe(ctx context.Context) (User, error) {
	var u User
	err := c.call(ctx, "getMe", struct{}{}, &u, callTimeout)
	return u, err
}

func (c *Client) SendMessage(ctx context.Context, m SendMessage) (Message, error) {
	var out Message
	err := c.call(ctx, "sendMessage", m, &out, callTimeout)
	return out, err
}

// SendChatAction shows "typing…" (action "typing") for about five seconds.
func (c *Client) SendChatAction(ctx context.Context, chatID int64, action string) error {
	return c.call(ctx, "sendChatAction", map[string]any{"chat_id": chatID, "action": action}, nil, callTimeout)
}

// AnswerCallbackQuery acknowledges a button press; text, if set, shows as a
// small toast in the client.
func (c *Client) AnswerCallbackQuery(ctx context.Context, id, text string) error {
	p := map[string]any{"callback_query_id": id}
	if text != "" {
		p["text"] = text
	}
	return c.call(ctx, "answerCallbackQuery", p, nil, callTimeout)
}

// EditMessageReplyMarkup replaces (or, with nil, removes) a message's
// inline keyboard.
func (c *Client) EditMessageReplyMarkup(ctx context.Context, chatID, messageID int64, markup *InlineKeyboardMarkup) error {
	if markup == nil {
		markup = &InlineKeyboardMarkup{InlineKeyboard: [][]InlineKeyboardButton{}}
	}
	return c.call(ctx, "editMessageReplyMarkup", map[string]any{"chat_id": chatID, "message_id": messageID, "reply_markup": markup}, nil, callTimeout)
}

func (c *Client) SetMyCommands(ctx context.Context, cmds []BotCommand) error {
	return c.call(ctx, "setMyCommands", map[string]any{"commands": cmds}, nil, callTimeout)
}

func (c *Client) GetFile(ctx context.Context, fileID string) (File, error) {
	var f File
	err := c.call(ctx, "getFile", map[string]any{"file_id": fileID}, &f, callTimeout)
	return f, err
}

// ErrTooLarge means a download is over the size limit.
var ErrTooLarge = errors.New("file is larger than the download limit")

// Download fetches a file by the path GetFile returned, refusing anything
// over maxBytes (MaxDownload when 0).
func (c *Client) Download(ctx context.Context, filePath string, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		maxBytes = MaxDownload
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/file/bot"+c.token+"/"+strings.TrimLeft(filePath, "/"), nil)
	if err != nil {
		return nil, c.scrub("download", err)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, c.scrub("download", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, c.scrub("download", fmt.Errorf("HTTP %d", resp.StatusCode))
	}
	if resp.ContentLength > maxBytes {
		return nil, ErrTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, c.scrub("download", err)
	}
	if int64(len(data)) > maxBytes {
		return nil, ErrTooLarge
	}
	return data, nil
}
