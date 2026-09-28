<script setup lang="ts">
import { computed } from "vue";
import { vSpin } from "../utils/spin";

/**
 * 统一的"进行中"圈。刻意不用 lucide 的 LoaderCircle：
 * 那是一条 288° 的**开口弧**（`M21 12a9 9 0 1 1-6.219-8.56`，缺 72°），弧的视觉重心离圆心
 * 2.09 个 viewBox 单位 → 12px 下重心绕圈半径 1.05px，转起来就像"旋转中心不在圆心"。
 * 整圈轨道 + 一段高亮的画法在任何角度都是完整圆，重心不绕（实测
 * `.pi/bin/hitprobe/spin-wobble.html`：弧 1.046px / 整圆 0.0125px @12px）。
 *
 * 旋转走 v-spin（Web Animations API），理由见 utils/spin.ts 顶部注释。
 *
 * ⚠️ 几何量全在 layout.css 的 `.loading-ring` 里，调用方不要再挂 `size-*` 或 `flex-*` utility
 *    （tailwind 是 important 引入的，会压过 CSS）。
 */
const props = withDefaults(defineProps<{
  size?: number;
  duration?: number;
}>(), {
  size: 12,
  duration: 900,
});

const ringStyle = computed(() => ({ "--loading-ring-size": `${props.size}px` }));
</script>

<template>
  <span v-spin="{ duration: props.duration }" class="loading-ring" :style="ringStyle" aria-hidden="true" />
</template>
