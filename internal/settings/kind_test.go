package settings_test

import (
	"context"
	"encoding/json"
	"errors"
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
