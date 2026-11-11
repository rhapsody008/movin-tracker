// Command movin is the renovation agent server: web page, REST API and
// (from step 1.9) the Telegram bot.
//
//	movin                    serve (default)
//	movin healthcheck        exit 0 if /healthz answers; used by Docker HEALTHCHECK
//	movin init-bucket        create the bucket with versioning (local MinIO only)
//	movin seed FILE          replace entries.json with FILE (validated, ETag-guarded)
package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata" // the distroless image has no zoneinfo

	movintracker "github.com/rhapsody008/movin-tracker"
	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/config"
	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/server"
	"github.com/rhapsody008/movin-tracker/internal/settings"
	"github.com/rhapsody008/movin-tracker/internal/telegram"
)

func main() {
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	var err error
	switch cmd {
	case "serve":
		err = serve()
	case "healthcheck":
		err = healthcheck()
	case "init-bucket":
		err = initBucket()
	case "seed":
		if len(os.Args) < 3 {
			err = errors.New("usage: movin seed FILE")
		} else {
			err = seed(os.Args[2])
		}
	default:
		err = fmt.Errorf("unknown command %q", cmd)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func logger(level string) *slog.Logger {
	var l slog.Level
	_ = l.UnmarshalText([]byte(level))
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: l}))
}

func openStore(ctx context.Context, c config.Config) (*objstore.S3, error) {
	return objstore.NewS3(ctx, objstore.S3Options{Bucket: c.S3Bucket, Prefix: c.S3Prefix, Region: c.AWSRegion, EndpointURL: c.S3EndpointURL})
}

func serve() error {
	c, err := config.Load()
	if err != nil {
		return err
	}
	log := logger(c.LogLevel)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	store, err := openStore(ctx, c)
	if err != nil {
		return err
	}
	ents := entries.NewService(store, log)
	if err := ents.Load(ctx); err != nil {
		// Keep serving: /readyz reports the problem and reads retry lazily.
		log.Error("initial entries load failed", "err", err)
	}
	go ents.Poll(ctx, c.PollEvery)

	sets, err := settings.NewService(store, c.LLM, c.SettingsSecret, log)
	if err != nil {
		return err
	}
	sets.WithTelegramEnv(c.Telegram)
	if c.SettingsSecret == "" {
		log.Warn("SETTINGS_SECRET is not set; the settings drawer cannot store an API key")
	}
	if len(c.AllowedEmails) == 0 {
		log.Warn("ALLOWED_EMAILS is empty; every user the proxy lets through can use the board")
	}

	var static fs.FS = movintracker.Static()
	if c.StaticDir != "" {
		static = os.DirFS(c.StaticDir)
		log.Info("serving frontend from disk", "dir", c.StaticDir)
	}
	runner := &agent.Runner{Entries: ents, Loc: c.Location, Log: log, Now: time.Now}
	if c.TelegramToken != "" {
		bot := &telegram.Bot{API: telegram.New(c.TelegramToken, ""), Agent: runner, Entries: ents, Settings: sets, Log: log}
		go func() {
			if err := bot.Run(ctx); err != nil && ctx.Err() == nil {
				log.Error("telegram bot stopped", "err", err)
			}
		}()
	} else {
		log.Info("TELEGRAM_BOT_TOKEN is not set; the Telegram bot is off")
	}
	srv := &server.Server{
		Entries: ents, Settings: sets, Store: store, Static: static, Log: log,
		Agent:      runner,
		AuthHeader: c.AuthHeader, AllowedEmails: c.AllowedEmails, DevEmail: c.DevEmail,
	}
	hs := &http.Server{
		Addr:              c.ListenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// No WriteTimeout: SSE streams stay open.
	}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		hs.Shutdown(sctx)
	}()
	log.Info("listening", "addr", c.ListenAddr, "bucket", c.S3Bucket, "prefix", c.S3Prefix, "authHeader", c.AuthHeader, "devEmail", c.DevEmail != "")
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func healthcheck() error {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	cl := &http.Client{Timeout: 3 * time.Second}
	resp, err := cl.Get("http://" + addr + "/healthz")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthz returned %d", resp.StatusCode)
	}
	return nil
}

func initBucket() error {
	c, err := config.Load()
	if err != nil {
		return err
	}
	ctx := context.Background()
	store, err := openStore(ctx, c)
	if err != nil {
		return err
	}
	// MinIO may still be starting when this runs from compose.
	for i := 0; ; i++ {
		if err = store.CreateBucket(ctx); err == nil || i == 20 {
			break
		}
		time.Sleep(time.Second)
	}
	if err != nil {
		return err
	}
	fmt.Printf("bucket %s ready (versioning on)\n", c.S3Bucket)
	return nil
}

func seed(path string) error {
	c, err := config.Load()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	nd, err := entries.Decode(data)
	if err != nil {
		return err
	}
	ctx := context.Background()
	store, err := openStore(ctx, c)
	if err != nil {
		return err
	}
	svc := entries.NewService(store, logger("warn"))
	if err := svc.Load(ctx); err != nil {
		return err
	}
	snap, err := svc.Replace(ctx, nd)
	if err != nil {
		return err
	}
	key := entries.Key
	if c.S3Prefix != "" {
		key = c.S3Prefix + "/" + key
	}
	fmt.Printf("seeded s3://%s/%s with %d entries (etag %s)\n", c.S3Bucket, key, len(snap.Doc.Entries), snap.ETag)
	return nil
}
