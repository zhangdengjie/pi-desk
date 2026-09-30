/**
 * A transcript is fetched from the app's own asset server, not carried across the bridge.
 *
 * The bridge is a control channel - one serialised value per message (`@wailsio/runtime/dist/system.js`
 * hands it to `window.webkit.messageHandlers['external']` on macOS). Measured on the same bytes:
 * 1.39MB took 89ms over the bridge and 4-6ms over HTTP, so a 4.5MB transcript spent ~300ms of a
 * 368ms first open on being *carried* - while parsing those bytes in JS is 9ms and the Go that
 * assembled them is 130ms. See `internal/sessionindex/transcriptrefs.go` for the minting side and
 * `docs/06-数据通道选型.md` for the whole comparison.
 *
 * The bridge path stays as the fallback, and it is not a sad path: a stale reference, an unsignable
 * process (no randomness at startup) or a blocked fetch all land back on `GetSessionSnapshot`,
 * which is a slower transcript rather than a broken one.
 */
import type { SessionSnapshot } from "../../bindings/pi-desk/internal/domain";

/** The asset-server path the Go middleware answers for a whole transcript. */
export const SESSION_TRANSCRIPT_PATH = "/session-transcript";

/** Relative on purpose, like `sessionImageUrl`: it resolves against whichever origin is serving the
 *  page - the dev server in development, the app's own scheme in a packaged build. */
export function sessionTranscriptUrl(ref: string): string {
  return `${SESSION_TRANSCRIPT_PATH}?ref=${encodeURIComponent(ref)}`;
}

type TranscriptResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

type TranscriptTransport = {
  /** Mints a reference for this session file; "" means this process cannot sign one. */
  mint: (path: string) => Promise<string>;
  /** The bridge, kept as the fallback. */
  bridge: () => Promise<SessionSnapshot>;
  /** Injectable for tests and for whatever the webview hands us in a packaged build. */
  get: (url: string) => Promise<TranscriptResponse>;
};

function defaultGet(url: string): Promise<TranscriptResponse> {
  return fetch(url, { credentials: "same-origin" }).then((response) => ({ ok: response.ok, json: () => response.json() }));
}

/**
 * Reads one transcript, preferring the asset server. Any trouble on that route - a reference that
 * went stale because the session wrote a turn, a non-2xx, a body that is not an object, a rejected
 * fetch - falls through to the bridge instead of surfacing an error the reader cannot act on.
 */
export async function fetchSessionSnapshot(path: string, transport: Pick<TranscriptTransport, "mint" | "bridge"> & Partial<TranscriptTransport>): Promise<SessionSnapshot> {
  const { mint, bridge } = transport;
  const get = transport.get ?? defaultGet;

  try {
    const ref = await mint(path);
    if (ref) {
      const response = await get(sessionTranscriptUrl(ref));
      if (response?.ok) {
        const body = await response.json();
        // A JSON array is `typeof "object"` too, and it would blow up the reader two calls later.
        if (body && typeof body === "object" && !Array.isArray(body)) return body as SessionSnapshot;
      }
    }
  } catch {
    // The bridge still carries the transcript.
  }
  return bridge();
}
