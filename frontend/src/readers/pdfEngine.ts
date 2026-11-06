import { nativeCapabilities } from "./polyfills";

import type * as PdfJs from "pdfjs-dist";

/** Why a `PdfReader` shows the "open in another app" notice instead of pages. */
export type PdfEngineFailure = "unsupported" | "load";

/**
 * Whether the WebView shipped with every API pdf.js 6.x wants.
 *
 * `Promise.withResolvers` (Safari 17.4) is the newest of them, so it stands for the set: the rest
 * arrived by 15.4 and the `static {}` blocks are syntax the build target transpiles, not something
 * a webview can lack at runtime. `polyfills.ts` back-fills the missing ones, which is why this is a
 * *diagnostic* rather than a gate — the engine is still attempted, and only a real failure turns
 * this false into the "your system is too old" wording.
 */
export function hasNativePdfSupport(): boolean {
  return nativeCapabilities.promiseWithResolvers;
}

let engine: Promise<typeof PdfJs> | undefined;

/**
 * Loads the engine on demand. Kept behind a function so `InspectorPanel` never imports pdf.js
 * statically: the engine contains `static {}` blocks, and a macOS 12 webview that had to parse them
 * would fail at module evaluation — taking the whole panel, and the notice that explains it, down
 * with it.
 */
export function loadPdfEngine(): Promise<typeof PdfJs> {
  engine ??= (async () => {
    const pdfjs = await import("pdfjs-dist");
    const { default: PdfWorker } = await import("./pdfWorkerEntry?worker");
    pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
    return pdfjs;
  })().catch((error: unknown) => {
    engine = undefined;
    throw error;
  });
  return engine;
}

/** Asset roots. Copied out of `node_modules` into `public/pdf/` by `scripts/copy-pdf-assets.mjs`. */
export const pdfAssetBase = "/pdf/";

/**
 * Document options shared by every open. `wasmUrl`/`iccUrl` are the 5.x additions: without them the
 * engine cannot find its JPEG-2000 and colour-profile decoders, and a scanned book renders blank
 * pages with no error to show for it.
 */
export function pdfDocumentOptions(extra: Record<string, unknown> = {}) {
  return {
    cMapUrl: `${pdfAssetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${pdfAssetBase}standard_fonts/`,
    wasmUrl: `${pdfAssetBase}wasm/`,
    iccUrl: `${pdfAssetBase}iccs/`,
    ...extra,
  };
}
