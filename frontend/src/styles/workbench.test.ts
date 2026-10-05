import workbenchFile from "./workbench.css?inline";
import { describe, expect, it } from "vitest";

async function workbenchText(): Promise<string> {
  if (workbenchFile.includes(".app-shell")) return workbenchFile.replace(/\r\n?/g, "\n");
  const moduleName = ["node", "fs/promises"].join(":");
  const { readFile } = await import(/* @vite-ignore */ moduleName) as {
    readFile(path: string, encoding: "utf8"): Promise<string>;
  };
  return (await readFile("src/styles/workbench.css", "utf8")).replace(/\r\n?/g, "\n");
}

async function topbarText(): Promise<string> {
  return vueText("src/components/AppTopbar.vue");
}

async function textAt(path: string): Promise<string> {
  const moduleName = ["node", "fs/promises"].join(":");
  const { readFile } = await import(/* @vite-ignore */ moduleName) as {
    readFile(path: string, encoding: "utf8"): Promise<string>;
  };
  return (await readFile(path, "utf8")).replace(/\r\n?/g, "\n");
}

async function vueText(path: string): Promise<string> {
  return textAt(path);
}

// Tailwind utilities that emit `display: … !important` under `@import "tailwindcss" important`.
const DISPLAY_UTILS = new Set(["grid", "flex", "inline-flex", "inline-grid", "block", "inline-block", "table", "inline", "contents"]);

function hiddenTargets(css: string): Set<string> {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const names = new Set<string>();
  for (const rule of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/display:\s*none/.test(rule[2])) continue;
    for (const sel of rule[1].split(",")) {
      const rightmost = sel.trim().split(/\s+/).pop() ?? "";
      const last = rightmost.match(/\.([a-z0-9_-]+)(?![\w-])/);
      if (last) names.add(last[1]);
    }
  }
  return names;
}

