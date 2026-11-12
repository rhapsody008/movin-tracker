package settings_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/fernet/fernet-go"

	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/settings"
	"github.com/rhapsody008/movin-tracker/internal/testutil"
)

// A settings file written before kinds existed, by v1 or by today's build,
// is an OpenAI-compatible connection with its URL unchanged.
func TestNoKindMeansOpenAI(t *testing.T) {
	current := `{"schema":1,"llm":{"baseUrl":"http://host.docker.internal:8081/v1","model":"q","streaming":true,"thinkOnDemand":true}}`
	for name, file := range map[string]string{"v1": v1File, "current": current, "none": ""} {
		r := newRig(t, file, envTG(t))
		l := r.svc.Resolve(context.Background())
		if l.Kind != settings.KindOpenAI {
			t.Errorf("%s: kind %q", name, l.Kind)
		}
		if v := r.svc.View(context.Background()); v.Kind != settings.KindOpenAI {
			t.Errorf("%s: view kind %q", name, v.Kind)
		}
	}
	r := newRig(t, current, envTG(t))
	if l := r.svc.Resolve(context.Background()); l.BaseURL != "http://host.docker.internal:8081/v1" || !l.ThinkOnDemand {
		t.Fatalf("current file changed: %+v", l)
	}
}

func TestBadKindIsRejected(t *testing.T) {
	r := newRig(t, "", envTG(t))
	in := llmIn
	in.Kind = "gpt"
	_, err := r.svc.Save(context.Background(), "zy", in)
	var ve *settings.ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("save: %v", err)
	}
	if _, err := r.svc.ForTest(context.Background(), in); !errors.As(err, &ve) {
		t.Fatalf("test: %v", err)
	}
}

