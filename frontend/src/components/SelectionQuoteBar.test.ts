import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { tr } from "../i18n";
import { useAppStore } from "../stores/app";
import SelectionQuoteBar from "./SelectionQuoteBar.vue";

vi.mock("../services/agent", () => ({ agentService: {}, onPiEvent: () => () => undefined }));
vi.mock("../services/catalog", () => ({ catalogService: {} }));
vi.mock("../services/desktop", () => ({ getBootstrapState: vi.fn() }));
vi.mock("../services/modelconfig", () => ({ modelConfigService: { selectable: vi.fn().mockResolvedValue([]) } }));
vi.mock("../services/repository", () => ({ repositoryService: { clipboardFiles: vi.fn().mockResolvedValue([]) } }));

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left, y: top, left, top, width, height,
    right: left + width, bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

/** jsdom has no layout: the range reports nothing, and the bar would refuse to place itself. */
function stubRangeGeometry(box: DOMRect) {
  Range.prototype.getClientRects = function getClientRects() {
    return Object.assign([box], { item: (index: number) => (index === 0 ? box : null) }) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = () => box;
}

function selectTextOf(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

const settle = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await nextTick();
  await nextTick();
};

describe("SelectionQuoteBar", () => {
  let wrapper: VueWrapper | undefined;

  beforeEach(() => {
    setActivePinia(createPinia());
    stubRangeGeometry(rect(120, 240, 180, 20));
  });

  afterEach(() => {
    // Unmount before the next test wipes <body>: the teleport target lives there, and Vue patches
    // into a removed node otherwise (the "insertBefore of null" unhandled rejection).
    wrapper?.unmount();
    wrapper = undefined;
    document.body.innerHTML = "";
    window.getSelection()?.removeAllRanges();
  });

  it("offers quote and copy for a selection inside the transcript", async () => {
    const store = useAppStore();
    store.activeThreadId = "thread-1";
    document.body.innerHTML = '<div class="timeline"><p id="answer">第一段 正文</p></div>';
    wrapper = mount(SelectionQuoteBar, { attachTo: document.body });

    selectTextOf(document.getElementById("answer")!);
    await settle();

    const bar = document.querySelector(".selection-actions");
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("data-placement")).toBe("above");
    expect(Array.from(bar!.querySelectorAll("button")).map((button) => button.textContent?.trim())).toEqual([
      tr("selection.quote"),
      tr("selection.copy"),
    ]);
  });

  it("quotes the selection into the draft and asks the composer for focus", async () => {
    const store = useAppStore();
    store.activeThreadId = "thread-1";
    store.draftsByThread["thread-1"] = "看这里：";
    document.body.innerHTML = '<div class="timeline"><p id="answer">第一段\n第二段</p></div>';
    wrapper = mount(SelectionQuoteBar, { attachTo: document.body });
    const focus = vi.fn();
    window.addEventListener("pidesk:focus-composer", focus);

    selectTextOf(document.getElementById("answer")!);
    await settle();
    (document.querySelector(".selection-actions button") as HTMLButtonElement).click();
    await settle();

    expect(store.draftsByThread["thread-1"]).toBe("看这里：\n\n> 第一段\n> 第二段\n\n");
    expect(focus).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".selection-actions")).toBeNull();
  });

  it("stays out of the way of a selection outside the transcript", async () => {
    useAppStore().activeThreadId = "thread-1";
    document.body.innerHTML = '<div class="composer"><p id="draft">草稿里的字</p></div>';
    wrapper = mount(SelectionQuoteBar, { attachTo: document.body });

    selectTextOf(document.getElementById("draft")!);
    await settle();

    expect(document.querySelector(".selection-actions")).toBeNull();
  });

  it("hides again when the selection collapses", async () => {
    useAppStore().activeThreadId = "thread-1";
    document.body.innerHTML = '<div class="timeline"><p id="answer">一段正文</p></div>';
    wrapper = mount(SelectionQuoteBar, { attachTo: document.body });

    selectTextOf(document.getElementById("answer")!);
    await settle();
    expect(document.querySelector(".selection-actions")).not.toBeNull();

    window.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    await settle();
    expect(document.querySelector(".selection-actions")).toBeNull();
  });
});