import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore, type TimelineMessage } from "../stores/app";
import ConversationPane from "./ConversationPane.vue";

vi.mock("../services/agent", () => ({
  agentService: { getState: vi.fn().mockResolvedValue({}) },
  onPiEvent: () => vi.fn(),
}));
vi.mock("../services/catalog", () => ({ catalogService: {} }));
vi.mock("../services/desktop", () => ({ getBootstrapState: vi.fn() }));
vi.mock("../services/repository", () => ({ repositoryService: {} }));

function transcript(length: number): TimelineMessage[] {
  return Array.from({ length }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 ? "assistant" : "user",
    text: `Message ${index}`,
    thinking: "",
    timestamp: "10:00",
    streaming: false,
    tools: [],
  }));
}

describe("ConversationPane", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.unstubAllGlobals());

  function mountTranscript(length: number) {
    const store = useAppStore();
    store.threads = [{
      id: "thread-1", title: "Long task", workspace: "repo", workspacePath: "D:\\repo",
      trust: "deny", status: "idle", started: false, generation: 0,
    }];
    store.activeThreadId = "thread-1";
    store.messagesByThread["thread-1"] = transcript(length);
    return mount(ConversationPane, {
      global: {
        stubs: {
          ComposerBar: true,
          ConversationMessage: { props: ["message"], template: '<article class="stub-message" :data-message-id="message.id" :data-role="message.role">{{ message.text }}</article>' },
        },
      },
    });
  }

  it("keeps the workspace blank when no task is selected", () => {
    const wrapper = mount(ConversationPane, { global: { stubs: { ComposerBar: true } } });

    expect(wrapper.get(".empty-workspace").text()).toBe("");
    expect(wrapper.find(".welcome-empty").exists()).toBe(false);
    expect(wrapper.find(".empty-logo").exists()).toBe(false);
    expect(wrapper.find("composer-bar-stub").exists()).toBe(false);
  });

  it("keeps short transcripts on the exact DOM path", () => {
    const wrapper = mountTranscript(80);
    expect(wrapper.find("[data-virtualized]").exists()).toBe(false);
    expect(wrapper.findAll(".stub-message")).toHaveLength(80);
    expect(wrapper.find("composer-bar-stub").exists()).toBe(true);
  });

  it("measures the composer stack and follows its growth only while pinned to the bottom", async () => {
    const observers: Array<{ callback: () => void; target?: Element; disconnect: () => void }> = [];
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("ResizeObserver", class {
      record: (typeof observers)[number];
      constructor(callback: () => void) {
        this.record = { callback, disconnect: vi.fn() };
        observers.push(this.record);
      }
      observe(target: Element) { this.record.target = target; }
      unobserve() {}
      disconnect() { this.record.disconnect(); }
    });
    const wrapper = mountTranscript(4);
    await flushPromises();
    const composer = wrapper.get("composer-bar-stub").element;
    const observer = observers.find((item) => item.target === composer)!;
    expect(observer).toBeDefined();
    const timeline = wrapper.get(".timeline").element as HTMLElement;
    Object.defineProperties(timeline, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 1200 },
    });
    timeline.scrollTop = 600;
    await wrapper.get(".timeline").trigger("scroll");
    const rect = vi.spyOn(composer, "getBoundingClientRect").mockReturnValue({ height: 320 } as DOMRect);

    observer.callback();
    frames.at(-1)?.(0);
    await flushPromises();

    expect((wrapper.get(".timeline").element as HTMLElement).style.getPropertyValue("--composer-overlay-reserve")).toBe("320px");
    expect(timeline.scrollTop).toBe(1200);

    timeline.scrollTop = 100;
    await wrapper.get(".timeline").trigger("scroll");
    rect.mockReturnValue({ height: 400 } as DOMRect);
    observer.callback();
    frames.at(-1)?.(0);
    await flushPromises();

    expect((wrapper.get(".timeline").element as HTMLElement).style.getPropertyValue("--composer-overlay-reserve")).toBe("400px");
    expect(timeline.scrollTop).toBe(100);
    wrapper.unmount();
    expect(observer.disconnect).toHaveBeenCalled();
  });

  async function mountPinnedTail() {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const store = useAppStore();
    const wrapper = mountTranscript(4);
    await flushPromises();
    const sizes = { clientHeight: 600, scrollHeight: 1800 };
    const timeline = wrapper.get(".timeline").element as HTMLElement;
    Object.defineProperties(timeline, {
      clientHeight: { configurable: true, get: () => sizes.clientHeight },
      scrollHeight: { configurable: true, get: () => sizes.scrollHeight },
    });
    const settle = async () => {
      await nextTick();
      while (frames.length) frames.shift()?.(0);
      await flushPromises();
    };
    // Growing the tail is what normally triggers the follow; scrollHeight has to
    // move with it because jsdom lays nothing out.
    const stream = async (text: string, scrollHeight: number) => {
      const messages = store.messagesByThread["thread-1"];
      messages[messages.length - 1].text = text;
      sizes.scrollHeight = scrollHeight;
      await settle();
    };
    return { wrapper, timeline, stream, settle };
  }

  it("stops following the tail when a small wheel flick escapes the bottom", async () => {
    const { wrapper, timeline, stream } = await mountPinnedTail();

    // 20px above the bottom: the scroll handler alone would keep following.
    timeline.scrollTop = 1180;
    await wrapper.get(".timeline").trigger("wheel", { deltaY: -30 });
    await stream("Message 3 is still writing", 1900);

    expect(timeline.scrollTop).toBe(1180);
    wrapper.unmount();
  });

  it("stops following the tail for scroll sources without a wheel gesture", async () => {
    const { wrapper, timeline, stream } = await mountPinnedTail();

    // 40px off the bottom used to sit inside the old 96px "near bottom" band, so
    // a keyboard or scrollbar move that far never released the pin.
    timeline.scrollTop = 1160;
    await wrapper.get(".timeline").trigger("scroll");
    await stream("Message 3 is still writing", 1900);

    expect(timeline.scrollTop).toBe(1160);
    wrapper.unmount();
  });

  // Scroll anchoring is the other author of scroll events: when a reasoning window
  // collapses above the viewport the browser compensates scrollTop by itself, and reading
  // that as "the reader left" would disarm the follow in the middle of a run - the
  // transcript then sits still while the answer keeps streaming.
  it("keeps following when scroll anchoring nudges the position mid-stream", async () => {
    const { wrapper, timeline, stream } = await mountPinnedTail();

    await stream("the answer is growing", 1900);
    timeline.scrollTop = 1160; // 140px above the new bottom, with no input behind it
    await wrapper.get(".timeline").trigger("scroll");
    await stream("and still growing", 2020);

    expect(timeline.scrollTop).toBe(2020);

    // Real input still releases it, grace or not.
    await wrapper.get(".timeline").trigger("wheel", { deltaY: -30 });
    timeline.scrollTop = 1200; // 220px above the bottom of a 2020px document
    await wrapper.get(".timeline").trigger("scroll");
    await stream("and again", 2200);
    expect(timeline.scrollTop).toBe(1200);
    wrapper.unmount();
  });

  it("resumes following the tail once the reader is back at the bottom", async () => {
    const { wrapper, timeline, stream } = await mountPinnedTail();

    timeline.scrollTop = 1160;
    await wrapper.get(".timeline").trigger("wheel", { deltaY: -30 });
    await stream("Message 3 is still writing", 1900);
    expect(timeline.scrollTop).toBe(1160);

    // The tail grew to 1900, so its bottom now sits at scrollTop 1300.
    timeline.scrollTop = 1300;
    await wrapper.get(".timeline").trigger("scroll");
    await stream("Message 3 finished writing", 2020);

    expect(timeline.scrollTop).toBe(2020);
    wrapper.unmount();
  });

  it("keeps following while the wheel is still feeding a nested scroll container", async () => {
    const { wrapper, timeline, stream } = await mountPinnedTail();
    const reasoning = wrapper.findAll(".stub-message")[1].element;
    Object.defineProperties(reasoning, {
      scrollTop: { configurable: true, get: () => 40 },
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });

    timeline.scrollTop = 1200;
    await wrapper.get(".timeline").trigger("scroll");
    await wrapper.findAll(".stub-message")[1].trigger("wheel", { deltaY: -30 });
    await stream("Message 3 is still writing", 1900);

    expect(timeline.scrollTop).toBe(1900);
    wrapper.unmount();
  });

  it("offers a one-click return to the tail after the reader scrolls away", async () => {
    const { wrapper, timeline, stream } = await mountPinnedTail();
    expect(wrapper.find(".timeline-jump-latest").exists()).toBe(false);

    timeline.scrollTop = 1160;
    await wrapper.get(".timeline").trigger("wheel", { deltaY: -30 });
    await stream("Message 3 is still writing", 1900);

    expect(wrapper.find(".timeline-jump-latest").exists()).toBe(true);
    await wrapper.get(".timeline-jump-latest").trigger("click");
    expect(timeline.scrollTop).toBe(1900);
    expect(wrapper.find(".timeline-jump-latest").exists()).toBe(false);

    await stream("Message 3 finished writing", 2020);
    expect(timeline.scrollTop).toBe(2020);
    wrapper.unmount();
  });

  it("re-pins the tail in the same frame a panel above it collapses", async () => {
    const frames: FrameRequestCallback[] = [];
    const observers: Array<{ callback: () => void; targets: Element[]; disconnect: () => void }> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("ResizeObserver", class {
      record: { callback: () => void; targets: Element[]; disconnect: () => void };
      constructor(callback: () => void) {
        this.record = { callback, targets: [], disconnect: vi.fn() };
        observers.push(this.record);
      }
      observe(target: Element) { this.record.targets.push(target); }
      unobserve() {}
      disconnect() { this.record.disconnect(); }
    });
    const wrapper = mountTranscript(4);
    await flushPromises();

    const sizes = { clientHeight: 600, scrollHeight: 1800 };
    const timeline = wrapper.get(".timeline").element as HTMLElement;
    Object.defineProperties(timeline, {
      clientHeight: { configurable: true, get: () => sizes.clientHeight },
      scrollHeight: { configurable: true, get: () => sizes.scrollHeight },
    });
    timeline.scrollTop = 1200;
    await wrapper.get(".timeline").trigger("scroll");
    const rowObserver = observers.find((entry) => entry.targets.some((target) => target.classList.contains("stub-message")));
    expect(rowObserver).toBeDefined();

    // The reasoning window closes: the document loses its 168px and the browser
    // has already clamped scrollTop down before anything repaints.
    sizes.scrollHeight = 1632;
    timeline.scrollTop = 1032;
    rowObserver!.callback();

    expect(timeline.scrollTop).toBe(1632);
    wrapper.unmount();
    expect(rowObserver!.disconnect).toHaveBeenCalled();
  });

  // End to end on purpose: the real store event path, the real row, the real
  // MarkdownBody and ToolCallPanel. Per-layer unit tests cannot show what a reader
  // actually sees - that growth moves every frame instead of landing in clauses, and
  // that in alwaysOpen the panels of the turn are still open after it settles.
  it("reveals a streamed turn frame by frame and keeps its panels open in alwaysOpen", async () => {
    vi.useFakeTimers();
    const store = useAppStore();
    store.threads = [{
      id: "thread-stream", title: "Run", workspace: "repo", workspacePath: "/repo",
      trust: "approve", status: "running", started: true, generation: 4,
    } as never];
    store.activeThreadId = "thread-stream";
    store.messagesByThread["thread-stream"] = [];
    store.notificationsEnabled = false;
    store.streamPanels = "alwaysOpen";
    const wrapper = mount(ConversationPane, { global: { stubs: { ComposerBar: true } } });
    const send = (type: string, payload: Record<string, unknown> = {}) =>
      store.handlePiEvent({ threadId: "thread-stream", event: { generation: 4, type, payload } as never });
    const answer = () => wrapper.get(".message-content > .markdown-body").text();

    send("message_start", { message: { role: "assistant", id: "a1", content: [] } });
    await nextTick();
    // An empty assistant message is not a turn yet: grouping drops it until it carries
    // something, and the waiting spinner stands in for it.
    expect(wrapper.find(".message-content > .markdown-body").exists()).toBe(false);

    send("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "thinking of it" } });
    await nextTick();
    const reasoning = () => wrapper.get(".thinking-body").text();
    expect(reasoning()).toBe("thinking of it");

    const burst = "reasoning ".repeat(80).trim();
    send("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: ` ${burst}` } });
    await nextTick();
    // The whole burst is already in the store, and none of it is on screen: a frame
    // has not run yet. That is the difference from landing a clause at a time.
    const held = ("thinking of it " + burst).length;
    expect(reasoning()).toBe("thinking of it");
    await vi.advanceTimersByTimeAsync(16);
    const firstStep = reasoning().length;
    expect(firstStep).toBeGreaterThan("thinking of it".length);
    expect(firstStep).toBeLessThan(held);
    await vi.advanceTimersByTimeAsync(16);
    expect(reasoning().length).toBeGreaterThan(firstStep);
    await vi.advanceTimersByTimeAsync(2000);
    expect(reasoning()).toBe(`thinking of it ${burst}`);

    send("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
    send("tool_execution_update", { toolCallId: "t1", toolName: "bash", partialResult: { content: [{ type: "text", text: "listing" }] } });
    await nextTick();
    // Same rule everywhere: a panel's first appearance lands whole, growth animates.
    expect(wrapper.get(".tool-output").text()).toBe("listing");
    send("tool_execution_update", { toolCallId: "t1", toolName: "bash", partialResult: { content: [{ type: "text", text: `listing${"x".repeat(400)}` }] } });
    await nextTick();
    expect(wrapper.get(".tool-output").text()).toBe("listing");
    await vi.advanceTimersByTimeAsync(16);
    const outputStep = wrapper.get(".tool-output").text().length;
    expect(outputStep).toBeGreaterThan("listing".length);
    expect(outputStep).toBeLessThan(407);
    await vi.advanceTimersByTimeAsync(3000);
    expect(wrapper.get(".tool-output").text()).toBe(`listing${"x".repeat(400)}`);
    send("tool_execution_end", { toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "x".repeat(400) }] } });
    await nextTick();
    expect(wrapper.get(".tool-output").text()).toBe("x".repeat(400));

    send("message_update", { assistantMessageEvent: { type: "text_delta", delta: "so" } });
    await nextTick();
    expect(answer()).toBe("so");
    send("message_update", { assistantMessageEvent: { type: "text_delta", delta: "answer ".repeat(80) } });
    await nextTick();
    expect(answer()).toBe("so");
    await vi.advanceTimersByTimeAsync(16);
    const answerStep = answer().length;
    expect(answerStep).toBeGreaterThan(2);
    expect(answerStep).toBeLessThan(562);
    await vi.advanceTimersByTimeAsync(16);
    expect(answer().length).toBeGreaterThan(answerStep);
    await vi.advanceTimersByTimeAsync(2000);
    expect(answer()).toBe(("so" + "answer ".repeat(80)).trim());

    send("message_end", { message: { role: "assistant", content: [{ type: "text", text: "so" + "answer ".repeat(80) }] } });
    send("agent_settled", {});
    await nextTick();
    await vi.advanceTimersByTimeAsync(200);

    expect(wrapper.get(".execution-process").attributes("open")).toBeDefined();
    expect(wrapper.get(".thinking-block").attributes("open")).toBeDefined();
    expect(wrapper.get(".tool-call").attributes("open")).toBeDefined();
    wrapper.unmount();
    vi.useRealTimers();
  });
  // A jump bigger than a typing step is eased over frames, and every step of that ease
  // moves the scroll position - which the browser reports as a scroll event. If the
  // follow read its own steps as "the reader left the tail", one jump would be enough
  // to stop following the run for good.
  it("keeps following the tail across an eased jump", async () => {
    const frames: FrameRequestCallback[] = [];
    const observers: Array<{ callback: () => void; targets: Element[] }> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("ResizeObserver", class {
      record: { callback: () => void; targets: Element[] };
      constructor(callback: () => void) {
        this.record = { callback, targets: [] };
        observers.push(this.record);
      }
      observe(target: Element) { this.record.targets.push(target); }
      unobserve() {}
      disconnect() {}
    });
    const wrapper = mountTranscript(4);
    await flushPromises();

    const sizes = { clientHeight: 600, scrollHeight: 1800 };
    const timeline = wrapper.get(".timeline").element as HTMLElement;
    Object.defineProperties(timeline, {
      clientHeight: { configurable: true, get: () => sizes.clientHeight },
      scrollHeight: { configurable: true, get: () => sizes.scrollHeight },
    });
    timeline.scrollTop = 1200;
    await wrapper.get(".timeline").trigger("scroll");

    // A panel opens below the fold: 900px of content in one frame.
    sizes.scrollHeight = 2700;
    const rowObserver = observers.find((entry) => entry.targets.some((target) => target.classList.contains("stub-message")))!;
    rowObserver.callback();

    expect(timeline.scrollTop).toBeGreaterThan(1200);
    expect(timeline.scrollTop).toBeLessThan(2100);

    await wrapper.get(".timeline").trigger("scroll");
    for (let guard = 0; guard < 40 && frames.length; guard += 1) frames.shift()!(0);
    expect(timeline.scrollTop).toBe(2700);
    wrapper.unmount();
  });

  it("leaves the reader's place alone when a collapsed panel grows above them", async () => {
    const frames: FrameRequestCallback[] = [];
    const observers: Array<{ callback: () => void; targets: Element[] }> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("ResizeObserver", class {
      record: { callback: () => void; targets: Element[] };
      constructor(callback: () => void) {
        this.record = { callback, targets: [] };
        observers.push(this.record);
      }
      observe(target: Element) { this.record.targets.push(target); }
      unobserve() {}
      disconnect() {}
    });
    const wrapper = mountTranscript(4);
    await flushPromises();

    const timeline = wrapper.get(".timeline").element as HTMLElement;
    Object.defineProperties(timeline, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 1800 },
    });
    timeline.scrollTop = 1160;
    await wrapper.get(".timeline").trigger("wheel", { deltaY: -30 });
    const rowObserver = observers.find((entry) => entry.targets.some((target) => target.classList.contains("stub-message")))!;

    rowObserver.callback();

    expect(timeline.scrollTop).toBe(1160);
    wrapper.unmount();
  });

  it("keeps an opened reasoning block across the row remount a new assistant message causes", async () => {
    const store = useAppStore();
    store.threads = [{
      id: "thread-1", title: "Streaming task", workspace: "repo", workspacePath: "D:\\repo",
      trust: "deny", status: "running", started: true, generation: 1,
    }];
    store.activeThreadId = "thread-1";
    store.messagesByThread["thread-1"] = [
      { id: "u1", role: "user", text: "Go", thinking: "", timestamp: "10:00", streaming: false, tools: [] },
      { id: "a1", role: "assistant", text: "", thinking: "Reading the scroll code", timestamp: "10:01", streaming: true, tools: [] },
    ];
    const wrapper = mount(ConversationPane, { global: { stubs: { ComposerBar: true } } });
    await flushPromises();

    const rowIds = () => wrapper.findAll(".message-row").map((row) => row.attributes("data-message-id"));
    expect(rowIds()).toEqual(["u1", "a1"]);
    const block = wrapper.get(".thinking-block");
    expect(block.attributes("open")).toBeUndefined();
    (block.element as HTMLDetailsElement).open = true;
    await block.trigger("toggle");
    expect(wrapper.get(".thinking-block").attributes("open")).toBeDefined();
    const blockElement = wrapper.get(".thinking-block").element;
    const reasoningBody = wrapper.get(".thinking-block .thinking-body").element as HTMLElement;
    reasoningBody.scrollTop = 120;

    // The next Pi message of the same run moves the merged row id. The row key
    // follows the run instead, so the panels keep their DOM node, their open
    // state, and the reader's place inside a long reasoning block.
    store.messagesByThread["thread-1"].push(
      { id: "a2", role: "assistant", text: "Still working", thinking: "", timestamp: "10:02", streaming: true, tools: [] },
    );
    await nextTick();
    await flushPromises();

    expect(rowIds()).toEqual(["u1", "a2"]);
    expect(wrapper.get(".thinking-block").element).toBe(blockElement);
    expect(wrapper.get(".thinking-block").attributes("open")).toBeDefined();
    expect((wrapper.get(".thinking-block .thinking-body").element as HTMLElement).scrollTop).toBe(120);
    expect(wrapper.get(".thinking-block .thinking-body").text()).toBe("Reading the scroll code");
    wrapper.unmount();
  });

  it("shows the temporary thinking status only while waiting for backend output", async () => {
    const store = useAppStore();
    store.threads = [{
      id: "thread-1", title: "Waiting task", workspace: "repo", workspacePath: "D:\\repo",
      trust: "deny", status: "running", started: true, generation: 1,
    }];
    store.activeThreadId = "thread-1";
    store.messagesByThread["thread-1"] = transcript(2);
    store.waitingForOutputByThread["thread-1"] = true;
    const wrapper = mount(ConversationPane, {
      global: {
        stubs: {
          ComposerBar: true,
          ConversationMessage: { props: ["message"], template: '<article class="stub-message">{{ message.text }}</article>' },
        },
      },
    });

    const status = wrapper.get(".waiting-for-output");
    expect(status.text()).toBe("");
    expect(status.attributes("aria-label")).toBe("Thinking");
    expect(status.find("svg.is-spinning").exists()).toBe(true);
    expect(wrapper.get(".timeline").element.lastElementChild?.classList.contains("waiting-for-output")).toBe(true);

    store.retryByThread["thread-1"] = { attempt: 1, maxAttempts: 3, delayMs: 4000 };
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".waiting-for-output").exists()).toBe(false);

    store.waitingForOutputByThread["thread-1"] = false;
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".waiting-for-output").exists()).toBe(false);
  });

  it("opens conversation search with Ctrl+F and navigates results", async () => {
    const wrapper = mountTranscript(3);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".conversation-search").exists()).toBe(true);
    const input = wrapper.get(".conversation-search-input");
    await input.setValue("Message");
    expect(wrapper.get(".conversation-search-result").text()).toBe("1 / 3");

    await wrapper.findAll(".conversation-search-control")[1].trigger("click");
    expect(wrapper.get(".conversation-search-result").text()).toBe("2 / 3");

    await input.trigger("keydown", { key: "Escape" });
    expect(wrapper.find(".conversation-search").exists()).toBe(false);
  });

  it("does not jump back to a search result when streaming output changes", async () => {
    const wrapper = mountTranscript(4);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }));
    await wrapper.vm.$nextTick();
    await wrapper.get(".conversation-search-input").setValue("Message 0");
    await flushPromises();

    const scrollIntoView = vi.fn();
    wrapper.findAll(".stub-message")[0].element.scrollIntoView = scrollIntoView;
    const store = useAppStore();
    store.messagesByThread["thread-1"][3].text += " streaming";
    await wrapper.vm.$nextTick();
    await flushPromises();

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("shows a left conversation outline preview and jumps to a turn", async () => {
    const wrapper = mountTranscript(3);
    const items = wrapper.findAll(".conversation-outline-item");
    expect(items).toHaveLength(2);
    expect(wrapper.get(".conversation-outline").attributes("aria-label")).toBe("Conversation outline");

    await items[0].trigger("mouseenter");
    expect(wrapper.get(".conversation-outline-preview").text()).toContain("Message 0");
    expect(wrapper.get(".conversation-outline-preview").text()).toContain("Message 1");

    await items[1].trigger("click");
    expect(items[1].classes()).toContain("is-active");
  });

  it("renders an empty historical session without a card frame", () => {
    const store = useAppStore();
    store.threads = [{
      id: "thread-1", title: "History", workspace: "repo", workspacePath: "D:\\repo",
      trust: "deny", status: "idle", started: false, generation: 0, sessionFile: "session.jsonl",
    }];
    store.activeThreadId = "thread-1";
    store.messagesByThread["thread-1"] = [];
    const wrapper = mount(ConversationPane, { global: { stubs: { ComposerBar: true } } });

    const emptyThread = wrapper.get(".empty-thread");
    expect(emptyThread.classes()).not.toContain("border");
    expect(emptyThread.classes()).not.toContain("rounded-xl");
    expect(emptyThread.classes()).not.toContain("shadow-sm");
  });

  it("removes recovered retry noise before the later assistant response", () => {
    const store = useAppStore();
    store.threads = [{
      id: "thread-1", title: "Recovered task", workspace: "repo", workspacePath: "D:\\repo",
      trust: "deny", status: "idle", started: false, generation: 0,
    }];
    store.activeThreadId = "thread-1";
    store.messagesByThread["thread-1"] = [
      { ...transcript(1)[0], id: "user-1", role: "user", text: "Upload it" },
      { ...transcript(1)[0], id: "failed-1", role: "assistant", text: "", error: "Request timed out." },
      { ...transcript(1)[0], id: "success-1", role: "assistant", text: "Upload complete" },
    ];
    const wrapper = mount(ConversationPane, {
      global: {
        stubs: {
          ComposerBar: true,
          ConversationMessage: {
            props: ["message"],
            template: '<article class="stub-message"><span v-if="message.runNotice" class="stub-notice">{{ message.runNotice.status }}</span><span>{{ message.text }}</span></article>',
          },
        },
      },
    });

    const rows = wrapper.findAll(".stub-message");
    expect(rows).toHaveLength(2);
    expect(rows[1].text()).toContain("Upload complete");
    expect(rows[1].find(".stub-notice").exists()).toBe(false);
  });

  it("virtualizes a long transcript", async () => {
    const wrapper = mountTranscript(2);
    const store = useAppStore();
    store.activeThread!.messageCount = 200;

    await wrapper.vm.$nextTick();

    expect(wrapper.get("[data-virtualized]").attributes("data-virtualized")).toBe("true");
  });

  it("switches every long transcript to the virtualized path", () => {
    const wrapper = mountTranscript(81);
    expect(wrapper.get("[data-virtualized]").attributes("data-virtualized")).toBe("true");
    expect(wrapper.findAll(".stub-message").length).toBeLessThan(81);
    expect(wrapper.find("composer-bar-stub").exists()).toBe(true);
  });
});
