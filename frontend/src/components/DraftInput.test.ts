import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import DraftInput from "./DraftInput.vue";

type Surface = {
  focus(): void;
  replaceMarkdown(value: string): void;
  handleEnter(event: KeyboardEvent): boolean;
  captureTextInsertion(): (text: string, separate?: boolean) => boolean;
};

function open(modelValue = "") {
  // attachTo is not decoration: `applyUndoable` only patches through the editing command when the
  // field is `document.activeElement`, and jsdom only tracks that for mounted elements.
  const host = document.createElement("div");
  document.body.append(host);
  const wrapper = mount(DraftInput, { props: { modelValue, placeholder: "Write", ariaLabel: "Prompt" }, attachTo: host });
  const surface = wrapper.vm as unknown as Surface;
  const field = wrapper.get<HTMLTextAreaElement>("textarea.draft-input").element;
  return { wrapper, surface, field, emitted: () => String(wrapper.emitted("update:modelValue")?.at(-1)?.[0]) };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("DraftInput", () => {
  it("seeds the field from the draft and keeps the typed string verbatim", async () => {
    const { wrapper, field, emitted } = open("Restored\nwith a blank line below");
    expect(field.value).toBe("Restored\nwith a blank line below");

    field.value = "Restored\n\nwith two breaks and  two spaces";
    await wrapper.get("textarea").trigger("input");
    // The whole point of the swap: nothing rewrites the characters between the reader and Pi.
    expect(emitted()).toBe("Restored\n\nwith two breaks and  two spaces");
    expect(field.value).toBe("Restored\n\nwith two breaks and  two spaces");
  });

  it("writes an external draft change into the field without emitting it back", async () => {
    const { wrapper, field } = open("first thread");
    await wrapper.setProps({ modelValue: "another thread's draft" });
    await flushPromises();
    expect(field.value).toBe("another thread's draft");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("inserts pasted text at the caret and adds one separating space for references", async () => {
    const plain = open("Review: ");
    plain.field.setSelectionRange(8, 8);
    expect(plain.surface.captureTextInsertion()("src/app.ts")).toBe(true);
    expect(plain.field.value).toBe("Review: src/app.ts");
    expect(plain.emitted()).toBe("Review: src/app.ts");

    const glued = open("Review");
    glued.field.setSelectionRange(6, 6);
    // A reference gets a leading space because the character before the caret was not whitespace;
    // the caller passes it with a trailing space so the next word cannot glue onto it.
    expect(glued.surface.captureTextInsertion()('@"a b.pdf" ', true)).toBe(true);
    expect(glued.field.value).toBe('Review @"a b.pdf" ');
    expect(glued.field.selectionStart).toBe(18);

    const spaced = open("Review: ");
    spaced.field.setSelectionRange(8, 8);
    expect(spaced.surface.captureTextInsertion()("@main.go", true)).toBe(true);
    expect(spaced.field.value).toBe("Review: @main.go");
    expect(spaced.field.selectionStart).toBe(16);
  });

  it("refuses a delayed insert once the draft moved on", async () => {
    const { wrapper, surface, field } = open("original");
    const insert = surface.captureTextInsertion();
    await wrapper.setProps({ modelValue: "newer" });
    await flushPromises();
    expect(insert("main.go")).toBe(false);
    expect(field.value).toBe("newer");
  });

  it("routes an external draft change through the editing command when the field is focused", async () => {
    const calls: Array<{ name: string; arg: string }> = [];
    // jsdom ships no editing commands at all, so the component would fall back to a raw write. Stub
    // one that behaves like the engine: replace the current selection, leave the caret after it.
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: (name: string, _ui: unknown, arg?: unknown) => {
        calls.push({ name, arg: String(arg ?? "") });
        const el = document.activeElement as HTMLTextAreaElement;
        el.setRangeText(String(arg ?? ""), el.selectionStart, el.selectionEnd, "end");
        el.dispatchEvent(new Event("input"));
        return true;
      },
    });
    try {
      const { surface, field } = open("fix the bug");
      field.focus();
      field.setSelectionRange(8, 8);
      surface.replaceMarkdown("fix the @src/app.ts bug");
      await flushPromises();
      // only the differing range goes through the command - assigning `value` here would flush the
      // undo stack, which is what made Cmd+Z dead for the rest of the draft (V5 in undo-battery)
      expect(calls).toEqual([{ name: "insertText", arg: "@src/app.ts " }]);
      expect(field.value).toBe("fix the @src/app.ts bug");
    } finally {
      Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("re-asserts the caret after every keystroke so Cmd+Z is one character", async () => {
    const { wrapper, field } = open("hell");
    field.value = "hello";
    field.setSelectionRange(5, 5);
    const caret = vi.spyOn(field, "setSelectionRange");
    await wrapper.get("textarea").trigger("input");
    // the two-call form: a same-position write can be treated as a no-op by the engine, so the
    // selection is moved for real and collapsed again in the same task (undo-real-draft R0e vs R0f)
    expect(caret.mock.calls.map((call) => [call[0], call[1]])).toEqual([[4, 5], [5, 5]]);

    field.value = "hello ";
    field.setSelectionRange(6, 6);
    caret.mockClear();
    await wrapper.get("textarea").trigger("input");
    expect(caret.mock.calls.map((call) => [call[0], call[1]])).toEqual([[5, 6], [6, 6]]);
  });

  it("does not schedule the engine's own undo replay as a new edit", async () => {
    const { wrapper, field } = open("hello ");
    field.value = "hello";
    field.setSelectionRange(5, 5);
    const caret = vi.spyOn(field, "setSelectionRange");
    await wrapper.get("textarea").trigger("input", { inputType: "historyUndo" });
    expect(caret).not.toHaveBeenCalled();
  });

  it("counts a character typed over an equally long selection as an edit", async () => {
    const { wrapper, field } = open("ab");
    field.value = "cd";
    field.setSelectionRange(2, 2);
    const caret = vi.spyOn(field, "setSelectionRange");
    await wrapper.get("textarea").trigger("input", { inputType: "insertText" });
    expect(caret).toHaveBeenCalledWith(1, 2);
    expect(caret).toHaveBeenCalledWith(2, 2);
  });

  it("leaves the selection alone while an IME session owns the field", async () => {
    const { wrapper, field } = open("hello ");
    await wrapper.get("textarea").trigger("compositionstart");
    field.value = "你好 ";
    field.setSelectionRange(3, 3);
    const caret = vi.spyOn(field, "setSelectionRange");
    await wrapper.get("textarea").trigger("input");
    expect(caret).not.toHaveBeenCalled();
  });

  it("keeps the four method names ComposerBar calls and never claims Enter", () => {
    const { wrapper, surface, field } = open("Keep editing");
    expect(typeof surface.focus).toBe("function");
    expect(typeof surface.replaceMarkdown).toBe("function");
    expect(typeof surface.captureTextInsertion).toBe("function");
    expect(surface.handleEnter(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false);

    surface.replaceMarkdown("Replaced from the queue");
    expect(field.value).toBe("Replaced from the queue");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["Replaced from the queue"]);
    expect(wrapper.get("textarea").attributes("placeholder")).toBe("Write");
    expect(wrapper.get("textarea").attributes("aria-label")).toBe("Prompt");
  });
});
