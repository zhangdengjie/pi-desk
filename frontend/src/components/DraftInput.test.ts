import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import DraftInput from "./DraftInput.vue";

type Surface = {
  focus(): void;
  replaceMarkdown(value: string): void;
  handleEnter(event: KeyboardEvent): boolean;
  captureTextInsertion(): (text: string, separate?: boolean) => boolean;
};

function open(modelValue = "") {
  const wrapper = mount(DraftInput, { props: { modelValue, placeholder: "Write", ariaLabel: "Prompt" } });
  const surface = wrapper.vm as unknown as Surface;
  const field = wrapper.get<HTMLTextAreaElement>("textarea.draft-input").element;
  return { wrapper, surface, field, emitted: () => String(wrapper.emitted("update:modelValue")?.at(-1)?.[0]) };
}

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
