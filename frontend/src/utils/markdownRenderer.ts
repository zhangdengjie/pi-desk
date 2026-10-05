import MarkdownIt, { type Env } from "markdown-it";
import { normalizeMarkdownBreakTags, uniqueHeadingSlug } from "./markdown";
import { resolveWorkspaceFileLink } from "./fileLinks";

/**
 * The one Markdown renderer this app has, plus the cross-instance cache in front of it.
 *
 * Both live outside `components/MarkdownBody.vue` on purpose. Everything inside `<script setup>`
 * runs per component instance, and a transcript mounts dozens of `MarkdownBody`s at once - a
 * virtualized long session unmounts and remounts whole rows while the reader scrolls, so a
 * per-instance renderer means the same 256k-char tool output is parsed again on every pass.
 * Measured with this app's own options (node, markdown-it): 119k chars 14ms, 256k 30ms, 358k 42ms,
 * 1MiB 135ms. The cache turns a remount into one `String.replaceAll` over the finished HTML, which
 * over 1.7MB costs 0.11ms - so the parse is paid once per *text*, not once per mount.
 *
 * Construction itself is not the problem and is deliberately still per app, not per instance: a
 * `new MarkdownIt` with these rules measured 0.02-0.34ms.
 */

/**
 * Stands in for the per-instance heading prefix while the HTML sits in the cache.
 *
 * Headings carry the instance prefix so two `## Setup` headings in one window cannot collide (see
 * `instanceUid` in MarkdownBody.vue). Cached HTML therefore cannot be served verbatim: it is stored
 * with this placeholder and substituted on the way out, which is the cheap half of a cache hit.
 * A NUL byte pair cannot appear in Markdown source, so the substitution can never hit body text.
 */
export const MARKDOWN_UID_PLACEHOLDER = "\u0000md-uid\u0000";

export interface MarkdownRenderEnv extends Env {
  /** Repository root, for resolving a relative link to a workspace file. */
  workspacePath?: string;
  /** The directory of the document being previewed; empty means "the reader is at the repository". */
  baseDir?: string;
  /** Per-render heading-slug dedup. Cleared at the start of every render. */
  slugCounts: Map<string, number>;
}

/**
 * Measured in both engines (WebKit = the one this app renders with, plus Blink as
 * control): a bare text cell ignores max-width on <th>/<td> - WebKit laid the column
 * out at 490px for a 340px cap. A block child inside the cell fixes it (340px in both
 * engines). So every cell gets one wrapper and the ceiling lives on that wrapper.
 * A column floor is only useful on cells that actually hold prose: applied to "Go" or
 * "1.26.1" it inflates a two-column value table to hundreds of pixels of dead space.
 * CSS cannot express "floor, but never above the content" - min(340px, max-content)
 * computes to 0px in both engines (re-measured 2026-09-25: min(max-content, 100cqi/cols)
 * leaves a label column at 41px), so the renderer decides from the cell's own text.
 */
const WIDE_CELL_MIN_CHARS = 24;
// Short labels ("持仓", "科大讯飞", "❌ 第三次点名") have no soft-wrap opportunity either,
// and auto table layout squeezes them to one glyph per line as soon as the prose
// columns need the room. Under this many codepoints the cell is cheap enough to keep
// on a single line unconditionally, so it never has to be floored by a percentage.
const NOWRAP_MAX_CHARS = 8;

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false });
const defaultValidateLink = markdown.validateLink.bind(markdown);
const originalLinkOpen = markdown.renderer.rules.link_open;

markdown.renderer.rules.heading_open = (tokens, index, options, env, self) => {
  const inline = tokens[index + 1];
  const slugCounts = (env as MarkdownRenderEnv).slugCounts;
  tokens[index].attrSet("id", `${MARKDOWN_UID_PLACEHOLDER}-${uniqueHeadingSlug(slugCounts, inline?.type === "inline" ? inline.content : "")}`);
  return self.renderToken(tokens, index, options);
};

markdown.validateLink = (url) => /^file:/i.test(url) || defaultValidateLink(url);

