import { Events } from "@wailsio/runtime";

export interface AgentEvent {
  id: string;
  seq: number;
  type: string;
  taskId?: string;
  runId?: string;
  threadId?: string;
  sessionPath?: string;
  runtime?: string;
  generation?: number;
  ts: number;
  payload: unknown;
}

/** No-op outside a Wails host (unit tests, plain browser). */
export function onAgentEvent(callback: (event: AgentEvent) => void): () => void {
  if (typeof window === "undefined" || !("_wails" in window)) return () => undefined;
  return Events.On("agent:event", (event) => callback(event.data as AgentEvent));
}
