import layoutFile from "./layout.css?inline";
import { describe, expect, it } from "vitest";

async function readStyle(name: string): Promise<string> {
  const moduleName = ["node", "fs/promises"].join(":");
  const { readFile } = await import(/* @vite-ignore */ moduleName) as {
    readFile(path: string, encoding: "utf8"): Promise<string>;
  };
  return (await readFile(`src/styles/${name}`, "utf8")).replace(/\r\n?/g, "\n");
}

async function layoutText(): Promise<string> {
  if (layoutFile.includes(".workspace-shell")) return layoutFile.replace(/\r\n?/g, "\n");
  return readStyle("layout.css");
}

async function tokensText(): Promise<string> {
  return readStyle("tokens.css");
}

function ruleBodies(layout: string, selector: string): string[] {
  const result: string[] = [];
  let cursor = 0;
  while (cursor < layout.length) {
    const open = layout.indexOf("{", cursor);
    if (open < 0) break;
    const close = layout.indexOf("}", open + 1);
    if (close < 0) break;
    const previousClose = layout.lastIndexOf("}", open - 1);
    // Comments before a selector are documentation, not part of the selector.
    const candidate = layout.slice(previousClose + 1, open).replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (candidate === selector) result.push(layout.slice(open + 1, close));
    cursor = close + 1;
  }
  return result;
}

function firstRuleBody(layout: string, selector: string): string {
  const body = ruleBodies(layout, selector)[0];
  if (body === undefined) throw new Error(`Missing CSS rule: ${selector}`);
  return body;
}

describe("application rail alignment", () => {
  it("keeps the browser flush and centers the empty-page icon", async () => {
    const layout = await layoutText();
    expect(firstRuleBody(layout, ".inspector-content.browser-panel")).toMatch(/padding:\s*0/);
    expect(firstRuleBody(layout, ".browser-toolbar")).toContain("var(--bg-settings)");
    expect(firstRuleBody(layout, ".browser-toolbar .browser-address")).toContain("var(--bg-card)");
    expect(firstRuleBody(layout, ".browser-empty > svg")).toMatch(/margin:\s*0 auto 24px/);
  });
  it("pins both workspace rails to the same grid row without a top offset", async () => {
    const layout = await layoutText();
    const shared = firstRuleBody(layout, `.workspace-shell,
.inspector`);
    expect(shared).toMatch(/margin-top:\s*0/);
    expect(shared).toMatch(/grid-row:\s*2/);
    expect(firstRuleBody(layout, ".workspace-shell")).toMatch(/grid-column:\s*2/);
    expect(firstRuleBody(layout, ".inspector")).toMatch(/grid-column:\s*3/);
    expect(firstRuleBody(layout, ".inspector")).not.toMatch(/margin-top/);
    expect(ruleBodies(layout, ".inspector").some((body) => /margin-top:\s*[1-9]/.test(body))).toBe(false);
  });
});

describe("file preview density", () => {
  it("compacts the structural file preview and keeps its gutter flush", async () => {
    const layout = await layoutText();
    expect(firstRuleBody(layout, ".inspector")).toMatch(/grid-template-rows:\s*34px minmax\(0, 1fr\)/);
    expect(firstRuleBody(layout, ".inspector-header")).toMatch(/min-height:\s*34px/);
    expect(firstRuleBody(layout, ".inspector-file-header.file-preview-toolbar")).toMatch(/height:\s*49px/);
    expect(layout).toMatch(/\.inspector-tabs button\s*{[^}]*display:\s*flex[^}]*align-items:\s*center/s);
    expect(layout).toMatch(/\.inspector\.is-code-view\s*{[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/s);
    expect(layout).toMatch(/\.file-preview-row\s*{[^}]*grid-template-columns:\s*48px max-content/s);
    expect(firstRuleBody(layout, ".file-preview-content")).toMatch(/padding:\s*0 0 12px/);
    expect(layout).toMatch(/\.file-preview-line-number\s*{[^}]*padding:\s*0 14px 0 0[^}]*text-align:\s*right/s);
    expect(layout).toMatch(/\.file-preview-line-text\s*{[^}]*padding:\s*0 12px/s);
    expect(layout).toContain(":is(.file-preview-content, .diff-line-text)");
    expect(firstRuleBody(layout, ".diff-section pre")).toMatch(/padding:\s*0 0 12px/);
    expect(firstRuleBody(layout, ".diff-section pre > code")).toMatch(/display:\s*block[^}]*width:\s*max-content[^}]*min-width:\s*100%/s);
    expect(layout).toMatch(/\.diff-line\s*{[^}]*grid-template-columns:\s*48px max-content/s);
    expect(layout).toContain('data-code-wrap="wrap"');
  });

  it("uses the sampled ZCode spreadsheet geometry", async () => {
    const layout = await layoutText();
    expect(firstRuleBody(layout, ".file-spreadsheet-preview")).toMatch(/background:\s*var\(--sheet-bg\)/);
    expect(firstRuleBody(layout, ".spreadsheet-scroll")).toMatch(/overflow:\s*auto/);
    expect(firstRuleBody(layout, ".spreadsheet-grid")).toMatch(/border-spacing:\s*0/);
    expect(layout).toMatch(/\.spreadsheet-grid th,[^}]*height:\s*24px[^}]*padding:\s*0 8px[^}]*border-right:\s*1px solid var\(--sheet-border\)/s);
    expect(firstRuleBody(layout, ".spreadsheet-grid thead th")).toMatch(/position:\s*sticky[^}]*min-width:\s*120px/s);
    expect(firstRuleBody(layout, ".spreadsheet-grid tbody th")).toMatch(/width:\s*44px[^}]*min-width:\s*44px/s);
    expect(firstRuleBody(layout, ".spreadsheet-tabs")).toMatch(/min-height:\s*36px[^}]*overflow-x:\s*auto/s);
  });
});

