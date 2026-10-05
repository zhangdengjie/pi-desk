import tokensFile from "./tokens.css?inline";
import tailwindFile from "./tailwind.css?inline";
import { describe, expect, it } from "vitest";
import { TRANSCRIPT_TINT_ANCHOR } from "../utils/transcriptTint";

async function tokensText(): Promise<string> {
  if (tokensFile.includes("--bg-app")) return tokensFile.replace(/\r\n?/g, "\n");
  const moduleName = ["node", "fs/promises"].join(":");
  const { readFile } = await import(/* @vite-ignore */ moduleName) as {
    readFile(path: string, encoding: "utf8"): Promise<string>;
  };
  return (await readFile("src/styles/tokens.css", "utf8")).replace(/\r\n?/g, "\n");
}

async function tailwindText(): Promise<string> {
  if (tailwindFile.includes("--text-xs")) return tailwindFile.replace(/\r\n?/g, "\n");
  const moduleName = ["node", "fs/promises"].join(":");
  const { readFile } = await import(/* @vite-ignore */ moduleName) as {
    readFile(path: string, encoding: "utf8"): Promise<string>;
  };
  return (await readFile("src/styles/tailwind.css", "utf8")).replace(/\r\n?/g, "\n");
}

describe("teleported dialog theme inheritance", () => {
  it("publishes light theme variables from the document root", async () => {
    const tokens = await tokensText();
    expect(tokens).toContain(":root[data-theme=\"light\"],\n.app-shell[data-theme=\"light\"]");
    expect(tokens).toContain(":root[data-theme=\"system\"],\n  .app-shell[data-theme=\"system\"]");
    expect(tokens).toContain("--bg-settings: #f8f8f8");
    // Not a literal any more: the transcript's ground is the theme's own colour plus an optional tint
    // (Settings > Appearance > Answer background), mixed in tokens.css so one value covers light, dark
    // and "system". What this test owns is that the declaration still lives on the root selector, so a
    // teleported dialog inherits it.
    expect(tokens).toMatch(/--bg-conversation: color-mix\(in oklab, #f8f8f8 calc\(100% - var\(--transcript-tint-strength, 0%\)\), var\(--transcript-tint, transparent\)\)/);
    // And the mix has to be an identity when no tone is chosen, or the default appearance would move.
    expect(tokens).toMatch(/:root\s*{\s*--transcript-tint: transparent;\s*--transcript-tint-strength: 0%;/);
    expect(tokens).toContain("--bg-card: #ffffff");
    expect(tokens).toContain("--bg-composer: var(--bg-card)");
  });

  it("keeps the tint anchor the stylesheet declares equal to the one TypeScript uses", async () => {
    const tokens = await tokensText();
    // App.vue anchors the reader's pick to a lightness constant instead of reading
    // `--transcript-tint-anchor` off the element, because the tint watch and the theme watch fire on
    // the same appearance change and whichever runs first would see the old theme. That is only safe
    // while the two copies agree, so they are pinned together here.
    expect(tokens).toContain(`--transcript-tint-anchor: ${TRANSCRIPT_TINT_ANCHOR.light};`);
    expect(tokens).toContain(`--transcript-tint-anchor: ${TRANSCRIPT_TINT_ANCHOR.dark};`);
    // The light block and the system-light media block must not drift apart.
    expect(tokens.match(/--transcript-tint-anchor: 0\.9871;/g)).toHaveLength(2);
  });

  it("publishes global font-family and root-size preference tokens", async () => {
    const tokens = await tokensText();
    expect(tokens).toContain('--font-interface-shipped: "PingFang SC",');
    expect(tokens).toContain(':root[data-font-family="system"]');
    expect(tokens).toContain(':root[data-font-family="serif"]');
    expect(tokens).toContain(':root[data-font-family="mono"]');
    // A reader-typed family has no closed set of values, so the sheet consumes it as a variable instead
    // of enumerating it - and the fallback has to stay the shipped stack, because WebKit cannot tell us
    // whether the name exists (`document.fonts.check` answers true for a made-up one).
    expect(tokens).toContain(':root[data-font-family="custom"]');
    expect(tokens).toMatch(/--font-interface-body:\s*var\(--font-interface-custom\),\s*var\(--font-interface-shipped\)/);
    // The fallback has to be the shipped stack by reference, never a copy: a literal list here drifts
    // from the base one the first time someone edits line 40.
    expect(tokens).toMatch(/--font-interface-shipped:/);
    expect(tokens).toMatch(/--font-interface-custom:\s*var\(--font-interface-shipped\)/);
    expect(tokens).toContain(':root[data-font-size="12"]');
    expect(tokens).toContain(':root[data-font-size="18"]');
    expect(tokens).toContain("--font-size-delta: -2px");
    expect(tokens).toContain("--font-size-delta: 4px");
    expect(tokens).toContain("--font-size-root: 16px");
    expect(tokens).toContain("--font-size-meta: calc(11px + var(--font-size-delta))");
    expect(tokens).toContain("--font-size-control: calc(13px + var(--font-size-delta))");
    expect(tokens).toContain("--font-size-body: calc(14px + var(--font-size-delta))");
  });

  it("publishes the selectable code preview palettes and sampled ZCode surfaces", async () => {
    const tokens = await tokensText();
    for (const theme of ["github-light", "github-dark", "vitesse-light", "vitesse-dark", "minimal-light", "minimal-dark", "github-hc-light", "github-hc-dark", "catppuccin-latte", "catppuccin-mocha"]) {
      expect(tokens).toContain(`data-code-theme="${theme}"`);
    }
    expect(tokens).toContain("--preview-toolbar-bg: #f6f6f6");
    expect(tokens).toContain("--preview-bg: #ffffff");
    expect(tokens).toContain("--panel-surface: #ffffff");
    expect(tokens).toContain("--panel-selected: #f3f3f3");
    expect(tokens).toContain("--preview-border: #e0e0e0");
    expect(tokens).toContain("--diff-add-bg: #e3f2e3");
    expect(tokens).toContain("--diff-delete-bg: #ffe4e0");
    expect(tokens).toContain("--sheet-bg: #f8f8f8");
    expect(tokens).toContain("--sheet-header-bg: #f6f6f6");
    expect(tokens).toContain("--sheet-cell-bg: #ffffff");
    expect(tokens).toContain("--sheet-border: #e0e0e0");
    expect(tokens).toContain("--sheet-text: #242424");
  });

  it("scales Tailwind text utilities with the selected interface size", async () => {
    const tailwind = await tailwindText();
    expect(tailwind).toContain("--text-xs: var(--font-size-meta)");
    expect(tailwind).toContain("--text-sm: var(--font-size-control)");
    expect(tailwind).toContain("--text-base: var(--font-size-body)");
  });
});

describe("text colour tokens", () => {
  // `--text-faint` sat undefined in every theme for two commits: the git-ignored fade in the file
  // tree (`layout.css` `.file-tree-name.is-ignored`) and upstream's MCP switch both resolved to
  // nothing, so the rows looked identical to tracked ones and no test noticed. A rule that points at
  // a missing custom property fails silently, so the check has to be "every reference has a home".
  it("defines every --text token the stylesheets reference", async () => {
    const moduleName = ["node", "fs/promises"].join(":");
    const { readFile } = await import(/* @vite-ignore */ moduleName) as {
      readFile(path: string, encoding: "utf8"): Promise<string>;
    };
    const [tokens, layout, workbench] = await Promise.all([
      tokensText(),
      readFile(["src", "styles", "layout.css"].join("/"), "utf8"),
      readFile(["src", "styles", "workbench.css"].join("/"), "utf8"),
    ]);
    const defined = new Set([...tokens.matchAll(/^\s*(--text(?:-[a-z0-9-]+)?)\s*:/gm)].map((match) => match[1]));
    const used = new Set([...[layout, workbench].join("\n").matchAll(/var\((--text(?:-[a-z0-9-]+)?)[,)\s]/g)].map((match) => match[1]));
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
    expect(defined.has("--text-faint")).toBe(true);
  });
});
