// Package server wires the HTTP routes: static frontend, REST API over
// entries, SSE stream, web chat (through the agent) and LLM settings.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/rhapsody008/movin-tracker/internal/agent"
	"github.com/rhapsody008/movin-tracker/internal/entries"
	"github.com/rhapsody008/movin-tracker/internal/llm"
	"github.com/rhapsody008/movin-tracker/internal/objstore"
	"github.com/rhapsody008/movin-tracker/internal/settings"
	"github.com/rhapsody008/movin-tracker/internal/telegram"
)

type Server struct {
	Entries  *entries.Service
	Settings *settings.Service
	Agent    *agent.Runner
	Bot      *telegram.Bot // nil when TELEGRAM_BOT_TOKEN is not set
	// Guide returns the admin guide (Markdown). Nil serves 404.
	Guide  func() ([]byte, error)
	Store  objstore.Store
	Static fs.FS
	Log    *slog.Logger

	AuthHeader    string
	AllowedEmails []string
	DevEmail      string

	// SSEHeartbeat keeps idle proxies from closing the event stream.
	SSEHeartbeat time.Duration

	probeMu sync.Mutex // one storage test at a time
}

type ctxKey struct{}

func userOf(r *http.Request) string { s, _ := r.Context().Value(ctxKey{}).(string); return s }

// actorOf is the web user as the entries journal records them.
func actorOf(r *http.Request) entries.Actor { return entries.Actor{By: userOf(r), Channel: "web"} }

func (s *Server) Handler() http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("GET /api/entries", s.getEntries)
	api.HandleFunc("POST /api/entries", s.createEntry)
	api.HandleFunc("PATCH /api/entries/{id}", s.patchEntry)
	api.HandleFunc("DELETE /api/entries/{id}", s.deleteEntry)
	api.HandleFunc("POST /api/changes/{id}/undo", s.undoChange)
	api.HandleFunc("PUT /api/meta", s.putMeta)
	api.HandleFunc("GET /api/events", s.events)
	api.HandleFunc("POST /api/chat", s.chat)
	api.HandleFunc("GET /api/me", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"email": userOf(r)})
	})
	api.HandleFunc("GET /api/admin/guide", s.getGuide)
	api.HandleFunc("GET /api/admin/storage", s.getStorage)
	api.HandleFunc("POST /api/admin/storage/test", s.testStorage)
	api.HandleFunc("GET /api/admin/telegram", s.getTelegram)
	api.HandleFunc("PUT /api/settings/telegram", s.putTelegram)
	api.HandleFunc("GET /api/settings/llm", s.getSettings)
	api.HandleFunc("PUT /api/settings/llm", s.putSettings)
	api.HandleFunc("POST /api/settings/llm/test", s.testSettings)
	api.HandleFunc("GET /api/settings/llm/models", s.listModels)
	api.Handle("/", s.static())

	root := http.NewServeMux()
	// Home-screen icon and manifest: iOS may fetch these without the sign-in
	// cookie, and they reveal nothing.
	for _, p := range []string{"/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"} {
		root.Handle("GET "+p, s.static())
	}
	root.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok\n")) })
	root.HandleFunc("GET /readyz", s.readyz)
	root.Handle("/", s.auth(api))
	return s.logRequests(root)
}

// auth trusts the email header set by the proxy in front. The app must only
// be reachable through that proxy (see deploy/k8s: it listens on localhost
// inside the pod, next to oauth2-proxy).
func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		email := strings.ToLower(strings.TrimSpace(r.Header.Get(s.AuthHeader)))
		if email == "" {
			email = s.DevEmail
		}
		if email == "" {
			http.Error(w, "Not signed in.", http.StatusUnauthorized)
			return
		}
		if len(s.AllowedEmails) > 0 && !slices.Contains(s.AllowedEmails, email) {
			s.Log.Warn("rejected user not on ALLOWED_EMAILS", "email", email, "path", r.URL.Path)
			http.Error(w, "This page is private. "+email+" is not on the list.", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, email)))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(c int)           { r.status = c; r.ResponseWriter.WriteHeader(c) }
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
			return
		}
		s.Log.Debug("request", "method", r.Method, "path", r.URL.Path, "status", rec.status, "ms", time.Since(start).Milliseconds())
	})
}

func (s *Server) static() http.Handler {
	files := http.FileServerFS(s.Static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			writeErr(w, http.StatusNotFound, "no such endpoint")
			return
		}
		// Always revalidate so a deploy shows up on the next load.
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	})
}

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if _, err := s.Store.Head(ctx, entries.Key); err != nil && !errors.Is(err, objstore.ErrNotFound) {
		s.Log.Warn("readyz: S3 not reachable", "err", err)
		http.Error(w, "S3 not reachable", http.StatusServiceUnavailable)
		return
	}
	w.Write([]byte("ok\n"))
}

// ---------- helpers ----------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

const conflictMsg = "Someone else just changed this. Showing the latest."

