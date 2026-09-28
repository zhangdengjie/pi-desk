<script setup lang="ts">
// The search box, with no opinion about what it searches.
//
// It started life inline in `ConversationPane.vue`. The file preview needs the same control -
// same field, same `N / M` counter, same prev/next/close - and two copies of a popover are how the
// conversation one drifted out of sync with the inspector overlay (see the `--inspector-width`
// comment in styles/workbench.css). Placement is NOT this component's job: each host passes its own
// positioning classes (`conversation-search` / `markdown-search`), because the single root merges
// them onto the element that is already the CSS hook.
import { ChevronDown, ChevronUp, Search, X } from "lucide-vue-next";
import { ref } from "vue";
import { ui } from "../ui/classes";
import { tr } from "../i18n";

defineProps<{
  hasMatches: boolean;
  resultLabel: string;
  // The conversation and the preview want different placeholders; everything else is shared wording.
  placeholder?: string;
  ariaLabel?: string;
}>();

const query = defineModel<string>("query", { default: "" });

const emit = defineEmits<{ previous: []; next: []; close: [] }>();
// A ternary on the event name (`emit(cond ? "previous" : "next")`) does not typecheck: the union of
// two literal names collapses to a parameter none of `emit`'s overloads accepts. Branch instead.
function step(event: { shiftKey: boolean }) {
  if (event.shiftKey) emit("previous");
  else emit("next");
}

const input = ref<HTMLInputElement>();
defineExpose({
  focus() {
    input.value?.focus();
    input.value?.select();
  },
});
</script>

<template>
  <div class="search-popover overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-raised)] shadow-lg" :aria-label="ariaLabel ?? tr('conversation.search')" role="search">
    <div class="search-popover-main flex min-h-10 items-center gap-2 px-2 text-[var(--text-muted)]">
      <Search :size="17" aria-hidden="true" />
      <input
        ref="input"
        v-model="query"
        :class="ui.input"
        autocomplete="off"
        class="search-popover-input min-w-0 flex-1 border-0 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
        :placeholder="placeholder ?? tr('conversation.searchPlaceholder')"
        :aria-label="placeholder ?? tr('conversation.searchPlaceholder')"
        type="search"
        @keydown.enter.prevent="step($event)"
        @keydown.esc.prevent.stop="emit('close')"
      />
      <span class="search-popover-count shrink-0 font-mono text-[calc(10px+var(--font-size-delta))] text-[var(--text-muted)]" aria-live="polite">{{ resultLabel }}</span>
      <button class="search-popover-control inline-grid size-7 place-items-center rounded-md border-0 bg-transparent text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:bg-[var(--bg-active)] disabled:cursor-not-allowed disabled:opacity-40" type="button" :title="tr('conversation.previousSearchResult')" :aria-label="tr('conversation.previousSearchResult')" :disabled="!hasMatches" @click="emit('previous')">
        <ChevronUp :size="15" aria-hidden="true" />
      </button>
      <button class="search-popover-control inline-grid size-7 place-items-center rounded-md border-0 bg-transparent text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:bg-[var(--bg-active)] disabled:cursor-not-allowed disabled:opacity-40" type="button" :title="tr('conversation.nextSearchResult')" :aria-label="tr('conversation.nextSearchResult')" :disabled="!hasMatches" @click="emit('next')">
        <ChevronDown :size="15" aria-hidden="true" />
      </button>
      <button class="search-popover-close inline-grid size-7 place-items-center rounded-md border-0 bg-transparent text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:bg-[var(--bg-active)]" type="button" :title="tr('conversation.closeSearch')" :aria-label="tr('conversation.closeSearch')" @click="emit('close')">
        <X :size="17" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
