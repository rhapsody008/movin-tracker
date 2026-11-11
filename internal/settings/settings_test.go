package settings_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fernet/fernet-go"

	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/settings"
	"github.com/rhapsody008/movin-tracker/internal/testutil"
)

// v1File is settings.json as the board version wrote it: no telegram section.
const v1File = `{
  "schema": 1,
  "llm": {"baseUrl": "https://llm.example/v1", "model": "qwen", "temperature": 0.1, "maxTokens": 2048, "streaming": false},
  "updated": "2026-10-14T00:00:00Z",
  "by": "zy@example.com"
}`

type rig struct {
	svc   *settings.Service
	store *objstore.Memory
	now   time.Time
}

func newRig(t *testing.T, file string, env settings.Telegram) *rig {
	t.Helper()
	r := &rig{store: objstore.NewMemory(), now: time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)}
	if file != "" {
		if _, err := r.store.Put(context.Background(), settings.Key, []byte(file), ""); err != nil {
			t.Fatal(err)
		}
	}
	k := fernet.Key{}
	k.Generate()
	envLLM := settings.Defaults
	envLLM.BaseURL, envLLM.Model, envLLM.APIKey = "https://env.example/v1", "env-model", "sk-env-0000-aaaa"
	svc, err := settings.NewService(r.store, envLLM, k.Encode(), testutil.Logger(nil))
	if err != nil {
		t.Fatal(err)
	}
	svc.WithTelegramEnv(env)
	svc.SetClock(func() time.Time { return r.now })
	r.svc = svc
	return r
}

