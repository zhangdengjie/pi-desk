import { tr } from "../i18n";
import { createID, formatMessageTime } from "../utils/ids";
import { parseImageDataURL, type PreparedImage } from "../utils/imageAttachments";
import { sessionImageUrl } from "../utils/sessionImages";
import { buildToolDiff } from "../utils/toolDiff";
import { runtimeErrorText } from "../utils/runtimeError";
import {
  boundedToolOutput,
  contentText,
  contentThinking,
  messageTimestamp,
  tokenCount,
} from "./events/piEvents";
import type { PromptCacheStatus, TimelineMessage, ToolExecution } from "./app";

export function contentImages(content: unknown): PreparedImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part, index) => {
    if (!part || typeof part !== "object") return [];
    const value = part as Record<string, unknown>;
    if (value.type !== "image" || typeof value.mimeType !== "string") return [];
    // A snapshot image carries a reference instead of bytes (see utils/sessionImages.ts). Its
    // payload is the URL itself - one string, no base64 copy, and no `data:` URL built here.
    if (typeof value.ref === "string" && value.ref) {
      return [{
        id: createID(`history-image-${index}`),
        name: `Image ${index + 1}`,
        data: "",
        bytes: typeof value.bytes === "number" ? value.bytes : undefined,
        ref: value.ref,
        mimeType: value.mimeType,
        previewUrl: sessionImageUrl(value.ref),
      }];
    }
    if (typeof value.data !== "string" || !value.data) return [];
    return [{
      id: createID(`history-image-${index}`),
      name: `Image ${index + 1}`,
      data: value.data,
      mimeType: value.mimeType,
      previewUrl: `data:${value.mimeType};base64,${value.data}`,
    }];
  });
}

/**
 * The one path that still needs an image's bytes: sending it. A fork of a user message carries that
 * message's images into the composer, and those may be reference-only, so they are fetched back and
 * encoded at the RPC boundary instead of being kept in memory for the whole session.
 */
export async function imageAttachmentContent(image: PreparedImage): Promise<{ type: "image"; data: string; mimeType: string }> {
  if (image.data || !image.ref) return { type: "image", data: image.data, mimeType: image.mimeType };
  const response = await fetch(sessionImageUrl(image.ref));
  if (!response.ok) throw new Error("Unable to read the attached image");
  const parsed = parseImageDataURL(await readBlobDataURL(await response.blob()), image.mimeType);
  return { type: "image", data: parsed.data, mimeType: parsed.mimeType };
}

export function readBlobDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Unable to read the attached image"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}




export function messageTime(value: unknown): string {
  const timestamp = messageTimestamp(value);
  return timestamp === undefined ? "" : formatMessageTime(new Date(timestamp));
}

export function transcriptDisplayID(value: Record<string, unknown>): string | undefined {
  if (typeof value.piDeskEntryId === "string") return value.piDeskEntryId;
  return typeof value.piDeskDisplayId === "string" ? value.piDeskDisplayId : undefined;
}

export function historicalIdentity(value: Record<string, unknown>, fallback: string, prefix = "history"): { id: string; entryId?: string } {
  const entryId = typeof value.piDeskEntryId === "string" ? value.piDeskEntryId : undefined;
  const displayId = transcriptDisplayID(value);
  return {
    id: displayId ? `${prefix}-${displayId}` : createID(fallback),
    entryId,
  };
}


export function promptCacheStatus(message: Record<string, unknown>, cacheObserved = false): PromptCacheStatus | undefined {
  if (!message.usage || typeof message.usage !== "object" || Array.isArray(message.usage)) return undefined;
  const usage = message.usage as Record<string, unknown>;
  const input = tokenCount(usage.input) ?? 0;
  const cacheRead = tokenCount(usage.cacheRead) ?? 0;
  const cacheWrite = tokenCount(usage.cacheWrite) ?? 0;
  if (input + cacheRead + cacheWrite === 0) return undefined;
  return { input, cacheRead, cacheWrite, cacheObserved: cacheObserved || cacheRead + cacheWrite > 0 };
}

export function latestPromptCacheStatus(source: Array<Record<string, unknown>>): PromptCacheStatus | undefined {
  let latest: PromptCacheStatus | undefined;
  for (const message of source) {
    if (message.role !== "assistant") continue;
    latest = promptCacheStatus(message, latest?.cacheObserved) ?? latest;
  }
  return latest;
}

export function compactionEstimateKey(summary: string, tokensBefore: number | undefined): string {
  return `${tokensBefore ?? ""}\n${summary}`;
}

