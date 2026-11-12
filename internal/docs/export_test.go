package docs

// CacheSize reports the viewer's cached PDFs and renders (entries, bytes),
// for tests.
func CacheSize(v *Viewer) (pdfs, pdfBytes, views, viewBytes int) {
	v.mu.Lock()
	defer v.mu.Unlock()
	return len(v.pdfs.keys), v.pdfs.bytes, len(v.views.keys), v.views.bytes
}
