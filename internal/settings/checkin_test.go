package settings_test

import (
	"context"
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
	if c := s.ResolveCheckin(ctx); !c.On || c.Schedule != "09:30" || c.Hour != 9 || c.Minute != 30 || c.Chat != "" || !c.FromEnv {
		t.Fatalf("default: %+v", c)
	}
	env, err := settings.ParseCheckin("off", "-100")
	if err != nil {
		t.Fatal(err)
	}
	s.WithCheckinEnv(env)
	if c := s.ResolveCheckin(ctx); c.On || c.Schedule != "off" || c.ChatID() != -100 || !c.FromEnv {
		t.Fatalf("env: %+v", c)
	}
	v, err := s.SaveCheckin(ctx, "zy", settings.CheckinInput{Schedule: " 7:05 ", Chat: ""})
	if err != nil || v.Schedule != "07:05" || v.FromEnv || v.By != "zy" || !v.On || v.Hour != 7 || v.Minute != 5 {
		t.Fatalf("saved: %+v %v", v, err)
	}
	// Another service on the same file (the other copy of the app) sees it.
	other, _ := settings.NewService(store, settings.Defaults, "", testutil.Logger(nil))
	if c := other.ResolveCheckin(ctx); c.Schedule != "07:05" {
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