describe("conversation scroll rail", () => {
  it("places the quick-jump outline on the left and the scrollbar on the far right", async () => {
    const layout = await layoutText();
    const timeline = firstRuleBody(layout, ".timeline");
    expect(timeline).toMatch(/overflow-y:\s*auto/);
    expect(timeline).toMatch(/max-width:\s*none/);
    expect(timeline).toMatch(/scrollbar-width:\s*auto/);
    expect(timeline).toMatch(/scrollbar-gutter:\s*stable/);
    expect(timeline).not.toMatch(/scrollbar-color:/);
    expect(ruleBodies(layout, ".timeline::-webkit-scrollbar")).toHaveLength(0);
    expect(ruleBodies(layout, ".timeline::-webkit-scrollbar-track")).toHaveLength(0);
    expect(ruleBodies(layout, ".timeline::-webkit-scrollbar-thumb")).toHaveLength(0);
    const outline = firstRuleBody(layout, ".conversation-outline");
    expect(outline).toMatch(/left:\s*8px/);
    expect(outline).not.toMatch(/right:/);
    expect(firstRuleBody(layout, ".conversation-outline-preview")).toMatch(/left:\s*40px/);
  });
});

describe("reasoning window and tail control", () => {
  it("gives live reasoning a fixed height so streaming cannot push the answer down", async () => {
    const layout = await layoutText();
    const panel = firstRuleBody(layout, ".thinking-block .thinking-body");
    expect(panel).toMatch(/max-height:\s*300px/);
    expect(panel).toMatch(/overflow:\s*auto/);
    expect(firstRuleBody(layout, ".thinking-block .thinking-body.is-live")).toMatch(/height:\s*168px/);
  });

  it("gives a running call's output a constant window instead of a growing one", async () => {
    const layout = await layoutText();
    const window = firstRuleBody(layout, `.tool-call[data-state="running"] .tool-output`);
    expect(window).toMatch(/height:\s*132px/);
    expect(window).toMatch(/max-height:\s*none/);
    expect(firstRuleBody(layout, ".tool-call pre")).toMatch(/max-height:\s*280px/);
  });

  it("floats the jump-to-latest control above the composer overlay reserve", async () => {
    const layout = await layoutText();
    const jump = firstRuleBody(layout, ".timeline-jump-latest");
    expect(jump).toMatch(/position:\s*absolute/);
    expect(jump).toMatch(/bottom:\s*calc\(var\(--composer-overlay-reserve\) \+ 16px\)/);
    expect(jump).toMatch(/transform:\s*translateX\(-50%\)/);
    expect(jump).not.toMatch(/\btop:/);
  });
});

