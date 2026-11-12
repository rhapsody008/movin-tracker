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

// Connection kinds. A settings file without a kind is OpenAI-compatible.
const (
	KindOpenAI = "openai" // OpenAI-compatible /chat/completions (vMLX, NAI)
	KindClaude = "claude" // Anthropic Messages API
)

// ClaudeOrigin is where the Claude connection goes. It has no URL field on
// the page; LLM_CLAUDE_BASE_URL overrides it for tests and stubs only.
const ClaudeOrigin = "https://api.anthropic.com"

// LLM is a fully resolved connection, ready to call.
type LLM struct {
	Kind string // KindOpenAI or KindClaude; never empty once resolved
	// Vision: the model takes images (drawing crops). Always on for Claude;
	// for OpenAI-compatible endpoints it is what the Save check found.
	Vision  bool
	BaseURL string
	APIKey  string
	Model   string
	// TimeoutSec and MaxToolRounds are the app's own limits, not settings:
	// they come from Defaults (tests may lower them). Temperature and the
	// output length are left to the model server.
	TimeoutSec    int
	MaxToolRounds int
	Streaming     bool
	// ThinkOnDemand: the model thinks only when a message starts with
	// /think; otherwise requests carry chat_template_kwargs
	// enable_thinking=false (Qwen3-style templates, vLLM, vMLX). Leave off
	// for endpoints that reject unknown parameters.
	ThinkOnDemand bool
}

// Defaults are the built-in values, used when neither settings.json nor
// the LLM_* env vars set a field. TimeoutSec is per model call and allows
// for long thinking.
var Defaults = LLM{TimeoutSec: 600, MaxToolRounds: 5, Streaming: true}

// stored is the decoded settings.json. Top-level updated/by mean "LLM last
// saved" (kept for files written before the telegram section existed).
type stored struct {
	Schema   int             `json:"schema"`
	LLM      storedLLM       `json:"llm"`
	Telegram *storedTelegram `json:"telegram,omitempty"`
	Checkin  *storedCheckin  `json:"checkin,omitempty"`
	Updated  string          `json:"updated,omitempty"`
	By       string          `json:"by,omitempty"`
}

type storedLLM struct {
	Vision        *bool   `json:"vision,omitempty"`
	Kind          *string `json:"kind,omitempty"`
	BaseURL       *string `json:"baseUrl,omitempty"`
	APIKeyEnc     *string `json:"apiKeyEnc,omitempty"`
	Model         *string `json:"model,omitempty"`
	Streaming     *bool   `json:"streaming,omitempty"`
	ThinkOnDemand *bool   `json:"thinkOnDemand,omitempty"`
}

// Input is what the settings drawer sends to save or test.
type Input struct {
	Vision        bool   `json:"vision"` // from the Save check's image probe
	Kind          string `json:"kind"`   // empty means openai; for claude BaseURL is ignored
	BaseURL       string `json:"baseUrl"`
	APIKey        string `json:"apiKey"`   // empty keeps the stored key
	ClearKey      bool   `json:"clearKey"` // explicit removal
	Model         string `json:"model"`
	Streaming     bool   `json:"streaming"`
	ThinkOnDemand bool   `json:"thinkOnDemand"`
}

// View is what GET /api/settings/llm returns. It has no field that could
// carry the key; only whether one is set and its last four characters.
type View struct {
	Vision        bool   `json:"vision"`
	ClaudeOrigin  string `json:"claudeOrigin"` // where a claude connection goes
	Kind          string `json:"kind"`
	BaseURL       string `json:"baseUrl"`
	Model         string `json:"model"`
	Streaming     bool   `json:"streaming"`
	ThinkOnDemand bool   `json:"thinkOnDemand"`
	KeySet        bool   `json:"keySet"`
	KeyLast4      string `json:"keyLast4,omitempty"`
	KeyFromEnv    bool   `json:"keyFromEnv"`
	CanStoreKey   bool   `json:"canStoreKey"`
	Updated       string `json:"updated,omitempty"`
	By            string `json:"by,omitempty"`
}

