import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import layoutFile from "../styles/layout.css?inline";
import FileTreeNode from "./FileTreeNode.vue";
import type { RepositoryTreeNode } from "../utils/fileMentions";

/**
 * The row is a CSS grid with a fixed track list, and the template hands it one cell per element.
 * Those two numbers live in different files, and when cells outnumber tracks the surplus is not
 * dropped - it auto-places into an implicit second grid row, which is how the `@` button ended up
 * under the filename for every git-changed file (it renders a rollback button, folders do not).
 */
function countTracks(value: string): number {
  let depth = 0;
  let tracks = 0;
  let pending = false;
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (ch === " " && depth === 0) {
      if (pending) tracks += 1;
      pending = false;
      continue;
    }
    pending = true;
  }
  return tracks + (pending ? 1 : 0);
}

async function layoutSource(): Promise<string> {
  // Same dance as `styles/layout.test.ts`: under vitest the `?inline` import is not the stylesheet
  // text, so read the file (cwd is `frontend/`).
  if (layoutFile.includes(".file-tree-row")) return layoutFile;
  const moduleName = ["node", "fs/promises"].join(":");
  const { readFile } = (await import(/* @vite-ignore */ moduleName)) as {
    readFile(path: string, encoding: "utf8"): Promise<string>;
  };
  return await readFile("src/styles/layout.css", "utf8");
}

async function rowColumns(): Promise<number> {
  const rule = (await layoutSource()).match(/\.file-tree-row\s*\{([^}]*)\}/);
  if (!rule) throw new Error("missing .file-tree-row rule");
  const tracks = rule[1].match(/grid-template-columns:\s*([^;]+);/);
  if (!tracks) throw new Error("missing grid-template-columns on .file-tree-row");
  return countTracks(tracks[1].trim());
}

function node(over: Partial<RepositoryTreeNode>): RepositoryTreeNode {
  return { name: "file.md", path: "file.md", directory: false, children: [], ...over };
}

type RowProps = {
  node: RepositoryTreeNode;
  changeStatuses?: Record<string, string>;
  rollbackActions?: Record<string, string>;
};

function cells(props: RowProps) {
  const wrapper = mount(FileTreeNode, { props });
  const row = wrapper.get(".file-tree-row");
  const count = row.element.children.length;
  const mention = wrapper.get(".file-tree-mention").element as HTMLElement;
  const name = wrapper.get(".file-tree-name").element as HTMLElement;
  // jsdom does no layout, so "same line" is asserted structurally: the mention must be the last
  // cell and no cell may sit in a second implicit row (that is what `cells === columns` guarantees).
  wrapper.unmount();
  return { count, mentionIsLast: mention === row.element.lastElementChild, nameHasText: name.textContent !== "" };
}

describe("repository tree row grid cells", () => {
  it("renders exactly as many cells as the row has grid columns", async () => {
    const columns = await rowColumns();
    expect(columns).toBe(6);
    const cases: Record<string, RowProps> = {
      directory: { node: node({ name: "src", path: "src", directory: true }) },
      cleanFile: { node: node({}) },
      changedFile: { node: node({}), changeStatuses: { "file.md": "M" } },
      rollbackFile: {
        node: node({}),
        changeStatuses: { "file.md": "M" },
        rollbackActions: { "file.md": "Roll back this file" },
      },
    };
    for (const [name, props] of Object.entries(cases)) {
      const result = cells(props);
      expect(result.count, `${name} row cells`).toBe(columns);
      expect(result.mentionIsLast, `${name} mention is the last cell`).toBe(true);
    }
  });

  it("keeps a spacer where the rollback button is absent", () => {
    const wrapper = mount(FileTreeNode, {
      props: { node: node({}), changeStatuses: { "file.md": "M" } },
    });
    expect(wrapper.find(".file-tree-rollback").exists()).toBe(false);
    expect(wrapper.find(".file-tree-rollback-spacer").exists()).toBe(true);
    wrapper.unmount();
  });
});
