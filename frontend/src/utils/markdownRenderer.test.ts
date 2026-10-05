import {
  MARKDOWN_CACHE_MIN_CHARS,
  MARKDOWN_UID_PLACEHOLDER,
  createMarkdownRenderCache,
  markdownRenderCache,
  renderMarkdownDocument,
} from "./markdownRenderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

function longDoc(chars = MARKDOWN_CACHE_MIN_CHARS + 100): string {
  const line = "- 关键结论：`wear IS NULL` 788 条，占样本 100%，需要复核。\n";
  const body = line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
  // One heading, so the uid prefix is visible in the output.
  return `## 复核结论\n${body}`;
}

function env(overrides: Partial<{ workspacePath: string; baseDir: string }> = {}) {
  return { slugCounts: new Map<string, number>(), ...overrides };
}

beforeEach(() => markdownRenderCache.clear());

describe("ordered list markers", () => {
  it("hands the CSS counter its start, and keeps the role the list-style reset costs", () => {
    const html = renderMarkdownDocument("8. 八\n9. 九\n", env(), "md1");
    // The transcript draws the number with `counter-increment`, which knows nothing about the
    // `start` attribute - without this offset a list that begins at 8 would print 1, 2.
    expect(html).toMatch(/<ol[^>]*style="--md-ol-start:7"/);
    // `start` itself stays in the markup: it is the semantic value, and the preview and any other
    // consumer that keeps native markers still has to number correctly.
    expect(html).toContain('start="8"');
    expect(html).toMatch(/<ol[^>]*role="list"/);
    const plain = renderMarkdownDocument("1. 一\n2. 二\n", env(), "md2");
    expect(plain).toMatch(/<ol[^>]*role="list"/);
    expect(plain).not.toMatch(/--md-ol-start/);
  });
});

describe("markdown render cache", () => {
  it("parses a text once however many instances render it", () => {
    const text = longDoc();
    const first = renderMarkdownDocument(text, env({ workspacePath: "/repo" }), "md1");
    const second = renderMarkdownDocument(text, env({ workspacePath: "/repo" }), "md2");

    // The whole point: a virtualized scroll unmounts a row and mounts it again, and the second
    // mount must not pay the parse (256k chars is ~30ms, 1MiB ~135ms).
    expect(markdownRenderCache.stats).toMatchObject({ misses: 1, hits: 1 });
    expect(second).not.toBe(first);
    expect(first).toContain('id="md1-');
    expect(second).toContain('id="md2-');
    expect(first.includes(MARKDOWN_UID_PLACEHOLDER)).toBe(false);
    expect(second.includes(MARKDOWN_UID_PLACEHOLDER)).toBe(false);
  });

  it("keys on the link environment, because the same text resolves links differently", () => {
    const text = longDoc();
    renderMarkdownDocument(text, env({ workspacePath: "/repo", baseDir: "docs" }), "md1");
    renderMarkdownDocument(text, env({ workspacePath: "/repo", baseDir: "app" }), "md2");
    renderMarkdownDocument(text, env({ workspacePath: "/repo" }), "md3");

    expect(markdownRenderCache.stats).toMatchObject({ misses: 3, hits: 0 });
  });

  it("leaves a streaming block out of the cache entirely", () => {
    const text = longDoc();
    renderMarkdownDocument(text, env(), "md1", false);
    renderMarkdownDocument(text, env(), "md1", false);

    // Every frame of a reveal is a longer string: caching them would evict the entries that are
    // actually being remounted.
    expect(markdownRenderCache.stats).toMatchObject({ misses: 0, hits: 0, entries: 0 });
  });

  it("does not cache a block whose parse is cheaper than the lookup", () => {
    const text = "短消息，不值得进缓存。".repeat(4);
    expect(text.length).toBeLessThan(MARKDOWN_CACHE_MIN_CHARS);
    renderMarkdownDocument(text, env(), "md1");
    renderMarkdownDocument(text, env(), "md1");

    expect(markdownRenderCache.stats).toMatchObject({ misses: 0, entries: 0 });
  });
});

describe("markdown render cache eviction", () => {
  it("keeps the newest entries inside the byte budget", () => {
    const render = vi.fn((text: string) => `<p>${text}</p>`);
    const cache = createMarkdownRenderCache(render, 34);

    cache.render("aaaaaaaaaa", env());
    cache.render("bbbbbbbbbb", env());
    cache.render("cccccccccc", env());

    // Each entry is 17 chars, so a 34-char budget holds two: the oldest is evicted rather than
    // letting the cache grow without bound.
    expect(cache.stats.entries).toBe(2);
    expect(cache.stats.chars).toBe(34);
    cache.render("cccccccccc", env());
    expect(render).toHaveBeenCalledTimes(3);
  });

  it("treats a hit as recent use, so the untouched entry is the one evicted", () => {
    const render = vi.fn((text: string) => `<p>${text}</p>`);
    const cache = createMarkdownRenderCache(render, 34);

    cache.render("aaaaaaaaaa", env());
    cache.render("bbbbbbbbbb", env());
    cache.render("aaaaaaaaaa", env()); // touch a, making b the least recently used
    cache.render("cccccccccc", env());
    cache.render("aaaaaaaaaa", env());
    cache.render("bbbbbbbbbb", env()); // b was evicted, so this parses again

    expect(render).toHaveBeenCalledTimes(4);
    expect(cache.stats).toMatchObject({ hits: 2, misses: 4 });
  });
});