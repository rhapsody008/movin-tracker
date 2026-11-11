// Package settings stores the LLM connection in settings.json next to the
// board. The API key is Fernet-encrypted at rest and never leaves the server.
package settings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/fernet/fernet-go"

	"github.com/rhapsody008/movin-tracker/internal/objstore"
)

const Key = "settings.json"

// LLM is a fully resolved connection, ready to call.
type LLM struct {
	BaseURL       string
	APIKey        string
	Model         string
	Temperature   float64
	MaxTokens     int
	TimeoutSec    int
	MaxToolRounds int
	Streaming     bool
}

// Defaults are the built-in values, used when neither settings.json nor
// the LLM_* env vars set a field.
var Defaults = LLM{Temperature: 0.2, MaxTokens: 1024, TimeoutSec: 60, MaxToolRounds: 5, Streaming: true}

type stored struct {
	Schema  int       `json:"schema"`
	LLM     storedLLM `json:"llm"`
	Updated string    `json:"updated,omitempty"`
	By      string    `json:"by,omitempty"`
}

type storedLLM struct {
	BaseURL       *string  `json:"baseUrl,omitempty"`
	APIKeyEnc     *string  `json:"apiKeyEnc,omitempty"`
	Model         *string  `json:"model,omitempty"`
	Temperature   *float64 `json:"temperature,omitempty"`
	MaxTokens     *int     `json:"maxTokens,omitempty"`
	TimeoutSec    *int     `json:"timeoutSec,omitempty"`
	MaxToolRounds *int     `json:"maxToolRounds,omitempty"`
	Streaming     *bool    `json:"streaming,omitempty"`
}

// Input is what the settings drawer sends to save or test.
type Input struct {
	BaseURL       string  `json:"baseUrl"`
	APIKey        string  `json:"apiKey"`   // empty keeps the stored key
	ClearKey      bool    `json:"clearKey"` // explicit removal
	Model         string  `json:"model"`
	Temperature   float64 `json:"temperature"`
	MaxTokens     int     `json:"maxTokens"`
	TimeoutSec    int     `json:"timeoutSec"`
	MaxToolRounds int     `json:"maxToolRounds"`
	Streaming     bool    `json:"streaming"`
}

// View is what GET /api/settings/llm returns. It has no field that could
// carry the key; only whether one is set and its last four characters.
type View struct {
	BaseURL       string  `json:"baseUrl"`
	Model         string  `json:"model"`
	Temperature   float64 `json:"temperature"`
	MaxTokens     int     `json:"maxTokens"`
	TimeoutSec    int     `json:"timeoutSec"`
	MaxToolRounds int     `json:"maxToolRounds"`
	Streaming     bool    `json:"streaming"`
	KeySet        bool    `json:"keySet"`
	KeyLast4      string  `json:"keyLast4,omitempty"`
	KeyFromEnv    bool    `json:"keyFromEnv"`
	CanStoreKey   bool    `json:"canStoreKey"`
	Updated       string  `json:"updated,omitempty"`
	By            string  `json:"by,omitempty"`
}

type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

var ErrConflict = errors.New("settings changed by someone else")

type Service struct {
	store objstore.Store
	env   LLM // values from LLM_* env vars, layered over Defaults
	fkey  *fernet.Key
	log   *slog.Logger
	now   func() time.Time
}

// NewService takes the env-level defaults and the SETTINGS_SECRET Fernet key
// (may be empty: then keys can only come from LLM_API_KEY).
func NewService(store objstore.Store, env LLM, secret string, log *slog.Logger) (*Service, error) {
	s := &Service{store: store, env: env, log: log, now: time.Now}
	if secret != "" {
		k, err := fernet.DecodeKey(secret)
		if err != nil {
			return nil, fmt.Errorf("SETTINGS_SECRET is not a valid Fernet key: %w", err)
		}
		s.fkey = k
	}
	return s, nil
}

func (s *Service) load(ctx context.Context) (stored, string, error) {
	var st stored
	body, etag, err := s.store.Get(ctx, Key)
	if err != nil {
		return st, "", err
	}
	if err := json.Unmarshal(body, &st); err != nil {
		return st, etag, fmt.Errorf("decode settings.json: %w", err)
	}
	return st, etag, nil
}

func (s *Service) decrypt(enc string) (string, bool) {
	if s.fkey == nil {
		return "", false
	}
	msg := fernet.VerifyAndDecrypt([]byte(enc), 0, []*fernet.Key{s.fkey})
	if msg == nil {
		return "", false
	}
	return string(msg), true
}

// resolve layers settings.json over env over defaults, field by field.
func (s *Service) resolve(st stored) (LLM, bool) {
	out := s.env
	keyFromEnv := out.APIKey != ""
	l := st.LLM
	if l.BaseURL != nil {
		out.BaseURL = *l.BaseURL
	}
	if l.APIKeyEnc != nil {
		if k, ok := s.decrypt(*l.APIKeyEnc); ok {
			out.APIKey, keyFromEnv = k, false
		} else {
			s.log.Warn("stored API key could not be decrypted; using LLM_API_KEY instead (check SETTINGS_SECRET)")
		}
	}
	if l.Model != nil {
		out.Model = *l.Model
	}
	if l.Temperature != nil {
		out.Temperature = *l.Temperature
	}
	if l.MaxTokens != nil {
		out.MaxTokens = *l.MaxTokens
	}
	if l.TimeoutSec != nil {
		out.TimeoutSec = *l.TimeoutSec
	}
	if l.MaxToolRounds != nil {
		out.MaxToolRounds = *l.MaxToolRounds
	}
	if l.Streaming != nil {
		out.Streaming = *l.Streaming
	}
	return out, keyFromEnv
}

