// Package movintracker embeds the frontend and the admin guide so the
// production image is a single binary.
package movintracker

import (
	"embed"
	"io/fs"
)

//go:embed static
var staticFS embed.FS

//go:embed docs/admin-guide.md
var adminGuide []byte

// Static is the frontend: index.html, guide.html, manifest and icons.
func Static() fs.FS {
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic(err)
	}
	return sub
}

// AdminGuide is docs/admin-guide.md as built into this binary.
func AdminGuide() []byte { return adminGuide }
