import { Events } from "@wailsio/runtime";
import { TerminalService } from "../../bindings/pi-desk/internal/appservice";
import type { TerminalState } from "../../bindings/pi-desk/internal/domain";

export interface TerminalEvent {
  threadId: string;
  /** Which terminal of the task produced this. Empty means the task's one and only terminal, the
   *  shape the runtime used before a task could own several. */
  sessionId?: string;
  type: "output" | "error" | "exit";
  generation?: number;
  sequence: number;
  dataB64?: string;
  exitCode?: number;
  error?: string;
  /** Wall-clock millisecond at which the pseudo-terminal produced `dataB64`. */
  emittedAt?: number;
}

export type TerminalWorkspaceReference = string | { workspaceId: string };

export const terminalService = {
  start(threadId: string, sessionId: string | undefined, workspace: TerminalWorkspaceReference, columns: number, rows: number): Promise<TerminalState> {
    const reference = typeof workspace === "string" ? { workspacePath: workspace } : workspace;
    return TerminalService.Start({ threadId, sessionId, ...reference, columns, rows });
  },
  snapshot(threadId: string, sessionId?: string, workspaceId?: string): Promise<TerminalState> {
    return TerminalService.Snapshot({ threadId, sessionId, workspaceId });
  },
  write(threadId: string, sessionId: string | undefined, data: string): Promise<void> {
    return TerminalService.Write({ threadId, sessionId, data });
  },
  resize(threadId: string, sessionId: string | undefined, columns: number, rows: number): Promise<void> {
    return TerminalService.Resize({ threadId, sessionId, columns, rows });
  },
  stop(threadId: string, sessionId?: string): Promise<void> {
    return TerminalService.Stop({ threadId, sessionId });
  },
};

export function onTerminalEvent(callback: (event: TerminalEvent) => void): () => void {
  return Events.On("terminal:event", (event) => callback(event.data as TerminalEvent));
}
