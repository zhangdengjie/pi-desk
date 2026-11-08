import { defineStore } from "pinia";
import { createID, nowLabel } from "../utils/ids";
import type { TimelineMessage, ToolExecution } from "./app";

function finishTool(tool: ToolExecution) {
  if (tool.status === "running") tool.status = "unfinished";
  tool.children?.forEach(finishTool);
}

/**
 * Live transcript state for one process. `app.ts` keeps getters with the same
 * names as a facade while the rest of the store is split in later cuts.
 */
export const useSessionStore = defineStore("session", {
  state: () => ({
    messagesByThread: {} as Record<string, TimelineMessage[]>,
    activeAssistantByThread: {} as Record<string, string>,
    waitingForOutputByThread: {} as Record<string, boolean | undefined>,
  }),
  actions: {
    currentAssistant(threadId: string, create: boolean): TimelineMessage | undefined {
      const messages = this.messagesByThread[threadId] ?? (this.messagesByThread[threadId] = []);
      const activeID = this.activeAssistantByThread[threadId];
      let assistant = messages.find((message) => message.id === activeID);
      if (!assistant && create) {
        assistant = {
          id: createID("assistant"),
          role: "assistant",
          text: "",
          thinking: "",
          timestamp: nowLabel(),
          timestampMs: Date.now(),
          streaming: true,
          tools: [],
        };
        messages.push(assistant);
        this.activeAssistantByThread[threadId] = assistant.id;
      }
      return assistant;
    },
    finishAssistant(threadId: string) {
      const messages = this.messagesByThread[threadId] ?? [];
      const activeID = this.activeAssistantByThread[threadId];
      const activeIndex = messages.findIndex((message) => message.id === activeID);
      for (let index = activeIndex; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== "assistant") break;
        message.streaming = false;
        message.activeExecution = undefined;
        message.tools.forEach(finishTool);
      }
      delete this.activeAssistantByThread[threadId];
    },
  },
});
