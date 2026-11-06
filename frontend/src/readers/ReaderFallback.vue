<script setup lang="ts">
import { ExternalLink, FolderOpen } from "lucide-vue-next";
import { tr } from "../i18n";

/**
 * The actions offered when a reader cannot render a document in this WebView — the engine needs a
 * newer WebKit than the machine has, or the bytes could not be read.
 *
 * This component is deliberately separate from `PdfReader`/`EpubReader` so it is always available:
 * on such a machine those modules cannot even be parsed, and the notice that explains why can only
 * appear if the thing rendering it never depended on them.
 */
const emit = defineEmits<{ open: []; openWith: []; reveal: [] }>();
</script>

<template>
  <div class="reader-fallback-actions">
    <button type="button" @click="emit('open')"><ExternalLink :size="14" />{{ tr("files.openExternal") }}</button>
    <button type="button" @click="emit('openWith')"><FolderOpen :size="14" />{{ tr("files.openWith") }}</button>
    <button type="button" @click="emit('reveal')">{{ tr("files.reveal") }}</button>
  </div>
</template>
