// Package movintracker embeds the frontend so the production image is a
// single binary.
package movintracker

import (
	"embed"
	"io/fs"
)

//go:embed static
var staticFS embed.FS

// Static is the frontend: index.html, manifest and icons.
func Static() fs.FS {
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic(err)
	}
	return sub
}