// Resolve returns the settings to use right now. A missing or unreadable
// settings.json falls back to env without failing.
func (s *Service) Resolve(ctx context.Context) LLM {
	st, _, err := s.load(ctx)
	if err != nil && !errors.Is(err, objstore.ErrNotFound) {
		s.log.Warn("settings.json unreadable, using env defaults", "err", err)
	}
	out, _ := s.resolve(st)
	return out
}

func (s *Service) View(ctx context.Context) View {
	st, _, err := s.load(ctx)
	if err != nil && !errors.Is(err, objstore.ErrNotFound) {
		s.log.Warn("settings.json unreadable, using env defaults", "err", err)
	}
	l, fromEnv := s.resolve(st)
	v := View{
		BaseURL: l.BaseURL, Model: l.Model, Temperature: l.Temperature, MaxTokens: l.MaxTokens,
		TimeoutSec: l.TimeoutSec, MaxToolRounds: l.MaxToolRounds, Streaming: l.Streaming,
		KeySet: l.APIKey != "", KeyFromEnv: fromEnv && l.APIKey != "", CanStoreKey: s.fkey != nil,
		Updated: st.Updated, By: st.By,
	}
	if len(l.APIKey) >= 8 {
		v.KeyLast4 = l.APIKey[len(l.APIKey)-4:]
	}
	return v
}

func (in Input) validate() error {
	u, err := url.Parse(strings.TrimSpace(in.BaseURL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return &ValidationError{"endpoint URL must start with http:// or https://"}
	}
	switch {
	case strings.TrimSpace(in.Model) == "":
		return &ValidationError{"model is required"}
	case in.Temperature < 0 || in.Temperature > 1:
		return &ValidationError{"temperature must be between 0 and 1"}
	case in.MaxTokens < 128 || in.MaxTokens > 8192:
		return &ValidationError{"max tokens must be between 128 and 8192"}
	case in.TimeoutSec < 10 || in.TimeoutSec > 300:
		return &ValidationError{"timeout must be between 10 and 300 seconds"}
	case in.MaxToolRounds < 1 || in.MaxToolRounds > 8:
		return &ValidationError{"max tool rounds must be between 1 and 8"}
	}
	return nil
}

// ForTest resolves the settings the drawer is showing, without saving, so
// "Test connection" exercises exactly what Save would store.
func (s *Service) ForTest(ctx context.Context, in Input) (LLM, error) {
	if err := in.validate(); err != nil {
		return LLM{}, err
	}
	cur := s.Resolve(ctx)
	key := cur.APIKey
	if in.ClearKey {
		key = s.env.APIKey
	}
	if in.APIKey != "" {
		key = in.APIKey
	}
	return LLM{
		BaseURL: strings.TrimRight(strings.TrimSpace(in.BaseURL), "/"), APIKey: key, Model: strings.TrimSpace(in.Model),
		Temperature: in.Temperature, MaxTokens: in.MaxTokens, TimeoutSec: in.TimeoutSec,
		MaxToolRounds: in.MaxToolRounds, Streaming: in.Streaming,
	}, nil
}

// Save writes settings.json with the same ETag guard as the board.
func (s *Service) Save(ctx context.Context, by string, in Input) (View, error) {
	if err := in.validate(); err != nil {
		return View{}, err
	}
	if in.APIKey != "" && s.fkey == nil {
		return View{}, &ValidationError{"SETTINGS_SECRET is not configured on the server, so a key cannot be stored. Set LLM_API_KEY instead."}
	}
	var enc *string
	if in.APIKey != "" {
		tok, err := fernet.EncryptAndSign([]byte(in.APIKey), s.fkey)
		if err != nil {
			return View{}, err
		}
		e := string(tok)
		enc = &e
	}
	for attempt := 0; ; attempt++ {
		st, etag, err := s.load(ctx)
		if err != nil && !errors.Is(err, objstore.ErrNotFound) {
			// Unreadable file: overwrite it rather than leave the app stuck.
			s.log.Warn("replacing unreadable settings.json", "err", err)
		}
		keep := st.LLM.APIKeyEnc
		if in.ClearKey {
			keep = nil
		}
		if enc != nil {
			keep = enc
		}
		baseURL := strings.TrimRight(strings.TrimSpace(in.BaseURL), "/")
		model := strings.TrimSpace(in.Model)
		next := stored{
			Schema: 1,
			LLM: storedLLM{
				BaseURL: &baseURL, APIKeyEnc: keep, Model: &model, Temperature: &in.Temperature,
				MaxTokens: &in.MaxTokens, TimeoutSec: &in.TimeoutSec, MaxToolRounds: &in.MaxToolRounds, Streaming: &in.Streaming,
			},
			Updated: s.now().UTC().Format(time.RFC3339),
			By:      by,
		}
		body, _ := json.MarshalIndent(next, "", "  ")
		_, err = s.store.Put(ctx, Key, body, etag)
		if err == nil {
			s.log.Info("LLM settings saved", "by", by, "model", model, "baseUrl", baseURL, "keyChanged", enc != nil || in.ClearKey)
			return s.View(ctx), nil
		}
		if !errors.Is(err, objstore.ErrPrecondition) {
			return View{}, err
		}
		if attempt >= 3 {
			return View{}, ErrConflict
		}
	}
}
