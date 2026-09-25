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



function mountMarkdown(text: string) {
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
  return { store, wrapper: mount(MarkdownBody, { props: { text }, attachTo: document.body, global: { plugins: [pinia] } }) };
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
    expect(store.openRepositoryFilePreview).toHaveBeenCalledWith("reports/tg_groups.csv", undefined);

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

  it("highlights search matches in rendered Markdown", async () => {
    const { wrapper } = mountMarkdown("**Done** and done");
    await wrapper.setProps({ searchQuery: "done", searchActive: true });

    expect(wrapper.findAll("mark.markdown-search-hit")).toHaveLength(2);
    expect(wrapper.findAll("mark.is-active")).toHaveLength(2);
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