export function findTool(tools: ToolExecution[], id: string): ToolExecution | undefined {
  for (const tool of tools) {
    if (tool.id === id) return tool;
    const child = findTool(tool.children ?? [], id);
    if (child) return child;
  }
}

export function nestedToolHistory(value: unknown): ToolExecution[] | undefined {
  if (!value || typeof value !== "object") return;
  const calls = (value as Record<string, unknown>).calls;
  if (!Array.isArray(calls)) return;
  const roots: ToolExecution[] = [];
  const byId = new Map<string, ToolExecution>();
  for (const call of calls) {
    if (!call || typeof call !== "object") continue;
    const tool: ToolExecution = {
      id: String(call.id), name: String(call.name), arguments: call.arguments,
      output: typeof call.error === "string" ? call.error : call.status === "unfinished" ? tr("tools.unfinished") : "",
      status: call.status === "ok" ? "complete" : call.status === "unfinished" ? "unfinished" : "error",
      resultReceived: call.status !== "unfinished", durationMs: tokenCount(call.durationMs),
    };
    // Pi assigns each nested call <callerId>/<n>; the durable record omits parentToolCallId.
    const parent = byId.get(tool.id.slice(0, tool.id.lastIndexOf("/")));
    (parent ? (parent.children ??= []) : roots).push(tool);
    byId.set(tool.id, tool);
  }
  return roots;
}

export function historicalMessages(
  source: Array<Record<string, unknown>>,
  compactionEstimates: Record<string, number> = {},
  compactionDurations: Record<string, number> = {},
): TimelineMessage[] {
  const result: TimelineMessage[] = [];
  const toolsByID = new Map<string, ToolExecution>();
  for (const value of source) {
    const role = String(value.role ?? "");
    if (role === "piDeskCompaction") {
      const identity = historicalIdentity(value, "history-compaction", "history-compaction");
      const summary = typeof value.summary === "string" ? value.summary : "";
      const tokensBefore = tokenCount(value.tokensBefore);
      const persistedEstimate = tokenCount(value.estimatedTokensAfter);
      const estimateKey = compactionEstimateKey(summary, tokensBefore);
      result.push({
        id: identity.id,
        role: "system", text: "", thinking: "",
        timestamp: messageTime(value.timestamp), timestampMs: messageTimestamp(value.timestamp), streaming: false, tools: [],
        compaction: {
          summary,
          tokensBefore,
          estimatedTokensAfter: persistedEstimate ?? compactionEstimates[estimateKey],
          durationMs: compactionDurations[estimateKey],
        },
      });
      continue;
    }
    if (role === "toolResult") {
      const toolCallID = String(value.toolCallId ?? "");
      const tool = toolsByID.get(toolCallID);
      if (tool) {
        tool.entryId = typeof value.piDeskEntryId === "string" ? value.piDeskEntryId : undefined;
        tool.contextExcluded = value.piDeskContextExcluded === true || undefined;
        const output = boundedToolOutput(contentText(value.content));
        tool.output = output.text;
        tool.truncated = output.truncated || undefined;
        tool.resultReceived = true;
        tool.status = value.isError ? "error" : "complete";
        const images = contentImages(value.content);
        if (images.length) tool.images = images;
        const endedAt = messageTimestamp(value.timestamp);
        tool.durationMs = tokenCount(value.durationMs) ?? (endedAt !== undefined && tool.startedAt !== undefined ? Math.max(0, endedAt - tool.startedAt) : undefined);
        tool.children = nestedToolHistory(value.nestedCalls);
        tool.nestedCallsIncomplete = !!value.nestedCalls && (value.nestedCalls as Record<string, unknown>).complete === false;
        tool.diff = buildToolDiff(tool.name, tool.arguments, value.details) ?? tool.diff;
      }
      continue;
    }
    if (role === "user") {
      const images = contentImages(value.content);
      const identity = historicalIdentity(value, "history-user");
      result.push({
        ...identity,
        role: "user", text: contentText(value.content), thinking: "",
        timestamp: messageTime(value.timestamp), timestampMs: messageTimestamp(value.timestamp), streaming: false, images, tools: [],
        contextExcluded: value.piDeskContextExcluded === true || undefined,
      });
      continue;
    }
    if (role === "assistant") {
      const content = Array.isArray(value.content) ? value.content : [];
      const tools: ToolExecution[] = [];
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const part = item as Record<string, unknown>;
        if (part.type === "toolCall") {
          const tool: ToolExecution = {
            id: String(part.id ?? createID("history-tool")), name: String(part.name ?? "tool"),
            arguments: part.arguments, output: "", status: "unfinished", startedAt: messageTimestamp(value.timestamp),
          };
          tool.diff = buildToolDiff(tool.name, tool.arguments);
          tools.push(tool);
          toolsByID.set(tool.id, tool);
        }
      }
      const identity = historicalIdentity(value, "history-assistant");
      result.push({
        ...identity,
        role: "assistant", text: contentText(value.content), thinking: contentThinking(value.content),
        timestamp: messageTime(value.timestamp), timestampMs: messageTimestamp(value.timestamp), streaming: false,
        error: runtimeErrorText(value.errorMessage), tools,
        contextExcluded: value.piDeskContextExcluded === true || undefined,
      });
      continue;
    }
    if (role === "bashExecution") {
      const command = typeof value.command === "string" ? value.command : "";
      const output = typeof value.output === "string" ? value.output : "";
      result.push({
        ...historicalIdentity(value, "history-bash"), role: "system", text: [`$ ${command}`, output].filter(Boolean).join("\n"),
        thinking: "", timestamp: messageTime(value.timestamp), timestampMs: messageTimestamp(value.timestamp), streaming: false,
        error: Number(value.exitCode ?? 0) !== 0 ? `Command exited with code ${String(value.exitCode)}` : undefined, tools: [],
      });
    }
  }
  return result;
}