// The transcript draws an ordered list's number itself instead of letting the browser place it, so
// that the digits sit in a bounded, centred column - see `.markdown-body ol` in workbench.css for the
// measurements. Two attributes have to travel with the <ol> for that to be correct rather than
// merely pretty:
// - `--md-ol-start`: markdown-it emits `<ol start="8">` for a list written to begin at 8, and
//   `counter-increment` knows nothing about that attribute, so without this the numbers restart at 1.
// - `role="list"`: WebKit drops the list semantics of an <ol>/<ul> whose `list-style` is none, which
//   would silently cost VoiceOver the item count on every numbered answer.
markdown.renderer.rules.ordered_list_open = (tokens, index, options, _env, self) => {
  const start = Number(tokens[index].attrGet("start") ?? "1");
  const offset = Number.isInteger(start) && start > 1 ? start - 1 : 0;
  tokens[index].attrSet("role", "list");
  if (offset) tokens[index].attrSet("style", `--md-ol-start:${offset}`);
  return self.renderToken(tokens, index, options);
};

type CellTokens = Parameters<NonNullable<typeof markdown.renderer.rules.td_open>>[0];

function tableColumnCount(tokens: CellTokens, index: number): number {
  let columns = 0;
  for (let i = index + 1; i < tokens.length && tokens[i].type !== "tr_close"; i++) {
    if (tokens[i].type === "th_open" || tokens[i].type === "td_open") columns++;
  }
  return Math.max(columns, 1);
}

function cellFitClass(tokens: CellTokens, index: number): string {
  const inline = tokens[index + 1];
  if (!inline || inline.type !== "inline") return "";
  const chars = Array.from(inline.content ?? "").length;
  if (chars >= WIDE_CELL_MIN_CHARS) return " is-wide";
  return chars <= NOWRAP_MAX_CHARS ? " is-nowrap" : "";
}

// markdown-it emits bare <table>. A table can only scroll sideways if some box
// around it owns the overflow, and a <table> cannot be that box without losing
// its own table layout (see .markdown-table-scroll in layout.css). So every
// rendered table gets a scroll wrapper here, in the one place markdown becomes
// HTML, which also keeps streamed reasoning and file previews on the same shape.
// The column count travels with the table because the cell floor in layout.css has
// to divide the pane by it: an absolute floor on every prose cell summed past the
// reading axis on wide tables (8 columns x 200px in a 880px pane), so the table
// overflowed and the label columns were left with one glyph per line.
markdown.renderer.rules.table_open = (tokens, index, options, _env, self) =>
  `<div class="markdown-table-scroll" style="--markdown-table-cols:${tableColumnCount(tokens, index)}">${self.renderToken(tokens, index, options)}`;
markdown.renderer.rules.table_close = (tokens, index, options, _env, self) =>
  `${self.renderToken(tokens, index, options)}</div>`;

markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  const rawHref = tokens[index].attrGet("href");
  const href = typeof rawHref === "string" ? rawHref : String(rawHref ?? "");
  const linkEnvironment = (environment ?? {}) as { workspacePath?: string; baseDir?: string };
  const file = resolveWorkspaceFileLink(href, String(linkEnvironment.workspacePath ?? ""), String(linkEnvironment.baseDir ?? ""));
  if (file) {
    tokens[index].attrSet("href", "#");
    tokens[index].attrSet("class", "markdown-file-link");
    tokens[index].attrSet("title", file.absolutePath);
    tokens[index].attrSet("data-file-path", file.relativePath);
    tokens[index].attrSet("data-file-absolute", file.absolutePath);
    tokens[index].attrSet("data-file-name", file.name);
    if (file.line) tokens[index].attrSet("data-file-line", String(file.line));
    if (file.anchor) tokens[index].attrSet("data-file-anchor", file.anchor);
  } else if (/^(https?:)\/\//i.test(href)) {
    // Web links route to the managed browser panel; the click handler in MarkdownBody prevents
    // default and falls back to the system browser on failure.
    tokens[index].attrSet("class", "markdown-web-link");
  } else if (/^(mailto:|tel:)/i.test(href)) {
    tokens[index].attrSet("target", "_blank");
    tokens[index].attrSet("rel", "noopener noreferrer");
  } else if (!href.startsWith("#")) {
    tokens[index].attrSet("href", "#");
  }
  return originalLinkOpen
    ? originalLinkOpen(tokens, index, options, environment, renderer)
    : renderer.renderToken(tokens, index, options);
};

