import type { ObjectDirective } from "vue";

/**
 * 为什么用 Web Animations API，而不是 CSS `animation`：
 *
 * 侧栏任务行按 `modifiedAt` 倒序排（stores/app.ts 的 `filteredThreads`），而 `modifiedAt` 在
 * 发 prompt / 改名 / 重载 transcript / 任务完成等处都会重写 → 行会换位 → Vue 的 keyed reorder
 * 用 `insertBefore()` 移动 DOM。同文档内的重新插入会让 **CSS animation 从 0 重播**，
 * 于是"只是有一行被顶下去"的转圈看起来在反复重新开始（症状：卡卡的）。
 *
 * 真机（WKWebView，和 Wails 同一个引擎）实测见 `.pi/bin/hitprobe/reorder-spin.html`：
 *   B_insertBeforeSameParent  { t: 0   }   ← CSS animation 被重置
 *   F_waapiMove               { t: 500, sameObject: true }  ← WAAPI 不受移动影响
 *   G_waapiReattach           { t: 500, sameObject: true }  ← detach + re-attach 也不受影响
 *
 * 所以：几何/外观仍由 CSS 管，只有旋转交给 WAAPI。
 */
const SPIN_KEYFRAMES: Keyframe[] = [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }];
const SPIN_DURATION_MS = 850;
const STORE_KEY = "__piDeskSpin" as const;

type SpinHost = HTMLElement & { [STORE_KEY]?: Animation };

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function startSpin(el: HTMLElement) {
  // jsdom 不实现 WAAPI；缺能力时退化成静止圆环（外观仍由 CSS 提供），不报错。
  if (typeof el.animate !== "function") return;
  if (prefersReducedMotion()) return;
  (el as SpinHost)[STORE_KEY] = el.animate(SPIN_KEYFRAMES, {
    duration: SPIN_DURATION_MS,
    iterations: Infinity,
    easing: "linear",
  });
}

function stopSpin(el: HTMLElement) {
  const holder = el as SpinHost;
  holder[STORE_KEY]?.cancel();
  delete holder[STORE_KEY];
}

/** 用在"进行中"指示元素上：`<span v-spin class="thread-status" />` */
export const vSpin: ObjectDirective<HTMLElement> = {
  mounted: (el) => startSpin(el),
  unmounted: (el) => stopSpin(el),
};
