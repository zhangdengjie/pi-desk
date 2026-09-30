import { describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "../../bindings/pi-desk/internal/domain";
import { fetchSessionSnapshot, sessionTranscriptUrl } from "./sessionTranscript";

const snapshot: SessionSnapshot = { messages: [], messageCount: 1 };

/** Every failure of the fast route has to land on the bridge, so the bridge is a mock we can watch. */
function transport(body: unknown = snapshot, ok = true, getThrows = false) {
  const bridge = vi.fn(async () => snapshot);
  const mint = vi.fn(async () => "payload.signature");
  const get = vi.fn(async () => {
    if (getThrows) throw new TypeError("Failed to fetch");
    return { ok, json: async () => body };
  });
  return { bridge, mint, get, call: () => fetchSessionSnapshot("/sessions/a.jsonl", { mint, bridge, get }) };
}

describe("sessionTranscriptUrl", () => {
  it("encodes the signature's url-safe characters but not the dot", () => {
    expect(sessionTranscriptUrl("a_b-c.d_e")).toBe("/session-transcript?ref=a_b-c.d_e");
  });

  it("keeps the ref a query parameter so a forged path cannot leak in", () => {
    expect(sessionTranscriptUrl("../../etc/passwd")).toBe("/session-transcript?ref=..%2F..%2Fetc%2Fpasswd");
  });
});

describe("fetchSessionSnapshot", () => {
  it("takes the asset server and never touches the bridge when it answers", async () => {
    const context = transport();
    await expect(context.call()).resolves.toBe(snapshot);
    expect(context.get).toHaveBeenCalledWith("/session-transcript?ref=payload.signature");
    expect(context.bridge).not.toHaveBeenCalled();
  });

  it("falls back to the bridge when this process cannot sign a reference", async () => {
    const context = transport();
    context.mint.mockImplementation(async () => "");
    await expect(context.call()).resolves.toBe(snapshot);
    expect(context.get).not.toHaveBeenCalled();
    expect(context.bridge).toHaveBeenCalledTimes(1);
  });

  it("falls back on a stale reference (404) instead of rendering a transcript that is missing turns", async () => {
    const context = transport({ messages: null, messageCount: 0 }, false);
    await expect(context.call()).resolves.toBe(snapshot);
    expect(context.bridge).toHaveBeenCalledTimes(1);
  });

  it("falls back when the fetch itself fails", async () => {
    const context = transport(snapshot, true, true);
    await expect(context.call()).resolves.toBe(snapshot);
    expect(context.bridge).toHaveBeenCalledTimes(1);
  });

  it("refuses a body that is not an object - `null` would blow up the reader later", async () => {
    for (const body of [null, "text", 7, []]) {
      const context = transport(body);
      await expect(context.call()).resolves.toBe(snapshot);
      expect(context.bridge).toHaveBeenCalledTimes(1);
    }
  });

  it("passes the asset-server body through untouched, ref included", async () => {
    const body: SessionSnapshot = { messages: [], model: { provider: "p", id: "m" }, messageCount: 3 };
    const context = transport(body);
    await expect(context.call()).resolves.toBe(body);
  });
});
