/**
 * Worker entry for the PDF engine.
 *
 * pdf.js decodes every page inside a worker, so the `Promise.withResolvers` back-fill has to run
 * there too — patching the window is not enough. Bundling the worker through this module (rather
 * than pointing `workerSrc` at the package's `pdf.worker.mjs`) is what makes that possible: the
 * polyfill is evaluated first inside the worker, then the engine's own handler takes over.
 *
 * `build.worker.format` is `es` in vite.config.ts because pdf.js 6.x ships an ES module worker.
 */
import "./polyfills";
import "pdfjs-dist/build/pdf.worker.mjs";
