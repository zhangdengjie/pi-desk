import { describe, expect, it } from "vitest";
import { isStreamableDocument, workspaceFileUrl } from "./documentSource";

describe("workspaceFileUrl", () => {
  it("addresses the workspace by id when the thread has one", () => {
    expect(workspaceFileUrl({ workspaceId: "ws-1", workspacePath: "/repo", path: "books/novel.epub" }))
      .toBe("/workspace-file?workspaceId=ws-1&path=books%2Fnovel.epub");
  });

  it("falls back to the legacy path root for threads written before ids existed", () => {
    expect(workspaceFileUrl({ workspacePath: "/repo", path: "a.pdf" }))
      .toBe("/workspace-file?root=%2Frepo&path=a.pdf");
  });

  // The route resolves against the workspace, so a Windows-style path must be normalised here
  // rather than reaching `repository.ResolveFile` as a literal backslash.
  it("normalises Windows separators", () => {
    expect(workspaceFileUrl({ workspaceId: "ws-1", workspacePath: "C:\\repo", path: "docs\\a.pdf" }))
      .toContain("path=docs%2Fa.pdf");
  });
});

describe("isStreamableDocument", () => {
  it("is true only for a local workspace, which is the one that fills absolutePath", () => {
    expect(isStreamableDocument({ absolutePath: "/repo/a.pdf" })).toBe(true);
    // `RepositoryService.PreviewFile` clears absolutePath for SSH workspaces.
    expect(isStreamableDocument({ absolutePath: "" })).toBe(false);
    expect(isStreamableDocument(undefined)).toBe(false);
  });
});