markdown.renderer.rules.th_open = (tokens, index, options, _env, self) =>
  `${self.renderToken(tokens, index, options)}<div class="markdown-cell${cellFitClass(tokens, index)}">`;
markdown.renderer.rules.td_open = (tokens, index, options, _env, self) =>
  `${self.renderToken(tokens, index, options)}<div class="markdown-cell${cellFitClass(tokens, index)}">`;
markdown.renderer.rules.th_close = (tokens, index, options, _env, self) =>
  `</div>${self.renderToken(tokens, index, options)}`;
markdown.renderer.rules.td_close = (tokens, index, options, _env, self) =>
  `</div>${self.renderToken(tokens, index, options)}`;

/** Plain render, no cache: the source of truth for what a cached entry holds. */
export function renderMarkdownHtml(text: string, env: MarkdownRenderEnv): string {
  env.slugCounts.clear();
  return markdown.render(normalizeMarkdownBreakTags(text), env);
}

export type MarkdownRender = (text: string, env: MarkdownRenderEnv) => string;

export interface MarkdownRenderCacheStats {
  entries: number;
  chars: number;
  hits: number;
  misses: number;
}

/**
 * An LRU over rendered HTML, capped by the HTML's own length (a JS string is 2 bytes per code
 * unit, so the default budget of 6M chars is ~12MB - inside the 8-16MB this was scoped to).
 * The cap is not decoration: an unbounded cache of 1MiB documents is how a WebContent process gets
 * a memory-pressure kill, and a Map that only grows turns every re-render of a streaming block into
 * a permanent leak.
 */
export function createMarkdownRenderCache(render: MarkdownRender, charBudget = 6_000_000) {
  const entries = new Map<string, string>();
  let chars = 0;
  let hits = 0;
  let misses = 0;
  const key = (text: string, env: MarkdownRenderEnv) =>
    `${env.workspacePath ?? ""}\u0000${env.baseDir ?? ""}\u0000${text}`;
  return {
    /** The cached HTML *with* the uid placeholder still in it - `renderMarkdownDocument` owns the
     *  substitution, so one cache entry can serve every instance that renders the same text. */
    render(text: string, env: MarkdownRenderEnv): string {
      const cacheKey = key(text, env);
      const cached = entries.get(cacheKey);
      if (cached !== undefined) {
        hits += 1;
        // Re-insert on hit so the oldest end of the Map is the least recently used entry.
        entries.delete(cacheKey);
        entries.set(cacheKey, cached);
        return cached;
      }
      misses += 1;
      const html = render(text, env);
      while (chars + html.length > charBudget && entries.size > 0) {
        const oldest = entries.keys().next().value as string;
        chars -= entries.get(oldest)?.length ?? 0;
        entries.delete(oldest);
      }
      entries.set(cacheKey, html);
      chars += html.length;
      return html;
    },
    get stats(): MarkdownRenderCacheStats {
      return { entries: entries.size, chars, hits, misses };
    },
    clear(): void {
      entries.clear();
      chars = 0;
      hits = 0;
      misses = 0;
    },
  };
}

/**
 * At or above this many characters a remount is worth a lookup: the parse costs about
 * 0.12ms per 1k characters, so 40k chars is ~5ms of a 17ms frame - and a virtualized scroll
 * remounts rows continuously. Below it the lookup would cost more attention than it saves.
 */
export const MARKDOWN_CACHE_MIN_CHARS = 40_000;

export const markdownRenderCache = createMarkdownRenderCache(renderMarkdownHtml);

/**
 * The one call a Markdown host makes: render `text` for the instance named by `uid`.
 *
 * `cacheable` is false for a block that is still arriving. A streaming block re-renders every frame
 * with a slightly longer string, so every frame would be a cache miss that also evicts real entries -
 * the cache would hold nothing but dead intermediate HTML.
 */
export function renderMarkdownDocument(text: string, env: MarkdownRenderEnv, uid: string, cacheable = true): string {
  const html = cacheable && text.length >= MARKDOWN_CACHE_MIN_CHARS
    ? markdownRenderCache.render(text, env)
    : renderMarkdownHtml(text, env);
  return html.includes(MARKDOWN_UID_PLACEHOLDER)
    ? html.replaceAll(MARKDOWN_UID_PLACEHOLDER, uid)
    : html;
}