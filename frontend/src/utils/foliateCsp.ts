/**
 * Build-time rewrite of foliate-js's EPUB loader that sanitizes book markup and pins a CSP on it.
 *
 * Why a rewrite and not an upstream option: `epub.js` strips manifest scripts when
 * `allowScript` is false, but it deliberately leaves *inline* `<script>` alone (there is a TODO in
 * `loadReplaced` saying as much), and the paginator's iframe has `allow-scripts` enabled for a
 * WebKit event bug. A hostile EPUB can therefore execute code in a same-origin frame. The only
 * point where every section passes through before becoming a blob URL is `loadReplaced`'s
 * serialization step, so the rewrite happens there:
 *
 * - remove `<script>`, `<base>` and `<meta http-equiv="refresh">`;
 * - remove every `on*` event handler attribute (also covers inline SVG);
 * - prepend a CSP `<meta>` to the document head (SVG top-level documents cannot carry one, but
 *   their scripts/handlers are already gone).
 *
 * This is defense in depth: the CSP stops the remaining execution paths and remote requests even if
 * a future foliate release adds another element we did not anticipate.
 *
 * Every replacement is an exact source match. `applyFoliateCsp` reports what did not apply, and the
 * vite plugin turns a partial match into a build error — a foliate-js upgrade must fail loudly
 * instead of silently shipping an unsanitized reader.
 */

/**
 * Content-Security-Policy for book documents.
 *
 * Book markup is untrusted input. `foliate-js` renders a section in a same-origin iframe whose
 * sandbox also enables scripts (`allow-same-origin allow-scripts`, see paginator.js), so without a
 * policy a hostile EPUB can reach `parent` — including the Wails runtime — or make the reader fetch
 * remote images and stylesheets.
 *
 * The policy keeps the resources a normal reflowable book needs (blob/data images, fonts, media and
 * stylesheets) and forbids everything that can execute or navigate:
 * - `script-src 'none'` also covers inline event handlers and `javascript:` URLs;
 * - `frame-src`, `object-src` and `connect-src` are closed because the reader never needs them;
 * - `form-action` / `base-uri` do not inherit from `default-src` and must be listed.
 *
 * It is applied in two places, both before the markup reaches the iframe:
 * - `foliate-js/epub.js` (patched at build time by this module) for regular sections;
 * - `buildContinuousDocument()` for the merged document used by continuous pagination.
 */
export const EPUB_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline' blob:",
  "img-src blob: data:",
  "font-src blob: data:",
  "media-src blob: data:",
  "object-src 'none'",
  "frame-src 'none'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export interface CspRewrite {
  /** Shown in the build log when it stops matching. */
  readonly purpose: string;
  readonly from: string;
  readonly to: string;
}

/**
 * The exact point after `loadReplaced` has parsed and rewritten the section, and before it turns
 * the document into a blob URL. `item`, `doc`, `MIME` and `XMLSerializer` are all in scope there.
 */
const sanitizeSection: CspRewrite = {
  purpose: "epub Loader.loadReplaced: strip active content and inject CSP",
  from: "            // TODO: replace inline scripts? probably not worth the trouble\n"
    + "            const result = new XMLSerializer().serializeToString(doc)\n",
  to: "            // Security: books are untrusted archives and the paginator renders them in a\n"
    + "            // same-origin, script-capable iframe. Strip active content and pin a CSP before\n"
    + "            // the markup becomes a blob URL (a meta refresh can otherwise navigate the frame).\n"
    + "            for (const el of doc.querySelectorAll('script')) el.remove()\n"
    + "            for (const el of doc.querySelectorAll('meta[http-equiv=\"refresh\" i], base')) el.remove()\n"
    + "            for (const el of doc.querySelectorAll('*')) {\n"
    + "                for (let i = el.attributes.length - 1; i >= 0; i -= 1) {\n"
    + "                    const name = el.attributes[i].name\n"
    + "                    if (name.toLowerCase().startsWith('on')) el.removeAttribute(name)\n"
    + "                }\n"
    + "            }\n"
    + "            if (item.mediaType !== MIME.SVG) {\n"
    + "                let head = doc.head || doc.getElementsByTagName('head')[0]\n"
    + "                if (!head && doc.documentElement?.localName === 'html') {\n"
    + "                    head = doc.createElementNS(doc.documentElement.namespaceURI, 'head')\n"
    + "                    doc.documentElement.insertBefore(head, doc.documentElement.firstChild)\n"
    + "                }\n"
    + "                if (head) {\n"
    + "                    const csp = doc.createElementNS(\n"
    + "                        head.namespaceURI || 'http://www.w3.org/1999/xhtml', 'meta')\n"
    + "                    csp.setAttribute('http-equiv', 'Content-Security-Policy')\n"
    + "                    csp.setAttribute('content', " + JSON.stringify(EPUB_CSP) + ")\n"
    + "                    head.prepend(csp)\n"
    + "                }\n"
    + "            }\n"
    + "            const result = new XMLSerializer().serializeToString(doc)\n",
};

export const CSP_REWRITES: readonly CspRewrite[] = [sanitizeSection];

export interface CspRewriteResult {
  code: string;
  applied: string[];
  skipped: string[];
}

/** True when the module is foliate-js's EPUB loader (query strings included). */
export const isFoliateEpub = (id: string): boolean =>
  /[/\\]foliate-js[/\\]epub\.js$/.test(id.split("?")[0]);

/**
 * Applies every rewrite that matches. Returns the source untouched when nothing matches, which is
 * what makes this safe to run over every module the bundler sees.
 */
export function applyFoliateCsp(code: string): CspRewriteResult {
  let next = code;
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const rewrite of CSP_REWRITES) {
    if (next.includes(rewrite.from)) {
      next = next.split(rewrite.from).join(rewrite.to);
      applied.push(rewrite.purpose);
    } else {
      skipped.push(rewrite.purpose);
    }
  }
  return { code: applied.length ? next : code, applied, skipped };
}
