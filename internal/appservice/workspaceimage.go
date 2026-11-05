package appservice

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"pi-desk/internal/repository"
	"pi-desk/internal/workspace"
)

// workspaceImagePrefix serves images referenced by a Markdown document. The transcript carries
// session images as refs for the same reason (see sessionimage.go): a data URL would put the bytes
// inside the HTML string, get re-sent on every preview open, and hold them in the renderer's cache.
// A Markdown file can reference several images, so they travel as URLs and the bytes are read only
// when the browser actually paints one.
const workspaceImagePrefix = "/workspace-image"

// workspaceImageSource is the narrow half of the workspace catalog this route needs. Keeping it an
// interface means the handler is testable with a temp directory and no state file on disk.
type workspaceImageSource interface {
	ResolveID(id string) (workspace.Record, error)
	ResolvePath(path string) (workspace.Record, error)
}

// WorkspaceImageMiddleware routes `/workspace-image?workspaceId=…&path=…` (or `root=` for a thread
// written before workspace ids existed) to a trusted local workspace. Every other path passes
// through untouched, exactly like SessionImageMiddleware.
func WorkspaceImageMiddleware(source workspaceImageSource) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path == workspaceImagePrefix {
				serveWorkspaceImage(writer, request, source)
				return
			}
			next.ServeHTTP(writer, request)
		})
	}
}

func serveWorkspaceImage(writer http.ResponseWriter, request *http.Request, source workspaceImageSource) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writer.Header().Set("Allow", "GET, HEAD")
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	query := request.URL.Query()
	id := strings.TrimSpace(query.Get("workspaceId"))
	root := strings.TrimSpace(query.Get("root"))
	if (id == "") == (root == "") {
		http.Error(writer, "workspace image not available", http.StatusNotFound)
		return
	}
	var (
		record workspace.Record
		err    error
	)
	if id != "" {
		record, err = source.ResolveID(id)
		if err == nil && record.Location.Kind == workspace.KindLocal {
			// The same boundary check the preview RPC performs: a catalog entry that was moved or
			// replaced on disk must not turn its old id into a readable root.
			var verified workspace.Record
			if verified, err = source.ResolvePath(record.Path); err == nil && verified.ID != record.ID {
				err = errors.New("workspace is not registered")
			}
		}
	} else {
		record, err = source.ResolvePath(root)
	}
	// A stale/forged workspace or a file outside it is answered as "not found", not "forbidden":
	// the only reader is a rendered preview and its broken-image state is the actionable answer.
	// Trust matters here because the file tree and the preview RPC already require `approve`; a
	// deny workspace must not become readable through a Markdown image.
	if err != nil || record.Trust != "approve" || record.Location.Kind != workspace.KindLocal {
		http.Error(writer, "workspace image not available", http.StatusNotFound)
		return
	}
	data, mediaType, err := repository.ReadImage(record.Path, query.Get("path"))
	if err != nil {
		http.Error(writer, "workspace image not available", http.StatusNotFound)
		return
	}
	writer.Header().Set("Content-Type", mediaType)
	// The path is not content-addressed: a designer can replace the PNG under the same name, and
	// the next preview must show the new bytes. Revalidate instead of banking a long max-age.
	writer.Header().Set("Cache-Control", "no-cache")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Content-Length", strconv.Itoa(len(data)))
	writer.WriteHeader(http.StatusOK)
	if request.Method == http.MethodHead {
		return
	}
	_, _ = writer.Write(data)
}
