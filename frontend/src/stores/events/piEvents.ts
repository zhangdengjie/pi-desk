import { runtimeErrorText } from "../../utils/runtimeError";
import { subagentSummaryFromResult, type SubagentTaskSummary } from "../../utils/subagentTasks";
import { buildToolDiff } from "../../utils/toolDiff";

export const TOOL_OUTPUT_LIMIT = 256 << 10;
const TOOL_OUTPUT_TRUNCATION_MARKER = "\n\n... output truncated by Pi Desk ...\n\n";

export interface ToolCallShape {
  id: string;
  name: string;
  arguments?: unknown;
  output: string;
  status: "running" | "complete" | "error" | "unfinished";
  startedAt?: number;
  durationMs?: number;
  truncated?: boolean;
  resultReceived?: boolean;
  diff?: ReturnType<typeof buildToolDiff>;
  subagents?: SubagentTaskSummary;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") return value.text;
      return "";
    })
    .join("");
}

export function contentThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as Record<string, unknown>;
      if (value.type === "thinking" && typeof value.thinking === "string") return value.thinking;
      return "";
    })
    .join("");
}

export function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const value = result as Record<string, unknown>;
  return contentText(value.content) || (typeof value.output === "string" ? value.output : "");
}

export function boundedToolOutput(output: string): { text: string; truncated: boolean } {
  if (output.length <= TOOL_OUTPUT_LIMIT) return { text: output, truncated: false };
  const available = TOOL_OUTPUT_LIMIT - TOOL_OUTPUT_TRUNCATION_MARKER.length;
  const headLength = Math.floor(available * 0.6);
  return {
    text: output.slice(0, headLength) + TOOL_OUTPUT_TRUNCATION_MARKER + output.slice(-(available - headLength)),
    truncated: true,
  };
}

export function tokenCount(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : undefined;
}

export function messageTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

export interface MessageStartParts {
  text: string;
  thinking: string;
  activeExecution?: "thinking" | "text";
}

export function messageStartParts(message: Record<string, unknown>): MessageStartParts {
  const text = contentText(message.content);
  const thinking = contentThinking(message.content);
  return {
    text,
    thinking,
    activeExecution: thinking ? "thinking" : text ? "text" : undefined,
  };
}

export interface MessageEndParts {
  text: string;
  thinking: string;
  error?: string;
  timestampMs?: number;
}

export function messageEndParts(message: Record<string, unknown>): MessageEndParts {
  return {
    text: contentText(message.content),
    thinking: contentThinking(message.content),
    error: runtimeErrorText(message.errorMessage),
    timestampMs: messageTimestamp(message.timestamp),
  };
}

export function toolStartFromPayload(payload: Record<string, unknown>, id: string, now: number): ToolCallShape {
  const name = String(payload.toolName ?? "tool");
  return {
    id,
    name,
    arguments: payload.args,
    output: "",
    status: "running",
    startedAt: now,
    diff: buildToolDiff(name, payload.args),
  };
}

export interface ToolProgress {
  patch: Partial<ToolCallShape>;
  result?: Record<string, unknown>;
}

export function toolProgressFromPayload(
  tool: ToolCallShape,
  payload: Record<string, unknown>,
  isEnd: boolean,
  now: number,
): ToolProgress {
  const rawResult = payload.partialResult ?? payload.result;
  const finalResult = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
    ? payload.result as Record<string, unknown>
    : undefined;
  const output = resultText(rawResult);
  const patch: Partial<ToolCallShape> = {};
  if (output) {
    const bounded = boundedToolOutput(output);
    patch.output = bounded.text;
    patch.truncated = bounded.truncated;
  }
  const subagents = subagentSummaryFromResult(rawResult);
  if (subagents) patch.subagents = subagents;
  if (isEnd) {
    patch.resultReceived = true;
    patch.status = payload.isError ? "error" : "complete";
    patch.durationMs = tokenCount(payload.durationMs) ?? (tool.startedAt !== undefined ? Math.max(0, now - tool.startedAt) : undefined);
    const diff = buildToolDiff(tool.name, tool.arguments, finalResult?.details);
    if (diff) patch.diff = diff;
  }
  return { patch, result: finalResult };
}

export interface RetryStartParts {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage?: string;
  retryAt: number;
}

export function retryStartFromPayload(payload: Record<string, unknown>, now: number): RetryStartParts {
  const retry = {
    attempt: Number(payload.attempt ?? 0),
    maxAttempts: Number(payload.maxAttempts ?? 0),
    delayMs: Number(payload.delayMs ?? 0),
    errorMessage: runtimeErrorText(payload.errorMessage),
  };
  return { ...retry, retryAt: now + Math.max(0, retry.delayMs) };
}

export interface RetryPrevious {
  attempt: number;
  maxAttempts: number;
  errorMessage?: string;
}

export interface RetryEndParts {
  succeeded: boolean;
  status: "recovered" | "failed";
  error?: string;
  attempt: number;
  maxAttempts?: number;
}

export function retryEndFromPayload(payload: Record<string, unknown>, previous?: RetryPrevious): RetryEndParts {
  const succeeded = payload.success === true;
  return {
    succeeded,
    status: succeeded ? "recovered" : "failed",
    error: runtimeErrorText(payload.finalError) ?? previous?.errorMessage,
    attempt: Number(payload.attempt ?? previous?.attempt ?? 0),
    maxAttempts: previous?.maxAttempts,
  };
}