// fail maps service errors to HTTP answers. A 409 carries the latest
// document so the browser can re-render without another round trip.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var ve *entries.ValidationError
	var se *settings.ValidationError
	switch {
	case errors.As(err, &ve):
		writeErr(w, http.StatusBadRequest, ve.Msg)
	case errors.As(err, &se):
		writeErr(w, http.StatusBadRequest, se.Msg)
	case errors.Is(err, entries.ErrEntryNotFound):
		writeErr(w, http.StatusNotFound, "That entry no longer exists.")
	case errors.Is(err, entries.ErrChangeNotFound):
		writeErr(w, http.StatusNotFound, "That change is too old to undo.")
	case errors.Is(err, entries.ErrUndoStale):
		snap, _ := s.Entries.Current(r.Context())
		writeJSON(w, http.StatusConflict, map[string]any{"error": "That entry was changed again since, so it can't be undone.", "doc": snap.Doc, "etag": snap.ETag})
	case errors.Is(err, entries.ErrConflict), errors.Is(err, settings.ErrConflict):
		snap, _ := s.Entries.Current(r.Context())
		writeJSON(w, http.StatusConflict, map[string]any{"error": conflictMsg, "doc": snap.Doc, "etag": snap.ETag})
	default:
		s.Log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
		writeErr(w, http.StatusInternalServerError, "That change didn't save. Try again.")
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "Request body must be JSON: "+err.Error())
		return false
	}
	return true
}

// ---------- entries ----------

func (s *Server) getEntries(w http.ResponseWriter, r *http.Request) {
	snap, err := s.Entries.Current(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	w.Header().Set("ETag", snap.ETag)
	writeJSON(w, http.StatusOK, snap)
}

// entryResp answers every write: the entry it touched, the journal change
// (its id is the undo handle, with a ready-made line to show), and the new
// document.
type entryResp struct {
	Entry  *entries.Entry    `json:"entry,omitempty"`
	Change *agent.ChangeLine `json:"change,omitempty"`
	Doc    *entries.Doc      `json:"doc"`
	ETag   string            `json:"etag"`
}

func respond(res entries.Result) entryResp {
	out := entryResp{Doc: res.Snapshot.Doc, ETag: res.Snapshot.ETag}
	if len(res.Entries) > 0 {
		out.Entry = &res.Entries[0]
	}
	if len(res.Changes) > 0 {
		out.Change = &agent.ChangeLine{ID: res.Changes[0].ID, Text: agent.ChangeText(res.Changes[0])}
	}
	return out
}

func (s *Server) createEntry(w http.ResponseWriter, r *http.Request) {
	var p entries.Patch
	if !decode(w, r, &p) {
		return
	}
	res, err := s.Entries.Create(r.Context(), actorOf(r), []entries.Patch{p})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, respond(res))
}

func (s *Server) patchEntry(w http.ResponseWriter, r *http.Request) {
	var p entries.Patch
	if !decode(w, r, &p) {
		return
	}
	res, err := s.Entries.Update(r.Context(), actorOf(r), r.PathValue("id"), p)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, respond(res))
}

func (s *Server) deleteEntry(w http.ResponseWriter, r *http.Request) {
	res, err := s.Entries.Delete(r.Context(), actorOf(r), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	s.Log.Info("entry deleted", "by", userOf(r), "id", res.Entries[0].ID, "title", res.Entries[0].Title)
	out := respond(res)
	out.Entry = nil
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) undoChange(w http.ResponseWriter, r *http.Request) {
	res, err := s.Entries.Undo(r.Context(), actorOf(r), r.PathValue("id"))
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, respond(res))
}

func (s *Server) putMeta(w http.ResponseWriter, r *http.Request) {
	var raw map[string]json.RawMessage
	if !decode(w, r, &raw) {
		return
	}
	var mp entries.MetaPatch
	str := func(b json.RawMessage) (*string, bool) {
		var v *string
		return v, json.Unmarshal(b, &v) == nil
	}
	for k, b := range raw {
		v, ok := str(b)
		if !ok {
			writeErr(w, http.StatusBadRequest, k+" must be a string or null")
			return
		}
		switch k {
		case "moveDate":
			mp.MoveDate, mp.SetMove = v, true
		case "keyDate":
			mp.KeyDate, mp.SetKey = v, true
		default:
			writeErr(w, http.StatusBadRequest, "unknown field "+k)
			return
		}
	}
	snap, err := s.Entries.SetMeta(r.Context(), mp)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, entryResp{Doc: snap.Doc, ETag: snap.ETag})
}

// ---------- SSE ----------

type sse struct {
	w  http.ResponseWriter
	rc *http.ResponseController
}

func startSSE(w http.ResponseWriter) *sse {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no") // nginx ingress: do not buffer
	w.WriteHeader(http.StatusOK)
	rc := http.NewResponseController(w)
	rc.SetWriteDeadline(time.Time{})
	return &sse{w: w, rc: rc}
}

