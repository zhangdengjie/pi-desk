import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../stores/app";
import MarkdownBody from "./MarkdownBody.vue";

vi.mock("../services/agent", () => ({ agentService: {}, onPiEvent: () => () => undefined }));
vi.mock("../services/catalog", () => ({ catalogService: {} }));
vi.mock("../services/desktop", () => ({ getBootstrapState: vi.fn() }));
vi.mock("../services/browser", () => ({ browserService: { openUrl: vi.fn().mockResolvedValue({ attached: true }) } }));
vi.mock("../services/repository", () => ({
  repositoryService: {
    previewFile: vi.fn(), openFile: vi.fn(), openFileWith: vi.fn(), saveFileAs: vi.fn(), revealFile: vi.fn(),
  },
}));



function mountMarkdown(text: string, extraProps: Record<string, unknown> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useAppStore();
  store.$patch({
    threads: [{
      id: "thread-1", title: "Files", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
      status: "idle", started: false, generation: 0,
    }],
    activeThreadId: "thread-1",
  });
  return { store, wrapper: mount(MarkdownBody, { props: { text, ...extraProps }, attachTo: document.body, global: { plugins: [pinia] } }) };
}

describe("MarkdownBody", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders common Markdown while disabling raw HTML and unsafe links", () => {
    const { wrapper } = mountMarkdown("**Done**\n\n- one\n- two\n\n[bad](javascript:alert(1))\n\n<script>alert(1)</script>");

    expect(wrapper.find("strong").text()).toBe("Done");
    expect(wrapper.findAll("li")).toHaveLength(2);
    expect(wrapper.html()).not.toContain("href=\"javascript:");
    expect(wrapper.find("script").exists()).toBe(false);
    expect(wrapper.text()).toContain("<script>alert(1)</script>");
    wrapper.unmount();
  });

  it("renders the GFM table and strikethrough used by the composer", () => {
    const { wrapper } = mountMarkdown("| Name | Done |\n| --- | --- |\n| Build | yes |\n\n~~obsolete~~");

    expect(wrapper.get("table").text()).toContain("Build");
    expect(wrapper.get("s").text()).toBe("obsolete");
    wrapper.unmount();
  });

  it("wraps every rendered table in a horizontal scroll container", () => {
    const { wrapper } = mountMarkdown("| 组件 | 说明 |\n| --- | --- |\n| Build | 中文长文本，宽度有限时不允许垂直堆叠，必须靠横向滚动来兜住 |\n");

    const scroll = wrapper.get(".markdown-table-scroll");
    expect(scroll.element.tagName).toBe("DIV");
    expect(scroll.element.firstElementChild?.tagName).toBe("TABLE");
    expect(wrapper.findAll("table")).toHaveLength(1);
    expect(scroll.text()).toContain("组件");
    // Each cell carries the block child that holds the width ceiling: WebKit ignores
    // max-width on a th/td with bare text, so this DOM shape is part of the contract.
    expect(wrapper.findAll("th .markdown-cell")).toHaveLength(2);
    expect(wrapper.findAll("td .markdown-cell")).toHaveLength(2);
    // Only the prose cell takes the width floor; short value cells stay natural.
    expect(wrapper.findAll(".markdown-cell.is-wide")).toHaveLength(1);
    expect(wrapper.get("td .markdown-cell.is-wide").text()).toContain("中文长文本");
    // The pane is divided by this count, so it has to be on the wrapper the floor reads.
    expect(scroll.attributes("style")).toContain("--markdown-table-cols:2");
    wrapper.unmount();
  });

  it("floors prose by column count and keeps short labels on one line", () => {
    const header = "| 持仓 | 成本 | 现价 | 盈亏 | 触发线 | 首触日 | 走向 | 执行 |";
    const rule = "| --- | --- | --- | --- | --- | --- | --- | --- |";
    const row =
      "| 科大讯飞 | 42.785×200 | 39.20→38.32 | -10.4% | 兑现区39.8–40.5；收盘<39.00清；终极线38.67 | 9/1收40.22进兑现区；9/17收38.34双破 | 破线后阴跌至今 | ❌ 第三次点名 |";
    const { wrapper } = mountMarkdown(`${header}\n${rule}\n${row}\n`);

    expect(wrapper.get(".markdown-table-scroll").attributes("style")).toContain("--markdown-table-cols:8");
    // A two-glyph label and a seven-glyph verdict must both be pinned to one line:
    // at 31px these columns rendered as vertical text next to 200px prose columns.
    expect(wrapper.findAll("td .markdown-cell.is-nowrap")).toHaveLength(4);
    expect(wrapper.get("td .markdown-cell.is-nowrap").text()).toBe("科大讯飞");
    expect(wrapper.findAll(".markdown-cell.is-wide")).toHaveLength(2);
    wrapper.unmount();
  });

  it("renders legacy browser break tags as line breaks instead of text", () => {
    const { wrapper } = mountMarkdown("first</br>second<br>third<br/>fourth");

    expect(wrapper.text()).toBe("first\nsecond\nthird\nfourth");
    expect(wrapper.findAll("br")).toHaveLength(3);
    expect(wrapper.text()).not.toContain("</br>");
    wrapper.unmount();
  });

  it("preserves break-tag examples inside inline and fenced code", () => {
    const { wrapper } = mountMarkdown("`</br>`\n\n```html\n<br>\n```");

    expect(wrapper.findAll("code")).toHaveLength(2);
    expect(wrapper.text()).toContain("</br>");
    expect(wrapper.text()).toContain("<br>");
    expect(wrapper.findAll("br")).toHaveLength(0);
    wrapper.unmount();
  });

  it("turns workspace file links into previews and routes web links to the managed browser", async () => {
    const { store, wrapper } = mountMarkdown("[result](reports/tg_groups.csv) and [web](https://example.com/docs)");
    store.openRepositoryFilePreview = vi.fn().mockResolvedValue(undefined);
    store.openBrowserTab = vi.fn();
    const links = wrapper.findAll("a");

    expect(links[0].classes()).toContain("markdown-file-link");
    expect(links[0].attributes("title")).toBe("D:\\repo\\reports\\tg_groups.csv");
    expect(links[0].attributes("href")).toBe("#");
    expect(links[1].classes()).toContain("markdown-web-link");
    expect(links[1].attributes("target")).toBeUndefined();

    await links[0].trigger("click");
    expect(store.openRepositoryFilePreview).toHaveBeenCalledWith("reports/tg_groups.csv", undefined, true, undefined);

    await links[1].trigger("click");
    expect(store.openBrowserTab).toHaveBeenCalledWith("https://example.com/docs");

    await links[0].trigger("contextmenu", { clientX: 80, clientY: 90 });
    await flushPromises();
    const menu = document.body.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]');
    expect(menu?.textContent).toContain("Open file");
    expect(menu?.textContent).toContain("Open with...");
    expect(menu?.textContent).toContain("Save as...");
    expect(menu?.textContent).toContain("Copy path");
    expect(menu?.textContent).toContain("Show in file manager");
    wrapper.unmount();
  });

  it("stamps every heading with a slug id, deduplicated and scoped to this document", () => {
    const { wrapper } = mountMarkdown("# Title\n\n## Setup\n\n## Setup\n\n## 目录与锚点\n");
    const ids = wrapper.findAll("h1, h2").map((heading) => heading.attributes("id"));

    // The prefix is per MarkdownBody instance: a transcript mounts dozens of them, and a bare
    // "setup" would be claimed by whichever message renders first.
    expect(ids[0]).toMatch(/-title$/);
    expect(ids[1]).toMatch(/-setup$/);
    expect(ids[2]).toMatch(/-setup-1$/);
    expect(ids[3]).toMatch(/-目录与锚点$/);   // CJK survives the slug
    wrapper.unmount();
  });

  it("scrolls to a heading for an in-document anchor instead of navigating the WebView", async () => {
    const scrolled: string[] = [];
    const spy = vi.fn(function (this: Element) { scrolled.push(this.id); });
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = spy as typeof original;
    const { wrapper } = mountMarkdown("Jump [down](#target).\n\n## Target");

    const anchor = wrapper.get('a[href="#target"]');
    await anchor.trigger("click");
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toMatch(/-target$/);

    // A dead anchor must still not leak the fragment into the app's own URL.
    const dead = wrapper.find('a[href="#nope"]');
    expect(dead.exists()).toBe(false);
    await wrapper.setProps({ text: "Dead [link](#nope).\n\n## Target" });
    const before = scrolled.length;
    await wrapper.get('a[href="#nope"]').trigger("click");
    expect(scrolled).toHaveLength(before);
    wrapper.unmount();
    HTMLElement.prototype.scrollIntoView = original;
  });

  it("resolves a relative link against the previewed file, not the workspace root", async () => {
    const { store, wrapper } = mountMarkdown("[daily](./daily.md) and [up](../readme.md)", { basePath: "notes/a.md" });
    store.openRepositoryFilePreview = vi.fn().mockResolvedValue(undefined);

    const links = wrapper.findAll("a");
    expect(links[0].classes()).toContain("markdown-file-link");
    expect(links[0].attributes("title")).toBe("D:\\repo\\notes\\daily.md");
    await links[0].trigger("click");
    expect(store.openRepositoryFilePreview).toHaveBeenLastCalledWith("notes/daily.md", undefined, true, undefined);

    await links[1].trigger("click");
    expect(store.openRepositoryFilePreview).toHaveBeenLastCalledWith("readme.md", undefined, true, undefined);
    wrapper.unmount();
  });

  it("keeps chat-message links root-relative while carrying a cross-file anchor through", async () => {
    const { store, wrapper } = mountMarkdown("[plan](plan.md#deep-work)");
    store.openRepositoryFilePreview = vi.fn().mockResolvedValue(undefined);

    const link = wrapper.get("a");
    expect(link.attributes("data-file-anchor")).toBe("deep-work");
    await link.trigger("click");
    // No basePath here: a link in an answer is written from the repository's own directory.
    expect(store.openRepositoryFilePreview).toHaveBeenCalledWith("plan.md", undefined, true, "deep-work");
    wrapper.unmount();
  });

  it("lets the host panel jump to an anchor it only knows by slug", () => {
    const { wrapper } = mountMarkdown("## Deep Work\n\n## 目录");
    const vm = wrapper.vm as unknown as { scrollToAnchor(anchor: string): boolean };

    expect(vm.scrollToAnchor("deep-work")).toBe(true);
    expect(vm.scrollToAnchor("目录")).toBe(true);
    expect(vm.scrollToAnchor("missing-section")).toBe(false);
    wrapper.unmount();
  });

  it("hands a host the headings it rendered, with the levels rebased", () => {
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn() as typeof original;
    const { wrapper } = mountMarkdown("## Deep Work\n\n### Today\n\n## Ship log\n\n##### noise\n");
    const vm = wrapper.vm as unknown as { outline(): { id: string; level: number; title: string }[] };

    // The document opens on `##`, so that is level 0 - and h5 never makes the list at all.
    expect(vm.outline().map((entry) => [entry.level, entry.title])).toEqual([[0, "Deep Work"], [1, "Today"], [0, "Ship log"]]);
    wrapper.unmount();
    HTMLElement.prototype.scrollIntoView = original;
  });

  it("highlights search matches in rendered Markdown", async () => {
    const { wrapper } = mountMarkdown("**Done** and done");
    await wrapper.setProps({ searchQuery: "done", searchActive: true });

    expect(wrapper.findAll("mark.markdown-search-hit")).toHaveLength(2);
    expect(wrapper.findAll("mark.is-active")).toHaveLength(2);
    wrapper.unmount();
  });

  it("lights one hit when the caller names which one it is", async () => {
    const { wrapper } = mountMarkdown("**Done** and done");
    await wrapper.setProps({ searchQuery: "done", searchActive: true });
    // The transcript has no index to give (its counter points at a message), so the prop is optional
    // and the behaviour above is unchanged. A single-document search does have one - the file
    // preview - and needs exactly one mark lit out of the two.
    await wrapper.setProps({ searchActiveIndex: 1 });

    const hits = wrapper.findAll("mark.markdown-search-hit");
    expect(hits).toHaveLength(2);
    expect(hits[0].classes()).not.toContain("is-active");
    expect(hits[1].classes()).toContain("is-active");
    // Ordinals are document order, so an out-of-range index lights nothing rather than the wrong one.
    await wrapper.setProps({ searchActiveIndex: 9 });
    expect(wrapper.findAll("mark.is-active")).toHaveLength(0);
    wrapper.unmount();
  });

  // Provider chunks arrive as whole clauses, so a raw render lands a block at a time.
  // While an answer streams, the text is revealed one animation frame at a time instead.
  it("reveals a streamed burst over the next frames instead of landing it whole", async () => {
    vi.useFakeTimers();
    const { wrapper } = mountMarkdown("start");
    await wrapper.setProps({ text: `start ${"tail".repeat(200)}`, streaming: true });

    expect(wrapper.text()).toBe("start");
    await vi.advanceTimersByTimeAsync(64);
    const grown = wrapper.text();
    expect(grown.length).toBeGreaterThan("start".length);
    expect(grown.length).toBeLessThan("start".length + 200 * 4);

    await vi.advanceTimersByTimeAsync(1500);
    expect(wrapper.text()).toBe(`start ${"tail".repeat(200)}`);
    wrapper.unmount();
    vi.useRealTimers();
  });

  it("shows a finished document whole, because only a live source is revealed", async () => {
    vi.useFakeTimers();
    const { wrapper } = mountMarkdown("opened from disk");
    await wrapper.setProps({ text: "opened from disk\n\nand the rest of the file" });

    expect(wrapper.text()).toContain("the rest of the file");
    wrapper.unmount();
    vi.useRealTimers();
  });

  it("lands the whole answer the moment streaming stops", async () => {
    vi.useFakeTimers();
    const { wrapper } = mountMarkdown("half written");
    await wrapper.setProps({ text: "half written and still arriving", streaming: true });
    await wrapper.setProps({ streaming: false });

    expect(wrapper.text()).toBe("half written and still arriving");
    wrapper.unmount();
    vi.useRealTimers();
  });
});

