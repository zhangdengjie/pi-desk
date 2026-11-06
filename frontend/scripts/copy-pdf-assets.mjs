#!/usr/bin/env node
/**
 * Stages pdf.js's auxiliary data under `public/pdf/` so the asset server can hand it to the engine.
 *
 * The engine needs four directories next to its wasm and font decoders: `cmaps` (CJK text without a
 * ToUnicode map), `standard_fonts` (the 14 fonts a PDF may reference without embedding),
 * `wasm` (JPEG-2000 / JBIG2 / colour-profile decoders) and `iccs`. They are ~2.3MB in total and are
 * fetched only when a document actually asks for one of them, so they cost nothing at startup —
 * but they must exist on disk, because `pdfDocumentOptions()` points `cMapUrl`/`wasmUrl`/… at them.
 *
 * They are copied out of `node_modules` rather than committed: 185 binary files in the repository
 * would be a maintenance liability with no upside. `public/pdf/` is gitignored and rebuilt by the
 * `predev`/`prebuild` hooks in package.json.
 */
import { cp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const frontend = dirname(fileURLToPath(import.meta.url)) + "/..";
const source = join(frontend, "node_modules", "pdfjs-dist");
const target = join(frontend, "public", "pdf");
const marker = join(target, ".pdfjs-version");

const directories = ["cmaps", "standard_fonts", "wasm", "iccs"];

async function main() {
  if (!existsSync(source)) {
    // Nothing to do before the first `npm install`; the build will fail later with a clearer
    // message than "no such directory" if the dependency really is missing.
    console.warn("copy-pdf-assets: pdfjs-dist is not installed, skipping");
    return;
  }
  const { version } = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (existsSync(marker)) {
    const staged = (await readFile(marker, "utf8")).trim();
    if (staged === version) return;
  }
  for (const directory of directories) {
    await cp(join(source, directory), join(target, directory), { recursive: true });
  }
  await writeFile(marker, `${version}\n`);
  console.log(`copy-pdf-assets: staged pdfjs-dist@${version} into public/pdf`);
}

await main();
