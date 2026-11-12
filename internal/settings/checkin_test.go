package settings_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/settings"
	"github.com/rhapsody008/movin-tracker/internal/testutil"
)

func TestCheckinSetting(t *testing.T) {
	ctx := context.Background()
	store := objstore.NewMemory()
	s, _ := settings.NewService(store, settings.Defaults, "", testutil.Logger(nil))
	// Nothing anywhere: 09:30, default chat.
	if c, _ := s.ResolveCheckin(ctx); !c.On || c.Schedule != "09:30" || c.Hour != 9 || c.Minute != 30 || c.Chat != "" || !c.FromEnv {
		t.Fatalf("default: %+v", c)
	}
	env, err := settings.ParseCheckin("off", "-100")
	if err != nil {
		t.Fatal(err)
	}
	s.WithCheckinEnv(env)
	if c, _ := s.ResolveCheckin(ctx); c.On || c.Schedule != "off" || c.ChatID() != -100 || !c.FromEnv {
		t.Fatalf("env: %+v", c)
	}
	v, err := s.SaveCheckin(ctx, "zy", settings.CheckinInput{Schedule: " 7:05 ", Chat: ""})
	if err != nil || v.Schedule != "07:05" || v.FromEnv || v.By != "zy" || !v.On || v.Hour != 7 || v.Minute != 5 {
		t.Fatalf("saved: %+v %v", v, err)
	}
	// Another service on the same file (the other copy of the app) sees it.
	other, _ := settings.NewService(store, settings.Defaults, "", testutil.Logger(nil))
	if c, _ := other.ResolveCheckin(ctx); c.Schedule != "07:05" {
		t.Fatalf("other copy: %+v", c)
	}
	for _, bad := range []settings.CheckinInput{{Schedule: "20:00"}, {Schedule: "7"}, {Schedule: "09:30", Chat: "x"}, {Schedule: "09:30", Chat: "0"}} {
		if _, err := s.SaveCheckin(ctx, "zy", bad); err == nil {
			t.Errorf("%+v accepted", bad)
		}
	}
	if v, _ := s.SaveCheckin(ctx, "zy", settings.CheckinInput{UseEnv: true}); v.Schedule != "off" || !v.FromEnv {
		t.Fatalf("back to env: %+v", v)
	}
}

// failingGet is a store whose reads fail (an S3 blip).
type failingGet struct{ objstore.Store }

func (failingGet) Get(context.Context, string) ([]byte, string, error) {
	return nil, "", errors.New("503 slow down")
}

func TestCheckinUnreadableAndInvalid(t *testing.T) {
	ctx := context.Background()
	// Unreadable: an error, never the defaults (which would be on, 09:30).
	s, _ := settings.NewService(failingGet{objstore.NewMemory()}, settings.Defaults, "", testutil.Logger(nil))
	if c, err := s.ResolveCheckin(ctx); err == nil || c.On {
		t.Fatalf("unreadable settings resolved to %+v, %v", c, err)
	}
	// A hand-edited bad section: the server's setting, warned once.
	store := objstore.NewMemory()
	store.Put(ctx, settings.Key, []byte(`{"schema":1,"checkin":{"schedule":"21:00","chat":"x"}}`), "")
	logs := &testutil.SyncBuffer{}
	s, _ = settings.NewService(store, settings.Defaults, "", testutil.Logger(logs))
	env, _ := settings.ParseCheckin("08:15", "-100")
	s.WithCheckinEnv(env)
	for i := 0; i < 3; i++ {
		c, err := s.ResolveCheckin(ctx)
		if err != nil || !c.FromEnv || c.Schedule != "08:15" || c.Chat != "-100" {
			t.Fatalf("invalid section: %+v %v", c, err)
		}
	}
	if n := strings.Count(logs.String(), "checkin section of settings.json is invalid"); n != 1 {
		t.Fatalf("warned %d times", n)
	}
}

// Two different problems at once: each warning is logged once, not every
// time they alternate.
func TestTwoWarningsEachOnce(t *testing.T) {
	ctx := context.Background()
	store := objstore.NewMemory()
	store.Put(ctx, settings.Key, []byte(`{"schema":1,"checkin":{"schedule":"25:00"},"telegram":{"users":[{"id":"-1","name":"x"}],"groups":[]}}`), "")
	logs := &testutil.SyncBuffer{}
	s, _ := settings.NewService(store, settings.Defaults, "", testutil.Logger(logs))
	for i := 0; i < 3; i++ {
		s.ResolveCheckin(ctx)
		s.ResolveTelegram(ctx)
	}
	for _, w := range []string{"checkin section of settings.json is invalid", "telegram section of settings.json is invalid"} {
		if n := strings.Count(logs.String(), w); n != 1 {
			t.Errorf("%q logged %d times", w, n)
		}
	}
}
