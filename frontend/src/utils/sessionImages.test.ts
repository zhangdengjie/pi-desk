import { SESSION_IMAGE_PATH, sessionImageUrl } from "./sessionImages";
import { describe, expect, it } from "vitest";

describe("session image urls", () => {
  it("encodes a reference so it survives the query string", () => {
    // A reference is base64url plus a dot, and the signature is what makes it unforgeable - a
    // `+`/`/` pair from a hand-built URL would be corrupted by the form decoder.
    expect(sessionImageUrl("cGF5bG9hZA.c2ln")).toBe(`${SESSION_IMAGE_PATH}?ref=cGF5bG9hZA.c2ln`);
    expect(sessionImageUrl("a+b/c=d&e")).toBe(`${SESSION_IMAGE_PATH}?ref=a%2Bb%2Fc%3Dd%26e`);
  });

  it("stays relative so the page's own origin serves it", () => {
    // The dev server proxies unknown paths to the app's asset server, and a packaged build answers
    // on its own scheme: an absolute URL would hard-code one of the two.
    expect(sessionImageUrl("x").startsWith("/")).toBe(true);
    expect(sessionImageUrl("x")).not.toContain("://");
  });
});