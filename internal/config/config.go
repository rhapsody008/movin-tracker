// Package config reads every setting from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/docs"
	"github.com/rhapsody008/movin-tracker/internal/sched"
	"github.com/rhapsody008/movin-tracker/internal/settings"
)

type Config struct {
	ListenAddr string

	S3Bucket      string
	S3Prefix      string
	AWSRegion     string
	S3EndpointURL string

	AuthHeader    string
	AllowedEmails []string
	DevEmail      string // used when the auth header is missing; local dev only

	SettingsSecret string
	LLM            settings.LLM // env-level defaults; settings.json overrides
	ClaudeBaseURL  string       // LLM_CLAUDE_BASE_URL: tests and stubs only

	DocsSync string // DOCS_SYNC_SCHEDULE: HH:MM in TZ, or off; default 03:00

	// CHECKIN_SCHEDULE (HH:MM in TZ, or off; default 09:30) and CHECKIN_CHAT:
	// the defaults that Settings → Telegram can override. (DOCS_SYNC_SCHEDULE
	// stays a string: docs.Syncer.Background parses it.)
	Checkin settings.Checkin

	TelegramToken string            // empty: the bot does not start
	Telegram      settings.Telegram // env-level allowlist; settings.json overrides

	Location  *time.Location
	StaticDir string // serve the frontend from disk (live reload) instead of the embedded copy
	PollEvery time.Duration
	LogLevel  string
}

func env(k, d string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return d
}

func Load() (Config, error) {
	c := Config{
		// Loopback by default: the app trusts the auth header, so only the
		// proxy beside it may reach it. Compose sets ":8080" for local use.
		ListenAddr:     env("LISTEN_ADDR", "127.0.0.1:8080"),
		S3Bucket:       env("S3_BUCKET", ""),
		S3Prefix:       strings.Trim(env("S3_PREFIX", ""), "/"),
		AWSRegion:      env("AWS_REGION", "ap-southeast-1"),
		S3EndpointURL:  env("S3_ENDPOINT_URL", ""),
		AuthHeader:     env("AUTH_HEADER", "X-Forwarded-Email"),
		DevEmail:       strings.ToLower(env("DEV_EMAIL", "")),
		SettingsSecret: env("SETTINGS_SECRET", ""),
		StaticDir:      env("STATIC_DIR", ""),
		LogLevel:       env("LOG_LEVEL", "info"),
		PollEvery:      5 * time.Second,
	}
	if c.S3Bucket == "" {
		return c, fmt.Errorf("S3_BUCKET is required")
	}
	for _, e := range strings.Split(env("ALLOWED_EMAILS", ""), ",") {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			c.AllowedEmails = append(c.AllowedEmails, e)
		}
	}
	loc, err := time.LoadLocation(env("TZ", "Asia/Singapore"))
	if err != nil {
		return c, fmt.Errorf("TZ: %w", err)
	}
	c.Location = loc

	c.LLM = settings.Defaults
	c.LLM.BaseURL = strings.TrimRight(env("LLM_BASE_URL", ""), "/")
	c.ClaudeBaseURL = strings.TrimRight(env("LLM_CLAUDE_BASE_URL", settings.ClaudeOrigin), "/")
	switch c.LLM.Kind = env("LLM_KIND", settings.KindOpenAI); c.LLM.Kind {
	case settings.KindOpenAI:
	case settings.KindClaude:
		c.LLM.BaseURL = c.ClaudeBaseURL // LLM_API_KEY then belongs to Claude
	default:
		return c, fmt.Errorf("LLM_KIND must be %q or %q", settings.KindOpenAI, settings.KindClaude)
	}
	c.LLM.APIKey = env("LLM_API_KEY", "")
	c.LLM.Model = env("LLM_MODEL", "")
	if v := env("LLM_STREAMING", ""); v != "" {
		if c.LLM.Streaming, err = strconv.ParseBool(v); err != nil {
			return c, fmt.Errorf("LLM_STREAMING: %w", err)
		}
	}
	if v := env("LLM_THINK_ON_DEMAND", ""); v != "" {
		if c.LLM.ThinkOnDemand, err = strconv.ParseBool(v); err != nil {
			return c, fmt.Errorf("LLM_THINK_ON_DEMAND: %w", err)
		}
	}
	c.DocsSync = env("DOCS_SYNC_SCHEDULE", docs.DefaultSyncSchedule)
	if _, _, _, err := sched.Parse("DOCS_SYNC_SCHEDULE", c.DocsSync, docs.DefaultSyncSchedule); err != nil {
		return c, err
	}
	schedule := env("CHECKIN_SCHEDULE", settings.DefaultCheckin)
	if _, err := settings.ParseCheckin(schedule, ""); err != nil {
		return c, fmt.Errorf("CHECKIN_SCHEDULE: %w", err)
	}
	if c.Checkin, err = settings.ParseCheckin(schedule, env("CHECKIN_CHAT", "")); err != nil {
		return c, fmt.Errorf("CHECKIN_CHAT: %w", err)
	}
	c.TelegramToken = env("TELEGRAM_BOT_TOKEN", "")
	if c.Telegram, err = settings.ParseTelegramEnv(env("TELEGRAM_ALLOWED_IDS", ""), env("TELEGRAM_ALLOWED_CHATS", "")); err != nil {
		return c, err
	}
	return c, nil
}
