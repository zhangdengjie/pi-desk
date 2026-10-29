import { afterEach, describe, expect, it } from "vitest";
import { applyStreamTuning, resetStreamTuning, SHIPPED, streamTuning } from "./streamTuning";
import { nextTailScroll } from "./scroll";

describe("streamTuning", () => {
  afterEach(() => resetStreamTuning());

  it("ships the same numbers the Go defaults write into a new file", () => {
    // internal/userconfig.DefaultReveal()/DefaultScroll() create the file with these;
    // a drift here means a fresh install and a fresh build disagree about the pace.
    expect(SHIPPED.reveal).toEqual({ mode: "plain", split: 20, floor: 2, ceiling: 60 });
    expect(SHIPPED.scroll).toEqual({ snapWithinPx: 4, factor: 0.32, resumeWithinPx: 24, liveWindowDelayMs: 1200, reasoningFoldMs: 0 });
    expect(streamTuning.reveal).toEqual(SHIPPED.reveal);
    expect(streamTuning.scroll).toEqual(SHIPPED.scroll);
  });

  it("takes a hand edit field by field and keeps the rest", () => {
    applyStreamTuning({ split: 3 } as never, undefined);
    expect(streamTuning.reveal.split).toBe(3);
    expect(streamTuning.reveal.ceiling).toBe(SHIPPED.reveal.ceiling);
    expect(streamTuning.scroll.snapWithinPx).toBe(SHIPPED.scroll.snapWithinPx);
  });

  it("rejects out of range values instead of taking a half-broken object", () => {
    applyStreamTuning({ split: 0, floor: -3, ceiling: 1 }, { factor: 0, snapWithinPx: -5, resumeWithinPx: 0, liveWindowDelayMs: 99999, reasoningFoldMs: -1 });
    expect(streamTuning.reveal).toEqual(SHIPPED.reveal);
    expect(streamTuning.scroll).toEqual(SHIPPED.scroll);
  });

  // 0 is a real setting here (fold off = the pre-fold behaviour), so it must survive while a
  // negative or absurdly slow fold falls back to the shipped 200ms.
  it("keeps a zero reasoning fold and rejects an impossible one", () => {
    applyStreamTuning(null, { reasoningFoldMs: 0 });
    expect(streamTuning.scroll.reasoningFoldMs).toBe(0);
    applyStreamTuning(null, { reasoningFoldMs: 5000 });
    expect(streamTuning.scroll.reasoningFoldMs).toBe(SHIPPED.scroll.reasoningFoldMs);
  });

  // Same rule as Go's normalise(): a ceiling under the floor is a contradiction, so the
  // field is replaced rather than silently reinterpreted.
  it("replaces a ceiling that contradicts the floor", () => {
    applyStreamTuning({ floor: 40, ceiling: 5 }, null);
    expect(streamTuning.reveal.floor).toBe(40);
    expect(streamTuning.reveal.ceiling).toBe(SHIPPED.reveal.ceiling);
  });

  // Same rule as Go's normalise(): an unknown render mode falls back to the shipped one instead
  // of being handed to the renderer.
  it("takes the render mode and rejects an unknown one", () => {
    applyStreamTuning({ mode: "markdown" }, null);
    expect(streamTuning.reveal.mode).toBe("markdown");
    applyStreamTuning({ mode: "raw" }, null);
    expect(streamTuning.reveal.mode).toBe("raw");
    applyStreamTuning({ mode: "typewriter" as never }, null);
    expect(streamTuning.reveal.mode).toBe(SHIPPED.reveal.mode);
  });

  it("is read per call by the scroll geometry", () => {
    applyStreamTuning(null, { snapWithinPx: 10, factor: 0.5 });
    // A 40px jump used to snap (inside the shipped 140px); with a 10px snap band it eases.
    expect(nextTailScroll(1000, 1140, 100)).toBe(1020);
    applyStreamTuning(null, { snapWithinPx: 100 });
    expect(nextTailScroll(1000, 1140, 100)).toBe(1140);
  });
});