describe("message editor theme colors", () => {
  it("restores Markdown list markers after the global CSS reset", async () => {
    const layout = await layoutText();
    expect(firstRuleBody(layout, ".markdown-body ol")).toMatch(/list-style-type:\s*decimal/);
    expect(firstRuleBody(layout, ".markdown-body ul")).toMatch(/list-style-type:\s*disc/);
  });

  it("scrolls wide Markdown tables sideways instead of stacking one glyph per line", async () => {
    const layout = await layoutText();
    const scroll = firstRuleBody(layout, ".markdown-body .markdown-table-scroll");
    expect(scroll).toMatch(/max-width:\s*100%/);
    expect(scroll).toMatch(/overflow-x:\s*auto/);
    const table = firstRuleBody(layout, ".markdown-body table");
    expect(table).toMatch(/width:\s*max-content/);
    // Clamped to the pane on the upper side only: min-width:100% stretched a table of
    // short values into two huge empty columns.
    expect(table).toMatch(/max-width:\s*100%/);
    expect(table).not.toMatch(/min-width/);
    // display:block on the table itself is what squeezed CJK cells into vertical text.
    expect(table).not.toMatch(/display:/);
    expect(table).not.toMatch(/overflow/);
    const cell = firstRuleBody(layout, ".markdown-body .markdown-cell");
    // break-word, not anywhere: `anywhere` feeds back into min-content and lets a
    // short identifier column collapse to one glyph per line.
    expect(cell).toMatch(/overflow-wrap:\s*break-word/);
    expect(cell).not.toMatch(/min-width/);
    // The floor is opt-in per cell, so "Go | 1.26.1" keeps its natural width.
    const wide = firstRuleBody(layout, ".markdown-body .markdown-cell.is-wide");
    expect(wide).toMatch(/min-width:\s*var\(--markdown-cell-wrap-min\)/);
    expect(wide).toMatch(/overflow-wrap:\s*anywhere/);
    // The floor is a token, so themes/densities can retune it in one place.
    expect(await tokensText()).toMatch(/--markdown-cell-wrap-min:\s*200px/);
    // And it must not move onto the cell itself — WebKit ignores width there.
    expect(firstRuleBody(layout, ".markdown-body th,\n.markdown-body td")).not.toMatch(/max-width/);
    expect(firstRuleBody(layout, ".markdown-body th,\n.markdown-body td")).not.toMatch(/min-width/);
    // Code blocks keep their own alignment instead of re-wrapping box-drawing output.
    expect(firstRuleBody(layout, ".markdown-body pre")).toMatch(/white-space:\s*pre;/);
    expect(firstRuleBody(layout, ".oversized-message")).toMatch(/white-space:\s*pre-wrap/);
  });

  it("uses defined foreground and background tokens in light and dark themes", async () => {
    const layout = await layoutText();
    expect(firstRuleBody(layout, ".message-edit textarea")).toMatch(/background:\s*var\(--bg-raised\)/);
    expect(firstRuleBody(layout, ".message-edit textarea")).toMatch(/color:\s*var\(--text\)/);
    expect(firstRuleBody(layout, ".message-edit-button--primary")).toMatch(/color:\s*var\(--text-inverse\)/);
  });
});

describe("settings management surfaces", () => {
  it("keeps the MCP page on the shared settings background", async () => {
    const layout = await layoutText();
    expect(layout).toMatch(/\.mcp-config-content\s*{[^}]*background:\s*var\(--bg-settings\)/s);
  });
});

describe("skill invocation messages", () => {
  it("renders skill metadata as a compact row that cannot expand the user bubble", async () => {
    const layout = await layoutText();
    const invocation = firstRuleBody(layout, ".message-skill-invocation");
    expect(invocation).toMatch(/display:\s*flex/);
    expect(invocation).toMatch(/min-width:\s*0/);
    expect(firstRuleBody(layout, ".message-skill-invocation > code")).toMatch(/text-overflow:\s*ellipsis/);
  });
});

describe("streamed assistant output alignment", () => {
  it("cancels the execution panel indent for intermediate assistant text", async () => {
    const layout = await layoutText();
    const output = firstRuleBody(layout, ".execution-process-details > .markdown-body");
    expect(output).toMatch(/margin-left:\s*-4px/);
    expect(output).toMatch(/padding:\s*4px 0/);
    expect(firstRuleBody(layout, ".execution-process > summary")).toMatch(/background:\s*var\(--bg-card\)/);
    expect(firstRuleBody(layout, ".composer")).toMatch(/background:\s*var\(--bg-composer\)/);
  });
});

