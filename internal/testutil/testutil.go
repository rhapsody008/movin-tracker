// Package testutil gives tests a set of object stores to run against: always
// the in-memory one, plus MinIO/S3 when S3_ENDPOINT_URL and S3_BUCKET are set
// (they are inside `make test`).
package testutil

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/objstore"
)

// Stores returns named stores; each S3 entry gets a fresh prefix so tests
// never see each other's objects.
func Stores(t *testing.T) map[string]objstore.Store {
	t.Helper()
	out := map[string]objstore.Store{"memory": objstore.NewMemory()}
	if s := S3(t); s != nil {
		out["s3"] = s
	}
	return out
}

var bucketOnce sync.Once

// S3 returns a store on a fresh prefix of the test bucket, or nil when no
// S3 endpoint is configured.
func S3(t *testing.T) objstore.Store {
	t.Helper()
	if os.Getenv("S3_ENDPOINT_URL") == "" || os.Getenv("S3_BUCKET") == "" {
		return nil
	}
	ctx := context.Background()
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = "ap-southeast-1"
	}
	name := strings.NewReplacer("/", "-", " ", "-").Replace(t.Name())
	s, err := objstore.NewS3(ctx, objstore.S3Options{
		Bucket:      os.Getenv("S3_BUCKET"),
		Prefix:      fmt.Sprintf("test/%s-%d", name, time.Now().UnixNano()),
		Region:      region,
		EndpointURL: os.Getenv("S3_ENDPOINT_URL"),
	})
	if err != nil {
		t.Fatal(err)
	}
	var berr error
	bucketOnce.Do(func() {
		// MinIO may still be starting when the test container comes up.
		for i := 0; i < 30; i++ {
			if berr = s.CreateBucket(ctx); berr == nil {
				return
			}
			time.Sleep(time.Second)
		}
	})
	if berr != nil {
		t.Fatal(berr)
	}
	return s
}

// Logger returns a logger that writes into buf (or discards when buf is nil).
func Logger(buf io.Writer) *slog.Logger {
	if buf == nil {
		buf = io.Discard
	}
	return slog.New(slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

// SyncBuffer is a goroutine-safe bytes buffer for capturing logs.
type SyncBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *SyncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *SyncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}
