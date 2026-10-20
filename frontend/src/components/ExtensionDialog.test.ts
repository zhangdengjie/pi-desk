import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore, type ExtensionUIRequest } from "../stores/app";
import { agentService } from "../services/agent";
import ExtensionDialog from "./ExtensionDialog.vue";

vi.mock("../services/agent", () => ({ agentService: {}, onPiEvent: () => () => undefined }));
vi.mock("../services/catalog", () => ({ catalogService: {} }));
vi.mock("../services/desktop", () => ({ getBootstrapState: vi.fn() }));
vi.mock("../services/repository", () => ({ repositoryService: {} }));

function setup(request: ExtensionUIRequest, options: { liveRespond?: boolean } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useAppStore();
  store.$patch({
    threads: [{
      id: "thread-1", title: "Extension", workspace: "repo", workspacePath: "D:\\repo", trust: "approve",
      status: "idle", started: true, generation: 1,
    }],
    activeThreadId: "thread-1",
    extensionRequestByThread: { "thread-1": request },
  });
  if (!options.liveRespond) store.respondToExtension = vi.fn().mockResolvedValue(undefined);
  store.dismissExtensionRequest = vi.fn();
  const wrapper = mount(ExtensionDialog, { global: { plugins: [pinia] } });
  return { store, wrapper };
}

