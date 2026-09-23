import { describe, expect, it } from "vitest";
import { buildRepositoryTree, formatFileMention } from "./fileMentions";

describe("file mentions", () => {
  it("quotes paths containing spaces and marks directories", () => {
    expect(formatFileMention("src/main.go")).toBe("@src/main.go");
    expect(formatFileMention("my docs/read me.md")).toBe('@"my docs/read me.md"');
    expect(formatFileMention("src", true)).toBe("@src/");
  });

  it("builds a directory-first tree from bounded flat paths", () => {
    const tree = buildRepositoryTree(["README.md", "src/view.ts", "src/main.ts"]);
    expect(tree.map((node) => node.name)).toEqual(["src", "README.md"]);
    expect(tree[0].children.map((node) => node.name)).toEqual(["main.ts", "view.ts"]);
  });

  it("marks git-ignored rows and folds a collapsed folder into the tree it belongs to", () => {
    const tree = buildRepositoryTree([
      { path: "README.md" },
      { path: ".pi/README.md" },
      { path: ".pi/plans", ignored: true, directory: true },
      { path: ".pi/plans/2026-09-23.md", ignored: true },
    ]);
    const pi = tree.find((node) => node.path === ".pi");
    // `.pi` itself is tracked: one excluded child must not fade the whole folder.
    expect(pi?.ignored).toBeUndefined();
    const plans = pi?.children.find((node) => node.path === ".pi/plans");
    expect(plans?.directory).toBe(true);
    expect(plans?.ignored).toBe(true);
    expect(plans?.children.map((node) => `${node.path}:${node.ignored}`)).toEqual([".pi/plans/2026-09-23.md:true"]);

    // The backend may report a folder after its children; both orders have to land on one node.
    const reversed = buildRepositoryTree([{ path: "target/app.jar", ignored: true }, { path: "target", ignored: true, directory: true }]);
    const target = reversed.find((node) => node.path === "target");
    expect(target?.directory).toBe(true);
    expect(target?.ignored).toBe(true);
    expect(target?.children).toHaveLength(1);
  });
});
