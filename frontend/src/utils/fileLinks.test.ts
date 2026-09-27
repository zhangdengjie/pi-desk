import { describe, expect, it } from "vitest";
import { resolveWorkspaceFileLink } from "./fileLinks";

describe("resolveWorkspaceFileLink", () => {
  it("resolves relative, absolute, file URL, and source-location links inside a Windows workspace", () => {
    expect(resolveWorkspaceFileLink("results/tg_groups.csv", "D:\\repo")).toEqual({
      relativePath: "results/tg_groups.csv",
      absolutePath: "D:\\repo\\results\\tg_groups.csv",
      name: "tg_groups.csv",
      line: undefined,
    });
    expect(resolveWorkspaceFileLink("D:/repo/scripts/join.py:19", "D:\\repo")).toMatchObject({
      relativePath: "scripts/join.py", absolutePath: "D:\\repo\\scripts\\join.py", line: 19,
    });
    expect(resolveWorkspaceFileLink("file:///D:/repo/docs/Guide%20One.md#L8", "D:\\repo")).toMatchObject({
      relativePath: "docs/Guide One.md", name: "Guide One.md", line: 8,
    });
  });

  it("resolves POSIX paths and rejects external links and workspace escapes", () => {
    expect(resolveWorkspaceFileLink("./src/main.ts", "/work/repo")).toMatchObject({
      relativePath: "src/main.ts", absolutePath: "/work/repo/src/main.ts",
    });
    expect(resolveWorkspaceFileLink("https://example.com/file.ts", "D:\\repo")).toBeUndefined();
    expect(resolveWorkspaceFileLink("mailto:user@example.com", "D:\\repo")).toBeUndefined();
    expect(resolveWorkspaceFileLink("../outside.txt", "D:\\repo")).toBeUndefined();
    expect(resolveWorkspaceFileLink("D:/other/outside.txt", "D:\\repo")).toBeUndefined();
  });

  it("resolves a relative link against the directory of the document it was found in", () => {
    // Inside notes/2026-09.md, `./daily.md` is notes/daily.md - not <root>/daily.md. GitHub does this
    // and every hand-written repo README assumes it; joining to the workspace root instead was the bug
    // that made cross-document links in a nested file dead.
    expect(resolveWorkspaceFileLink("./daily.md", "/repo", "notes")).toMatchObject({
      relativePath: "notes/daily.md", absolutePath: "/repo/notes/daily.md",
    });
    expect(resolveWorkspaceFileLink("../readme.md", "/repo", "docs/arch")).toMatchObject({
      relativePath: "docs/readme.md", absolutePath: "/repo/docs/readme.md",
    });
    expect(resolveWorkspaceFileLink("assets/logo.png", "/repo", "docs")).toMatchObject({
      relativePath: "docs/assets/logo.png",
    });
    // A link written from the repository root still works when the document lives at the root.
    expect(resolveWorkspaceFileLink("src/main.ts", "/repo", "")).toMatchObject({ relativePath: "src/main.ts" });
    // The workspace is still the fence: climbing out of it from a nested document resolves to a path
    // the containment check rejects.
    expect(resolveWorkspaceFileLink("../../../etc/passwd", "/repo", "notes")).toBeUndefined();
    expect(resolveWorkspaceFileLink("..\\..\\outside.md", "D:\\repo", "notes")).toBeUndefined();
  });

  it("carries a heading anchor through to the document that has to scroll there", () => {
    expect(resolveWorkspaceFileLink("notes/plan.md#deep-work", "/repo")).toMatchObject({
      relativePath: "notes/plan.md", anchor: "deep-work", line: undefined,
    });
    expect(resolveWorkspaceFileLink("plan.md#%E7%9B%AE%E5%BD%95", "/repo")).toMatchObject({ anchor: "目录" });
    // `#L8` stays a line request, not an anchor - the code-preview jump depends on that distinction.
    expect(resolveWorkspaceFileLink("plan.md#L8", "/repo")).toMatchObject({ line: 8, anchor: undefined });
  });
});
