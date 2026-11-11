package server

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/settings"
	"github.com/rhapsody008/movin-tracker/internal/telegram"
)

// ---------- admin: storage ----------

type lastWrite struct {
	Key string    `json:"key"`
	At  time.Time `json:"at"`
}

type storageView struct {
	objstore.Info
	// LastWrite is when entries.json last changed, from S3 itself, so it
	// survives restarts. Nil when the document does not exist yet or S3
	// could not be reached (see Error).
	LastWrite *lastWrite `json:"lastWrite"`
	Error     string     `json:"error,omitempty"`
}

func (s *Server) getStorage(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	var v storageView
	if d, ok := s.Store.(objstore.Describer); ok {
		v.Info = d.Info(ctx)
	}
	st, err := s.Store.Stat(ctx, entries.Key)
	switch {
	case err == nil:
		v.LastWrite = &lastWrite{Key: entries.Key, At: st.LastModified.UTC()}
	case !errors.Is(err, objstore.ErrNotFound):
		s.Log.Warn("storage stat failed", "err", err)
		v.Error = "Could not read " + entries.Key + " from storage."
	}
	writeJSON(w, http.StatusOK, v)
}

type probeStep struct {
	Name    string `json:"name"`
	OK      bool   `json:"ok"`
	Skipped bool   `json:"skipped,omitempty"`
	Ms      int64  `json:"ms"`
	Error   string `json:"error,omitempty"`
}

type probeResult struct {
	OK    bool        `json:"ok"`
	Key   string      `json:"key"`
	Steps []probeStep `json:"steps"`
}

// ProbePrefix is where the storage test writes its scratch object. The
// production IAM policy allows DeleteObject only under it (and docs/).
const ProbePrefix = "_probe/"

// testStorage runs the six-step storage probe on a scratch key: create
// (If-None-Match), head, get, a stale-ETag write that must be refused, a
// matching write, and delete. Only one probe runs at a time.
func (s *Server) testStorage(w http.ResponseWriter, r *http.Request) {
	if !s.probeMu.TryLock() {
		writeErr(w, http.StatusConflict, "A storage test is already running.")
		return
	}
	defer s.probeMu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	res := s.probe(ctx)
	s.Log.Info("storage test", "by", userOf(r), "ok", res.OK, "key", res.Key)
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) probe(ctx context.Context) probeResult {
	key := ProbePrefix + ulid.Make().String() + ".json"
	res := probeResult{Key: key}
	body := []byte(`{"probe":true}`)
	var etag, etag2 string
	failed := false
	step := func(name string, fn func() error) {
		if failed {
			res.Steps = append(res.Steps, probeStep{Name: name, Skipped: true})
			return
		}
		start := time.Now()
		err := fn()
		st := probeStep{Name: name, OK: err == nil, Ms: time.Since(start).Milliseconds()}
		if err != nil {
			st.Error = err.Error()
			failed = true
		}
		res.Steps = append(res.Steps, st)
	}
	step("create (only if absent)", func() (err error) {
		etag, err = s.Store.Put(ctx, key, body, "")
		return err
	})
	step("head", func() error {
		got, err := s.Store.Head(ctx, key)
		if err == nil && got != etag {
			return errors.New("head returned a different ETag than the write")
		}
		return err
	})
	step("get", func() error {
		got, tag, err := s.Store.Get(ctx, key)
		if err == nil && (!bytes.Equal(got, body) || tag != etag) {
			return errors.New("read back different content or ETag")
		}
		return err
	})
	step("refuse stale write", func() error {
		var err error
		if etag2, err = s.Store.Put(ctx, key, []byte(`{"probe":2}`), etag); err != nil {
			return errors.New("setup write failed: " + err.Error())
		}
		_, err = s.Store.Put(ctx, key, []byte(`{"probe":3}`), etag)
		if errors.Is(err, objstore.ErrPrecondition) {
			return nil
		}
		if err == nil {
			return errors.New("a write with a stale ETag was accepted; concurrent edits could be lost")
		}
		return err
	})
	step("write with current ETag", func() error {
		_, err := s.Store.Put(ctx, key, []byte(`{"probe":4}`), etag2)
		return err
	})
	// Delete runs whenever the scratch object was created, even after a
	// later step failed, so a failed test doesn't leave objects behind.
	if etag != "" {
		failed = false
	}
	step("delete", func() error {
		if err := s.Store.Delete(ctx, key); err != nil {
			return err
		}
		if _, err := s.Store.Stat(ctx, key); !errors.Is(err, objstore.ErrNotFound) {
			return errors.New("object still there after delete")
		}
		return nil
	})
	res.OK = true
	for _, st := range res.Steps {
		if !st.OK {
			res.OK = false
		}
	}
	return res
}

// ---------- admin: telegram ----------

type telegramView struct {
	// Status is the bot's state; it never includes the token, only whether
	// one is set.
	Status    telegram.Status       `json:"status"`
	Allowlist settings.TelegramView `json:"allowlist"`
}

func (s *Server) getTelegram(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, telegramView{Status: s.Bot.Status(), Allowlist: s.Settings.ViewTelegram(r.Context())})
}

func (s *Server) putTelegram(w http.ResponseWriter, r *http.Request) {
	var in settings.TelegramInput
	if !decode(w, r, &in) {
		return
	}
	v, err := s.Settings.SaveTelegram(r.Context(), userOf(r), in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, telegramView{Status: s.Bot.Status(), Allowlist: v})
}
