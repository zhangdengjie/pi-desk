import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SearchPopover from "./SearchPopover.vue";

// The contract this component owns since 2026-09-29: typing is not a search. The host rebuilds the
// hit list and re-highlights on every change of `query`, which on a long transcript is a visible
// stutter per keystroke - so the field keeps a draft and `query` moves on a commit only.
function mountPopover(query: string, hasMatches = false) {
  return mount(SearchPopover, { props: { query, hasMatches, resultLabel: "1 / 2" } });
}

describe("SearchPopover", () => {
  it("waits for Enter before it searches", async () => {
    const wrapper = mountPopover("");
    const input = wrapper.get(".search-popover-input");

    await input.setValue("dup");
    expect(wrapper.emitted("update:query")).toBeUndefined();

    await input.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("update:query")?.at(-1)).toEqual(["dup"]);
  });

  it("makes Enter step through hits once the text is already the searched one", async () => {
    const wrapper = mountPopover("dup", true);
    const input = wrapper.get(".search-popover-input");

    await input.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("next")).toHaveLength(1);
    expect(wrapper.emitted("update:query")).toBeUndefined();

    await input.trigger("keydown", { key: "Enter", shiftKey: true });
    expect(wrapper.emitted("previous")).toHaveLength(1);
  });

  it("commits an edited field instead of stepping when an arrow is clicked", async () => {
    const wrapper = mountPopover("dup", true);
    await wrapper.get(".search-popover-input").setValue("dupx");

    await wrapper.findAll(".search-popover-control")[1].trigger("click");
    expect(wrapper.emitted("update:query")?.at(-1)).toEqual(["dupx"]);
    expect(wrapper.emitted("next")).toBeUndefined();

    await wrapper.setProps({ query: "dupx" });
    await wrapper.findAll(".search-popover-control")[1].trigger("click");
    expect(wrapper.emitted("next")).toHaveLength(1);
  });

  it("takes an emptied field at once", async () => {
    // A stale set of amber marks behind an empty field is worse than one keystroke of work, and the
    // native ✕ of `type="search"` lands here too.
    const wrapper = mountPopover("dup", true);

    await wrapper.get(".search-popover-input").setValue("");

    expect(wrapper.emitted("update:query")?.at(-1)).toEqual([""]);
  });

  it("follows the host when it resets the query", async () => {
    // Closing search clears the host's query; the draft must not keep the old text for the next open.
    const wrapper = mountPopover("dup");

    await wrapper.setProps({ query: "" });

    expect((wrapper.get(".search-popover-input").element as HTMLInputElement).value).toBe("");
  });

  it("ignores a trailing space as an edit", async () => {
    const wrapper = mountPopover("dup", true);

    await wrapper.get(".search-popover-input").setValue("dup ");
    await wrapper.findAll(".search-popover-control")[1].trigger("click");

    expect(wrapper.emitted("update:query")).toBeUndefined();
    expect(wrapper.emitted("next")).toHaveLength(1);
  });
});
