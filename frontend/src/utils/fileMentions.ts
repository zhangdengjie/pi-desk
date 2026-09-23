export interface RepositoryTreeNode {
  name: string;
  path: string;
  directory: boolean;
  /** Git excludes this path. Only nodes the backend listed itself carry it, so a plain folder does
   *  not go grey just because one file inside it is ignored. */
  ignored?: boolean;
  children: RepositoryTreeNode[];
}

/** One row of the repository listing. `directory` marks a folder the backend refuses to expand
 *  (capped scan, or `node_modules`); a bare string means "file, not ignored". */
export interface RepositoryTreeEntry {
  path: string;
  ignored?: boolean;
  directory?: boolean;
}

export type RepositoryTreeInput = string | RepositoryTreeEntry;

export function formatFileMention(path: string, directory = false): string {
  let normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  if (directory) normalized += "/";
  if (!/[\s"]/.test(normalized)) return `@${normalized}`;
  return `@"${normalized.replaceAll('"', '\\"')}"`;
}

export function buildRepositoryTree(entries: RepositoryTreeInput[]): RepositoryTreeNode[] {
  const roots: RepositoryTreeNode[] = [];
  for (const raw of entries) {
    const entry = typeof raw === "string" ? { path: raw } : raw;
    const parts = entry.path.replaceAll("\\", "/").split("/").filter(Boolean);
    let level = roots;
    let currentPath = "";
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      const last = index === parts.length - 1;
      const directory = !last || Boolean(entry.directory);
      let node = level.find((item) => item.name === name && item.directory === directory);
      if (!node) {
        node = { name, path: currentPath, directory, children: [] };
        level.push(node);
      }
      if (last && entry.ignored) node.ignored = true;
      level = node.children;
    }
  }
  const sortNodes = (nodes: RepositoryTreeNode[]) => {
    nodes.sort((left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name));
    nodes.forEach((node) => sortNodes(node.children));
  };
  sortNodes(roots);
  return roots;
}
