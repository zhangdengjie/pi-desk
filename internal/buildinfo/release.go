//go:build production

package buildinfo

// DevTools is disabled in production builds. The Windows release task also
// must not add the `devtools` build tag; otherwise Wails compiles the devtools
// webview implementation back in.
const DevTools = false
