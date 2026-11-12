package settings

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/sched"
)

// DefaultCheckin is the check-in time when nothing is set.
const DefaultCheckin = "09:30"

// Checkin is the resolved morning check-in setting.
type Checkin struct {
	// Schedule is "HH:MM" in the app's time zone, or "off".
	Schedule string `json:"schedule"`
	// Chat is where it goes: a chat ID, or "" for the first allowed group
	// (else the first allowed person).
	Chat    string `json:"chat"`
	FromEnv bool   `json:"fromEnv"`

	On           bool `json:"-"`
	Hour, Minute int  `json:"-"`
}

// ChatID is Chat as a number (0 for the default).
func (c Checkin) ChatID() int64 {
	id, _ := strconv.ParseInt(c.Chat, 10, 64)
	return id
}

type storedCheckin struct {
	Schedule string `json:"schedule"`
	Chat     string `json:"chat,omitempty"`
	Updated  string `json:"updated,omitempty"`
	By       string `json:"by,omitempty"`
}

// CheckinInput is what the admin page sends. UseEnv drops the saved
// section so the server's CHECKIN_SCHEDULE / CHECKIN_CHAT apply again.
type CheckinInput struct {
	Schedule string `json:"schedule"`
	Chat     string `json:"chat"`
	UseEnv   bool   `json:"useEnv"`
}

// CheckinView is what the admin page shows.
type CheckinView struct {
	Checkin
	Updated string `json:"updated,omitempty"`
	By      string `json:"by,omitempty"`
}

// ParseCheckin checks a schedule ("HH:MM" before the cutoff, or "off";
// empty = DefaultCheckin) and a chat ID ("" = default) and normalises them.
func ParseCheckin(schedule, chat string) (Checkin, error) {
	hh, mm, on, err := sched.Parse("the check-in time", schedule, DefaultCheckin)
	if err != nil {
		return Checkin{}, &ValidationError{err.Error()}
	}
	if on && hh >= sched.CheckinCutoff {
		return Checkin{}, &ValidationError{fmt.Sprintf("the check-in time must be before %d:00 (later ones are skipped)", sched.CheckinCutoff)}
	}
	c := Checkin{Schedule: "off", On: on, Hour: hh, Minute: mm}
	if on {
		c.Schedule = fmt.Sprintf("%02d:%02d", hh, mm)
	}
	if chat = strings.TrimSpace(chat); chat != "" {
		id, err := strconv.ParseInt(chat, 10, 64)
		if err != nil || id == 0 {
			return Checkin{}, &ValidationError{fmt.Sprintf("the check-in chat must be a Telegram chat ID (a number), not %q", chat)}
		}
		c.Chat = strconv.FormatInt(id, 10)
	}
	return c, nil
}

// WithCheckinEnv sets the env-level check-in (the default that a checkin
// section in settings.json replaces).
func (s *Service) WithCheckinEnv(c Checkin) *Service { s.ciEnv = c; return s }

func (s *Service) resolveCheckin(st stored) Checkin {
	if st.Checkin == nil {
		c := s.ciEnv
		if c.Schedule == "" { // never set: the default
			c, _ = ParseCheckin("", "")
		}
		c.FromEnv = true
		return c
	}
	c, err := ParseCheckin(st.Checkin.Schedule, st.Checkin.Chat)
	if err != nil {
		s.log.Warn("checkin section of settings.json is invalid, using the server's setting", "err", err)
		return s.resolveCheckin(stored{})
	}
	return c
}

// ResolveCheckin returns the check-in setting to use right now (the bot
// reads it every minute, so a change applies without a restart).
func (s *Service) ResolveCheckin(ctx context.Context) Checkin {
	return s.resolveCheckin(s.current(ctx))
}

func (s *Service) ViewCheckin(ctx context.Context) CheckinView {
	st := s.current(ctx)
	v := CheckinView{Checkin: s.resolveCheckin(st)}
	if st.Checkin != nil {
		v.Updated, v.By = st.Checkin.Updated, st.Checkin.By
	}
	return v
}

// SaveCheckin writes the checkin section, keeping every other section.
func (s *Service) SaveCheckin(ctx context.Context, by string, in CheckinInput) (CheckinView, error) {
	var c Checkin
	if !in.UseEnv {
		var err error
		if c, err = ParseCheckin(in.Schedule, in.Chat); err != nil {
			return CheckinView{}, err
		}
	}
	err := s.modify(ctx, func(raw map[string]json.RawMessage) error {
		if in.UseEnv {
			delete(raw, "checkin")
			return nil
		}
		setJSON(raw, "checkin", storedCheckin{Schedule: c.Schedule, Chat: c.Chat, Updated: s.now().UTC().Format(time.RFC3339), By: by})
		return nil
	})
	if err != nil {
		return CheckinView{}, err
	}
	s.log.Info("check-in setting saved", "by", by, "schedule", c.Schedule, "chat", c.Chat, "useEnv", in.UseEnv)
	return s.ViewCheckin(ctx), nil
}
