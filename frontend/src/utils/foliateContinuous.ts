/**
 * Build-time rewrite that lets the paginator display one document holding many spine items.
 *
 * `paginator.js` assumes a one-to-one relationship between `#index` and the document on screen: it
 * reports `#index` on every `relocate` and reloads whenever `goTo` asks for a different index. In
 * continuous mode a single document covers every section, so both assumptions have to be relaxed —
 * and the paginator is the only place that knows the geometry needed to answer them.
 *
 * Rather than teaching the paginator about our merged document, it gets two optional hooks that the
 * reader installs on the element:
 *
 * - `unitIndexFor(index)` — map a real section index onto the unit currently displayed (always `0`
 *   in continuous mode), so `goTo` scrolls instead of swapping the document;
 * - `resolveIndex(range)` — the real section index for the range under the viewport, so `relocate`
 *   reports a section rather than "the whole book", which is what TOC progress and `getCFI` use.
 *
 * Both are plain properties, so nothing has to be exported and a paginator without them behaves
 * exactly as before.
 */

export interface PaginatorRewrite {
  readonly purpose: string;
  readonly from: string;
  readonly to: string;
}

const reportRealIndex: PaginatorRewrite = {
  purpose: "paginator #afterScroll: report the section the range belongs to",
  from: "        const index = this.#index\n"
    + "        const detail = { reason, range, index }\n",
  to: "        const index = typeof this.resolveIndex === 'function'\n"
    + "            ? (this.resolveIndex(range) ?? this.#index) : this.#index\n"
    + "        const detail = { reason, range, index }\n",
};

const mapUnitIndex: PaginatorRewrite = {
  purpose: "paginator #goTo: map a section index onto the displayed unit",
  from: "    async #goTo({ index, anchor, select }) {\n",
  to: "    async #goTo({ index, anchor, select }) {\n"
    + "        if (typeof this.unitIndexFor === 'function') index = this.unitIndexFor(index)\n",
};

export const CONTINUOUS_REWRITES: readonly PaginatorRewrite[] = [reportRealIndex, mapUnitIndex];

export interface ContinuousRewriteResult {
  code: string;
  applied: string[];
  skipped: string[];
}

export function applyContinuousPagination(code: string): ContinuousRewriteResult {
  let next = code;
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const rewrite of CONTINUOUS_REWRITES) {
    if (next.includes(rewrite.from)) {
      next = next.split(rewrite.from).join(rewrite.to);
      applied.push(rewrite.purpose);
    } else {
      skipped.push(rewrite.purpose);
    }
  }
  return { code: applied.length ? next : code, applied, skipped };
}