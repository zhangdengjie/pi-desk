import { beforeEach, describe, expect, it, vi } from "vitest";
import { readPosition, readerPositionKey, writePosition } from "./readingPositions";

/**
 * Positions are the one thing a reader must not lose, and they are persisted on every page turn, so
 * the rules worth pinning are: the key does not depend on a tab, a corrupt blob degrades instead of
 * throwing, and a re-read after a reload returns what was written.
 */
describe("readingPositions", () => {
  beforeEach(() => {
    localStorage.clear();
    // The module keeps an in-memory copy; a fresh import per expectation would be heavier than
    // resetting what it reads from.
    localStorage.setItem("pidesk.reader.positions", "{}");
  });

  it("keys on the workspace and the document, never on a tab", () => {
    expect(readerPositionKey("ws-1", "books/a.epub")).toBe("ws-1\0books/a.epub");
    // Windows separators normalise so a file reached through two paths shares one position.
    expect(readerPositionKey("ws-1", "books\\a.epub")).toBe(readerPositionKey("ws-1", "books/a.epub"));
  });

  it("returns what was written for that key and nothing for another", () => {
    writePosition("ws\0a.pdf", { page: 12 });
    expect(readPosition("ws\0a.pdf")).toEqual({ page: 12 });
    expect(readPosition("ws\0b.pdf")).toBeUndefined();
  });

  it("ignores an empty key instead of storing under one", () => {
    writePosition("", { page: 3 });
    expect(readPosition("")).toBeUndefined();
  });

  it("survives a corrupt blob", async () => {
    localStorage.setItem("pidesk.reader.positions", "{not json");
    // The module keeps the parsed map in memory, so reading it again means loading it again —
    // `vi.resetModules()` (a `?query` import would not survive `vue-tsc`, which checks this file).
    vi.resetModules();
    const fresh = await import("./readingPositions");
    expect(fresh.readPosition("ws\0a.pdf")).toBeUndefined();
  });
});