describe("responsive workbench layout", () => {
  it("keeps the dynamic workbench out of the shell grid flow", async () => {
    const css = await workbenchText();
    expect(css).toMatch(/\.inspector\.panel-workbench\s*{[^}]*position:\s*absolute[^}]*display:\s*flex/s);
    expect(css).toMatch(/\.app-shell\.is-inspector-expanded \.panel-workbench\s*{[^}]*width:\s*auto/s);
    expect(css).toMatch(/\.panel-body\.has-tree\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(160px, 32%\)/s);
  });
  it("uses one application topbar and a two-column shell", async () => {
    const css = await workbenchText();
    expect(css).toMatch(/--topbar-height:\s*44px/);
    expect(css).toMatch(/\.app-menubar\s*{\s*display:\s*none/);
    expect(css).toMatch(/\.topbar\s*{[^}]*background:\s*var\(--bg-conversation\)/s);
    expect(css).toMatch(/grid-template-columns:\s*var\(--sidebar-width\) minmax\(0, 1fr\)/);
    expect(css).toMatch(/grid-template-rows:\s*var\(--topbar-height\) minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.inspector\s*{[^}]*grid-template-rows:\s*34px minmax\(0, 1fr\)/s);
    expect(css).toMatch(/\.inspector-header\s*{[^}]*min-height:\s*34px/s);
  });

  it("keeps the brand cell clear of the macOS traffic lights", async () => {
    const css = await workbenchText();
    expect(css).toMatch(/--traffic-light-inset:\s*78px/);
    expect(css).toMatch(/\.app-shell\.is-mac \.topbar-brand\s*{[^}]*padding-left:\s*var\(--traffic-light-inset\)/s);
    expect(css).toMatch(/\.app-shell\.is-mac\.is-sidebar-collapsed \.topbar-brand\s*{[^}]*padding-left:\s*0/s);
  });

  it("keeps the removed topbar chrome out of both the template and the stylesheet", async () => {
    const css = await workbenchText();
    const topbar = await topbarText();
    // 3271ac4 deleted the "Pi" mark and the back/forward buttons from the template but left the rules
    // that served them - and left a test asserting the span was still there, which is why this suite
    // was red. The cascade trap this test used to demonstrate (a Tailwind display utility on the
    // element would beat any unlayered `display: none`, because `tailwind.css` imports the framework
    // `important`) is still covered by the next test, against the elements that do exist.
    expect(topbar).not.toMatch(/topbar-brand-mark|topbar-history/);
    expect(css).not.toMatch(/\.topbar-brand-mark|\.topbar-history/);
  });

  it("leaves display utilities off every element the workbench stylesheet hides", async () => {
    const css = await workbenchText();
    const sources = await Promise.all([
      vueText("src/components/AppTopbar.vue"),
      vueText("src/components/AppSidebar.vue"),
      vueText("src/App.vue"),
    ]);
    const hidden = hiddenTargets(css);
    expect(hidden.has("workspace-chip"), "fixture: workspace-chip must still be a hide target").toBe(true);
    const offenders = new Set<string>();
    sources.forEach((text, index) => {
      for (const match of text.matchAll(/class="([^"]*)"/g)) {
        const tokens = match[1].trim().split(/\s+/);
        const displays = tokens.filter((token) => DISPLAY_UTILS.has(token));
        if (!displays.length) continue;
        for (const token of tokens) {
          if (hidden.has(token)) offenders.add(`${["AppTopbar", "AppSidebar", "App"][index]}.${token} carries ${displays.join("|")}`);
        }
      }
    });
    expect([...offenders]).toEqual([]);
  });

  it("styles the workspace application control as a compact split button", async () => {
    const css = await workbenchText();
    expect(css).toMatch(/\.workspace-application-split\s*{[^}]*display:\s*inline-flex[^}]*border:\s*1px solid/s);
    expect(css).toMatch(/\.workspace-application-toggle\s*{[^}]*border-left:\s*1px solid/s);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.topbar-actions \.workspace-application-anchor\s*{\s*display:\s*none/);
  });

  it("lets the topbar title take the free width instead of a fixed cap", async () => {
    const css = await workbenchText();
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, ""); // the comment in that rule quotes the old cap
    const topbar = await topbarText();
    // `.topbar-title-group > strong` is the authoritative rule (the same selector without `>` also
    // exists in layout.css for the font axes - the child combinator is what wins here).
    const strong = rules.match(/\.topbar-title-group > strong\s*{([^}]*)}/);
    expect(strong, "missing .topbar-title-group > strong").not.toBeNull();
    expect(strong![1]).toMatch(/flex:\s*0 1 auto/);
    expect(strong![1]).toMatch(/min-width:\s*0/);
    expect(strong![1]).not.toMatch(/max-width/);
    // The chip keeps its size; the title is the flexible one.
    expect(rules).toMatch(/\.workspace-chip\s*{[^}]*flex-shrink:\s*0/s);
    const title = topbar.match(/<strong class="([^"]*)" :title="appStore\.activePage === 'scheduledTasks'/);
    expect(title, "topbar title <strong> not found in AppTopbar.vue").not.toBeNull();
    // AGENTS.md §4.2: layout belongs to the stylesheet - and every utility here ships `!important`,
    // so a leftover `max-w-[…]` would silently beat the CSS again.
    expect(title![1]).not.toMatch(/min-w-0|max-w-|truncate/);
  });

  it("keeps the reading and composer axes bounded", async () => {
    const css = await workbenchText();
    expect(css).toMatch(/--conversation-content-width:\s*880px/);
    expect(css).toMatch(/\.conversation-pane\s*{[^}]*--bg-workspace:\s*var\(--bg-conversation\)/s);
    expect(css).toMatch(/--composer-overlay-reserve:\s*0px/);
    expect(css).toMatch(/\.conversation-scroll-region\s*{[^}]*grid-column:\s*1[^}]*grid-row:\s*1 \/ -1/s);
    expect(css).toMatch(/\.timeline\s*{[^}]*width:\s*100%[^}]*padding:\s*24px var\(--conversation-inline-space\) calc\(var\(--composer-overlay-reserve\) \+ 20px\)[^}]*scroll-padding-bottom:\s*var\(--composer-overlay-reserve\)/s);
    expect(css).toMatch(/\.composer-wrap\s*{[^}]*--composer-max-width:\s*var\(--conversation-content-width\)[^}]*--composer-stack-total-inset:\s*20px[^}]*--conversation-inline-space:/s);
    expect(css).toMatch(/\.composer-wrap\s*{[^}]*grid-column:\s*1[^}]*grid-row:\s*2[^}]*background:\s*linear-gradient\(to right, var\(--bg-workspace\) calc\(100% - 15px\), transparent calc\(100% - 15px\)\)[^}]*pointer-events:\s*none/s);
    expect(css).toMatch(/\.composer-wrap\s*{[^}]*padding:\s*8px var\(--conversation-inline-space\) 14px/s);
    expect(css).toMatch(/\.composer,[^}]*width:\s*min\(var\(--composer-max-width\), 100%\)/s);
    expect(css).toMatch(/\.composer-token-metrics\s*{[^}]*display:\s*grid[^}]*width:\s*min\(var\(--composer-max-width\), 100%\)/s);
    expect(css).toMatch(/\.message-row\[data-role="assistant"\] \.message-content,[^}]*max-width:\s*100%/s);
  });

  it("keeps the scrollport clear of the topbar band it scrolls under", async () => {
    // `.topbar` sits in grid row 1, whose track is `--app-menu-height: 0px`, so its 44px overflows
    // into row 2 and paints over the first lines of the transcript. Any `scrollIntoView({ block:
    // "start" })` therefore parks its target under the session title unless the scroll container
    // declares the inset. Measured 2026-09-29 from a user screenshot: a search hit looked like it
    // "never scrolled out" - it was centred, just inside that covered band.
    const css = (await workbenchText()).replace(/\/\*[\s\S]*?\*\//g, "");
    const timeline = css.slice(css.indexOf(".timeline {"));
    expect(timeline.slice(0, timeline.indexOf("}")))
      .toMatch(/scroll-padding-top:\s*calc\(var\(--topbar-height\) \+ 8px\)/);
    // The token has to resolve in this same file: `workbench.css` loads after `layout.css`, and the
    // inset is worthless if the height it reads is never declared.
    expect(css).toMatch(/--topbar-height:\s*(\d+)px/);
    expect(Number(css.match(/--topbar-height:\s*(\d+)px/)![1])).toBeGreaterThan(0);
  });

  it("keeps the conversation scrollbar at the workspace edge when the inspector opens", async () => {
    const css = await workbenchText();
    expect(css).toMatch(/\.app-shell\.is-inspector-open \.workspace-shell\s*{[^}]*padding-right:\s*0/s);
    expect(css).toMatch(/\.app-shell\.is-inspector-open \.timeline\s*{[^}]*--inspector-width\) - var\(--conversation-content-width\)[^}]*padding-right:\s*calc\(var\(--inspector-width\) \+ var\(--conversation-inline-space\)\)/s);
    expect(css).toMatch(/\.app-shell\.is-inspector-open \.composer-wrap\s*{[^}]*--inspector-width\) - var\(--conversation-content-width\)[^}]*padding-right:\s*calc\(var\(--inspector-width\) \+ var\(--conversation-inline-space\)\)/s);
    expect(css).toMatch(/\.composer,[^}]*pointer-events:\s*auto/s);
  });

  it("restores hit testing for queue and todo panels while keeping the outer scrollbar accessible", async () => {
    const css = await workbenchText();
    expect(css).toMatch(/\.composer-wrap\s*{[^}]*pointer-events:\s*none/s);
    expect(css).toMatch(/\.composer-stack-panel\s*{[^}]*pointer-events:\s*auto/s);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.timeline\s*{[^}]*padding:\s*26px 16px calc\(var\(--composer-overlay-reserve\) \+ 18px\)/);
  });

  it("defines inspector drawer and compact sidebar breakpoints", async () => {
    const css = await workbenchText();
    expect(css).toContain("@media (max-width: 1279px)");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("@media (max-width: 520px)");
    expect(css).toMatch(/@media \(max-width: 520px\)[\s\S]*--composer-stack-total-inset:\s*12px/);
  });

  it("matches the neutral sidebar density and active surface", async () => {
    const css = await workbenchText();
    expect(css).toMatch(/\.sidebar\s*{[^}]*background:\s*var\(--bg-sidebar\)/s);
    expect(css).toMatch(/:root\[data-theme="light"\] \.sidebar,[^}]*--bg-active:\s*#e1e1e3/s);
    expect(css).toMatch(/\.primary-nav button\s*{[^}]*height:\s*40px[^}]*font-size:\s*calc\(15px \+ var\(--font-size-delta\)\)/s);
    expect(css).toMatch(/\.thread-time\s*{[^}]*font-variant-numeric:\s*tabular-nums/s);
  });

  it("gives markdown file previews a calm reading layout", async () => {
    const css = await workbenchText();
    expect(css).toMatch(/\.file-preview-toolbar\s*{[^}]*min-height:\s*40px[^}]*padding:\s*0 10px/s);
    // The bar owns the row. The toggle must not paint a surface or set a height floor of its own,
    // or it draws a --bg-conversation rectangle inside the panel's bar - see the comment in
    // workbench.css and the specificity trap that let it survive the bar's introduction.
    const toggle = css.match(/\.markdown-preview-toggle\s*{[^}]*}/s)?.[0] ?? "";
    expect(toggle).not.toMatch(/background/);
    expect(toggle).not.toMatch(/min-height/);
    expect(toggle).not.toMatch(/border-bottom/);
    expect(css).toMatch(/\.file-markdown-preview\s*{[^}]*padding:\s*32px max\(28px, calc\(\(100% - var\(--conversation-content-width\)\) \/ 2\)\) 72px[^}]*scrollbar-gutter:\s*stable/s);
    expect(css).toMatch(/\.file-markdown-preview h1\s*{[^}]*font-size:\s*calc\(24px \+ var\(--font-size-delta\)\)[^}]*letter-spacing:\s*-0\.02em/s);
    expect(css).toMatch(/\.file-markdown-preview h2\s*{[^}]*margin:\s*32px 0 12px[^}]*font-size:\s*calc\(19px \+ var\(--font-size-delta\)\)/s);
    // The scroll wrapper, not the <table>, owns the vertical gap in file previews.
    expect(css).toMatch(/\.file-markdown-preview \.markdown-table-scroll\s*{[^}]*margin:\s*0 0 14px/s);
  });

  it("keeps the preview's block rhythm out of quotes and list items", async () => {
    const css = await workbenchText();
    // Authored on top-level blocks, but written as a descendant selector...
    expect(css).toMatch(/\.file-markdown-preview :is\(p, ul, ol, blockquote, pre\)\s*{[^}]*margin-bottom:\s*14px/s);
    // ...so it also reaches the <p> inside a <blockquote>. A block with padding cannot collapse a
    // child's bottom margin past its own edge, so that 14px painted inside the tinted quote box and
    // read as a blank line: measured 49px around a 23px paragraph in the preview vs 35px in the
    // transcript. The last child of a container must not carry it.
    expect(css).toMatch(/\.file-markdown-preview :is\(blockquote, li\) > :last-child\s*{[^}]*margin-bottom:\s*0/s);
  });

  it("draws ordered-list markers in a bounded column instead of an outside marker", async () => {
    const css = await workbenchText();
    // The list gives up the browser's marker entirely: an outside marker is right-aligned to the text
    // column, so the only way to square off the digits was to make the marker wider, and the only
    // direction it can grow is left - onto the outline tick. Measured twice, and both attempts are
    // reverted in the history (bd781f1, e2f907b).
    expect(css).toMatch(/\.markdown-body ol\s*{[^}]*list-style:\s*none/s);
    // The number is a counter, and a counter has to be told where the list starts, because
    // markdown-it emits `<ol start="8">` (see markdownRenderer.test.ts for the other half).
    expect(css).toMatch(/\.markdown-body ol\s*{[^}]*counter-reset:\s*md-ol var\(--md-ol-start, 0\)/s);
    expect(css).toMatch(/\.markdown-body ol > li::before\s*{[^}]*content:\s*counter\(md-ol\)/s);
    expect(css).toMatch(/\.markdown-body ol > li::before\s*{[^}]*left:\s*calc\(-1 \* var\(--md-li-indent\)\)/s);
    expect(css).toMatch(/\.markdown-body ol > li::before\s*{[^}]*text-align:\s*center/s);
    // The file preview indents 24px rather than 22px, so its column has to follow or the number lands
    // 2px outside the block edge there.
    expect(css).toMatch(/\.file-markdown-preview :is\(ul, ol\)\s*{[^}]*--md-li-indent:\s*24px/s);
  });

  it("keeps the sidebar's text on the font-size ladder, not on rem utilities", async () => {
    const sidebar = await vueText("src/components/AppSidebar.vue");
    // `html { font-size: var(--font-size-root) }` is a flat 16px and `--font-size-delta` never touches
    // it, so `text-sm` / `text-xs` stay 14px / 12px no matter where the reader puts Settings > 外观 >
    // 字体大小. The thread rows were already on the ladder while their own group headers and the empty
    // states were not - which is exactly how the list drifts out of step with 活跃会话 when the setting
    // moves.
    expect(sidebar).not.toMatch(/[^-]\btext-(xs|sm|base|lg|xl)\b/);
    // The swap is size-neutral at the default setting: body = 14px + delta, label = 12px + delta.
    expect(sidebar).toMatch(/text-\[var\(--font-size-body\)\]/);
    expect(sidebar).toMatch(/text-\[var\(--font-size-label\)\]/);
  });

  it("moves the conversation search popover clear of the inspector overlay", async () => {
    const css = await workbenchText();
    const pane = await vueText("src/components/ConversationPane.vue");
    // The inspector is `position: absolute; right: 0`, and the pane keeps the full workspace width
    // (.timeline compensates with padding-right), so a popover pinned to the pane's right edge sat
    // under the inspector (z 20 vs 30) and did not follow the divider.
    expect(css).toMatch(/\.app-shell\.is-inspector-open \.conversation-search\s*{[^}]*right:\s*calc\(var\(--inspector-width\) \+ 16px\)/s);
    // --inspector-width is registered `inherits: false`, so the popover element has to be handed it.
    expect(pane).toMatch(/class="conversation-search[^"]*"\s*\n?\s*:style="\{ '--inspector-width'/s);
    // And `right` must stay out of the template: `.right-4` compiles to `right: … !important`, and an
    // important utility beats this unlayered rule - verified against the built sheet (16px won).
    expect(pane).not.toMatch(/class="conversation-search[^"]*\b(right|left)-[\w.]+/);
  });

  it("centres the jump-to-latest control over the transcript, not over the pane", async () => {
    const css = await workbenchText();
    const pane = await vueText("src/components/ConversationPane.vue");
    // The same overlay bites here: the pane keeps the full workspace width while the inspector is
    // open, so `left: 50%` sat the button half an inspector to the right of the column the reader is
    // looking at - on the divider.
    expect(css).toMatch(/\.app-shell\.is-inspector-open \.timeline-jump-latest\s*{[^}]*left:\s*calc\(50% - var\(--inspector-width\) \/ 2\)/s);
    // `--inspector-width` is registered `inherits: false`, so this element has to be handed it too.
    expect(pane).toMatch(/class="timeline-jump-latest"\s*\n\s*:style="\{ '--inspector-width'/);
    // And `left` stays out of the template for the same reason `right` does: the utility is
    // `!important` and would beat this unlayered rule.
    expect(pane).not.toMatch(/class="timeline-jump-latest[^"]*\b(left|right)-[\w.]+/);
  });

  it("separates transcript markdown levels by a size step and a rule, not by hue", async () => {
    const css = await workbenchText();
    // Typora's contract: headings are ink, and the level is carried by size + a hairline under
    // h1/h2. Pi's TUI has no size channel and uses a hue instead - that was tried first and read
    // as a theme change rather than as structure.
    const heading = css.match(/\.markdown-body :is\(h1, h2, h3, h4\)\s*\{[^}]*\}/s)?.[0] ?? "";
    expect(heading).toMatch(/color:\s*var\(--md-heading\)/);
    expect(heading).toMatch(/font-weight:\s*700/);
    for (const [level, size] of [["h1", "1.75em"], ["h2", "1.5em"], ["h3", "1.25em"], ["h4", "1.08em"]] as const) {
      expect(css, level).toMatch(new RegExp(`\\.markdown-body ${level}\\s*\\{[^}]*font-size:\\s*${size}`));
    }
    expect(css).toMatch(/\.markdown-body h1\s*\{[^}]*border-bottom:\s*1px solid var\(--md-rule\)/);
    expect(css).toMatch(/\.markdown-body h2\s*\{[^}]*border-bottom:\s*1px solid var\(--md-rule\)/);
    // em, not px: the same rules apply inside the 12-13px reasoning and compaction panes.
    expect(css).not.toMatch(/\.markdown-body h[1-4]\s*\{[^}]*font-size:\s*calc/);
    // The document scale in file previews must keep winning, which it only does while the
    // transcript block sits above it - equal specificity, so source order decides.
    expect(css.indexOf(".markdown-body h1")).toBeLessThan(css.indexOf(".file-markdown-preview h1"));
  });

  it("lays code as a fill-only panel and keeps tables a closed grid in a hairline", async () => {
    const css = await workbenchText();
    const code = css.match(/\.markdown-body code\s*\{[^}]*\}/s)?.[0] ?? "";
    expect(code).toMatch(/border-color:\s*transparent/);
    expect(code).toMatch(/color:\s*var\(--md-code\)/);
    // ...and the same for the block: outline off, fill on. A whole block of hue would be a
    // syntax theme this app does not have.
    const pre = css.match(/\.markdown-body pre\s*\{[^}]*\}/s)?.[0] ?? "";
    expect(pre).toMatch(/border-color:\s*transparent/);
    expect(pre).toMatch(/background:\s*var\(--md-code-panel-bg\)/);
    expect(css).toMatch(/\.markdown-body pre code\s*\{[^}]*color:\s*var\(--text-secondary\)/);
    // A closed grid, but the rule is nearly the surface colour - the borderless variant read as
    // open underlines, and columns stopped lining up once a cell wrapped.
    expect(css).toMatch(/\.markdown-body table\s*\{[^}]*border:\s*1px solid var\(--md-rule\)/);
    const cell = css.match(/\.markdown-body th,\n\.markdown-body td\s*\{[^}]*\}/s)?.[0] ?? "";
    expect(cell).toMatch(/border-color:\s*var\(--md-cell-rule\)/);
    expect(css).toMatch(/\.markdown-body thead th\s*\{[^}]*background:\s*var\(--md-table-head-bg\)/);
    expect(css).toMatch(/\.markdown-body tbody tr:nth-child\(even\) > td\s*\{[^}]*background:\s*var\(--md-table-row-bg\)/);
    // Every --md-* role has to resolve in both palettes. The geometry ones are derived in :root
    // from tokens that flip, so a missing base token would silently paint nothing; the two
    // foregrounds are asserted as deliberately *not* mixes - the hue experiments were reverted.
    const tokens = await textAt("src/styles/tokens.css");
    for (const role of ["code-bg", "code-panel-bg", "rule", "table-head-bg", "table-row-bg"]) {
      expect(tokens, `--md-${role}`).toMatch(new RegExp(`--md-${role}:\\s*color-mix\\(in srgb`));
    }
    expect(tokens).toMatch(/--md-heading:\s*var\(--text\)/);
    expect(tokens).toMatch(/--md-code:\s*var\(--text-code\)/);
  });

  it("keeps the inspector resize target on the panel edge without a visible rail", async () => {
    const css = await workbenchText();
    expect(css).toMatch(/\.pane-resizer\.is-right\s*{[^}]*right:\s*calc\(var\(--inspector-width\) - 3px\)/s);
    expect(css).toMatch(/\.pane-resizer\.is-right::after\s*{[^}]*content:\s*none/s);
  });

  it("gives settings the ZCode-style hierarchy and spacious rows", async () => {
    const css = await workbenchText();
    expect(css).toMatch(/\.dialog-body\.settings-layout\s*{[^}]*padding:\s*0 !important/s);
    expect(css).toMatch(/\.dialog-body\.settings-layout\s*{[^}]*padding-block:\s*0 !important[^}]*padding-inline:\s*0 !important/s);
    expect(css).toMatch(/\.settings-layout\s*{[^}]*grid-template-columns:\s*264px minmax\(0, 1fr\)/s);
    expect(css).toMatch(/\.settings-sidebar\s*{[^}]*border-right:\s*0[^}]*background:\s*var\(--bg-sidebar\)/s);
    expect(css).toMatch(/\.settings-nav\s*{[^}]*border-right:\s*0/s);
    expect(css).toMatch(/\.settings-main\s*{[^}]*border:\s*0[^}]*background:\s*var\(--bg-settings\)/s);
    expect(css).not.toContain(".settings-project-path");
    expect(css).toMatch(/\.settings-nav button\s*{[^}]*width:\s*100%[^}]*min-height:\s*42px[^}]*border-radius:\s*var\(--radius-lg\)[^}]*font-size:\s*var\(--font-size-body\)/s);
    expect(css).toMatch(/\.settings-view-header h1\s*{[^}]*font-size:\s*calc\(32px \+ var\(--font-size-delta\)\)[^}]*letter-spacing:\s*-0\.035em/s);
    expect(css).toMatch(/\.settings-main \.setting-row\s*{[^}]*min-height:\s*72px[^}]*padding:\s*var\(--space-md\) var\(--space-lg\)/s);
    expect(css).toMatch(/\.settings-main > \.settings-content\s*{[^}]*background:\s*var\(--bg-settings\) !important/s);
    expect(css).toMatch(/\.settings-main \.settings-sections\s*{[^}]*grid-auto-rows:\s*max-content[^}]*gap:\s*var\(--space-xl\)/s);
    expect(css).toMatch(/\.settings-main \.settings-sections > section\s*{[^}]*display:\s*grid[^}]*gap:\s*var\(--space-md\)[^}]*border:\s*0[^}]*background:\s*transparent/s);
    expect(css).toMatch(/\.settings-main \.settings-card\s*{[^}]*border:\s*1px solid var\(--border\)[^}]*border-radius:\s*var\(--radius-lg\)[^}]*background:\s*var\(--bg-card\)[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.settings-main \.setting-row\s*{[^}]*background:\s*transparent/s);
    expect(css).toMatch(/\.settings-main \.settings-section-title\s*{[^}]*margin:\s*0[^}]*padding:\s*0[^}]*border:\s*0/s);
    expect(css).toMatch(/\.settings-main \.settings-card > \.setting-row:last-child\s*{[^}]*border-bottom:\s*0/s);
    expect(css).toMatch(/\.settings-main \.setting-row-select select\s*{[^}]*width:\s*256px !important[^}]*height:\s*40px !important[^}]*flex:\s*0 0 256px !important/s);
    expect(css).toMatch(/\.settings-page\.settings-dialog \.settings-main \.setting-row > input\[type="checkbox"\]\s*{[^}]*width:\s*38px !important[^}]*height:\s*22px !important[^}]*margin:\s*0/s);
    expect(css).toMatch(/\.settings-page\.settings-dialog \.settings-main \.setting-row > input\[type="checkbox"\]\s*{[^}]*background-position:\s*left 1px center[^}]*background-size:\s*18px 18px/s);
    expect(css).toMatch(/input\[type="checkbox"\]:checked\s*{[^}]*background-position:\s*right 1px center/s);
    expect(css).not.toMatch(/\.settings-page\.settings-dialog \.settings-main \.setting-row > input\[type="checkbox"\]::after/);
    expect(css).toMatch(/\.settings-dialog \.provider-header-row\s*{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\) 32px/s);
  });

  it("keeps management screens aligned with the wider settings rhythm", async () => {
    const css = await workbenchText();
    expect(css).toMatch(/\.settings-dialog \.model-manager-layout,[^}]*grid-template-columns:\s*248px minmax\(0, 1fr\) !important/s);
    expect(css).toMatch(/\.settings-dialog \.model-manager-layout,[^}]*background:\s*var\(--bg-settings\)/s);
    expect(css).toMatch(/\.settings-dialog \.model-config-list,[^}]*background:\s*var\(--bg-settings\) !important/s);
    expect(css).toMatch(/\.settings-dialog \.model-editor,[^}]*background:\s*var\(--bg-settings\) !important/s);
    expect(css).toMatch(/\.settings-dialog \.model-config-list > button,[^}]*min-height:\s*42px !important/s);
    expect(css).toMatch(/\.settings-dialog \.skill-list \.prompt-config-scope > button,[^}]*min-height:\s*62px !important/s);
    expect(css).toMatch(/\.settings-dialog \.model-field > textarea\s*{[^}]*min-height:\s*96px !important/s);
    expect(css).toMatch(/\.settings-dialog \.model-editor-actions\s*{[^}]*padding:\s*var\(--space-md\) var\(--space-xl\)/s);
  });
});
