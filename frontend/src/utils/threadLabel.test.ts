import { describe, expect, it } from "vitest";
import { threadTooltip } from "./threadLabel";

describe("threadTooltip", () => {
  it("returns the title alone when there is nothing to add", () => {
    expect(threadTooltip({ title: "Ship it" })).toBe("Ship it");
    expect(threadTooltip({ title: "Ship it", firstMessage: "Ship it" })).toBe("Ship it");
    expect(threadTooltip({ title: "", firstMessage: "Only a prompt" })).toBe("Only a prompt");
    expect(threadTooltip(undefined)).toBe("");
  });

  it("prefers the longer copy when Pi's name is just a cut-off prefix of the prompt", () => {
    const first = "在使用pi的过程中，时常会遇到返回429等并发错误导致任务中断，这个可以做到自动重试吗";
    expect(threadTooltip({ title: "在使用pi的过程中，时常会遇到返回429等并", firstMessage: first })).toBe(first);
  });

  it("shows both lines when Pi's name ends in a literal ellipsis (not a prefix any more)", () => {
    // The `…` is stored inside the title string, so the prefix test cannot match and the reader gets
    // the headline plus the fuller prompt - which is the whole point of the tooltip.
    const first = "在使用pi的过程中，时常会遇到返回429等并发错误导致任务中断，这个可以做到自动重试吗";
    expect(threadTooltip({ title: "在使用pi的过程中，时常会遇到返回429等并…", firstMessage: first })).toBe(
      `在使用pi的过程中，时常会遇到返回429等并…

${first}`,
    );
  });

  it("keeps both lines when the title is unrelated to the prompt (a hand-named session)", () => {
    expect(threadTooltip({ title: "Nightly audit", firstMessage: "Check the retention job output" })).toBe(
      "Nightly audit\n\nCheck the retention job output",
    );
  });

  it("keeps the title when the prompt is only its prefix (nothing to gain)", () => {
    const title = "在使用pi的过程中，时常会遇到返回429等并发错误导致任务中断";
    expect(threadTooltip({ title, firstMessage: "在使用pi的过程中，时常会遇到返回429" })).toBe(title);
  });
});