export function liveCompactionMessage(payload: Record<string, unknown>, durationMs?: number): TimelineMessage | undefined {
  if (payload.aborted === true) return undefined;
  const result = payload.result && typeof payload.result === "object" ? payload.result as Record<string, unknown> : undefined;
  if (!result || typeof result.summary !== "string") return undefined;
  const tokensBefore = tokenCount(result.tokensBefore);
  const timestampMs = Date.now();
  return {
    id: createID("live-compaction"),
    role: "system", text: "", thinking: "",
    timestamp: formatMessageTime(new Date(timestampMs)), timestampMs, streaming: false, tools: [],
    compaction: {
      summary: result.summary,
      tokensBefore,
      estimatedTokensAfter: tokenCount(result.estimatedTokensAfter),
      durationMs,
    },
  };
}

/**
 * Give the rows of the run that just settled back the ids they streamed under.
 *
 * A live turn is keyed by the RPC message id; the transcript snapshot that replaces it a
 * moment later is keyed by the session entry id (`historicalIdentity`). Same row, two
 * ids - and two ids mean Vue tears the row down and builds it again: the markdown is
 * parsed a second time, `useRevealedText` restarts, the reader's expanded panels are
 * forgotten (`detailsOpenState` remembers them by message id) and the virtualizer
 * re-measures every row below. Adopting the streamed id makes the settled transcript a
 * patch instead of a rebuild.
 *
 * Deliberately narrow: only the tail still keyed by a streamed id is touched, and it is
 * matched from the end so a repeated prompt cannot re-pair older rows. `entryId` is left
 * as the snapshot set it - edit/delete/fork address the session entry through that, not
 * through the display id.
 */
export function adoptStreamedIds(historical: TimelineMessage[], previous: TimelineMessage[]): void {
  let incoming = historical.length - 1;
  let streamed = previous.length - 1;
  while (incoming >= 0 && streamed >= 0) {
    const next = historical[incoming];
    const live = previous[streamed];
    // A row on a session entry id on either side means the run ends here.
    if (live.id.startsWith("history-") || !next.id.startsWith("history-")) return;
    // A prompt can come back expanded (prompt templates, skills), so the one row that
    // cannot be anything else is allowed to differ in text.
    const sameText = next.role === live.role && next.text === live.text;
    const samePrompt = next.role === "user" && live.role === "user";
    if (!sameText && !samePrompt) return;
    next.id = live.id;
    incoming -= 1;
    streamed -= 1;
  }
}

export function copyTool(tool: ToolExecution): ToolExecution {
  return { ...tool, diff: tool.diff ? { ...tool.diff } : undefined, children: tool.children?.map(copyTool) };
}

export function copyMessages(messages: TimelineMessage[]): TimelineMessage[] {
  return messages.map((message) => ({
    ...message,
    images: message.images?.map((image) => ({ ...image })),
    tools: message.tools.map(copyTool),
    executionSteps: message.executionSteps?.map((step) => ({
      ...step,
      tools: step.tools?.map(copyTool),
    })),
    compaction: message.compaction ? { ...message.compaction } : undefined,
    runNotice: message.runNotice ? { ...message.runNotice } : undefined,
  }));
}


