package objstore

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

// stores returns the in-memory store, plus the real S3/MinIO store when
// S3_ENDPOINT_URL and S3_BUCKET are set (as they are inside `make test`).
func stores(t *testing.T) map[string]Store {
	t.Helper()
	out := map[string]Store{"memory": NewMemory()}
	if os.Getenv("S3_ENDPOINT_URL") != "" && os.Getenv("S3_BUCKET") != "" {
		ctx := context.Background()
		s, err := NewS3(ctx, S3Options{
			Bucket:      os.Getenv("S3_BUCKET"),
			Prefix:      fmt.Sprintf("test-objstore-%d", time.Now().UnixNano()),
			Region:      envOr("AWS_REGION", "ap-southeast-1"),
			EndpointURL: os.Getenv("S3_ENDPOINT_URL"),
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := s.CreateBucket(ctx); err != nil {
			t.Fatal(err)
		}
		out["s3"] = s
	}
	return out
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func TestConditionalWrites(t *testing.T) {
	for name, s := range stores(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			if _, _, err := s.Get(ctx, "x.json"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("get missing: want ErrNotFound, got %v", err)
			}
			if _, err := s.Stat(ctx, "x.json"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("stat missing: want ErrNotFound, got %v", err)
			}
			e1, err := s.Put(ctx, "x.json", []byte(`{"v":1}`), "")
			if err != nil {
				t.Fatalf("first create: %v", err)
			}
			if _, err := s.Put(ctx, "x.json", []byte(`{"v":1}`), ""); !errors.Is(err, ErrPrecondition) {
				t.Fatalf("second create must fail If-None-Match, got %v", err)
			}
			e2, err := s.Put(ctx, "x.json", []byte(`{"v":2}`), e1)
			if err != nil {
				t.Fatalf("matching write: %v", err)
			}
			if _, err := s.Put(ctx, "x.json", []byte(`{"v":3}`), e1); !errors.Is(err, ErrPrecondition) {
				t.Fatalf("stale If-Match must fail, got %v", err)
			}
			body, etag, err := s.Get(ctx, "x.json")
			if err != nil || string(body) != `{"v":2}` || etag != e2 {
				t.Fatalf("get: body=%s etag=%s want %s err=%v", body, etag, e2, err)
			}
			if st, _ := s.Stat(ctx, "x.json"); st.ETag != e2 {
				t.Fatalf("stat etag %s want %s", st.ETag, e2)
			}
		})
	}
}

func TestStatDeleteInfo(t *testing.T) {
	for name, s := range stores(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			if _, err := s.Stat(ctx, "y.json"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("stat missing: want ErrNotFound, got %v", err)
			}
			before := time.Now().Add(-2 * time.Second)
			etag, err := s.Put(ctx, "y.json", []byte(`{"v":1}`), "")
			if err != nil {
				t.Fatal(err)
			}
			st, err := s.Stat(ctx, "y.json")
			if err != nil || st.ETag != etag || st.Size != 7 || st.LastModified.Before(before) || st.LastModified.After(time.Now().Add(2*time.Second)) {
				t.Fatalf("stat: %+v err=%v", st, err)
			}
			if err := s.Delete(ctx, "y.json"); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Stat(ctx, "y.json"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("after delete: want ErrNotFound, got %v", err)
			}
			if err := s.Delete(ctx, "y.json"); err != nil {
				t.Fatalf("deleting a missing key must not fail: %v", err)
			}
			d, ok := s.(Describer)
			if !ok {
				t.Fatal("store does not describe itself")
			}
			in := d.Info(ctx)
			if name == "s3" && (in.Backend != "s3" || in.Bucket == "" || in.Endpoint == "" || in.CredentialSource != "env keys") {
				t.Fatalf("s3 info: %+v", in)
			}
			if name == "memory" && in.Backend != "memory" {
				t.Fatalf("memory info: %+v", in)
			}
		})
	}
}

func TestCredentialLabel(t *testing.T) {
	for in, want := range map[string]string{
		"EnvConfigCredentials":                      "env keys",
		"WebIdentityCredentials":                    "web identity (IRSA)",
		"SharedConfigCredentials: /root/.aws/creds": "shared profile",
		"EC2RoleProvider":                           "instance role",
		"":                                          "unknown",
		"SomethingNew":                              "SomethingNew",
	} {
		if got := CredentialLabel(in); got != want {
			t.Errorf("CredentialLabel(%q) = %q, want %q", in, got, want)
		}
	}
}