type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

var ErrConflict = errors.New("settings changed by someone else")

// CacheTTL is how long a read of settings.json is reused before S3 is asked
// again. Saves through this process update the cache at once; the TTL only
// matters for edits made elsewhere (another replica, a restore).
const CacheTTL = 30 * time.Second

type Service struct {
	claudeURL string // ClaudeOrigin unless overridden for tests
	store     objstore.Store
	env       LLM      // values from LLM_* env vars, layered over Defaults
	tgEnv     Telegram // from TELEGRAM_ALLOWED_IDS / TELEGRAM_ALLOWED_CHATS
	ciEnv     Checkin  // from CHECKIN_SCHEDULE / CHECKIN_CHAT

	warnMu   sync.Mutex
	lastWarn string
	fkey     *fernet.Key
	log      *slog.Logger
	now      func() time.Time
	ttl      time.Duration
	mu       sync.Mutex
	cached   stored
	at       time.Time
	has      bool
	gen      uint64 // bumped by every save, so a slower read can't cache older data
}

// NewService takes the env-level defaults and the SETTINGS_SECRET Fernet key
// (may be empty: then keys can only come from LLM_API_KEY).
func NewService(store objstore.Store, env LLM, secret string, log *slog.Logger) (*Service, error) {
	s := &Service{store: store, env: env, log: log, now: time.Now, ttl: CacheTTL, claudeURL: ClaudeOrigin}
	if s.env.Kind == "" {
		s.env.Kind = KindOpenAI
	}
	if secret != "" {
		k, err := fernet.DecodeKey(secret)
		if err != nil {
			return nil, fmt.Errorf("SETTINGS_SECRET is not a valid Fernet key: %w", err)
		}
		s.fkey = k
	}
	return s, nil
}

// warnOnce logs a warning only when it differs from the last one it logged
// (settings are resolved for every message; one line per change is enough).
func (s *Service) warnOnce(msg string, args ...any) {
	key := fmt.Sprint(msg, args)
	s.warnMu.Lock()
	same := s.lastWarn == key
	s.lastWarn = key
	s.warnMu.Unlock()
	if !same {
		s.log.Warn(msg, args...)
	}
}

// WithTelegramEnv sets the env-level Telegram allowlist (the default that a
// telegram section in settings.json replaces).
func (s *Service) WithTelegramEnv(t Telegram) *Service { s.tgEnv = t; return s }

// WithClaudeBaseURL points the Claude connection somewhere other than
// ClaudeOrigin (LLM_CLAUDE_BASE_URL; tests and stubs only).
func (s *Service) WithClaudeBaseURL(u string) *Service {
	if u = strings.TrimRight(strings.TrimSpace(u), "/"); u != "" {
		s.claudeURL = u
	}
	return s
}

// ClaudeBaseURL is where the Claude connection goes.
func (s *Service) ClaudeBaseURL() string { return s.claudeURL }

// SetClock replaces the time source (tests).
func (s *Service) SetClock(now func() time.Time) { s.now = now }

// current returns settings.json as of at most ttl ago. A missing file reads
// as empty; an unreadable one is logged and reads as empty (env applies),
// and is not cached so a fix shows up on the next call.
// current is the stored settings; an unreadable file reads as empty (the
// env defaults apply), which is right for the LLM and the allowlist.
func (s *Service) current(ctx context.Context) stored {
	st, err := s.currentErr(ctx)
	if err != nil {
		s.warnOnce("settings.json unreadable, using env defaults", "err", err)
	}
	return st
}