// Claude always goes to the fixed origin: a URL in the request or in the
// file never redirects it (and with it the key).
func TestClaudeUsesTheFixedOrigin(t *testing.T) {
	r := newRig(t, "", envTG(t))
	ctx := context.Background()
	in := settings.Input{Kind: settings.KindClaude, BaseURL: "https://evil.example/v1", APIKey: "sk-ant-typed-1234", Model: "claude-opus-5-5"}
	cfg, err := r.svc.ForTest(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Kind != settings.KindClaude || cfg.BaseURL != settings.ClaudeOrigin || cfg.APIKey != "sk-ant-typed-1234" {
		t.Fatalf("test cfg %+v", cfg)
	}
	if _, err := r.svc.Save(ctx, "zy", in); err != nil {
		t.Fatal(err)
	}
	var l struct{ Kind, BaseURL string }
	json.Unmarshal(r.raw(t)["llm"], &l)
	if l.Kind != "claude" || l.BaseURL != settings.ClaudeOrigin {
		t.Fatalf("stored %+v", l)
	}
	// Even a hand-edited file can't point claude elsewhere.
	r2 := newRig(t, `{"schema":1,"llm":{"kind":"claude","baseUrl":"https://evil.example","model":"m"}}`, envTG(t))
	if got := r2.svc.Resolve(ctx).BaseURL; got != settings.ClaudeOrigin {
		t.Fatalf("hand-edited file resolved to %q", got)
	}
}

// Moving from the vMLX host to Claude without typing a key drops the stored
// key: it belonged to another host.
func TestSwitchToClaudeDropsAnotherHostsKey(t *testing.T) {
	r := newRig(t, "", envTG(t))
	ctx := context.Background()
	if _, err := r.svc.Save(ctx, "zy", settings.Input{BaseURL: "http://host.docker.internal:8081/v1", APIKey: "sk-vmlx-key-5678", Model: "q"}); err != nil {
		t.Fatal(err)
	}
	in := settings.Input{Kind: settings.KindClaude, Model: "claude-opus-5-5"}
	if cfg, _ := r.svc.ForTest(ctx, in); cfg.APIKey != "" {
		t.Fatalf("test would send the vMLX key to Claude")
	}
	if _, err := r.svc.Save(ctx, "zy", in); err != nil {
		t.Fatal(err)
	}
	if l := r.svc.Resolve(ctx); l.APIKey != "" {
		t.Fatalf("vMLX key kept for Claude")
	}
	var l map[string]any
	json.Unmarshal(r.raw(t)["llm"], &l)
	if _, has := l["apiKeyEnc"]; has {
		t.Fatalf("stored key not dropped: %v", l)
	}
}

// A key saved for Anthropic's OpenAI layer (same origin) carries over.
func TestSwitchFromAnthropicOpenAILayerKeepsTheKey(t *testing.T) {
	r := newRig(t, "", envTG(t))
	ctx := context.Background()
	if _, err := r.svc.Save(ctx, "zy", settings.Input{BaseURL: "https://api.anthropic.com/v1/", APIKey: "sk-ant-saved-9999", Model: "claude-opus-5-5"}); err != nil {
		t.Fatal(err)
	}
	in := settings.Input{Kind: settings.KindClaude, Model: "claude-opus-5-5"}
	if cfg, _ := r.svc.ForTest(ctx, in); cfg.APIKey != "sk-ant-saved-9999" {
		t.Fatalf("test lost the key: %q", cfg.APIKey)
	}
	if _, err := r.svc.Save(ctx, "zy", in); err != nil {
		t.Fatal(err)
	}
	if l := r.svc.Resolve(ctx); l.APIKey != "sk-ant-saved-9999" || l.Kind != settings.KindClaude {
		t.Fatalf("resolved %+v", l)
	}
}

// The env key belongs to LLM_BASE_URL: it is not sent to Claude unless the
// env itself is the Claude origin (LLM_KIND=claude).
func TestEnvKeyGoesOnlyToItsOrigin(t *testing.T) {
	r := newRig(t, "", envTG(t)) // env: https://env.example/v1 with sk-env-…
	ctx := context.Background()
	if _, err := r.svc.Save(ctx, "zy", settings.Input{Kind: settings.KindClaude, Model: "claude-opus-5-5"}); err != nil {
		t.Fatal(err)
	}
	if l := r.svc.Resolve(ctx); l.APIKey != "" {
		t.Fatalf("env key sent to Claude")
	}

	store := objstore.NewMemory()
	k := fernet.Key{}
	k.Generate()
	env := settings.Defaults
	env.Kind, env.BaseURL, env.APIKey, env.Model = settings.KindClaude, settings.ClaudeOrigin, "sk-ant-env-4321", "claude-opus-5-5"
	svc, err := settings.NewService(store, env, k.Encode(), testutil.Logger(nil))
	if err != nil {
		t.Fatal(err)
	}
	if l := svc.Resolve(ctx); l.Kind != settings.KindClaude || l.APIKey != "sk-ant-env-4321" {
		t.Fatalf("LLM_KIND=claude env: %+v", l)
	}
}

// Saving the Telegram allowlist keeps the LLM kind (sections survive).
func TestTelegramSaveKeepsKind(t *testing.T) {
	r := newRig(t, "", envTG(t))
	ctx := context.Background()
	if _, err := r.svc.Save(ctx, "zy", settings.Input{Kind: settings.KindClaude, APIKey: "sk-ant-x-0001", Model: "claude-opus-5-5"}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.svc.SaveTelegram(ctx, "zy", settings.TelegramInput{Users: []settings.TelegramUser{{ID: "111", Name: "ZY"}}}); err != nil {
		t.Fatal(err)
	}
	if l := r.svc.Resolve(ctx); l.Kind != settings.KindClaude || l.APIKey != "sk-ant-x-0001" {
		t.Fatalf("after telegram save: %+v", l)
	}
}

func TestClaudeBaseURLOverride(t *testing.T) {
	r := newRig(t, `{"schema":1,"llm":{"kind":"claude","model":"m"}}`, envTG(t))
	r.svc.WithClaudeBaseURL("http://127.0.0.1:9999/")
	if got := r.svc.Resolve(context.Background()).BaseURL; got != "http://127.0.0.1:9999" {
		t.Fatalf("override: %q", got)
	}
}

// Claude always has vision; an OpenAI-compatible connection has what its
// Save check found.
func TestVision(t *testing.T) {
	r := newRig(t, "", envTG(t))
	ctx := context.Background()
	if r.svc.Resolve(ctx).Vision {
		t.Fatal("openai default should not have vision")
	}
	if _, err := r.svc.Save(ctx, "zy", settings.Input{BaseURL: "https://llm.example/v1", Model: "m", Vision: true}); err != nil {
		t.Fatal(err)
	}
	if !r.svc.Resolve(ctx).Vision || !r.svc.View(ctx).Vision {
		t.Fatal("saved vision lost")
	}
	if _, err := r.svc.Save(ctx, "zy", settings.Input{Kind: settings.KindClaude, Model: "claude-opus-5-5"}); err != nil {
		t.Fatal(err)
	}
	if !r.svc.Resolve(ctx).Vision {
		t.Fatal("claude without vision")
	}
}

// Review blocker: a stored key is only used for the host it was saved for,
// whatever this process's env says.
func TestStoredKeyStaysWithItsHost(t *testing.T) {
	ctx := context.Background()
	k := fernet.Key{}
	k.Generate()
	tok, err := fernet.EncryptAndSign([]byte("sk-vmlx-stored-7777"), &k)
	if err != nil {
		t.Fatal(err)
	}
	// 1. A file without a kind (older build) holding a vMLX key, read by a
	//    process with LLM_KIND=claude: the key must not go to Claude.
	store := objstore.NewMemory()
	file := `{"schema":1,"llm":{"baseUrl":"http://host.docker.internal:8081/v1","apiKeyEnc":"` + string(tok) + `","model":"q"}}`
	store.Put(ctx, settings.Key, []byte(file), "")
	env := settings.Defaults
	env.Kind, env.BaseURL = settings.KindClaude, settings.ClaudeOrigin
	svc, err := settings.NewService(store, env, k.Encode(), testutil.Logger(nil))
	if err != nil {
		t.Fatal(err)
	}
	if l := svc.Resolve(ctx); l.BaseURL != settings.ClaudeOrigin || l.APIKey != "" {
		t.Fatalf("vMLX key sent to Claude: %+v", l)
	}
	if got := svc.KeyFor(ctx, settings.ClaudeOrigin, ""); got != "" {
		t.Fatalf("KeyFor gave the vMLX key to Claude")
	}

	// 2. A Claude key saved for the real origin, read by a process whose
	//    Claude origin is overridden (LLM_CLAUDE_BASE_URL): not sent there.
	r := newRig(t, "", envTG(t))
	if _, err := r.svc.Save(ctx, "zy", settings.Input{Kind: settings.KindClaude, APIKey: "sk-ant-real-8888", Model: "claude-opus-5-5"}); err != nil {
		t.Fatal(err)
	}
	r.svc.WithClaudeBaseURL("http://127.0.0.1:9999")
	if l := r.svc.Resolve(ctx); l.APIKey == "sk-ant-real-8888" {
		t.Fatalf("Claude key sent to the override %s", l.BaseURL)
	}
	// Back on the real origin it is used again.
	r.svc.WithClaudeBaseURL(settings.ClaudeOrigin)
	if l := r.svc.Resolve(ctx); l.APIKey != "sk-ant-real-8888" {
		t.Fatalf("key lost on its own origin: %+v", l)
	}
}

// A key saved without a URL (hand-edited file) has no host to belong to:
// saving a connection without typing a key drops it instead of binding it
// to the new URL. And the "belongs to another host" warning is logged once,
// not on every message.
func TestKeyWithoutURLAndOneWarning(t *testing.T) {
	ctx := context.Background()
	k := fernet.Key{}
	k.Generate()
	tok, _ := fernet.EncryptAndSign([]byte("sk-orphan-1234"), &k)
	store := objstore.NewMemory()
	store.Put(ctx, settings.Key, []byte(`{"schema":1,"llm":{"apiKeyEnc":"`+string(tok)+`","model":"q"}}`), "")
	logs := &testutil.SyncBuffer{}
	svc, err := settings.NewService(store, settings.Defaults, k.Encode(), testutil.Logger(logs))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if l := svc.Resolve(ctx); l.APIKey != "" {
			t.Fatalf("URL-less key used: %+v", l)
		}
	}
	if n := strings.Count(logs.String(), "belongs to another host"); n != 1 {
		t.Fatalf("warning logged %d times, want once", n)
	}
	if _, err := svc.Save(ctx, "zy", settings.Input{Kind: settings.KindOpenAI, BaseURL: "https://llm.example/v1", Model: "m"}); err != nil {
		t.Fatal(err)
	}
	body, _, _ := store.Get(ctx, settings.Key)
	if strings.Contains(string(body), "apiKeyEnc") {
		t.Fatalf("URL-less key kept and bound to the new URL: %s", body)
	}
}
