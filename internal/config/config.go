// Package config reads every setting from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

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
		ListenAddr:     env("LISTEN_ADDR", ":8080"),
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
	c.LLM.APIKey = env("LLM_API_KEY", "")
	c.LLM.Model = env("LLM_MODEL", "")
	if v := env("LLM_TEMPERATURE", ""); v != "" {
		if c.LLM.Temperature, err = strconv.ParseFloat(v, 64); err != nil {
			return c, fmt.Errorf("LLM_TEMPERATURE: %w", err)
		}
	}
	for k, dst := range map[string]*int{"LLM_MAX_TOKENS": &c.LLM.MaxTokens, "LLM_TIMEOUT_SEC": &c.LLM.TimeoutSec, "LLM_MAX_TOOL_ROUNDS": &c.LLM.MaxToolRounds} {
		if v := env(k, ""); v != "" {
			if *dst, err = strconv.Atoi(v); err != nil {
				return c, fmt.Errorf("%s: %w", k, err)
			}
		}
	}
	if v := env("LLM_STREAMING", ""); v != "" {
		if c.LLM.Streaming, err = strconv.ParseBool(v); err != nil {
			return c, fmt.Errorf("LLM_STREAMING: %w", err)
		}
	}
	return c, nil
}
