import { defineStore } from "pinia";
import type { PromptCacheStatus, SessionStats } from "./app";

/** Session statistics and compaction estimates. */
export const useUsageStore = defineStore("usage", {
  state: () => ({
    sessionStatsByThread: {} as Record<string, SessionStats>,
    promptCacheByThread: {} as Record<string, PromptCacheStatus | undefined>,
    sessionStatsRefreshGenerationByThread: {} as Record<string, number>,
    compactionEstimatesByThread: {} as Record<string, Record<string, number>>,
    compactionDurationsByThread: {} as Record<string, Record<string, number>>,
    compactionStartByThread: {} as Record<string, number>,
    latestCompactionEstimateByThread: {} as Record<string, number | undefined>,
  }),
});
