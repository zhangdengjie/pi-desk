<script setup lang="ts">
import { ui } from "../ui/classes";
import { X, ZoomIn, ZoomOut } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useModalFocus } from "../composables/useModalFocus";
import { tr } from "../i18n";
import ZoomableImage from "./ZoomableImage.vue";

const props = defineProps<{ image: { name: string; previewUrl: string } }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement | null>(null);
const viewer = ref<InstanceType<typeof ZoomableImage> | null>(null);

const zoomState = computed(() => viewer.value?.snapshot() ?? { percent: 100, zoomed: false, canZoomIn: true, canZoomOut: false });
const zoomTitle = computed(() => (zoomState.value.zoomed ? tr("composer.zoomFit") : tr("composer.zoomActualSize")));

function close() {
  emit("close");
}

useModalFocus(dialog, close);

function onKeydown(event: KeyboardEvent) {
  viewer.value?.handleKeydown(event);
}
</script>

<template>
  <Teleport to="body">
    <div class="dialog-backdrop image-preview-backdrop" :class="ui.dialogBackdrop" @mousedown.self="close">
      <section
        ref="dialog"
        class="dialog-window image-preview-dialog" :class="[ui.dialog, ui.dialogImage]"
        role="dialog"
        aria-modal="true"
        :aria-label="tr('composer.imagePreview')"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header :class="ui.dialogHeader">
          <h2 :title="props.image.name">{{ props.image.name }}</h2>
          <div class="image-preview-actions">
            <div class="image-preview-tools">
              <button
                class="zoom-button"
                type="button"
                :title="tr('composer.zoomOut')"
                :aria-label="tr('composer.zoomOut')"
                :disabled="!zoomState.canZoomOut"
                @click="viewer?.zoomOut()"
              >
                <ZoomOut :size="15" aria-hidden="true" />
              </button>
              <button
                class="zoom-button zoom-level"
                type="button"
                :title="zoomTitle"
                :aria-label="`${zoomState.percent}% · ${zoomTitle}`"
                @click="viewer?.toggleZoom()"
              >
                {{ zoomState.percent }}%
              </button>
              <button
                class="zoom-button"
                type="button"
                :title="tr('composer.zoomIn')"
                :aria-label="tr('composer.zoomIn')"
                :disabled="!zoomState.canZoomIn"
                @click="viewer?.zoomIn()"
              >
                <ZoomIn :size="15" aria-hidden="true" />
              </button>
            </div>
            <button class="icon-button" :class="ui.iconButton" type="button" autofocus :title="tr('common.close')" @click="close">
              <X :size="16" aria-hidden="true" />
            </button>
          </div>
        </header>
        <ZoomableImage ref="viewer" :src="props.image.previewUrl" :alt="props.image.name" :controls="false" />
      </section>
    </div>
  </Teleport>
</template>