describe("assistant request status", () => {
  it("keeps retry and failure notices attached to the message without card styling", async () => {
    const layout = await layoutText();
    const notice = firstRuleBody(layout, ".message-run-notice");
    expect(notice).toMatch(/display:\s*grid/);
    expect(notice).toMatch(/grid-template-columns:\s*16px minmax\(0, 1fr\)/);
    expect(notice).toMatch(/border-top:\s*1px solid var\(--border\)/);
    expect(notice).not.toMatch(/border-radius|box-shadow|background/);
    expect(firstRuleBody(layout, '.message-run-notice[data-status="recovered"]')).toMatch(/color:\s*var\(--green\)/);
    expect(firstRuleBody(layout, '.message-run-notice[data-status="failed"]')).toMatch(/color:\s*var\(--red\)/);
  });
});

describe("assistant output waiting indicator", () => {
  it("keeps the spinner on the conversation content axis without a visible label", async () => {
    const layout = await layoutText();
    const status = firstRuleBody(layout, ".waiting-for-output");
    expect(status).toMatch(/width:\s*100%/);
    expect(status).toMatch(/justify-content:\s*flex-start/);
    expect(status).toMatch(/margin:\s*0/);
    expect(status).not.toMatch(/margin:\s*0\s+auto/);
  });
});

describe("session list state indicators", () => {
  it("uses process state for bold text and separate output and unread markers", async () => {
    const layout = await layoutText();
    expect(firstRuleBody(layout, ".thread-title.is-started")).toMatch(/font-weight:\s*650/);
    expect(firstRuleBody(layout, ".thread-status")).toMatch(/animation:\s*spin/);
    expect(firstRuleBody(layout, ".thread-unread")).toMatch(/background:\s*var\(--blue\)/);
    expect(layout).not.toContain(".thread-title.is-unread");
  });
});

