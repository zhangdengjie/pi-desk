import { tr } from "../i18n";

/**
 * The red line under a failed run is Pi's raw `errorMessage`, so a Chinese reader gets
 * 「模型请求失败，本轮已停止…」 followed by `Request was aborted`. Pi's own TUI already draws the
 * line we copy: it treats that exact string as a *sentinel* and swaps it for a fixed phrase, while
 * every other `errorMessage` passes through untouched
 * (`pi-coding-agent/dist/modes/interactive/components/assistant-message.js:144`).
 *
 * So localize the sentinels and nothing else. A provider body ("429 ... retry after 3s") carries
 * numbers the reader needs; rewriting it into a friendly sentence would hide the cause, which is
 * worse than mixed-language text. Unknown stays verbatim - the tooltip keeps the original either way.
 */
const SENTINELS = new Set([
  "request was aborted",
  "request aborted",
  "aborted",
  "operation aborted",
]);

export function humanizeRunError(error: string): string {
  return SENTINELS.has(error.trim().toLowerCase()) ? tr("conversation.requestAborted") : error;
}
