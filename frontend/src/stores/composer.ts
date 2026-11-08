import { defineStore } from "pinia";
import type { PreparedImage } from "../utils/imageAttachments";
import type { PendingPrompt, PiModel, QueuedMessages } from "./app";

/** Drafts, attachments and queued prompts, keyed by thread. */
export const useComposerStore = defineStore("composer", {
  state: () => ({
    draftsByThread: {} as Record<string, string>,
    attachmentsByThread: {} as Record<string, PreparedImage[]>,
    pendingPromptsByThread: {} as Record<string, PendingPrompt[]>,
    pendingPromptsPausedByThread: {} as Record<string, boolean>,
    pendingPromptDispatchByThread: {} as Record<string, string>,
    pendingModelByThread: {} as Record<string, PiModel | undefined>,
    pendingThinkingByThread: {} as Record<string, string | undefined>,
    queueByThread: {} as Record<string, QueuedMessages>,
  }),
});
