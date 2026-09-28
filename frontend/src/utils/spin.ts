import type { ObjectDirective } from "vue";

/**
 * 为什么旋转走 Web Animations API，而不是 CSS `animation`：
 *
 * 1) 侧栏任务行按 `modifiedAt` 倒序排（stores/app.ts 的 `filteredThreads`），而 `modifiedAt` 在
 *    发 prompt / 改名 / 重载 transcript / 任务完成等处都会重写 → 行会换位 → Vue 的 keyed reorder
 *    用 `insertBefore()` 移动 DOM。同文档内的重新插入会让 **CSS animation 从 0 重播**，
 *    症状就是转圈「卡卡的、像反复重新开始」。
 * 2) `content-visibility: auto` 的子树被跳过时，CSS animation 直接停摆（layout.css 里
 *    `.thread-row:has(.thread-status)` 那条豁免就是为它加的）。
 *
 * 真机（WKWebView，和 Wails 同一个引擎）实测：
 *   .pi/bin/hitprobe/reorder-spin.html
 *     B_insertBeforeSameParent { t: 0   }   ← CSS animation 被重置
 *     A_appendSibling          { t: 500 }   ← 对照：不动这个节点就不重置
 *     F_waapiMove              { t: 500, sameObject: true }  ← WAAPI 不受移动影响
 *     G_waapiReattach          { t: 500, sameObject: true }  ← detach + re-attach 也不受影响
 *   .pi/bin/hitprobe/spin-parity.html
 *     CSS 与 WAAPI 在 <svg> 图标上的 matrix / transform-origin / transform-box 完全一致
 *     → 48 处 `is-spinning`（lucide 图标）搬过来不会偏心。
 *
 * 所以：外观仍由 CSS 管，只有旋转交给 WAAPI。`base.css` 里的 `.is-spinning` 已退成纯标记类，
 * `@keyframes spin` 也删了；漏绑 v-spin 由 utils/spin.usage.test.ts 在源码层拦下。
 */
const SPIN_KEYFRAMES: Keyframe[] = [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }];
const SPIN_DURATION_MS = 900;
const STORE_KEY = "__piDeskSpin" as const;

export type SpinOptions = { duration?: number };
export type SpinValue = boolean | SpinOptions | undefined;

type SpinHost = HTMLElement & { [STORE_KEY]?: Animation };

function spinEnabled(value: SpinValue): boolean {
  // 裸写 `v-spin` 时 Vue 传的 value 是 undefined = 常开（元素本身已由 v-if 控制生死）。
  return value === undefined ? true : Boolean(value);
}

function optionsOf(value: SpinValue): SpinOptions {
  return typeof value === "object" && value !== null ? value : {};
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function startSpin(el: HTMLElement, options: SpinOptions = {}) {
  // jsdom 不实现 WAAPI；缺能力时退化成静止图标（外观仍由 CSS 提供），不报错。
  if (typeof el.animate !== "function") return;
  if (prefersReducedMotion()) return;
  (el as SpinHost)[STORE_KEY] = el.animate(SPIN_KEYFRAMES, {
    duration: options.duration ?? SPIN_DURATION_MS,
    iterations: Infinity,
    easing: "linear",
  });
}

function stopSpin(el: HTMLElement) {
  const holder = el as SpinHost;
  holder[STORE_KEY]?.cancel();
  delete holder[STORE_KEY];
}

function liveAnimation(el: HTMLElement): Animation | undefined {
  const anim = (el as SpinHost)[STORE_KEY];
  // 被外部 cancel 过（playState: idle）的动画再 play 也不会自己从头转，当作没有重来。
  if (anim && anim.playState !== "idle") return anim;
  return undefined;
}

/**
 * 用在"进行中"指示元素上：
 *   `<LoaderCircle v-spin class="is-spinning" :size="14" />`            常开
 *   `<RefreshCw v-spin="busy" :class="{ 'is-spinning': busy }" />`      按条件开合
 *   `<span v-spin="{ duration: 1400 }" class="thread-status" />`        调速
 *
 * ⚠️ `is-spinning` 走 `:class` 动态绑定时，必须把同一个条件也传给 v-spin，否则图标会一直转。
 *    这条由 utils/spin.usage.test.ts 拦。
 */
export const vSpin: ObjectDirective<HTMLElement, SpinValue> = {
  mounted(el, binding) {
    if (spinEnabled(binding.value)) startSpin(el, optionsOf(binding.value));
  },
  updated(el, binding) {
    const running = liveAnimation(el);
    if (spinEnabled(binding.value)) {
      if (!running) startSpin(el, optionsOf(binding.value));
    } else if (running) {
      stopSpin(el);
    }
  },
  unmounted(el) {
    stopSpin(el);
  },
};