func (e *sse) send(event string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(e.w, "event: %s\ndata: %s\n\n", event, b); err != nil {
		return err
	}
	return e.rc.Flush()
}

func (e *sse) comment() error {
	if _, err := fmt.Fprint(e.w, ": ping\n\n"); err != nil {
		return err
	}
	return e.rc.Flush()
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	ch, cancel := s.Entries.Subscribe()
	defer cancel()
	snap, err := s.Entries.Current(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out := startSSE(w)
	if out.send("entries", snap) != nil {
		return
	}
	hb := s.SSEHeartbeat
	if hb == 0 {
		hb = 25 * time.Second
	}
	tick := time.NewTicker(hb)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case snap := <-ch:
			if out.send("entries", snap) != nil {
				return
			}
		case <-tick.C:
			if out.comment() != nil {
				return
			}
		}
	}
}

// ---------- chat ----------

func (s *Server) chat(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Turns []agent.Turn `json:"turns"`
	}
	if !decode(w, r, &body) {
		return
	}
	cfg := s.Settings.Resolve(r.Context())
	user := userOf(r)
	req := agent.Request{By: user, Channel: "web", Turns: body.Turns}
	wantStream := cfg.Streaming && strings.Contains(r.Header.Get("Accept"), "text/event-stream")
	if !wantStream {
		res, err := s.Agent.Run(r.Context(), req, cfg, nil)
		if err != nil {
			s.Log.Warn("chat failed", "by", user, "model", cfg.Model, "err", err)
			writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error(), "changes": res.Changes, "model": cfg.Model})
			return
		}
		writeJSON(w, http.StatusOK, res)
		return
	}
	out := startSSE(w)
	res, err := s.Agent.Run(r.Context(), req, cfg, func(e agent.Event) { out.send(e.Type, e) })
	if err != nil {
		s.Log.Warn("chat failed", "by", user, "model", cfg.Model, "err", err)
		out.send("error", map[string]any{"error": err.Error(), "changes": res.Changes, "model": cfg.Model})
		return
	}
	out.send("done", res)
}

// ---------- settings ----------

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.Settings.View(r.Context()))
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	var in settings.Input
	if !decode(w, r, &in) {
		return
	}
	v, err := s.Settings.Save(r.Context(), userOf(r), in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

type testResult struct {
	OK          bool     `json:"ok"`
	LatencyMs   int64    `json:"latencyMs"`
	ToolCalls   bool     `json:"toolCalls"`
	Models      []string `json:"models,omitempty"`
	ModelsError string   `json:"modelsError,omitempty"`
	Error       string   `json:"error,omitempty"`
}

var probeTool = llm.Tool{Type: "function", Function: llm.FunctionDecl{
	Name: "set_dates", Description: "Set the move-in date (YYYY-MM-DD).",
	Parameters: json.RawMessage(`{"type":"object","properties":{"move_in":{"type":"string"}},"required":["move_in"]}`),
}}

// testSettings tries the drawer's values without saving: list models, then
// one tool-calling request. ok means tool calling works end to end.
func (s *Server) testSettings(w http.ResponseWriter, r *http.Request) {
	var in settings.Input
	if !decode(w, r, &in) {
		return
	}
	cfg, err := s.Settings.ForTest(r.Context(), in)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	cfg.Streaming = false
	c := llm.New(cfg)
	var res testResult
	if res.Models, err = c.Models(r.Context()); err != nil {
		res.ModelsError = err.Error()
	}
	start := time.Now()
	m, err := c.Complete(r.Context(), []llm.Message{
		{Role: "system", Content: "You set dates on a board. Always use the tool."},
		{Role: "user", Content: "We move in on 2026-12-05."},
	}, []llm.Tool{probeTool}, false, false, nil)
	res.LatencyMs = time.Since(start).Milliseconds()
	switch {
	case err != nil:
		res.Error = err.Error()
	case len(m.ToolCalls) == 0:
		res.Error = "The endpoint answered but did not return tool_calls. Pick a model that supports tool calling."
	default:
		res.OK, res.ToolCalls = true, true
	}
	s.Log.Info("LLM settings test", "by", userOf(r), "model", cfg.Model, "ok", res.OK, "latencyMs", res.LatencyMs)
	writeJSON(w, http.StatusOK, res)
}

// listModels proxies GET {baseUrl}/models. ?baseUrl= lets the drawer list
// models for an endpoint it has not saved yet, using the stored key.
func (s *Server) listModels(w http.ResponseWriter, r *http.Request) {
	cfg := s.Settings.Resolve(r.Context())
	if u := r.URL.Query().Get("baseUrl"); u != "" {
		cfg.BaseURL = u
	}
	if cfg.BaseURL == "" {
		writeErr(w, http.StatusBadRequest, "Set an endpoint URL first.")
		return
	}
	cfg.TimeoutSec = 15
	ids, err := llm.New(cfg).Models(r.Context())
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": ids})
}
