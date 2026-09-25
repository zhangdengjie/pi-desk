import { describe, expect, it } from "vitest";
import { tr } from "../i18n";
import { humanizeRunError } from "./runErrors";

// Asserted through `tr` so the file holds under either locale (vitest boots in en, the app in zh-CN).
describe("humanizeRunError", () => {
  it.each([
    "Request was aborted",
    "Request aborted",
    "Aborted",
    "Operation aborted",
    "  request WAS aborted \n",
  ])("localizes the abort sentinel %j", (raw) => {
    // No `not.toBe(raw)` here: in the en locale the translation of one sentinel IS the sentinel.
    expect(humanizeRunError(raw)).toBe(tr("conversation.requestAborted"));
  });

  it("passes a provider body through untouched - mixed language beats a wrong sentence", () => {
    for (const raw of [
      "429 Too Many Requests: retry after 3s",
      "Range of input length should be [1, 258048]",
      "Cannot connect to API base URL",
    ]) {
      expect(humanizeRunError(raw)).toBe(raw);
    }
  });
});
