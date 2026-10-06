// The two "hide a section" shortcuts on the home page - `.topbar-sidebar-toggle` (left, 任务) and
// `.inspector-toggle` (right, 文件/终端/变更 tabs) - now slide instead of cutting. The slide lives in
// `styles/workbench.css` ("Pane motion") and lasts `--motion-panel`.
//
// A CSS transition cannot run on a node that no longer exists, so the DOM that is leaving has to stay
// mounted for exactly that long. Both `App.vue` (inspector) and `AppSidebar.vue` (task rail) keep a
// settle timer fed by these numbers rather than binding their `v-if` straight to the store flag.
//
// `paneMotion.test.ts` pins PANEL_MOTION_MS against `--motion-panel` in tokens.css: the CSS and the
// timer are one duration read from two places, and drift shows up as a panel that unmounts mid-slide.
export const PANEL_MOTION_MS = 220;

/** `PANEL_MOTION_MS` plus two frames of slack, so the unmount lands after the last painted frame. */
export const PANEL_SETTLE_MS = PANEL_MOTION_MS + 40;

/** Two frames: the first paints the leaving state, the second lets the transition run from it. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
