import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { THREAD_TITLE_MAX_CHARS, threadTitleText, threadTooltip } from "./threadLabel";

// vitest serves modules over http, so import.meta.url is not a file: URL here. Walk up from the cwd
// instead - the suite is run from either frontend/ or the repo root.
function repoFile(relative: string): string {
  let dir = process.cwd();
  for (let hop = 0; hop < 6; hop += 1) {
    const candidate = path.join(dir, relative);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    dir = path.dirname(dir);
  }
  throw new Error(`${relative} not found from ${process.cwd()}`);
}

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

describe("threadTitleText", () => {
  it("keeps everything the indexer was willing to give us", () => {
    // One line, 205 chars: "修复登录 " (5) + 200 runes -> slice(0, 79) + the ellipsis = exactly 80.
    const prompt = `修复登录 ${"字".repeat(200)}`;
    const title = threadTitleText(prompt);
    expect(title).toBe(`修复登录 ${"字".repeat(74)}…`);
    expect(title.length).toBe(THREAD_TITLE_MAX_CHARS);
  });

  it("still strips the markdown and URL noise it always stripped", () => {
    // Only the first line ever survives, which is the point of the multi-line prompt below.
    expect(threadTitleText("## Ship `the` thing https://example.com/a/b?c=1\n\nmore detail here")).toBe(
      "Ship the thing example.com",
    );
    expect(threadTitleText("   \n  \n ")).toBe("");
  });

  // Two languages, one number: the indexer clamps the runes before we ever see the string, so a
  // smaller frontend cap silently discards text that already cost a disk read.
  it("matches the indexer's own headline clamp so neither side guesses", () => {
    const go = repoFile(path.join("internal", "sessionindex", "index.go"));
    const clamp = Number(go.match(/maxTitleRunes\s*=\s*(\d+)/)?.[1]);
    expect(clamp).toBeGreaterThan(0);
    expect(THREAD_TITLE_MAX_CHARS).toBe(clamp);
  });
});
