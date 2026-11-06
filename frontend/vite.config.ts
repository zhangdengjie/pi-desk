import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import wails from "@wailsio/runtime/plugins/vite";
import { applySafari15Rewrites, hasRegexLookbehind } from "./src/utils/safari15Compat.ts";
import { applyFoliateSplitView, isFoliatePaginator } from "./src/utils/foliateSplitView.ts";
import { applyContinuousPagination } from "./src/utils/foliateContinuous.ts";
import { applyFoliateCsp, isFoliateEpub } from "./src/utils/foliateCsp.ts";

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    // Wails links the app against `MACOSX_DEPLOYMENT_TARGET: "12.0"`, so a macOS 12 machine runs
    // WKWebView 15.x. pdf.js 6.x bundles `static {}` class blocks (Safari 16.4), which are *syntax*:
    // no polyfill can help, the module cannot even be parsed. Transpiling the whole frontend to
    // Safari 15 is what lets the panel load there and show "this system cannot display PDFs"
    // instead of a blank window. Runtime gaps are covered by `src/readers/polyfills.ts`.
    target: "safari15",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "milkdown-presets", test: /[\\/]node_modules[\\/]@milkdown[\\/]preset-/ },
            { name: "milkdown", test: /[\\/]node_modules[\\/]@milkdown[\\/]/ },
          ],
        },
      },
    },
  },
  // pdf.js 6.x ships an ES module worker; the reader bundles its own worker entry so the
  // `Promise.withResolvers` back-fill runs in the worker too (see src/readers/pdfWorkerEntry.ts).
  worker: {
    format: "es",
    // `build.target` does not reach the worker bundle, and pdf.js's `WorkerMessageHandler` carries a
    // `static {}` block of its own. Without this the worker is the one file a macOS 12 webview
    // cannot parse — and the worker is where every page is decoded.
    rolldownOptions: { transform: { target: "safari15" } },
  },
  // The paginator patch below runs in `transform`, which a pre-bundled dependency never reaches.
  // Excluding foliate-js makes dev serve its ESM sources directly, so `wails3 dev` and a production
  // build run the same patched code.
  optimizeDeps: { exclude: ["foliate-js"] },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  plugins: [
    tailwindcss(),
    vue(),
    wails("./bindings"),
    // Regex lookbehind is a *parse* error on WebKit 15, so it cannot be polyfilled. See
    // src/utils/safari15Compat.ts for why this rewrite exists and which dependency needed it.
    {
      name: "safari15-regex-compat",
      enforce: "pre" as const,
      transform(code: string, id: string) {
        if (!hasRegexLookbehind(code)) return null;
        const result = applySafari15Rewrites(code);
        if (result.applied.length === 0) {
          this.warn(`safari15-regex-compat: lookbehind left untouched in ${id} (${result.skipped.join(", ")})`);
          return null;
        }
        return { code: result.code, map: null };
      },
    },
    // Book markup is untrusted: strip scripts/handlers and pin a CSP before foliate turns a
    // section into a blob URL. See src/utils/foliateCsp.ts.
    {
      name: "foliate-csp",
      enforce: "pre" as const,
      transform(code: string, id: string) {
        if (!isFoliateEpub(id)) return null;
        const csp = applyFoliateCsp(code);
        if (csp.skipped.length > 0) {
          // A partial match means the upstream loader moved: shipping the reader without the CSP
          // would silently reopen the same-origin script path, so fail the build instead.
          this.error(
            `foliate CSP patch: ${csp.skipped.length} rewrite(s) no longer match ${id}:\n  - ${csp.skipped.join("\n  - ")}`,
          );
        }
        return { code: csp.code, map: null };
      },
    },
    // foliate-js destroys the outgoing page before the incoming one exists, so a chapter turn can
    // only dissolve. This rewrite parks it instead; see src/utils/foliateSplitView.ts.
    {
      name: "foliate-split-view",
      enforce: "pre" as const,
      transform(code: string, id: string) {
        if (!id.includes("foliate-js") || !isFoliatePaginator(code)) return null;
        const split = applyFoliateSplitView(code);
        // Both patches edit the paginator, so they run in sequence over the same source.
        const continuous = applyContinuousPagination(split.code);
        const skipped = [...split.skipped, ...continuous.skipped];
        if (skipped.length > 0) {
          // A partial match means the upstream code moved: the reader would silently fall back to
          // one page per section, or to one section per view, with no error anywhere.
          this.error(
            `foliate patches: ${skipped.length} rewrite(s) no longer match ${id}:\n  - ${skipped.join("\n  - ")}`,
          );
        }
        return { code: continuous.code, map: null };
      },
    },
  ],
});
