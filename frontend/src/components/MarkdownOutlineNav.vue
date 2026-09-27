<script setup lang="ts">
import { tr } from "../i18n";

/**
 * The heading list shared by every Markdown host in this app.
 *
 * It is presentational on purpose: which headings exist and what "go there" means belongs to the host.
 * The inspector scrolls its own pane to a measured offset and highlights the entry the reader has
 * passed; a chat answer asks MarkdownBody to scroll the heading into the transcript. Both can share
 * the list because an entry only carries `id`, `level` and `title`.
 *
 * The host owns the placement: `class` falls through onto the `nav`, because the geometry differs -
 * floating box in a narrow inspector, column in a wide one, anchored panel inside one chat answer.
 */
defineProps<{
  items: { id: string; level: number; title: string }[];
  activeId?: string;
}>();

const emit = defineEmits<{ jump: [id: string] }>();
</script>

<template>
  <nav class="markdown-outline" :aria-label="tr('files.outline')">
    <p v-if="!items.length" class="markdown-outline-empty">{{ tr("files.outlineEmpty") }}</p>
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      class="markdown-outline-item"
      :class="{ 'is-active': activeId === item.id, [`level-${Math.min(item.level, 4)}`]: true }"
      :aria-label="tr('files.outlineJump', { title: item.title })"
      :title="item.title"
      @click="emit('jump', item.id)"
    >{{ item.title }}</button>
  </nav>
</template>
