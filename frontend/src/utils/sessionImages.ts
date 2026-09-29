/**
 * Session images live outside the transcript payload.
 *
 * A snapshot ships `{type:"image", mimeType, bytes, ref}` instead of the image's base64: on an
 * 11.7MB session, 94% of those bytes were 27 images, and the reader waited for all of them to cross
 * the bridge before the transcript could paint. The bytes stay in the session file and the webview
 * fetches them from the app's own asset server, one image at a time, only when something displays
 * them - see `internal/sessionindex/imagerefs.go` for the minting side.
 */

/** The asset-server path the Go middleware answers; everything else in the chain is pass-through. */
export const SESSION_IMAGE_PATH = "/session-image";

/** The URL an `<img>` should use for a reference. Relative on purpose: it resolves against whichever
 *  origin is serving the page, which is the dev server proxy in development and the app's own
 *  scheme in a packaged build. */
export function sessionImageUrl(ref: string): string {
  return `${SESSION_IMAGE_PATH}?ref=${encodeURIComponent(ref)}`;
}