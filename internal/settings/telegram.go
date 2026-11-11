package settings

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// TelegramUser is one person allowed to talk to the bot. Name is what the
// journal records as "by" and what the group history shows as the speaker.
// IDs are strings so 64-bit Telegram IDs never pass through JS numbers.
type TelegramUser struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Telegram is the resolved allowlist. A private chat needs an allowed user;
// a group needs an allowed group and an allowed user. An empty user list
// allows nobody.
type Telegram struct {
	Users   []TelegramUser `json:"users"`
	Groups  []string       `json:"groups"`
	FromEnv bool           `json:"fromEnv"`
}

// UserName returns the configured name for an allowed user.
func (t Telegram) UserName(id int64) (string, bool) {
	s := strconv.FormatInt(id, 10)
	for _, u := range t.Users {
		if u.ID == s {
			return u.Name, true
		}
	}
	return "", false
}

// GroupAllowed reports whether a group chat ID is on the list.
func (t Telegram) GroupAllowed(id int64) bool {
	s := strconv.FormatInt(id, 10)
	for _, g := range t.Groups {
		if g == s {
			return true
		}
	}
	return false
}

type storedTelegram struct {
	Users   []TelegramUser `json:"users"`
	Groups  []string       `json:"groups"`
	Updated string         `json:"updated,omitempty"`
	By      string         `json:"by,omitempty"`
}

// TelegramInput is what the admin page sends. UseEnv drops the saved
// section so the env defaults apply again.
type TelegramInput struct {
	Users  []TelegramUser `json:"users"`
	Groups []string       `json:"groups"`
	UseEnv bool           `json:"useEnv"`
}

// TelegramView is what the admin page shows.
type TelegramView struct {
	Telegram
	Updated string `json:"updated,omitempty"`
	By      string `json:"by,omitempty"`
}

const (
	maxTelegramUsers  = 20
	maxTelegramGroups = 10
)

// validTelegram normalises and checks a list: user IDs are positive
// integers, group IDs negative ones (Telegram's convention), names 1-40
// characters, no duplicates.
func validTelegram(users []TelegramUser, groups []string) ([]TelegramUser, []string, error) {
	outU, outG := []TelegramUser{}, []string{}
	seen := map[string]bool{}
	if len(users) > maxTelegramUsers {
		return nil, nil, &ValidationError{fmt.Sprintf("at most %d Telegram users", maxTelegramUsers)}
	}
	if len(groups) > maxTelegramGroups {
		return nil, nil, &ValidationError{fmt.Sprintf("at most %d Telegram groups", maxTelegramGroups)}
	}
	for _, u := range users {
		id := strings.TrimSpace(u.ID)
		n, err := strconv.ParseInt(id, 10, 64)
		if err != nil || n <= 0 {
			return nil, nil, &ValidationError{fmt.Sprintf("Telegram user ID %q must be a positive number", u.ID)}
		}
		id = strconv.FormatInt(n, 10)
		name := strings.Join(strings.Fields(u.Name), " ")
		if l := utf8.RuneCountInString(name); l < 1 || l > 40 {
			return nil, nil, &ValidationError{fmt.Sprintf("name for Telegram user %s must be 1-40 characters", id)}
		}
		if seen[id] {
			return nil, nil, &ValidationError{fmt.Sprintf("Telegram user %s is listed twice", id)}
		}
		seen[id] = true
		outU = append(outU, TelegramUser{ID: id, Name: name})
	}
	for _, g := range groups {
		n, err := strconv.ParseInt(strings.TrimSpace(g), 10, 64)
		if err != nil || n >= 0 {
			return nil, nil, &ValidationError{fmt.Sprintf("Telegram group ID %q must be a negative number (group IDs start with -)", g)}
		}
		id := strconv.FormatInt(n, 10)
		if seen[id] {
			return nil, nil, &ValidationError{fmt.Sprintf("Telegram group %s is listed twice", id)}
		}
		seen[id] = true
		outG = append(outG, id)
	}
	return outU, outG, nil
}

// ParseTelegramEnv reads TELEGRAM_ALLOWED_IDS ("id=name,id2=name2"; a bare
// id gets the id as its name) and TELEGRAM_ALLOWED_CHATS ("-100…,-100…").
func ParseTelegramEnv(ids, chats string) (Telegram, error) {
	var users []TelegramUser
	for _, part := range strings.Split(ids, ",") {
		if part = strings.TrimSpace(part); part == "" {
			continue
		}
		id, name, ok := strings.Cut(part, "=")
		if !ok || strings.TrimSpace(name) == "" {
			name = id
		}
		users = append(users, TelegramUser{ID: strings.TrimSpace(id), Name: name})
	}
	var groups []string
	for _, g := range strings.Split(chats, ",") {
		if g = strings.TrimSpace(g); g != "" {
			groups = append(groups, g)
		}
	}
	u, g, err := validTelegram(users, groups)
	if err != nil {
		return Telegram{}, fmt.Errorf("TELEGRAM_ALLOWED_IDS / TELEGRAM_ALLOWED_CHATS: %w", err)
	}
	return Telegram{Users: u, Groups: g, FromEnv: true}, nil
}

func (s *Service) resolveTelegram(st stored) Telegram {
	if st.Telegram == nil {
		t := s.tgEnv
		t.FromEnv = true
		if t.Users == nil {
			t.Users = []TelegramUser{}
		}
		if t.Groups == nil {
			t.Groups = []string{}
		}
		return t
	}
	// Re-validate what was stored; a hand-edited file falls back to env.
	u, g, err := validTelegram(st.Telegram.Users, st.Telegram.Groups)
	if err != nil {
		s.log.Warn("telegram section of settings.json is invalid, using env allowlist", "err", err)
		return s.resolveTelegram(stored{})
	}
	return Telegram{Users: u, Groups: g}
}

// ResolveTelegram returns the allowlist to use right now. The bot calls it
// for every update, so changes apply without a restart.
func (s *Service) ResolveTelegram(ctx context.Context) Telegram {
	return s.resolveTelegram(s.current(ctx))
}

func (s *Service) ViewTelegram(ctx context.Context) TelegramView {
	st := s.current(ctx)
	v := TelegramView{Telegram: s.resolveTelegram(st)}
	if st.Telegram != nil {
		v.Updated, v.By = st.Telegram.Updated, st.Telegram.By
	}
	return v
}

// SaveTelegram writes the telegram section, keeping every other section.
func (s *Service) SaveTelegram(ctx context.Context, by string, in TelegramInput) (TelegramView, error) {
	var users []TelegramUser
	var groups []string
	if !in.UseEnv {
		var err error
		if users, groups, err = validTelegram(in.Users, in.Groups); err != nil {
			return TelegramView{}, err
		}
	}
	err := s.modify(ctx, func(raw map[string]json.RawMessage) error {
		if in.UseEnv {
			delete(raw, "telegram")
			return nil
		}
		setJSON(raw, "telegram", storedTelegram{Users: users, Groups: groups, Updated: s.now().UTC().Format(time.RFC3339), By: by})
		return nil
	})
	if err != nil {
		return TelegramView{}, err
	}
	s.log.Info("Telegram allowlist saved", "by", by, "users", len(users), "groups", len(groups), "useEnv", in.UseEnv)
	return s.ViewTelegram(ctx), nil
}
