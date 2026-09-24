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
});
