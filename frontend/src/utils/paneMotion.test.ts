import tokensFile from "../styles/tokens.css?inline";
import { describe, expect, it } from "vitest";
import { PANEL_MOTION_MS, PANEL_SETTLE_MS } from "./paneMotion";

async function tokensText(): Promise<string> {
  if (tokensFile.includes("--bg-app")) return tokensFile.replace(/\r\n?/g, "\n");
  const moduleName = ["node", "fs/promises"].join(":");
  const { readFile } = await import(/* @vite-ignore */ moduleName) as {
    readFile(path: string, encoding: "utf8"): Promise<string>;
  };
  return (await readFile("src/styles/tokens.css", "utf8")).replace(/\r\n?/g, "\n");
}

describe("paneMotion", () => {
  it("pins the JS settle timer to the CSS --motion-panel duration", async () => {
    const css = await tokensText();
    const declared = css.match(/--motion-panel:\s*(\d+)ms/)?.[1];
    // utils/paneMotion.ts and styles/workbench.css read the same duration from two places. If this
    // fails, the pane unmounts mid-slide (JS too short) or the rail sits in a dead zone (too long).
    expect(Number(declared)).toBe(PANEL_MOTION_MS);
    expect(PANEL_SETTLE_MS).toBeGreaterThan(PANEL_MOTION_MS);
    expect(PANEL_SETTLE_MS - PANEL_MOTION_MS).toBeLessThanOrEqual(60);
  });
});
