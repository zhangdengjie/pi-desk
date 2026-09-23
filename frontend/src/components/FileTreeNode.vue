<script setup lang="ts">
import { AtSign, ChevronDown, ChevronRight, File, Folder, FolderOpen, Undo2 } from "lucide-vue-next";
import { computed } from "vue";
import type { RepositoryTreeNode } from "../utils/fileMentions";

const props = defineProps<{
  node: RepositoryTreeNode;
  depth?: number;
  changeStatuses?: Record<string, string>;
  rollbackActions?: Record<string, string>;
  rollbackArmed?: Record<string, boolean>;
  /** Expanded directories of the current workspace, owned by the store so the state survives the
   *  file preview unmounting the whole tree. Absent entries fall back to "top level open". */
  expanded?: Record<string, boolean>;
}>();
const emit = defineEmits<{
  mention: [path: string, directory: boolean];
  open: [path: string];
  diff: [path: string];
  rollback: [path: string];
  toggleDirectory: [path: string];
}>();
const open = computed(() => props.expanded?.[props.node.path] ?? (props.depth ?? 0) === 0);

function toggleDirectory() {
  if (props.node.directory) emit("toggleDirectory", props.node.path);
}

function forwardToggleDirectory(path: string) {
  emit("toggleDirectory", path);
}

function forwardMention(path: string, directory: boolean) {
  emit("mention", path, directory);
}

function forwardOpen(path: string) {
  emit("open", path);
}

function forwardDiff(path: string) {
  emit("diff", path);
}

function forwardRollback(path: string) {
  emit("rollback", path);
}
</script>

<template>
  <!-- Geometry belongs to layout.css: `ui.listItem` carries `px-2.5`, `gap-2`, `min-h-9` and
       `flex`, and `ui.root` carries `text-[var(--text)]`. Tailwind is imported `important`
       (`styles/tailwind.css:9`), so those utilities beat every unlayered `.file-tree-*` rule and
       flattened the indentation, the grid columns and the muted/hover text colours. -->
  <div class="file-tree-node">
    <div class="file-tree-row">
      <button v-if="node.directory" class="file-tree-toggle" type="button" :title="open ? 'Collapse folder' : 'Expand folder'" @click="toggleDirectory">
        <ChevronDown v-if="open" :size="13" />
        <ChevronRight v-else :size="13" />
      </button>
      <span v-else class="file-tree-spacer" />
      <FolderOpen v-if="node.directory && open" :size="14" />
      <Folder v-else-if="node.directory" :size="14" />
      <File v-else :size="14" />
      <span v-if="node.directory" class="file-tree-name" :title="node.path" @click="toggleDirectory">{{ node.name }}</span>
      <button
        v-else
        class="file-tree-name file-tree-open"
        :class="{ 'is-changed': changeStatuses?.[node.path] }"
        type="button"
        :data-status="changeStatuses?.[node.path]"
        :title="`Preview ${node.path}`"
        @click="emit('open', node.path)"
      >{{ node.name }}</button>
      <button
        v-if="!node.directory && changeStatuses?.[node.path]"
        class="file-tree-change change-status"
        type="button"
        :data-status="changeStatuses[node.path]"
        :title="`View diff for ${node.path}`"
        @click="emit('diff', node.path)"
      >{{ changeStatuses[node.path] }}</button>
      <span v-else class="file-tree-change-spacer" />
      <button
        v-if="!node.directory && rollbackActions?.[node.path]"
        class="file-tree-rollback"
        :class="{ 'is-armed': rollbackArmed?.[node.path] }"
        type="button"
        :title="rollbackActions[node.path]"
        @click.stop="emit('rollback', node.path)"
      >
        <Undo2 :size="13" />
      </button>
      <button class="file-tree-mention" type="button" :title="node.directory ? 'Mention folder' : 'Mention file'" @click="emit('mention', node.path, node.directory)">
        <AtSign :size="13" />
      </button>
    </div>
    <div v-if="node.directory && open" class="file-tree-children">
      <FileTreeNode
        v-for="child in node.children"
        :key="`${child.directory}-${child.path}`"
        :node="child"
        :depth="(depth || 0) + 1"
        :change-statuses="changeStatuses"
        :rollback-actions="rollbackActions"
        :rollback-armed="rollbackArmed"
        :expanded="expanded"
        @toggle-directory="forwardToggleDirectory"
        @mention="forwardMention"
        @open="forwardOpen"
        @diff="forwardDiff"
        @rollback="forwardRollback"
      />
    </div>
  </div>
</template>