func (r *rig) raw(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	body, _, err := r.store.Get(context.Background(), settings.Key)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func envTG(t *testing.T) settings.Telegram {
	t.Helper()
	tg, err := settings.ParseTelegramEnv("111=ZY, 222=Partner", "-1001234")
	if err != nil {
		t.Fatal(err)
	}
	return tg
}

var llmIn = settings.Input{BaseURL: "https://new.example/v1", APIKey: "sk-new-secret-7f3a", Model: "m2"}

func TestV1FileReadsAsBefore(t *testing.T) {
	r := newRig(t, v1File, envTG(t))
	ctx := context.Background()
	l := r.svc.Resolve(ctx)
	// The env key belongs to LLM_BASE_URL (env.example); the file points at
	// llm.example, so the env key must not be sent there.
	if l.BaseURL != "https://llm.example/v1" || l.Model != "qwen" || l.Streaming || l.APIKey != "" {
		t.Fatalf("v1 llm resolved differently: %+v", l)
	}
	v := r.svc.View(ctx)
	if v.Updated != "2026-10-14T00:00:00Z" || v.By != "zy@example.com" || v.KeySet || v.KeyFromEnv {
		t.Fatalf("v1 view: %+v", v)
	}
	// Pointing back at the env endpoint brings the env key back.
	r2 := newRig(t, strings.Replace(v1File, "https://llm.example/v1", "https://env.example/v1", 1), envTG(t))
	if l := r2.svc.Resolve(ctx); l.APIKey != "sk-env-0000-aaaa" {
		t.Fatalf("env key on its own endpoint: %+v", l)
	}
	tg := r.svc.ResolveTelegram(ctx)
	if !tg.FromEnv || len(tg.Users) != 2 || tg.Users[1].Name != "Partner" || !tg.GroupAllowed(-1001234) {
		t.Fatalf("telegram should come from env: %+v", tg)
	}
}

func TestSectionsSurviveEachOthersSaves(t *testing.T) {
	// A file with a section this version doesn't know must keep it too.
	file := strings.Replace(v1File, `"by": "zy@example.com"`, `"by": "zy@example.com", "stt": {"model": "whisper"}`, 1)
	r := newRig(t, file, envTG(t))
	ctx := context.Background()

	if _, err := r.svc.SaveTelegram(ctx, "zy@example.com", settings.TelegramInput{Users: []settings.TelegramUser{{ID: "333", Name: "Helper"}}, Groups: []string{"-1009"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.svc.Save(ctx, "partner@example.com", llmIn); err != nil {
		t.Fatal(err)
	}
	raw := r.raw(t)
	if raw["telegram"] == nil || raw["stt"] == nil {
		t.Fatalf("LLM save dropped a section: %s", raw)
	}
	var llm map[string]any
	json.Unmarshal(raw["llm"], &llm)
	enc, _ := llm["apiKeyEnc"].(string)
	if enc == "" || strings.Contains(string(raw["llm"]), "sk-new-secret") {
		t.Fatalf("key must be stored encrypted: %s", raw["llm"])
	}

	// Now a Telegram save must keep the encrypted key and the rest of llm.
	if _, err := r.svc.SaveTelegram(ctx, "zy@example.com", settings.TelegramInput{Users: []settings.TelegramUser{{ID: "111", Name: "ZY"}}}); err != nil {
		t.Fatal(err)
	}
	raw = r.raw(t)
	var llm2 map[string]any
	json.Unmarshal(raw["llm"], &llm2)
	if llm2["apiKeyEnc"] != enc || llm2["model"] != "m2" || raw["stt"] == nil {
		t.Fatalf("Telegram save changed llm or dropped stt: %s", raw)
	}
	if l := r.svc.Resolve(ctx); l.APIKey != "sk-new-secret-7f3a" || l.Model != "m2" {
		t.Fatalf("llm after telegram save: %+v", l)
	}
	if v := r.svc.View(ctx); v.By != "partner@example.com" {
		t.Fatalf("top-level by must still mean 'LLM last saved': %+v", v)
	}
}

func TestTelegramSectionReplacesEnvAsAWhole(t *testing.T) {
	r := newRig(t, "", envTG(t))
	ctx := context.Background()
	v, err := r.svc.SaveTelegram(ctx, "zy", settings.TelegramInput{Users: []settings.TelegramUser{{ID: " 333 ", Name: "  Helper   Lim "}}})
	if err != nil {
		t.Fatal(err)
	}
	if v.FromEnv || len(v.Users) != 1 || v.Users[0].ID != "333" || v.Users[0].Name != "Helper Lim" || len(v.Groups) != 0 || v.By != "zy" || v.Updated == "" {
		t.Fatalf("saved view: %+v", v)
	}
	tg := r.svc.ResolveTelegram(ctx)
	if _, ok := tg.UserName(111); ok || tg.GroupAllowed(-1001234) {
		t.Fatal("env users and groups must not be merged into a saved section")
	}
	if name, ok := tg.UserName(333); !ok || name != "Helper Lim" {
		t.Fatalf("UserName(333) = %q %v", name, ok)
	}

	// An empty saved list allows nobody (it does not fall back to env).
	r.svc.SaveTelegram(ctx, "zy", settings.TelegramInput{})
	if tg := r.svc.ResolveTelegram(ctx); len(tg.Users) != 0 || tg.FromEnv {
		t.Fatalf("empty saved list: %+v", tg)
	}
	// UseEnv drops the section and env applies again.
	r.svc.SaveTelegram(ctx, "zy", settings.TelegramInput{UseEnv: true})
	if _, ok := r.raw(t)["telegram"]; ok {
		t.Fatal("useEnv should remove the telegram section")
	}
	if tg := r.svc.ResolveTelegram(ctx); !tg.FromEnv || len(tg.Users) != 2 {
		t.Fatalf("after useEnv: %+v", tg)
	}
}

func TestTelegramValidation(t *testing.T) {
	r := newRig(t, "", settings.Telegram{})
	ctx := context.Background()
	u := func(id, name string) []settings.TelegramUser { return []settings.TelegramUser{{ID: id, Name: name}} }
	cases := map[string]settings.TelegramInput{
		"not a number":       {Users: u("abc", "x")},
		"negative user":      {Users: u("-5", "x")},
		"empty name":         {Users: u("5", "  ")},
		"name 41":            {Users: u("5", strings.Repeat("n", 41))},
		"duplicate user":     {Users: append(u("5", "a"), u("5", "b")...)},
		"positive group":     {Users: u("5", "a"), Groups: []string{"1001"}},
		"group not a number": {Users: u("5", "a"), Groups: []string{"reno"}},
		"duplicate group":    {Users: u("5", "a"), Groups: []string{"-1", "-1"}},
		"duplicate name":     {Users: append(u("5", "ZY"), u("6", "zy")...)},
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			var ve *settings.ValidationError
			if _, err := r.svc.SaveTelegram(ctx, "zy", in); !errors.As(err, &ve) {
				t.Fatalf("want ValidationError, got %v", err)
			}
		})
	}
	if _, _, err := r.store.Get(ctx, settings.Key); !errors.Is(err, objstore.ErrNotFound) {
		t.Fatal("rejected input must not write anything")
	}
}

func TestParseTelegramEnv(t *testing.T) {
	tg, err := settings.ParseTelegramEnv("111=ZY,222, 333=Lim Ah Kow ", "-100123, -456")
	if err != nil {
		t.Fatal(err)
	}
	if len(tg.Users) != 3 || tg.Users[1].Name != "222" || tg.Users[2].Name != "Lim Ah Kow" || len(tg.Groups) != 2 || !tg.FromEnv {
		t.Fatalf("parsed: %+v", tg)
	}
	if tg, err := settings.ParseTelegramEnv("", ""); err != nil || len(tg.Users) != 0 {
		t.Fatalf("empty env: %+v %v", tg, err)
	}
	if _, err := settings.ParseTelegramEnv("zy=ZY", ""); err == nil || !strings.Contains(err.Error(), "TELEGRAM_ALLOWED_IDS") {
		t.Fatalf("bad env should name the variable: %v", err)
	}
}

func TestUnreadableFileFallsBackToEnv(t *testing.T) {
	r := newRig(t, "{not json", envTG(t))
	ctx := context.Background()
	if l := r.svc.Resolve(ctx); l.Model != "env-model" {
		t.Fatalf("llm: %+v", l)
	}
	if tg := r.svc.ResolveTelegram(ctx); !tg.FromEnv || len(tg.Users) != 2 {
		t.Fatalf("telegram must fall back to env, never allow-all: %+v", tg)
	}
	// A hand-edited invalid telegram section also falls back to env.
	r2 := newRig(t, `{"schema":1,"llm":{},"telegram":{"users":[{"id":"x","name":"?"}],"groups":[]}}`, envTG(t))
	if tg := r2.svc.ResolveTelegram(ctx); !tg.FromEnv || len(tg.Users) != 2 {
		t.Fatalf("invalid section: %+v", tg)
	}
	// Saving over an unreadable file works and keeps nothing from it.
	if _, err := r.svc.SaveTelegram(ctx, "zy", settings.TelegramInput{Users: []settings.TelegramUser{{ID: "9", Name: "N"}}}); err != nil {
		t.Fatal(err)
	}
	if tg := r.svc.ResolveTelegram(ctx); tg.FromEnv || len(tg.Users) != 1 {
		t.Fatalf("after save: %+v", tg)
	}
}

func TestCacheAndTTL(t *testing.T) {
	r := newRig(t, "", envTG(t))
	ctx := context.Background()
	// Saves through the service show up at once.
	r.svc.SaveTelegram(ctx, "zy", settings.TelegramInput{Users: []settings.TelegramUser{{ID: "9", Name: "N"}}})
	if _, ok := r.svc.ResolveTelegram(ctx).UserName(9); !ok {
		t.Fatal("own save not visible immediately")
	}
	// A write from elsewhere (another replica, a restore) waits for the TTL.
	_, etag, _ := r.store.Get(ctx, settings.Key)
	r.store.Put(ctx, settings.Key, []byte(`{"schema":1,"llm":{},"telegram":{"users":[{"id":"8","name":"Outside"}],"groups":[]}}`), etag)
	if _, ok := r.svc.ResolveTelegram(ctx).UserName(8); ok {
		t.Fatal("outside write visible before the TTL; the cache is not working")
	}
	r.now = r.now.Add(settings.CacheTTL + time.Second)
	if name, ok := r.svc.ResolveTelegram(ctx).UserName(8); !ok || name != "Outside" {
		t.Fatal("outside write not picked up after the TTL")
	}
}

// conflictOnce makes the first conditional write lose, to exercise the retry.
type conflictOnce struct {
	*objstore.Memory
	lost bool
}

func (c *conflictOnce) Put(ctx context.Context, k string, b []byte, m string) (string, error) {
	if !c.lost && m != "" {
		c.lost = true
		// Someone else saves the llm section in between.
		c.Memory.Put(ctx, k, []byte(`{"schema":1,"llm":{"model":"raced"}}`), m)
		return "", objstore.ErrPrecondition
	}
	return c.Memory.Put(ctx, k, b, m)
}

func TestTelegramSaveRetriesOnConflictAndKeepsTheOtherWrite(t *testing.T) {
	mem := objstore.NewMemory()
	mem.Put(context.Background(), settings.Key, []byte(v1File), "")
	store := &conflictOnce{Memory: mem}
	svc, _ := settings.NewService(store, settings.Defaults, "", testutil.Logger(nil))
	if _, err := svc.SaveTelegram(context.Background(), "zy", settings.TelegramInput{Users: []settings.TelegramUser{{ID: "1", Name: "A"}}}); err != nil {
		t.Fatal(err)
	}
	body, _, _ := mem.Get(context.Background(), settings.Key)
	if !strings.Contains(string(body), `"raced"`) || !strings.Contains(string(body), `"telegram"`) {
		t.Fatalf("both writes must survive: %s", body)
	}
}

// blockFirstGet holds the first Get until released, to order a slow read
// after a save.
type blockFirstGet struct {
	*objstore.Memory
	once    sync.Once
	started chan struct{}
	release chan struct{}
}

func (b *blockFirstGet) Get(ctx context.Context, k string) ([]byte, string, error) {
	first := false
	b.once.Do(func() { first = true })
	body, etag, err := b.Memory.Get(ctx, k)
	if first {
		close(b.started)
		<-b.release
	}
	return body, etag, err
}

// TestSlowReadDoesNotCacheOverASave: a read that started before a save and
// finished after it must not put the older settings back in the cache (a
// removed Telegram user would keep access for the TTL).
func TestSlowReadDoesNotCacheOverASave(t *testing.T) {
	mem := objstore.NewMemory()
	mem.Put(context.Background(), settings.Key, []byte(`{"schema":1,"llm":{},"telegram":{"users":[{"id":"1","name":"Old"}],"groups":[]}}`), "")
	store := &blockFirstGet{Memory: mem, started: make(chan struct{}), release: make(chan struct{})}
	svc, _ := settings.NewService(store, settings.Defaults, "", testutil.Logger(nil))
	ctx := context.Background()

	done := make(chan settings.Telegram)
	go func() { done <- svc.ResolveTelegram(ctx) }() // slow read of the old list
	<-store.started
	if _, err := svc.SaveTelegram(ctx, "zy", settings.TelegramInput{Users: []settings.TelegramUser{{ID: "2", Name: "New"}}}); err != nil {
		t.Fatal(err)
	}
	close(store.release)
	<-done
	tg := svc.ResolveTelegram(ctx)
	if _, ok := tg.UserName(1); ok {
		t.Fatal("the slow read put the old allowlist back in the cache")
	}
	if _, ok := tg.UserName(2); !ok {
		t.Fatalf("the saved list is missing: %+v", tg)
	}
}
