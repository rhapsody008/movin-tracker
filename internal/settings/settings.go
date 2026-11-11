// Package settings stores runtime settings in settings.json next to the
// entries: the LLM connection (the API key Fernet-encrypted at rest, never
// sent to the browser) and the Telegram allowlist. Each section is written
// on its own, so saving one never drops another.
package settings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"sync"
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

// stored is the decoded settings.json. Top-level updated/by mean "LLM last
// saved" (kept for files written before the telegram section existed).
type stored struct {
	Schema   int             `json:"schema"`
	LLM      storedLLM       `json:"llm"`
	Telegram *storedTelegram `json:"telegram,omitempty"`
	Updated  string          `json:"updated,omitempty"`
	By       string          `json:"by,omitempty"`
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

// CacheTTL is how long a read of settings.json is reused before S3 is asked
// again. Saves through this process update the cache at once; the TTL only
// matters for edits made elsewhere (another replica, a restore).
const CacheTTL = 30 * time.Second

type Service struct {
	store  objstore.Store
	env    LLM      // values from LLM_* env vars, layered over Defaults
	tgEnv  Telegram // from TELEGRAM_ALLOWED_IDS / TELEGRAM_ALLOWED_CHATS
	fkey   *fernet.Key
	log    *slog.Logger
	now    func() time.Time
	ttl    time.Duration
	mu     sync.Mutex
	cached stored
	at     time.Time
	has    bool
}

// NewService takes the env-level defaults and the SETTINGS_SECRET Fernet key
// (may be empty: then keys can only come from LLM_API_KEY).
func NewService(store objstore.Store, env LLM, secret string, log *slog.Logger) (*Service, error) {
	s := &Service{store: store, env: env, log: log, now: time.Now, ttl: CacheTTL}
	if secret != "" {
		k, err := fernet.DecodeKey(secret)
		if err != nil {
			return nil, fmt.Errorf("SETTINGS_SECRET is not a valid Fernet key: %w", err)
		}
		s.fkey = k
	}
	return s, nil
}

// WithTelegramEnv sets the env-level Telegram allowlist (the default that a
// telegram section in settings.json replaces).
func (s *Service) WithTelegramEnv(t Telegram) *Service { s.tgEnv = t; return s }

// SetClock replaces the time source (tests).
func (s *Service) SetClock(now func() time.Time) { s.now = now }

// current returns settings.json as of at most ttl ago. A missing file reads
// as empty; an unreadable one is logged and reads as empty (env applies),
// and is not cached so a fix shows up on the next call.
func (s *Service) current(ctx context.Context) stored {
	s.mu.Lock()
	if s.has && s.now().Sub(s.at) < s.ttl {
		st := s.cached
		s.mu.Unlock()
		return st
	}
	s.mu.Unlock()
	st, _, err := s.load(ctx)
	switch {
	case err == nil, errors.Is(err, objstore.ErrNotFound):
		s.mu.Lock()
		s.cached, s.at, s.has = st, s.now(), true
		s.mu.Unlock()
		return st
	default:
		s.log.Warn("settings.json unreadable, using env defaults", "err", err)
		return stored{}
	}
}

func (s *Service) remember(body []byte) {
	var st stored
	if json.Unmarshal(body, &st) != nil {
		return
	}
	s.mu.Lock()
	s.cached, s.at, s.has = st, s.now(), true
	s.mu.Unlock()
}

// modify is the only write path: read settings.json as raw sections, let fn
// change the ones it owns, and write it back with the ETag guard. Sections
// fn does not touch (including ones this version doesn't know) are kept.
func (s *Service) modify(ctx context.Context, fn func(raw map[string]json.RawMessage) error) error {
	for attempt := 0; ; attempt++ {
		raw := map[string]json.RawMessage{}
		body, etag, err := s.store.Get(ctx, Key)
		switch {
		case err == nil:
			if json.Unmarshal(body, &raw) != nil {
				// Unreadable file: overwrite it rather than leave the app stuck.
				s.log.Warn("replacing unreadable settings.json")
				raw = map[string]json.RawMessage{}
			}
		case errors.Is(err, objstore.ErrNotFound):
			etag = ""
		default:
			return err
		}
		if err := fn(raw); err != nil {
			return err
		}
		raw["schema"] = json.RawMessage("1")
		out, _ := json.MarshalIndent(raw, "", "  ")
		_, err = s.store.Put(ctx, Key, out, etag)
		if err == nil {
			s.remember(out)
			return nil
		}
		if !errors.Is(err, objstore.ErrPrecondition) {
			return err
		}
		if attempt >= 3 {
			return ErrConflict
		}
	}
}

func setJSON(raw map[string]json.RawMessage, k string, v any) {
	b, _ := json.Marshal(v)
	raw[k] = b
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
	out, _ := s.resolve(s.current(ctx))
	return out
}

func (s *Service) View(ctx context.Context) View {
	st := s.current(ctx)
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

// Save writes the llm section of settings.json (ETag-guarded), keeping
// every other section as it is.
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
	baseURL := strings.TrimRight(strings.TrimSpace(in.BaseURL), "/")
	model := strings.TrimSpace(in.Model)
	err := s.modify(ctx, func(raw map[string]json.RawMessage) error {
		var old storedLLM
		_ = json.Unmarshal(raw["llm"], &old)
		keep := old.APIKeyEnc
		if in.ClearKey {
			keep = nil
		}
		if enc != nil {
			keep = enc
		}
		setJSON(raw, "llm", storedLLM{
			BaseURL: &baseURL, APIKeyEnc: keep, Model: &model, Temperature: &in.Temperature,
			MaxTokens: &in.MaxTokens, TimeoutSec: &in.TimeoutSec, MaxToolRounds: &in.MaxToolRounds, Streaming: &in.Streaming,
		})
		setJSON(raw, "updated", s.now().UTC().Format(time.RFC3339))
		setJSON(raw, "by", by)
		return nil
	})
	if err != nil {
		return View{}, err
	}
	s.log.Info("LLM settings saved", "by", by, "model", model, "baseUrl", baseURL, "keyChanged", enc != nil || in.ClearKey)
	return s.View(ctx), nil
}
