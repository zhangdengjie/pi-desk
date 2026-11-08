//go:build !production

package buildinfo

// DevTools is enabled outside production builds. `wails3 dev` does not pass
// the production tag, so development keeps the inspector.
const DevTools = true
