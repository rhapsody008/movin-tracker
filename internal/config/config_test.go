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
	if err != nil || c.Checkin != "09:30" || c.CheckinChat != 0 {
		t.Fatalf("defaults: %q %d %v", c.Checkin, c.CheckinChat, err)
	}
	t.Setenv("CHECKIN_SCHEDULE", "off")
	t.Setenv("CHECKIN_CHAT", "-100123")
	if c, err = config.Load(); err != nil || c.Checkin != "off" || c.CheckinChat != -100123 {
		t.Fatalf("off + chat: %q %d %v", c.Checkin, c.CheckinChat, err)
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
