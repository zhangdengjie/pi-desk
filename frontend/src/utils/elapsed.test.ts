import { describe, expect, it } from "vitest";

import { formatElapsed } from "./elapsed";

describe("formatElapsed", () => {
  it("uses the transcript's scale steps", () => {
    expect(formatElapsed(0)).toBe("0ms");
    expect(formatElapsed(999)).toBe("999ms");
    expect(formatElapsed(1_000)).toBe("1.0s");
    expect(formatElapsed(8_400)).toBe("8.4s");
    expect(formatElapsed(12_400)).toBe("12s");
    expect(formatElapsed(60_000)).toBe("1m0s");
    expect(formatElapsed(125_000)).toBe("2m5s");
  });

  it("keeps the pre-existing rounding at the minute boundary", () => {
    // 59.999 s still reads "60s" rather than "1m0s" - the same output the assistant row has
    // always produced. Recorded so a future "fix" is a deliberate change, not a silent drift.
    expect(formatElapsed(59_999)).toBe("60s");
  });
});