// currentErr is current, but reports a failed read (other than "no file
// yet") instead of falling back, for callers that must not act on defaults.
func (s *Service) currentErr(ctx context.Context) (stored, error) {
	s.mu.Lock()
	if s.has && s.now().Sub(s.at) < s.ttl {
		st := s.cached
		s.mu.Unlock()
		return st, nil
	}
	gen := s.gen
	s.mu.Unlock()
	st, _, err := s.load(ctx)
	switch {
	case err == nil, errors.Is(err, objstore.ErrNotFound):
		s.mu.Lock()
		if s.gen != gen {
			// A save landed while we were reading; its copy is newer.
			st = s.cached
		} else {
			s.cached, s.at, s.has = st, s.now(), true
		}
		s.mu.Unlock()
		return st, nil
	default:
		return stored{}, err
	}
}

func (s *Service) remember(body []byte) {
	var st stored
	if json.Unmarshal(body, &st) != nil {
		return
	}
	s.mu.Lock()
	s.cached, s.at, s.has = st, s.now(), true
	s.gen++
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
	if l.Kind != nil && (*l.Kind == KindOpenAI || *l.Kind == KindClaude) {
		out.Kind = *l.Kind
	}
	if l.BaseURL != nil {
		out.BaseURL = *l.BaseURL
	}
	if l.Vision != nil {
		out.Vision = *l.Vision
	}
	if out.Kind == KindClaude {
		out.BaseURL = s.claudeURL // fixed: a stored or env URL never redirects it
		out.Vision = true
	}
	if l.APIKeyEnc != nil {
		switch k, ok := s.decrypt(*l.APIKeyEnc); {
		case !ok:
			s.log.Warn("stored API key could not be decrypted; using LLM_API_KEY instead (check SETTINGS_SECRET)")
		case l.BaseURL == nil || !SameOrigin(*l.BaseURL, out.BaseURL):
			// The stored key belongs to the URL it was saved with. If this
			// process would send it elsewhere (another kind from env, a
			// test override of the Claude origin, a hand-edited file), it
			// is not used.
			s.warnOnce("stored API key belongs to another host; not using it", "savedFor", originOf(l.BaseURL), "target", originOf(&out.BaseURL))
		default:
			out.APIKey, keyFromEnv = k, false
		}
	}
	if l.Model != nil {
		out.Model = *l.Model
	}
	if l.Streaming != nil {
		out.Streaming = *l.Streaming
	}
	if l.ThinkOnDemand != nil {
		out.ThinkOnDemand = *l.ThinkOnDemand
	}
	// The env key belongs to LLM_BASE_URL. If the page points the app at a
	// different host, that key must not follow it there.
	if keyFromEnv && s.env.BaseURL != "" && !SameOrigin(out.BaseURL, s.env.BaseURL) {
		out.APIKey = ""
	}
	return out, keyFromEnv && out.APIKey != ""
}

// originOf is a URL's scheme://host for logs (never a path or a query).
func originOf(u *string) string {
	if u == nil {
		return ""
	}
	p, err := url.Parse(strings.TrimSpace(*u))
	if err != nil {
		return ""
	}
	return p.Scheme + "://" + p.Host
}

// SameOrigin reports whether two URLs share scheme, host and port. A saved
// or env API key is only ever sent to the origin it was configured for.
func SameOrigin(a, b string) bool {
	ua, err1 := url.Parse(strings.TrimSpace(a))
	ub, err2 := url.Parse(strings.TrimSpace(b))
	if err1 != nil || err2 != nil || ua.Host == "" {
		return false
	}
	return strings.EqualFold(ua.Scheme, ub.Scheme) && strings.EqualFold(ua.Host, ub.Host)
}

// KeyFor returns the API key to send to baseURL: the typed one if given,
// otherwise the configured key only when baseURL is the origin it belongs
// to. Everything that calls an endpoint the request names must use this.
func (s *Service) KeyFor(ctx context.Context, baseURL, typed string) string {
	if typed != "" {
		return typed
	}
	cur := s.Resolve(ctx)
	if cur.APIKey != "" && SameOrigin(baseURL, cur.BaseURL) {
		return cur.APIKey
	}
	return ""
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
		ClaudeOrigin: s.claudeURL, Kind: l.Kind, Vision: l.Vision, BaseURL: l.BaseURL, Model: l.Model, Streaming: l.Streaming, ThinkOnDemand: l.ThinkOnDemand,
		KeySet: l.APIKey != "", KeyFromEnv: fromEnv && l.APIKey != "", CanStoreKey: s.fkey != nil,
		Updated: st.Updated, By: st.By,
	}
	if len(l.APIKey) >= 8 {
		v.KeyLast4 = l.APIKey[len(l.APIKey)-4:]
	}
	return v
}

