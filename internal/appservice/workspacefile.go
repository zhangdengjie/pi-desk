package appservice

import (
	"errors"
	"net/http"
	"os"
	"strings"

	"pi-desk/internal/repository"
	"pi-desk/internal/workspace"
)

// workspaceFilePrefix streams the bytes of a document the reader view renders itself (PDF, EPUB).
// `PreviewFile` returns the small media types as data URLs, which is right for the one image or
// the one short recording the reader opened; a book is tens of megabytes, is read a page at a
// time, and the PDF engine addresses it with byte ranges. So these bytes travel as a URL, and the
// document never crosses the RPC bridge.
const workspaceFilePrefix = "/workspace-file"

// WorkspaceFileMiddleware routes `/workspace-file?workspaceId=…&path=…` (or `root=` for a thread
// written before workspace ids existed) to a trusted local workspace. Every other path passes
// through untouched, exactly like SessionImageMiddleware.
func WorkspaceFileMiddleware(source workspaceAssetSource) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			if request.URL.Path == workspaceFilePrefix {
				serveWorkspaceFile(writer, request, source)
				return
			}
			next.ServeHTTP(writer, request)
		})
	}
}

func serveWorkspaceFile(writer http.ResponseWriter, request *http.Request, source workspaceAssetSource) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writer.Header().Set("Allow", "GET, HEAD")
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	query := request.URL.Query()
	id := strings.TrimSpace(query.Get("workspaceId"))
	root := strings.TrimSpace(query.Get("root"))
	if (id == "") == (root == "") {
		http.Error(writer, "workspace file not available", http.StatusNotFound)
		return
	}
	var (
		record workspace.Record
		err    error
	)
	if id != "" {
		record, err = source.ResolveID(id)
		if err == nil && record.Location.Kind == workspace.KindLocal {
			// The same boundary check the image route performs: a catalog entry that was moved or
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
	// the only reader is a rendered preview and its "cannot open" state is the actionable answer.
	// Trust matters here because the file tree and the preview RPC already require `approve`; a
	// deny workspace must not become readable through a reader URL.
	if err != nil || record.Trust != "approve" || record.Location.Kind != workspace.KindLocal {
		http.Error(writer, "workspace file not available", http.StatusNotFound)
		return
	}
	resolved, err := repository.ResolveFile(record.Path, query.Get("path"))
	if err != nil {
		http.Error(writer, "workspace file not available", http.StatusNotFound)
		return
	}
	// This route must not become a generic file reader. Only the formats the reader view renders
	// from bytes are served; everything else keeps travelling through the preview RPC.
	mediaType := repository.DocumentMediaType(resolved)
	if mediaType == "" {
		http.Error(writer, "workspace file not available", http.StatusNotFound)
		return
	}
	file, err := os.Open(resolved)
	if err != nil {
		http.Error(writer, "workspace file not available", http.StatusNotFound)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.Error(writer, "workspace file not available", http.StatusNotFound)
		return
	}
	writer.Header().Set("Content-Type", mediaType)
	// The path is not content-addressed: a book can be replaced under the same name, and the next
	// open must show the new bytes. Revalidate instead of banking a long max-age.
	writer.Header().Set("Cache-Control", "no-cache")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	// ServeContent answers Range, If-Range and If-Modified-Since, which is the whole point of this
	// route: the PDF engine asks for one page's bytes at a time and never holds the file.
	http.ServeContent(writer, request, info.Name(), info.ModTime(), file)
}
