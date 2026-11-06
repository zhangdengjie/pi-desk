<script setup lang="ts">
import { Settings2, X } from "lucide-vue-next";
import { ref } from "vue";
import { tr } from "../i18n";
import {
  FONT_CHOICES, THEMES, readerSettings, updateReaderSettings, type ReaderTheme,
} from "./readerSettings";
import { useDismiss } from "./useDismiss";

/**
 * One settings surface for both reader views.
 *
 * PDF is a bitmap, so type controls would be lies there: `mode` keeps the panel to what the format
 * can actually honour. Everything else — theme, table-of-contents behaviour, wheel paging,
 * animation — is shared, which is the point of putting it here instead of in each toolbar.
 */
const props = defineProps<{ mode: "pdf" | "epub" }>();

const open = ref(false);
/** The parent closes this from outside the panel's own document (a press inside the book iframe). */
defineExpose({ close: () => { open.value = false; }, isOpen: () => open.value });
const panel = ref<HTMLElement | null>(null);
const root = ref<HTMLElement | null>(null);
// A settings sheet that only closes when you find its own ✕ feels stuck; a press anywhere else
// dismisses it, and so does Escape.
useDismiss(() => open.value, () => [root.value, panel.value], () => { open.value = false; });
const themeLabels: Record<ReaderTheme, string> = {
  light: tr("reader.themeLight"),
  sepia: tr("reader.themeSepia"),
  dark: tr("reader.themeDark"),
};
</script>

<template>
  <div ref="root" class="reader-settings">
    <button
      type="button"
      :class="{ 'is-active': open }"
      :aria-expanded="open"
      :aria-label="tr('reader.settings')"
      :title="tr('reader.settings')"
      @click="open = !open"
    ><Settings2 :size="15" /></button>
    <div v-if="open" ref="panel" class="reader-settings-panel" role="dialog" :aria-label="tr('reader.settings')">
      <div class="reader-settings-head">
        <span>{{ tr("reader.settings") }}</span>
        <button type="button" :aria-label="tr('common.close')" @click="open = false"><X :size="13" /></button>
      </div>

      <!-- Theme tints the book's own document; a PDF page is a bitmap the engine already painted,
           so offering it there would be a control that visibly does nothing. -->
      <label v-if="props.mode === 'epub'" class="reader-settings-row">
        <span>{{ tr("reader.theme") }}</span>
        <span class="reader-settings-swatches">
          <button
            v-for="theme in THEMES"
            :key="theme"
            type="button"
            class="reader-swatch"
            :class="[`is-${theme}`, { 'is-active': readerSettings.theme === theme }]"
            :title="themeLabels[theme]"
            :aria-label="themeLabels[theme]"
            :aria-pressed="readerSettings.theme === theme"
            @click="updateReaderSettings({ theme })"
          />
        </span>
      </label>

      <template v-if="props.mode === 'epub'">
        <label class="reader-settings-row">
          <span>{{ tr("reader.font") }}</span>
          <select
            :value="readerSettings.fontFamily"
            @change="updateReaderSettings({ fontFamily: ($event.target as HTMLSelectElement).value })"
          >
            <option v-for="choice in FONT_CHOICES" :key="choice.label" :value="choice.value">{{ tr(`reader.font_${choice.label}`) }}</option>
          </select>
        </label>
        <label class="reader-settings-row">
          <span>{{ tr("reader.fontSize") }}</span>
          <span class="reader-settings-inline">
            <input
              type="range" min="12" max="30" step="1"
              :value="readerSettings.fontSize"
              @input="updateReaderSettings({ fontSize: Number(($event.target as HTMLInputElement).value) })"
            />
            <b>{{ readerSettings.fontSize }}</b>
          </span>
        </label>
        <label class="reader-settings-row">
          <span>{{ tr("reader.lineHeight") }}</span>
          <span class="reader-settings-inline">
            <input
              type="range" min="1.2" max="2.4" step="0.1"
              :value="readerSettings.lineHeight"
              @input="updateReaderSettings({ lineHeight: Number(($event.target as HTMLInputElement).value) })"
            />
            <b>{{ readerSettings.lineHeight.toFixed(1) }}</b>
          </span>
        </label>
        <label class="reader-settings-row">
          <span>{{ tr("reader.wheelPaging") }}</span>
          <input type="checkbox" :checked="readerSettings.wheelPaging" @change="updateReaderSettings({ wheelPaging: ($event.target as HTMLInputElement).checked })" />
        </label>
        <label class="reader-settings-row">
          <span>{{ tr("reader.animateTurns") }}</span>
          <input type="checkbox" :checked="readerSettings.animateTurns" @change="updateReaderSettings({ animateTurns: ($event.target as HTMLInputElement).checked })" />
        </label>
      </template>

      <label class="reader-settings-row">
        <span>{{ tr("reader.tocAutoClose") }}</span>
        <input type="checkbox" :checked="readerSettings.tocAutoClose" @change="updateReaderSettings({ tocAutoClose: ($event.target as HTMLInputElement).checked })" />
      </label>
    </div>
  </div>
</template>