describe("composer todo and queue stack", () => {
  it("keeps todo and queue narrower than the composer with zero vertical gaps", async () => {
    const layout = await layoutText();
    const stackPanel = firstRuleBody(layout, ".composer-stack-panel");
    expect(stackPanel).toMatch(/width:\s*min\(calc\(var\(--composer-max-width\) - var\(--composer-stack-total-inset\)\), calc\(100% - var\(--composer-stack-total-inset\)\)\)/);
    const queue = firstRuleBody(layout, ".queue-panel");
    expect(queue).toMatch(/margin-bottom:\s*0/);
    expect(queue).toMatch(/border-bottom:\s*0/);
    expect(queue).toMatch(/box-shadow:\s*none/);
    expect(firstRuleBody(layout, ".retry-banner")).toMatch(/margin-bottom:\s*8px/);
    expect(ruleBodies(layout, ".retry-banner").find((body) => body.includes("align-items"))).toMatch(/align-items:\s*center/);
    expect(firstRuleBody(layout, ".retry-banner button")).toMatch(/align-self:\s*center/);
    expect(firstRuleBody(layout, ".extension-widget")).toMatch(/margin-bottom:\s*8px/);
  });

  it("uses the agreed compact row, image, scrolling, progress, and motion budgets", async () => {
    const layout = await layoutText();
    expect(firstRuleBody(layout, ".queue-list")).toMatch(/max-height:\s*128px/);
    expect(firstRuleBody(layout, ".queue-row")).toMatch(/min-height:\s*32px/);
    expect(firstRuleBody(layout, ".queue-thumbnail")).toMatch(/width:\s*24px[\s\S]*height:\s*24px/);
    expect(firstRuleBody(layout, ".pi-desk-todo-list")).toMatch(/max-height:\s*160px/);
    expect(firstRuleBody(layout, ".pi-desk-todo-row")).toMatch(/height:\s*32px/);
    expect(firstRuleBody(layout, ".pi-desk-todo-progress")).toMatch(/height:\s*2px/);
    expect(layout).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

describe("batch extension questions", () => {
  it("uses a bounded wide dialog with scrollable tabs and full-width option cards", async () => {
    const layout = await layoutText();
    expect(firstRuleBody(layout, ".batch-extension-dialog")).toMatch(/width:\s*min\(720px, 100%\)/);
    expect(firstRuleBody(layout, ".batch-question-tabs")).toMatch(/overflow-x:\s*auto/);
    expect(firstRuleBody(layout, ".batch-question-options > button")).toMatch(/grid-template-columns:\s*16px minmax\(0, 1fr\)/);
    expect(firstRuleBody(layout, ".batch-question-review-item div > span")).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe("model menu stability", () => {
  it("keeps selected model and thinking options distinct from hover", async () => {
    const layout = await layoutText();
    expect(layout).toMatch(/\.model-menu button\[aria-checked="true"\],[\s\S]*\.thinking-level-grid button\[aria-checked="true"\]\s*\{[^}]*background:\s*var\(--bg-selected\) !important/);
    expect(layout).toMatch(/\.model-menu button:hover[^}]*\{[^}]*background:\s*var\(--bg-hover\)/);
  });

  it("keeps the popup height fixed while model capabilities refresh", async () => {
    const layout = await layoutText();
    const menu = firstRuleBody(layout, ".model-menu");
    expect(menu).toMatch(/display:\s*flex/);
    expect(menu).toMatch(/height:\s*min\(360px,\s*calc\(100vh - 96px\)\)/);
    expect(menu).not.toMatch(/max-height/);
    expect(firstRuleBody(layout, ".model-menu-options")).toMatch(/flex:\s*1 1 auto/);
    expect(firstRuleBody(layout, ".thinking-level-grid")).toMatch(/min-height:\s*62px/);
  });
});

describe("repository file tree hierarchy", () => {
  it("indents by nesting so each level draws its own guide line", async () => {
    const layout = await layoutText();
    const children = firstRuleBody(layout, ".file-tree-children");
    expect(children).toMatch(/margin-left:\s*7px/);
    expect(children).toMatch(/padding-left:\s*5px/);
    expect(children).toMatch(/border-left:\s*1px solid var\(--border\)/);
    // The row must stop carrying a depth-based padding: the nesting is what positions it now.
    expect(firstRuleBody(layout, ".file-tree-row")).not.toMatch(/--tree-depth/);
    // Nothing may read the variable any more (prose in comments is fine).
    expect(layout).not.toMatch(/var\(--tree-depth\)/);
  });

  it("keeps the row on the grid columns the tree was designed around", async () => {
    const layout = await layoutText();
    const row = firstRuleBody(layout, ".file-tree-row");
    expect(row).toMatch(/display:\s*grid/);
    expect(row).toMatch(/grid-template-columns:\s*18px 16px minmax\(0, 1fr\) 22px 26px/);
    expect(row).toMatch(/color:\s*var\(--text-muted\)/);
    expect(firstRuleBody(layout, ".file-tree-row:hover")).toMatch(/color:\s*var\(--text-secondary\)/);
  });

  it("keeps a visible scrollbar on the long file list", async () => {
    const layout = await layoutText();
    const tree = firstRuleBody(layout, ".file-tree");
    // The list holds up to 5000 rows now; the platform overlay scrollbar hides itself until you
    // scroll, which reads as "the list cannot scroll". Same treatment the terminal viewport uses.
    expect(tree).toMatch(/overflow-y:\s*auto/);
    expect(tree).toMatch(/scrollbar-width:\s*thin/);
    expect(tree).toMatch(/scrollbar-color:\s*var\(--border-strong\) transparent/);
  });
});

describe("draft editor base styles", () => {
  it("keeps the two ProseMirror rules that decide how a draft paints", async () => {
    const text = await layoutText();
    // prosemirror-view ships style/prosemirror.css but the host has to include it: without
    // `white-space` the browser collapses a draft's trailing spaces, and the separator <img>
    // ProseMirror inserts beside a line break inherits the app's generic image sizing. Both were
    // adding a line box to the composer that no text change explained.
    expect(text).toMatch(/\.markdown-editor \.ProseMirror\s*\{[^}]*white-space:\s*pre-wrap[^}]*white-space:\s*break-spaces/s);
    expect(text).toMatch(/img\.ProseMirror-separator\s*\{[^}]*display:\s*inline !important/s);
  });
});

describe("transcript line breaks", () => {
  it("does not let a rendered <br> break the line twice", async () => {
    const text = await layoutText();
    // MarkdownBody renders with `breaks: true`, so markdown-it already emitted a <br> for every
    // soft break and left the literal newline in the text node. If a paragraph inherits
    // white-space: pre-wrap again, one Shift+Enter in the composer paints as a blank line.
    const paragraph = text.match(/\.markdown-body p\s*\{[^}]*\}/s)?.[0] ?? "";
    expect(paragraph).toContain("white-space: normal");
    const message = text.match(/\.message-content p\s*\{[^}]*\}/s)?.[0] ?? "";
    expect(message).toContain("white-space: pre-wrap");
    expect(text.indexOf(".markdown-body p")).toBeGreaterThan(text.indexOf(".message-content p"));
  });
});
