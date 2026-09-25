import { completedToolDiff, type CompletedToolLike } from "./toolDiff";

export const CONVERSATION_VIRTUALIZATION_THRESHOLD = 80;

interface VirtualizationCandidate {
  role: "user" | "assistant" | "system";
  text: string;
  thinking: string;
  /** A live row has no changed-files card yet (ConversationMessage hides it mid-run). */
  streaming?: boolean;
  images?: unknown[];
  tools: CompletedToolLike[];
  executionSteps?: Array<{ kind: "thinking" | "tools" | "message"; tools?: CompletedToolLike[] }>;
  runNotice?: { status: "retrying" | "retried" | "recovered" | "failed" };
  compaction?: { summary: string; tokensBefore?: number };
}

export function shouldVirtualizeMessages(messages: VirtualizationCandidate[]): boolean {
  return messages.length > CONVERSATION_VIRTUALIZATION_THRESHOLD;
}

function collectDiffs(paths: Set<string>, tools: CompletedToolLike[] | undefined) {
  for (const tool of tools ?? []) {
    const diff = completedToolDiff(tool);
    if (diff) paths.add(diff.path);
  }
}

/**
 * The height the settled changed-files card will take, counted through the same predicate
 * the card renders with (`completedToolDiff`): a 56px header, one 40px row per file up to
 * three, then the 40px "N more" row. The estimate used to skip this entirely, so every
 * row below an answer grew by the card's height on the measure pass that followed the run
 * - which is a shift of the whole transcript, not of one row.
 */
export function estimatedChangedFilesSize(message: VirtualizationCandidate): number {
  // Deliberately independent of `message.streaming`. The virtualizer positions every row by
  // summing these numbers, so a value that changes when a flag flips moves the whole
  // viewport by (rows x delta). Reserving the card only after the run stopped was exactly
  // that: on a 354-line session the transcript alternated between two scroll positions
  // ~1500px apart at ~15Hz (measured frame by frame from a screen recording). Reserving it
  // always costs a little accuracy mid-run and buys a number that never oscillates.
  if (message.role !== "assistant") return 0;
  const paths = new Set<string>();
  for (const step of message.executionSteps ?? []) collectDiffs(paths, step.tools);
  collectDiffs(paths, message.tools);
  if (!paths.size) return 0;
  return 56 + 40 * Math.min(paths.size, 3) + (paths.size > 3 ? 40 : 0) + 8;
}

/**
 * Lines a markdown body occupies, deliberately coarse.
 *
 * A precise count is worse here than a wrong one. The virtualizer places every row by
 * summing these numbers, so a row that is still streaming must not move its neighbours:
 * counting hard breaks means a table or list landing in one chunk jumps the estimate from
 * 1 line to 20 (+440px), and everything below it shifts by that much in one frame. Measured
 * on a screen recording of a table-heavy answer: the viewport bounced ±111 to ±166 device
 * pixels every ~0.25s, exactly this shape. A character-count estimate grows smoothly and
 * monotonically with the text, which is the property the layout actually needs.
 *
 * The accuracy this gives up is recovered by `measureElement` on mount - and by the
 * changed-files reservation below, which is the one height that is genuinely invisible to
 * a character count.
 */
function proseLines(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 90));
}

export function estimateMessageSize(message: VirtualizationCandidate): number {
  if (message.compaction) return 48;
  const textLines = proseLines(message.text);
  const groupedSections = message.executionSteps?.reduce((count, step) => count + (step.kind === "tools" ? step.tools?.length ?? 0 : 1), 0) ?? 0;
  const compactSections = Math.max(groupedSections, (message.thinking ? 1 : 0) + message.tools.length);
  const noticeSize = message.runNotice ? 48 : 0;
  const baseSize = message.role === "system"
    ? 62
    : message.role === "user"
      ? 86
      : compactSections > 0
        ? 0
        : 28;
  // The ceiling only keeps one row from claiming more than a viewport; a measured answer
  // with a card and a long body is routinely past the old 420, and every pixel it missed
  // was a pixel the next measure pass moved the rows below it.
  return Math.min(900, Math.max(22, baseSize + textLines * 22 + compactSections * 22 + noticeSize + estimatedChangedFilesSize(message)));
}
