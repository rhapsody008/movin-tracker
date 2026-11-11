// Command movin is the "Project LTM" board server.
//
//	movin                    serve (default)
//	movin healthcheck        exit 0 if /healthz answers; used by Docker HEALTHCHECK
//	movin init-bucket        create the bucket with versioning (local MinIO only)
//	movin seed FILE          replace board.json with FILE (validated, ETag-guarded)
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
	"github.com/rhapsody008/movin-tracker/internal/board"
	"github.com/rhapsody008/movin-tracker/internal/chat"
	"github.com/rhapsody008/movin-tracker/internal/config"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/server"
	"github.com/rhapsody008/movin-tracker/internal/settings"
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
	boards := board.NewService(store, log)
	if err := boards.Load(ctx); err != nil {
		// Keep serving: /readyz reports the problem and reads retry lazily.
		log.Error("initial board load failed", "err", err)
	}
	go boards.Poll(ctx, c.PollEvery)

	sets, err := settings.NewService(store, c.LLM, c.SettingsSecret, log)
	if err != nil {
		return err
	}
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
	srv := &server.Server{
		Board: boards, Settings: sets, Store: store, Static: static, Log: log,
		Chat:       &chat.Runner{Board: boards, Loc: c.Location, Log: log, Now: time.Now},
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
	nb, err := board.Decode(data)
	if err != nil {
		return err
	}
	ctx := context.Background()
	store, err := openStore(ctx, c)
	if err != nil {
		return err
	}
	svc := board.NewService(store, logger("warn"))
	if err := svc.Load(ctx); err != nil {
		return err
	}
	snap, err := svc.Replace(ctx, nb)
	if err != nil {
		return err
	}
	key := board.Key
	if c.S3Prefix != "" {
		key = c.S3Prefix + "/" + key
	}
	fmt.Printf("seeded s3://%s/%s with %d items (etag %s)\n", c.S3Bucket, key, len(snap.Board.Items), snap.ETag)
	return nil
}
