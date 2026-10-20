<script setup lang="ts">
import { ui } from "../ui/classes";
import { X } from "lucide-vue-next";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useModalFocus } from "../composables/useModalFocus";
import { useAppStore, type ExtensionUIRequest } from "../stores/app";
import BatchQuestionForm from "./BatchQuestionForm.vue";
import { tr } from "../i18n";

const appStore = useAppStore();
// The live request - the only one that may be answered.
const request = computed(() => appStore.extensionRequestByThread[appStore.activeThreadId]);
// What is painted. `pi-tui-kit`'s dialog fallback re-sends the same screen after every click, and
// the store keeps the head slot held across that round trip. Retaining the last frame here is what
// makes the <section>, its scroll container, and the option rows survive the swap instead of being
// torn down - a torn-down `.dialog-body` restarts at scrollTop 0, which is the "click an item and
// the whole list jumps" symptom.
const frame = ref<ExtensionUIRequest | undefined>(request.value);
const pendingCount = computed(() => appStore.extensionRequestsPendingByThread[appStore.activeThreadId]?.length ?? 0);
// True during the hold: the frame on screen has already been answered.
const stale = computed(() => !request.value);
const value = ref("");
const dialog = ref<HTMLElement | null>(null);
// The window is centred, so any change in its height slides every row by half the delta. A `select`
// re-sends itself on each click, so from the first re-issue onwards its height is pinned to what
// the frame you clicked on actually occupied; anything taller scrolls inside .dialog-body, which is
// already what happens at max-h. The first frame is never pinned, so a two-option select stays small.
const heightLock = ref(0);
const dialogTitle = computed(() => frame.value?.method === "batch_ask"
  ? tr("extension.batchTitle", { count: frame.value.batchQuestions?.length ?? 0 })
  : frame.value?.title || tr("extension.title"));
let timeoutID: ReturnType<typeof setTimeout> | undefined;

useModalFocus(dialog, () => appStore.respondToExtension(undefined, true));

function respond(answer: string | boolean | undefined, cancelled = false) {
  // Never answer twice: during the hold the painted frame is already spent.
  if (!request.value) return;
  // Forward exactly the arguments the template used to pass - `cancelled` only exists when true.
  void (cancelled ? appStore.respondToExtension(answer, true) : appStore.respondToExtension(answer));
}

// pi-tui-kit has no screen identity on the wire, only the strings it renders; its `dialogTitle()`
// always puts the screen title on the first line, so that line is what distinguishes "same screen,
// re-issued" from "the user navigated somewhere else".
function screenKeyOf(screen?: ExtensionUIRequest) {
  return screen ? `${screen.method}|${(screen.title ?? "").split("\n", 1)[0]}` : "";
}

// `flush: "pre"` - reading the rect here still measures the OUTGOING frame, which is the geometry
// the user's eyes are on.
watch(frame, (next, previous) => {
  if (!next || !previous) return;
  if (screenKeyOf(next) !== screenKeyOf(previous)) {
    heightLock.value = 0;
    return;
  }
  if (heightLock.value || next.method !== "select") return;
  const measured = Math.round(dialog.value?.getBoundingClientRect().height ?? 0);
  if (measured > 64) heightLock.value = measured;
});

watch(request, (next) => {
  if (next) frame.value = next;
  if (timeoutID) clearTimeout(timeoutID);
  value.value = next?.prefill ?? "";
  if (next?.timeout && Number.isFinite(next.timeout) && next.timeout > 0) {
    timeoutID = setTimeout(() => appStore.dismissExtensionRequest(next.id), next.timeout);
  }
}, { immediate: true });

onBeforeUnmount(() => {
  if (timeoutID) clearTimeout(timeoutID);
});
</script>

<template>
  <div v-if="frame" class="dialog-backdrop" :class="[ui.dialogBackdrop, { 'extension-dialog-hold': stale }]">
    <section ref="dialog" class="dialog-window extension-dialog" :class="[ui.dialog, frame.method === 'select' ? 'select-dialog' : '', frame.method === 'batch_ask' ? ui.dialogLarge : '', { 'batch-extension-dialog': frame.method === 'batch_ask' }]" :style="heightLock ? { height: `${heightLock}px` } : undefined" role="dialog" aria-modal="true" :aria-labelledby="`extension-title-${frame.id}`" :aria-busy="stale" tabindex="-1">
      <header :class="ui.dialogHeader">
        <h2 :id="`extension-title-${frame.id}`">{{ dialogTitle }}</h2>
        <button class="icon-button" :class="ui.iconButton" type="button" :title="tr('extension.cancel')" @click="respond(undefined, true)"><X :size="17" /></button>
      </header>
      <div class="dialog-body" :class="[ui.dialogBody, { 'batch-question-dialog-body': frame.method === 'batch_ask' }]">
        <p v-if="pendingCount" class="extension-pending text-[var(--font-size-label)] text-[var(--text-muted)]">{{ tr("extension.pendingCount", { count: pendingCount }) }}</p>
        <BatchQuestionForm
          v-if="frame.method === 'batch_ask' && frame.batchQuestions"
          :key="frame.id"
          :questions="frame.batchQuestions"
          :review="Boolean(frame.batchReview)"
          @submit="respond($event)"
        />
        <p v-else-if="frame.message">{{ frame.message }}</p>
        <!-- Keyed by position, not by the label: a toggle rewrites the row's text (`[ ] read` ->
             `[x] read`), and a string key makes that a different node - so every click destroyed
             and rebuilt the rows it touched. -->
        <div v-if="frame.method === 'select'" class="select-options">
          <button v-for="(option, index) in frame.options" :key="index" class="text-button select-option" type="button" @click="respond(option)">{{ option }}</button>
        </div>
        <textarea :class="ui.textarea" v-else-if="frame.method === 'editor'" v-model="value" rows="10" :placeholder="frame.placeholder" autofocus />
        <input :class="ui.input" v-else-if="frame.method === 'input'" v-model="value" :placeholder="frame.placeholder" autofocus @keydown.enter="respond(value)" />
      </div>
      <footer :class="ui.dialogFooter" v-if="frame.method !== 'select' && frame.method !== 'batch_ask'">
        <button class="text-button" :class="ui.button" type="button" @click="respond(undefined, true)">{{ tr("extension.cancel") }}</button>
        <template v-if="frame.method === 'confirm'">
          <button class="text-button" :class="ui.button" type="button" @click="respond(false)">{{ tr("extension.no") }}</button>
          <button class="text-button primary" :class="ui.buttonPrimary" type="button" @click="respond(true)">{{ tr("extension.yes") }}</button>
        </template>
        <button v-else class="text-button primary" :class="ui.buttonPrimary" type="button" @click="respond(value)">{{ tr("extension.submit") }}</button>
      </footer>
    </section>
  </div>
</template>