describe("ExtensionDialog", () => {
  afterEach(() => vi.useRealTimers());

  it("shows how many more prompts are waiting behind the visible one", async () => {
    const { store, wrapper } = setup({ id: "a", method: "confirm", title: "A", message: "Proceed" });
    expect(wrapper.find(".extension-pending").exists()).toBe(false);

    store.extensionRequestsPendingByThread["thread-1"] = [{ id: "b", method: "confirm" }, { id: "c", method: "confirm" }];
    await wrapper.vm.$nextTick();

    expect(wrapper.get(".extension-pending").text()).toContain("2");
  });

  it("responds to select, input, editor, confirm, and cancel controls", async () => {
    const { store, wrapper } = setup({ id: "select", method: "select", title: "Pick", options: ["Allow", "Block"] });
    await wrapper.findAll(".select-options button")[0].trigger("click");
    expect(store.respondToExtension).toHaveBeenLastCalledWith("Allow");

    store.extensionRequestByThread["thread-1"] = { id: "input", method: "input", title: "Value", placeholder: "Name" };
    await wrapper.vm.$nextTick();
    await wrapper.get("input").setValue("Pi Desk");
    await wrapper.get("input").trigger("keydown", { key: "Enter" });
    expect(store.respondToExtension).toHaveBeenLastCalledWith("Pi Desk");

    store.extensionRequestByThread["thread-1"] = { id: "editor", method: "editor", title: "Edit", prefill: "one" };
    await wrapper.vm.$nextTick();
    await wrapper.get("textarea").setValue("one\ntwo");
    await wrapper.findAll("footer button").at(-1)!.trigger("click");
    expect(store.respondToExtension).toHaveBeenLastCalledWith("one\ntwo");

    store.extensionRequestByThread["thread-1"] = { id: "confirm", method: "confirm", title: "Continue", message: "Proceed?" };
    await wrapper.vm.$nextTick();
    const footerButtons = wrapper.findAll("footer button");
    await footerButtons[1].trigger("click");
    await footerButtons[2].trigger("click");
    expect(store.respondToExtension).toHaveBeenCalledWith(false);
    expect(store.respondToExtension).toHaveBeenCalledWith(true);
    await wrapper.get('button[title="Cancel"]').trigger("click");
    expect(store.respondToExtension).toHaveBeenLastCalledWith(undefined, true);
  });

  it("keeps select rows left-aligned and wrapping, because plan-mode sends terminal-width option strings", async () => {
    // pi-plan-mode has no TUI over RPC, so its tool allowlist falls back to `select` and every row
    // arrives as one long string (`[-] edit — blocked by Plan policy (unavailable: …)`).
    // `ui.button` puts `justify-center` + `whitespace-nowrap` on the element; those are layered
    // `!important` utilities, so layout.css cannot outvote them (AGENTS §4.3) and the row blew past
    // the dialog with the tool name centred off the left edge. Measured in real WebKit:
    // before -> button 1810px wide, first char at x=875; after -> 606px, first char at x=12.
    const { wrapper } = setup({ id: "sel", method: "select", title: "Pick", options: [
      `[-] find — inactive in Pi (unavailable: ${"Not active in Pi; Plan mode will not activate it; ".repeat(3)})`,
    ] });
    const classes = wrapper.get(".select-options button").classes();
    for (const utility of ["justify-center", "whitespace-nowrap", "inline-flex", "min-h-[34px]"]) {
      expect(classes, `select option still carries the layout utility ${utility}`).not.toContain(utility);
    }
    expect(classes).toContain("select-option");

    const { readFile } = await import(["node", "fs/promises"].join(":") as string) as {
      readFile(path: string, encoding: "utf8"): Promise<string>;
    };
    const css = await readFile("src/styles/layout.css", "utf8");
    const list = css.match(/\.select-options \{[^}]*\}/)?.[0] ?? "";
    const row = css.match(/\.select-options \.text-button \{[^}]*\}/)?.[0] ?? "";
    expect(row).toMatch(/text-align:\s*left/);
    expect(row).toMatch(/white-space:\s*normal/);
    // A `grid` row is sized by WebKit's intrinsic-height pass, which uses a width a few px wider
    // than the final layout - so a row that "barely" wraps (e.g. `[-] edit … policy)`, max-content
    // ≈568 vs 567 available) reserved ONE line (csHeight 34 / scrollHeight 43) and the second line
    // spilled onto the border. Block layout has no such pass.
    expect(list).toMatch(/display:\s*block/);
    expect(list).not.toMatch(/display:\s*grid/);
    expect(css).toMatch(/\.select-options > \* \+ \* \{[^}]*margin-top:/);
  });

  it("survives a menu re-issue: same scroll container, same rows, no second answer", async () => {
    // pi-plan-mode's tool allowlist is one `select` per click (pi-tui-kit runtime.js runDialogMenu).
    // The head slot used to be cleared synchronously on click, so App.vue's v-if tore the dialog
    // down and rebuilt it: .dialog-body restarted at scrollTop 0 and every row slid - the jump.
    vi.useFakeTimers();
    const respondExtensionUI = vi.fn().mockResolvedValue(undefined);
    agentService.respondExtensionUI = respondExtensionUI;

    const { store, wrapper } = setup({
      id: "s1", method: "select", title: "Choose Plan policy allowlist\nPlan policy will allow: bash, read.",
      options: ["[ ] read", "[ ] write"],
    }, { liveRespond: true });
    const body = wrapper.get(".dialog-body").element;
    const firstRow = wrapper.get(".select-options button").element;
    expect(wrapper.get(".dialog-window").classes()).toContain("select-dialog");

    await wrapper.get(".select-options button").trigger("click");
    await vi.advanceTimersByTimeAsync(0);

    expect(store.extensionRequestByThread["thread-1"]).toBeUndefined();
    expect(store.extensionDialogVisible).toBe(true);
    expect(wrapper.get(".dialog-body").element).toBe(body);
    // A position key patches the row instead of replacing it.
    expect(wrapper.get(".select-options button").element).toBe(firstRow);
    expect(wrapper.get(".dialog-backdrop").classes()).toContain("extension-dialog-hold");

    // An already answered frame must not answer a second time.
    await wrapper.get(".select-options button").trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    expect(respondExtensionUI).toHaveBeenCalledTimes(1);

    // The next frame of the same menu lands in the surviving element.
    store.queueExtensionRequest("thread-1", {
      id: "s2", method: "select", title: "Choose Plan policy allowlist\nPlan policy will allow: bash, read, git_ops.",
      options: ["[x] read", "[ ] write"],
    });
    await wrapper.vm.$nextTick();
    expect(store.extensionDialogHeldByThread["thread-1"]).toBeUndefined();
    expect(wrapper.get(".dialog-body").element).toBe(body);
    expect(wrapper.get(".select-options button").element).toBe(firstRow);
    expect(wrapper.get(".select-options button").text()).toBe("[x] read");
    expect(wrapper.get(".dialog-backdrop").classes()).not.toContain("extension-dialog-hold");

    // Closing the menu for real: the held frame expires instead of hanging on screen.
    await wrapper.get(".select-options button").trigger("click");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(store.extensionDialogVisible).toBe(false);
    wrapper.unmount();
  });

  it("keeps the extension's line breaks and locks the centred window's height across a re-issue", async () => {
    const { readFile } = await import(["node", "fs/promises"].join(":") as string) as {
      readFile(path: string, encoding: "utf8"): Promise<string>;
    };
    const css = await readFile("src/styles/layout.css", "utf8");
    // The title is title + every description line joined with \n; folding it into one re-wrapped
    // paragraph made the header row's height depend on where the tool names landed.
    expect(css).toMatch(/\.extension-dialog h2 \{[^}]*white-space:\s*pre-line/);
    expect(css).toMatch(/\.dialog-backdrop\.extension-dialog-hold \{[^}]*pointer-events:\s*none/);

    // The user wants it centred, so the height is what has to stop changing instead.
    const { store, wrapper } = setup({
      id: "s1", method: "select", title: "Choose Plan policy allowlist\nPlan policy will allow: bash, read.",
      options: ["[ ] read", "[ ] write"],
    });
    expect(wrapper.get(".dialog-backdrop").classes()).toContain("place-items-center");
    const win = wrapper.get<HTMLElement>(".dialog-window").element;
    expect(win.style.height, "the first frame must keep its natural size").toBe("");

    // jsdom lays nothing out, so hand the component the geometry a real engine would report.
    win.getBoundingClientRect = () => ({ height: 512 }) as unknown as DOMRect;
    store.extensionRequestByThread["thread-1"] = {
      id: "s2", method: "select", title: "Choose Plan policy allowlist\nPlan policy will allow: bash, read, git_ops.",
      options: ["[x] read", "[ ] write"],
    };
    await wrapper.vm.$nextTick();
    expect(win.style.height).toBe("512px");

    // A different screen releases the lock, so it can size itself.
    store.extensionRequestByThread["thread-1"] = { id: "s3", method: "select", title: "Settings", options: ["Theme"] };
    await wrapper.vm.$nextTick();
    expect(win.style.height).toBe("");
  });

  it("renders a batch ask as tabs, preserves option descriptions, reviews, and submits structured answers", async () => {
    const { store, wrapper } = setup({
      id: "batch",
      method: "batch_ask",
      batchReview: true,
      batchQuestions: [
        {
          id: "listen_port", type: "select", question: "服务器对外访问端口使用哪个？", prefill: "8000", allowOther: true,
          placeholder: "也可以填写其他端口",
          options: [
            { label: "8000（推荐）", value: "8000", description: "访问地址为 http://example:8000" },
            { label: "8080", value: "8080", description: "访问地址为 http://example:8080" },
          ],
        },
        {
          id: "data_mode", type: "select", question: "是否迁移现有数据？", allowOther: false,
          options: [
            { label: "完整迁移现有数据（推荐）", value: "migrate", description: "上传配置和数据库" },
            { label: "全新部署", value: "fresh", description: "重新配置" },
          ],
        },
      ],
    });

    expect(wrapper.get("h2").text()).toContain("2");
    expect(wrapper.text()).not.toContain("__piDeckBatchAsk");
    expect(wrapper.get('.batch-question-tabs [role="tab"]').classes()).toContain("answered");
    expect(wrapper.get(".batch-question-options").text()).toContain("访问地址为 http://example:8000");

    await wrapper.findAll('.batch-question-tabs [role="tab"]')[1].trigger("click");
    await wrapper.findAll(".batch-question-options > button")[0].trigger("click");
    await wrapper.get(".batch-question-review-tab").trigger("click");
    expect(wrapper.get(".batch-question-review-list").text()).toContain("完整迁移现有数据（推荐）");
    await wrapper.get(".batch-question-submit").trigger("click");

    const raw = vi.mocked(store.respondToExtension).mock.calls.at(-1)?.[0];
    expect(typeof raw).toBe("string");
    expect(JSON.parse(raw as string)).toEqual({ answers: [
      { id: "listen_port", type: "select", value: "8000", label: "8000（推荐）" },
      { id: "data_mode", type: "select", value: "migrate", label: "完整迁移现有数据（推荐）" },
    ] });
  });

  it("collects confirm, input, and editor questions before enabling submission", async () => {
    const { store, wrapper } = setup({
      id: "mixed-batch",
      method: "batch_ask",
      batchReview: false,
      batchQuestions: [
        { id: "confirm", type: "confirm", question: "Continue?" },
        { id: "name", type: "input", question: "Name?", placeholder: "project" },
        { id: "notes", type: "editor", question: "Notes?", prefill: "existing notes" },
      ],
    });

    await wrapper.findAll(".batch-question-confirm > button")[0].trigger("click");
    await wrapper.findAll('.batch-question-tabs [role="tab"]')[1].trigger("click");
    await wrapper.get('.batch-question-panel > input').setValue("desk");
    await wrapper.findAll('.batch-question-tabs [role="tab"]')[2].trigger("click");
    await wrapper.get(".batch-question-navigation .primary").trigger("click");

    const raw = vi.mocked(store.respondToExtension).mock.calls.at(-1)?.[0];
    expect(JSON.parse(raw as string)).toMatchObject({ answers: [
      { id: "confirm", type: "confirm", value: true },
      { id: "name", type: "input", value: "desk" },
      { id: "notes", type: "editor", value: "existing notes" },
    ] });
  });

  it("submits an allowOther batch selection as a custom answer", async () => {
    const { store, wrapper } = setup({
      id: "custom-batch",
      method: "batch_ask",
      batchReview: false,
      batchQuestions: [{
        id: "port", type: "select", question: "Port?", allowOther: true,
        options: [{ label: "8000", value: "8000" }], placeholder: "Other port",
      }],
    });

    await wrapper.get(".batch-question-custom input").setValue("9000");
    expect(wrapper.get<HTMLButtonElement>(".batch-question-navigation .primary").element.disabled).toBe(true);
    expect(store.respondToExtension).not.toHaveBeenCalled();
    await wrapper.get(".batch-question-custom .text-button").trigger("click");
    await wrapper.get(".batch-question-navigation .primary").trigger("click");
    const raw = vi.mocked(store.respondToExtension).mock.calls.at(-1)?.[0];
    expect(JSON.parse(raw as string)).toEqual({ answers: [
      { id: "port", type: "select", value: "9000", label: "9000", wasCustom: true },
    ] });
  });

  it("dismisses a dialog locally when Pi's timeout elapses", async () => {
    vi.useFakeTimers();
    const { store, wrapper } = setup({ id: "timed", method: "confirm", title: "Continue", message: "Proceed?", timeout: 250 });
    await vi.advanceTimersByTimeAsync(250);
    expect(store.dismissExtensionRequest).toHaveBeenCalledWith("timed");
    wrapper.unmount();
  });
});
