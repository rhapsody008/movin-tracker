package config_test

import (
	"strings"
	"testing"

	"github.com/rhapsody008/movin-tracker/internal/config"
)

func TestCheckinSettings(t *testing.T) {
	t.Setenv("S3_BUCKET", "b")
	// Start from the defaults whatever the environment (.env may set these).
	t.Setenv("CHECKIN_SCHEDULE", "")
	t.Setenv("CHECKIN_CHAT", "")
	c, err := config.Load()
	if err != nil || !c.Checkin.On || c.Checkin.Hour != 9 || c.Checkin.Minute != 30 || c.Checkin.Schedule != "09:30" || c.Checkin.Chat != "" {
		t.Fatalf("defaults: %+v %v", c, err)
	}
	t.Setenv("CHECKIN_SCHEDULE", "off")
	t.Setenv("CHECKIN_CHAT", "-100123")
	if c, err = config.Load(); err != nil || c.Checkin.On || c.Checkin.Schedule != "off" || c.Checkin.ChatID() != -100123 {
		t.Fatalf("off + chat: %+v %v", c, err)
	}
	for env, val := range map[string]string{"CHECKIN_SCHEDULE": "9am", "CHECKIN_CHAT": "the group"} {
		t.Run(env, func(t *testing.T) {
			t.Setenv(env, val)
			if _, err := config.Load(); err == nil || !strings.Contains(err.Error(), env) {
				t.Fatalf("%s=%q: %v", env, val, err)
			}
		})
	}
	t.Setenv("CHECKIN_SCHEDULE", "20:00")
	if _, err := config.Load(); err == nil || !strings.Contains(err.Error(), "before 20:00") {
		t.Fatalf("20:00 accepted: %v", err)
	}
}
