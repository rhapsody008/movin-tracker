package server

import (
	"context"
	"net/http"

	"github.com/rhapsody008/movin-tracker/internal/docs"
)

// docView is one document as the Documents tab shows it.
type docView struct {
	docs.Doc
	Name   string `json:"name"`
	Folder string `json:"folder"`
}

type docsView struct {
	On       bool       `json:"on"`
	Running  bool       `json:"running"`
	LastSync *docs.Sync `json:"lastSync,omitempty"`
	Docs     []docView  `json:"docs"`
}

func (s *Server) docsView(ctx context.Context) (docsView, error) {
	v := docsView{Docs: []docView{}}
	if s.Docs == nil {
		return v, nil
	}
	v.On, v.Running = true, s.Docs.Running()
	ix, err := s.Docs.Index(ctx)
	if err != nil {
		return v, err
	}
	v.LastSync = ix.LastSync
	for _, d := range ix.Docs {
		v.Docs = append(v.Docs, docView{Doc: d, Name: d.Name(), Folder: d.Folder()})
	}
	return v, nil
}

func (s *Server) getDocs(w http.ResponseWriter, r *http.Request) {
	v, err := s.docsView(r.Context())
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// syncDocs starts a sync (or joins the running one) and answers at once;
// the page hears the result over the event stream.
func (s *Server) syncDocs(w http.ResponseWriter, r *http.Request) {
	if s.Docs == nil {
		writeErr(w, http.StatusNotFound, "Documents are not switched on.")
		return
	}
	joined := s.Docs.Running()
	go func() {
		// Not tied to this request: the sync goes on after it returns.
		if _, err := s.Docs.Sync(context.WithoutCancel(r.Context()), "web"); err != nil {
			s.Log.Warn("document sync from the web page failed", "by", userOf(r), "err", err)
		}
	}()
	s.Log.Info("document sync requested", "by", userOf(r), "joined", joined)
	writeJSON(w, http.StatusAccepted, map[string]any{"started": !joined, "joined": joined})
}