it("renders one newline as a single <br> inside one paragraph", async () => {
  const { wrapper } = mountMarkdown("你好\n都说了封建时代");
  const html = wrapper.get(".markdown-body").element.innerHTML;
  // markdown-it runs with `breaks: true`, so the soft break becomes exactly one <br> and both lines
  // stay inside one <p>. The literal newline left next to the <br> is what the old inherited
  // `white-space: pre-wrap` turned into a second break, which read as a phantom blank line in the
  // transcript; `.markdown-body p { white-space: normal }` in layout.css drops that second break.
  expect(html.trim()).toBe('<p>你好<br>\n都说了封建时代</p>');
  wrapper.unmount();
});

it("renders a large settled document instead of dumping raw text", () => {
  // The 100k ceiling used to apply to every block. A 119,423-char AGENTS.md - a size the
  // file preview reaches routinely, since internal/repository/repository.go:33 caps a
  // preview at 1MiB - therefore rendered as one `<pre>` with an empty outline, while
  // Typora showed the same file formatted. Parsing that document costs 12-15ms.
  const section = "## Heading\n\nA paragraph with **bold**, `code` and a [link](https://example.com).\n\n";
  const text = section.repeat(Math.ceil(119_423 / section.length));
  expect(text.length).toBeGreaterThan(100_000);

  const { wrapper } = mountMarkdown(text);
  expect(document.querySelector(".oversized-message")).toBeNull();
  expect(document.querySelectorAll("h2").length).toBeGreaterThan(100);
  wrapper.unmount();
});

it("keeps the ceiling for a block that is still arriving", () => {
  // A streaming block re-parses on every revealed frame, so past 100k chars it stays raw
  // until the run settles - at which point the test above applies.
  const { wrapper } = mountMarkdown("x".repeat(100_001), { streaming: true });
  expect(document.querySelector("pre.oversized-message")).not.toBeNull();
  wrapper.unmount();
});