// normalise fills the kind (empty = openai) and, for claude, the fixed
// origin, so validation and key binding see the URL that will be called.
func (s *Service) normalise(in Input) (Input, error) {
	switch in.Kind {
	case "":
		in.Kind = KindOpenAI
	case KindOpenAI:
	case KindClaude:
		in.BaseURL = s.claudeURL
	default:
		return in, &ValidationError{"kind must be openai or claude"}
	}
	return in, in.validate()
}

func (in Input) validate() error {
	u, err := url.Parse(strings.TrimSpace(in.BaseURL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return &ValidationError{"endpoint URL must start with http:// or https://"}
	}
	switch {
	case strings.TrimSpace(in.Model) == "":
		return &ValidationError{"model is required"}
	}
	return nil
}

// ForTest resolves the settings the drawer is showing, without saving, so
// "Test connection" exercises exactly what Save would store.
func (s *Service) ForTest(ctx context.Context, in Input) (LLM, error) {
	in, err := s.normalise(in)
	if err != nil {
		return LLM{}, err
	}
	base := strings.TrimRight(strings.TrimSpace(in.BaseURL), "/")
	key := s.KeyFor(ctx, base, in.APIKey)
	if in.ClearKey && in.APIKey == "" {
		key = ""
		if s.env.APIKey != "" && (s.env.BaseURL == "" || SameOrigin(base, s.env.BaseURL)) {
			key = s.env.APIKey
		}
	}
	return LLM{
		Kind: in.Kind, Vision: in.Vision || in.Kind == KindClaude, BaseURL: base, APIKey: key, Model: strings.TrimSpace(in.Model),
		TimeoutSec: s.env.TimeoutSec, MaxToolRounds: s.env.MaxToolRounds,
		Streaming: in.Streaming, ThinkOnDemand: in.ThinkOnDemand,
	}, nil
}

// Save writes the llm section of settings.json (ETag-guarded), keeping
// every other section as it is.
func (s *Service) Save(ctx context.Context, by string, in Input) (View, error) {
	in, err := s.normalise(in)
	if err != nil {
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
	err = s.modify(ctx, func(raw map[string]json.RawMessage) error {
		var old storedLLM
		_ = json.Unmarshal(raw["llm"], &old)
		keep := old.APIKeyEnc
		if in.ClearKey {
			keep = nil
		}
		// A saved key belongs to its endpoint: moving to another host
		// without typing a key drops it instead of sending it there.
		// (A key saved without a URL, from a hand-edited file, has no host to
		// belong to, so it is dropped too.)
		if keep != nil && enc == nil && (old.BaseURL == nil || !SameOrigin(baseURL, *old.BaseURL)) {
			keep = nil
		}
		if enc != nil {
			keep = enc
		}
		setJSON(raw, "llm", storedLLM{
			Kind: &in.Kind, Vision: &in.Vision, BaseURL: &baseURL, APIKeyEnc: keep, Model: &model,
			Streaming: &in.Streaming, ThinkOnDemand: &in.ThinkOnDemand,
		})
		setJSON(raw, "updated", s.now().UTC().Format(time.RFC3339))
		setJSON(raw, "by", by)
		return nil
	})
	if err != nil {
		return View{}, err
	}
	s.log.Info("LLM settings saved", "by", by, "kind", in.Kind, "model", model, "baseUrl", baseURL, "keyChanged", enc != nil || in.ClearKey)
	return s.View(ctx), nil
}
