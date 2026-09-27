export interface WorkspaceFileLink {
  relativePath: string;
  absolutePath: string;
  name: string;
  line?: number;
  /** Heading anchor from `other.md#install` - the target document has to scroll there after opening. */
  anchor?: string;
}

function decodeLink(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripLocationSuffix(value: string): { path: string; line?: number; anchor?: string } {
  let path = value;
  let line: number | undefined;
  let anchor: string | undefined;
  const hashIndex = path.indexOf("#");
  if (hashIndex >= 0) {
    const fragment = path.slice(hashIndex + 1);
    const match = fragment.match(/^L?(\d+)(?:[-:]L?\d+)?$/i);
    if (match) line = Number(match[1]);
    else anchor = fragment || undefined;
    path = path.slice(0, hashIndex);
  }
  const queryIndex = path.indexOf("?");
  if (queryIndex >= 0) path = path.slice(0, queryIndex);
  const location = path.match(/:(\d+)(?::\d+)?$/);
  if (location && !/^[a-z]:\d+$/i.test(path)) {
    line ??= Number(location[1]);
    path = path.slice(0, location.index);
  }
  return { path, line, anchor };
}

function fileURLPath(value: string, windows: boolean): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return undefined;
    const pathname = decodeLink(url.pathname);
    const location = `${url.search}${url.hash}`;
    if (windows) {
      if (url.hostname && url.hostname !== "localhost") return `\\\\${url.hostname}${pathname.replaceAll("/", "\\")}${location}`;
      return `${pathname.replace(/^\/(?=[a-z]:)/i, "").replaceAll("/", "\\")}${location}`;
    }
    return `${pathname}${location}`;
  } catch {
    return undefined;
  }
}

function normalizeWindowsPath(value: string): string | undefined {
  const path = value.replaceAll("/", "\\");
  const drive = path.match(/^([a-z]):\\/i);
  if (!drive) return undefined;
  const segments: string[] = [];
  for (const segment of path.slice(3).split("\\")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `${drive[1].toUpperCase()}:\\${segments.join("\\")}`;
}

function normalizePosixPath(value: string): string | undefined {
  if (!value.startsWith("/")) return undefined;
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * Resolve an href to a file inside the workspace.
 *
 * `baseDir` is the workspace-relative directory of the document the link was found in. Markdown
 * resolves a relative link against that directory (`notes/a.md` linking `./b.md` means `notes/b.md`),
 * which is not what a link in a chat message means - there the reader is at the repository itself, so
 * the caller passes nothing. Containment is still checked against the workspace root, so `../` in a
 * nested document can move around inside the repository but never leave it.
 */
export function resolveWorkspaceFileLink(href: string, workspacePath: string, baseDir = ""): WorkspaceFileLink | undefined {
  const root = workspacePath.trim().replace(/[\\/]+$/, "");
  const base = baseDir.trim().replace(/[\\/]+$/, "");
  let target = decodeLink(href.trim().replace(/^<|>$/g, ""));
  if (!root || !target || target.startsWith("#")) return undefined;
  const windows = /^[a-z]:[\\/]/i.test(root);
  const separator = windows ? "\\" : "/";
  // `root` stays the fence; `linkedRoot` is what a relative href is joined to.
  const linkedRoot = base ? `${root}${separator}${base}` : root;
  if (/^file:/i.test(target)) {
    const filePath = fileURLPath(target, windows);
    if (!filePath) return undefined;
    target = filePath;
  } else if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) {
    return undefined;
  }
  const location = stripLocationSuffix(target);
  target = location.path.trim();
  if (!target) return undefined;

  if (windows) {
    const normalizedRoot = normalizeWindowsPath(root);
    const absolute = normalizeWindowsPath(/^[a-z]:[\\/]/i.test(target) ? target : `${linkedRoot}\\${target}`);
    if (!normalizedRoot || !absolute) return undefined;
    const rootKey = normalizedRoot.toLocaleLowerCase();
    const absoluteKey = absolute.toLocaleLowerCase();
    if (absoluteKey !== rootKey && !absoluteKey.startsWith(`${rootKey}\\`)) return undefined;
    const relativePath = absolute.slice(normalizedRoot.length).replace(/^\\/, "").replaceAll("\\", "/");
    if (!relativePath) return undefined;
    return { relativePath, absolutePath: absolute, name: relativePath.split("/").pop() ?? relativePath, line: location.line, anchor: location.anchor };
  }

  const normalizedRoot = normalizePosixPath(root);
  const absolute = normalizePosixPath(target.startsWith("/") ? target : `${linkedRoot}/${target}`);
  if (!normalizedRoot || !absolute) return undefined;
  if (absolute !== normalizedRoot && !absolute.startsWith(`${normalizedRoot}/`)) return undefined;
  const relativePath = absolute.slice(normalizedRoot.length).replace(/^\//, "");
  if (!relativePath) return undefined;
  return { relativePath, absolutePath: absolute, name: relativePath.split("/").pop() ?? relativePath, line: location.line, anchor: location.anchor };
}
