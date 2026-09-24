import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ToolCallPanel from "./ToolCallPanel.vue";
import { forgetPanelOpenStates } from "../utils/detailsOpenState";

describe("ToolCallPanel", () => {
  // The expansion memory is module-scoped, so a click in one case must not decide
  // the next one.
  beforeEach(() => forgetPanelOpenStates());

  it("summarizes commands and exposes input and output copy actions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const wrapper = mount(ToolCallPanel, {
      props: { tool: { id: "tool-1", name: "bash", arguments: { command: "npm test" }, output: "all passed", status: "complete" } },
    });

    expect(wrapper.find("summary").text()).toContain("bash npm test");
    expect(wrapper.find("summary").text()).toContain("Complete");
    expect(wrapper.get(".tool-summary").element.nextElementSibling).toBe(wrapper.get(".tool-status").element);
    await wrapper.get('[aria-label="Copy tool input"]').trigger("click");
    await wrapper.get('[aria-label="Copy tool output"]').trigger("click");
    expect(writeText).toHaveBeenNthCalledWith(1, JSON.stringify({ command: "npm test" }, null, 2));
    expect(writeText).toHaveBeenNthCalledWith(2, "all passed");
  });

  it("keeps failed calls collapsed by default and labels projected output truncation", async () => {
    const wrapper = mount(ToolCallPanel, {
      props: { tool: { id: "tool-2", name: "read", arguments: { path: "main.go" }, output: "partial", truncated: true, status: "error" } },
    });

    expect(wrapper.get("details").attributes("open")).toBeUndefined();
    expect(wrapper.text()).toContain("Failed");
    await wrapper.get("summary").trigger("click");
    expect(wrapper.get("details").attributes("open")).toBeDefined();
    expect(wrapper.text()).toContain("Truncated in view");
  });

  it("keeps a call closed while it runs after the answer already started", async () => {
    vi.useFakeTimers();
    const wrapper = mount(ToolCallPanel, {
      props: { tool: { id: "tool-no-live", name: "bash", output: "npm test\nrunning", status: "running" }, allowLive: false },
    });

    await vi.advanceTimersByTimeAsync(3000);

    expect(wrapper.get("details").attributes("open")).toBeUndefined();
    expect(wrapper.get(".tool-output").text()).toContain("running");
    wrapper.unmount();
    vi.useRealTimers();
  });

  it("scrolls the live output window to its newest chunk instead of growing the row", async () => {
    vi.useFakeTimers();
    const wrapper = mount(ToolCallPanel, {
      props: { tool: { id: "tool-tail", name: "bash", output: "first chunk", status: "running" } },
    });
    await vi.advanceTimersByTimeAsync(1200);
    const panel = wrapper.get(".tool-output").element as HTMLElement;
    Object.defineProperty(panel, "scrollHeight", { configurable: true, get: () => 720 });

    await wrapper.setProps({ tool: { id: "tool-tail", name: "bash", output: "first chunk\nsecond chunk", status: "running" } });
    await vi.advanceTimersByTimeAsync(64);

    expect(panel.scrollTop).toBe(720);

    await wrapper.setProps({ tool: { id: "tool-tail", name: "bash", output: "first chunk\nsecond chunk", status: "complete" } });
    expect(wrapper.get("details").attributes("open")).toBeUndefined();
    wrapper.unmount();
    vi.useRealTimers();
  });

  // The window is capped (132px running, 300px settled), so a call that never crosses
  // the live-window delay still has its newest lines below the fold unless the box
  // follows its own tail. That is the case readers hit with a fast bash/git command in
  // alwaysOpen.
  it("follows the tail of a fast call's output window without waiting for the live delay", async () => {
    const wrapper = mount(ToolCallPanel, {
      props: { tool: { id: "tool-fast", name: "bash", output: "one", status: "running" }, panelMode: "alwaysOpen", runIsLive: true },
    });
    const panel = wrapper.get(".tool-output").element as HTMLElement;
    Object.defineProperties(panel, {
      clientHeight: { configurable: true, get: () => 132 },
      scrollHeight: { configurable: true, get: () => 880 },
    });

    await wrapper.setProps({ tool: { id: "tool-fast", name: "bash", output: "one\ntwo", status: "running" }, panelMode: "alwaysOpen", runIsLive: true });
    await nextTick();
    expect(panel.scrollTop).toBe(880);

    // The reader scrolls up inside the box: following again would yank them back.
    panel.scrollTop = 120;
    panel.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    await wrapper.setProps({ tool: { id: "tool-fast", name: "bash", output: "one\ntwo\nthree", status: "running" }, panelMode: "alwaysOpen", runIsLive: true });
    await nextTick();
    expect(panel.scrollTop).toBe(120);

    // Coming back to the bottom re-arms it on its own.
    panel.scrollTop = 760;
    panel.dispatchEvent(new Event("scroll"));
    await wrapper.setProps({ tool: { id: "tool-fast", name: "bash", output: "one\ntwo\nthree\nfour", status: "running" }, panelMode: "alwaysOpen", runIsLive: true });
    await nextTick();
    expect(panel.scrollTop).toBe(880);
    wrapper.unmount();
  });

  // A finished call of a run this window watched still lands on its last line: the box
  // grows from 132px to 300px when the run settles, and the newest output is the reason
  // the reader opened it.
  it("leaves a settled call showing its last line", async () => {
    const wrapper = mount(ToolCallPanel, {
      props: { tool: { id: "tool-settle", name: "bash", output: "line one", status: "running" }, panelMode: "alwaysOpen", runIsLive: true },
    });
    const panel = wrapper.get(".tool-output").element as HTMLElement;
    const sizes = { clientHeight: 132, scrollHeight: 880 };
    Object.defineProperties(panel, {
      clientHeight: { configurable: true, get: () => sizes.clientHeight },
      scrollHeight: { configurable: true, get: () => sizes.scrollHeight },
    });
    await wrapper.setProps({ tool: { id: "tool-settle", name: "bash", output: "line one\nline two", status: "running" }, panelMode: "alwaysOpen", runIsLive: true });
    await nextTick();

    sizes.clientHeight = 300;
    sizes.scrollHeight = 1600;
    await wrapper.setProps({ tool: { id: "tool-settle", name: "bash", output: "line one\nline two", status: "complete" }, panelMode: "alwaysOpen", runIsLive: true });
    await nextTick();

    expect(panel.scrollTop).toBe(1600);
    wrapper.unmount();
  });

  // The tail follow is for output that is arriving now. A long call the reader opens by
  // hand afterwards has to start at the top, which is where they mean to read it.
  it("does not jump a finished call the reader opens by hand", async () => {
    const wrapper = mount(ToolCallPanel, {
      props: { tool: { id: "tool-hand", name: "bash", output: "x".repeat(900), status: "complete" }, runIsLive: true },
    });
    const panel = wrapper.get(".tool-output").element as HTMLElement;
    Object.defineProperties(panel, {
      clientHeight: { configurable: true, get: () => 300 },
      scrollHeight: { configurable: true, get: () => 1600 },
    });

    await wrapper.get("summary").trigger("click");
    await nextTick();

    expect(wrapper.get("details").attributes("open")).toBeDefined();
    expect(panel.scrollTop).toBe(0);
    wrapper.unmount();
  });

  it("remembers a reader's expansion of a finished call across re-creation", async () => {
    const tool = { id: "tool-memory", name: "read", output: "source", status: "complete" as const };
    const wrapper = mount(ToolCallPanel, { props: { tool } });
    expect(wrapper.get("details").attributes("open")).toBeUndefined();

    await wrapper.get("summary").trigger("click");
    expect(wrapper.get("details").attributes("open")).toBeDefined();
    wrapper.unmount();

    const recreated = mount(ToolCallPanel, { props: { tool } });
    expect(recreated.get("details").attributes("open")).toBeDefined();
    recreated.unmount();
  });

  it("opens the live window only once a call is slow enough to wait on", async () => {
    vi.useFakeTimers();
    const wrapper = mount(ToolCallPanel, {
      props: { tool: { id: "tool-live", name: "read", output: "partial", status: "running" } },
    });

    expect(wrapper.get("details").attributes("open")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1200);
    expect(wrapper.get("details").attributes("open")).toBeDefined();

    await wrapper.setProps({ tool: { id: "tool-live", name: "read", output: "done", status: "complete" } });
    expect(wrapper.get("details").attributes("open")).toBeUndefined();
    wrapper.unmount();
    vi.useRealTimers();
  });

  it("never touches the layout for a call that finishes before the window would open", async () => {
    vi.useFakeTimers();
    const wrapper = mount(ToolCallPanel, {
      props: { tool: { id: "tool-fast", name: "bash", output: "", status: "running" } },
    });

    await wrapper.setProps({ tool: { id: "tool-fast", name: "bash", output: "all passed", status: "complete" } });
    await vi.advanceTimersByTimeAsync(5000);

    expect(wrapper.get("details").attributes("open")).toBeUndefined();
    wrapper.unmount();
    vi.useRealTimers();
  });

  it("contains clipboard permission failures", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const wrapper = mount(ToolCallPanel, {
      props: { tool: { id: "tool-3", name: "read", output: "content", status: "complete" } },
    });

    await expect(wrapper.get('[aria-label="Copy tool output"]').trigger("click")).resolves.toBeUndefined();
  });

  it("shows duration and a colored inline diff for edit and write tools", () => {
    const wrapper = mount(ToolCallPanel, {
      props: {
        tool: {
          id: "tool-4", name: "edit", arguments: { path: "main.go" }, output: "ok", status: "complete", durationMs: 16700,
          diff: { path: "main.go", text: "- 1 old\n+ 1 new" },
        },
      },
    });

    expect(wrapper.get("summary").text()).toContain("17s");
    expect(wrapper.get(".tool-diff-badge").text()).toBe("diff");
    expect(wrapper.get(".tool-diff-section").text()).toContain("main.go");
    expect(wrapper.findAll(".diff-line")[0].classes()).toContain("is-removed");
    expect(wrapper.findAll(".diff-line")[1].classes()).toContain("is-added");
  });

  it("renders result images with a fullscreen preview", async () => {
    const wrapper = mount(ToolCallPanel, {
      props: {
        tool: {
          id: "tool-5", name: "computer_screenshot", output: "captured", status: "complete",
          images: [{ id: "img-1", name: "Image 1", data: "abc", mimeType: "image/jpeg", previewUrl: "data:image/jpeg;base64,abc" }],
        },
      },
    });

    const thumb = wrapper.get(".tool-image-open img");
    expect(thumb.attributes("src")).toBe("data:image/jpeg;base64,abc");
    expect(document.body.querySelector(".image-preview-dialog")).toBeNull();
    await wrapper.get(".tool-image-open").trigger("click");
    const preview = document.body.querySelector(".image-preview-dialog img");
    expect(preview?.getAttribute("src")).toBe("data:image/jpeg;base64,abc");
    document.body.innerHTML = "";
  });

  it("renders subagent calls with a bot icon, an agent chip, and a task summary", () => {
    const wrapper = mount(ToolCallPanel, {
      props: { tool: { id: "tool-6", name: "subagent", arguments: { agent: "scout", task: "find  entry points" }, output: "done", status: "complete" } },
    });

    expect(wrapper.find("summary .lucide-bot").exists()).toBe(true);
    expect(wrapper.get(".tool-summary").text()).toBe("subagent");
    expect(wrapper.get(".tool-agent-chip").text()).toBe("scout");
    expect(wrapper.get(".tool-subtitle").text()).toBe("find entry points");
  });

  it("summarizes parallel and chain subagent dispatches in the agent chip", () => {
    const parallel = mount(ToolCallPanel, {
      props: {
        tool: {
          id: "tool-7", name: "subagent", output: "", status: "complete",
          arguments: { tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b" }, { agent: "planner", task: "c" }] },
        },
      },
    });
    expect(parallel.get(".tool-agent-chip").text()).toBe("scout, planner ×3");

    const chain = mount(ToolCallPanel, {
      props: {
        tool: {
          id: "tool-8", name: "subagent", output: "", status: "complete",
          arguments: { chain: [{ agent: "scout", task: "a" }, { agent: "planner", task: "{previous}" }] },
        },
      },
    });
    expect(chain.get(".tool-agent-chip").text()).toBe("scout → planner");
  });

  it("lists live per-delegate status and usage from subagent details", () => {
    const wrapper = mount(ToolCallPanel, {
      props: {
        tool: {
          id: "tool-9", name: "subagent", output: "working", status: "running",
          subagents: {
            mode: "parallel",
            tasks: [
              { agent: "scout", status: "ok", inputTokens: 1200, outputTokens: 345, cost: 0.0042, model: "z-ai/glm-5.3" },
              { agent: "planner", status: "running", inputTokens: 0, outputTokens: 0, cost: 0 },
              { agent: "writer", status: "error", inputTokens: 90, outputTokens: 0, cost: 0 },
            ],
          },        },
      },
    });

    const rows = wrapper.findAll(".tool-subagent-row");
    expect(rows).toHaveLength(3);
    expect(rows[0].get(".tool-subagent-name").text()).toBe("scout");
    expect(rows[0].attributes("data-status")).toBe("ok");
    expect(rows[0].get(".tool-subagent-meta").text()).toBe("↑1.2k ↓345 $0.0042");
    expect(rows[1].attributes("data-status")).toBe("running");
    expect(rows[1].find(".tool-subagent-meta").exists()).toBe(false);
    expect(rows[2].attributes("data-status")).toBe("error");
  });

  // The `streamPanels` modes only speak about a turn this window watched, so every
  // case here passes runIsLive the way ConversationMessage does while streaming.
  it("stays open after the call finishes when the run asked for alwaysOpen", async () => {
    vi.useFakeTimers();
    const wrapper = mount(ToolCallPanel, {
      props: {
        tool: { id: "tool-always", name: "bash", output: "built", status: "running" },
        panelMode: "alwaysOpen",
        runIsLive: true,
      },
    });
    await vi.advanceTimersByTimeAsync(1200);
    expect(wrapper.get("details").attributes("open")).toBeDefined();

    await wrapper.setProps({ tool: { id: "tool-always", name: "bash", output: "built", status: "complete" } });
    expect(wrapper.get("details").attributes("open")).toBeDefined();
    wrapper.unmount();
    vi.useRealTimers();
  });

  it("never opens a running call by itself in alwaysClosed, click still works", async () => {
    vi.useFakeTimers();
    const wrapper = mount(ToolCallPanel, {
      props: { tool: { id: "tool-shut", name: "bash", output: "built", status: "running" }, panelMode: "alwaysClosed", runIsLive: true },
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(wrapper.get("details").attributes("open")).toBeUndefined();

    await wrapper.get("summary").trigger("click");
    expect(wrapper.get("details").attributes("open")).toBeDefined();
    wrapper.unmount();
    vi.useRealTimers();
  });

  it("ignores alwaysOpen for a call that arrived from a saved session", () => {
    const wrapper = mount(ToolCallPanel, {
      props: { tool: { id: "tool-old", name: "read", output: "source", status: "complete" }, panelMode: "alwaysOpen" },
    });

    expect(wrapper.get("details").attributes("open")).toBeUndefined();
    wrapper.unmount();
  });
});
