/**
 * Build-time rewrite of foliate-js's paginator so a chapter turn keeps the outgoing page alive.
 *
 * Why a rewrite and not an upstream option: `#createView()` destroys the old `View` *before* the
 * incoming one is laid out, so at no point do two live pages exist — which is why a chapter turn can
 * only ever be a dissolve (or a View Transition that snapshots). Keeping the old element for the
 * length of one animation is the only way to get two real pages sliding past each other without
 * depending on `document.startViewTransition` (WebKit 18; this app still supports macOS 12).
 *
 * The patched contract, and the only thing the app relies on:
 *
 * - the outgoing view element stays in the paginator's container, absolutely positioned over the
 *   incoming one, until it is removed;
 * - when the incoming section is laid out, the paginator dispatches `view-swapped` with
 *   `{ incoming, outgoing, remove }` — both elements and an idempotent `remove()` that also unloads
 *   the outgoing section;
 * - `remove()` is called automatically after 700ms even if the app never calls it, so a missed
 *   animation cannot leak an iframe;
 * - `#goTo` no longer unloads the section it leaves; that moved into `remove()`.
 *
 * Every replacement is an exact source match. `applyFoliateSplitView` reports which ones did not
 * apply, and the vite plugin turns a partial match into a build error — a foliate-js upgrade must
 * fail loudly instead of silently reverting to the one-document behaviour.
 */

export interface SplitViewRewrite {
  /** Shown in the build log when it stops matching. */
  readonly purpose: string;
  readonly from: string;
  readonly to: string;
}

/** Private fields the patch needs. `#index = -1` is unique in the class body. */
const fields: SplitViewRewrite = {
  purpose: "paginator: private fields for the outgoing view",
  from: "    #index = -1\n",
  to: "    #index = -1\n    #previousIndex = -1\n    #outgoing = null\n    #outgoingIndex = -1\n",
};

/** `#display` overwrites `#index` before `#createView`, so the old index has to be captured first. */
const rememberPreviousIndex: SplitViewRewrite = {
  purpose: "paginator #display: remember the index being replaced",
  from: "        const { index, src, anchor, onLoad, select } = await promise\n        this.#index = index\n",
  to: "        const { index, src, anchor, onLoad, select } = await promise\n"
    + "        this.#previousIndex = this.#index\n"
    + "        this.#index = index\n",
};

/** The core change: park the old view instead of destroying it. */
const keepOutgoingView: SplitViewRewrite = {
  purpose: "paginator #createView: keep the outgoing view on screen",
  from: "    #createView() {\n"
    + "        if (this.#view) {\n"
    + "            this.#view.destroy()\n"
    + "            this.#container.removeChild(this.#view.element)\n"
    + "        }\n",
  to: "    #createView() {\n"
    + "        if (this.#view) {\n"
    + "            this.#outgoing = this.#view\n"
    + "            this.#outgoingIndex = this.#previousIndex\n"
    + "            Object.assign(this.#outgoing.element.style, {\n"
    + "                position: 'absolute', inset: '0', zIndex: '1',\n"
    + "            })\n"
    + "            this.#container.style.position = 'relative'\n"
    + "            // Its ResizeObserver is still watching the old document, and `expand()` calls\n"
    + "            // `onExpand` → `#scrollToAnchor`, which acts on the *new* view. Detaching it here\n"
    + "            // keeps the parked page inert; `destroy()` only unobserves, it does not touch the DOM.\n"
    + "            this.#outgoing.destroy()\n"
    + "        }\n",
};

/** Announce the swap once the incoming section has been laid out. */
const dispatchSwap: SplitViewRewrite = {
  purpose: "paginator #display: dispatch `view-swapped` with both elements",
  from: "            this.#view = view\n"
    + "        }\n"
    + "        await this.scrollToAnchor((typeof anchor === 'function'\n",
  to: "            this.#view = view\n"
    + "            if (this.#outgoing) {\n"
    + "                const outgoing = this.#outgoing\n"
    + "                const outgoingIndex = this.#outgoingIndex\n"
    + "                this.#outgoing = null\n"
    + "                this.#outgoingIndex = -1\n"
    + "                let removed = false\n"
    + "                const remove = () => {\n"
    + "                    if (removed) return\n"
    + "                    removed = true\n"
    + "                    outgoing.element.remove()\n"
    + "                    outgoing.destroy()\n"
    + "                    this.sections[outgoingIndex]?.unload?.()\n"
    + "                }\n"
    + "                this.dispatchEvent(new CustomEvent('view-swapped', {\n"
    + "                    detail: { incoming: view.element, outgoing: outgoing.element, remove },\n"
    + "                }))\n"
    + "                setTimeout(remove, 700)\n"
    + "            }\n"
    + "        }\n"
    + "        await this.scrollToAnchor((typeof anchor === 'function'\n",
};

/** Unloading moved into `remove()`: revoking the blob URLs while the old page is still painted can
 *  break images it has not finished loading. */
const deferSectionUnload: SplitViewRewrite = {
  purpose: "paginator #goTo: unload the old section when its element goes away",
  from: "            const onLoad = detail => {\n"
    + "                this.sections[oldIndex]?.unload?.()\n"
    + "                this.setStyles(this.#styles)\n",
  to: "            const onLoad = detail => {\n"
    + "                this.setStyles(this.#styles)\n",
};

export const SPLIT_VIEW_REWRITES: readonly SplitViewRewrite[] = [
  fields,
  rememberPreviousIndex,
  keepOutgoingView,
  dispatchSwap,
  deferSectionUnload,
];

export interface SplitViewResult {
  code: string;
  applied: string[];
  skipped: string[];
}

/**
 * Applies every rewrite that matches. Returns the source untouched when nothing matches, which is
 * what makes this safe to run over every module the bundler sees.
 */
export function applyFoliateSplitView(code: string): SplitViewResult {
  let next = code;
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const rewrite of SPLIT_VIEW_REWRITES) {
    if (next.includes(rewrite.from)) {
      next = next.split(rewrite.from).join(rewrite.to);
      applied.push(rewrite.purpose);
    } else {
      skipped.push(rewrite.purpose);
    }
  }
  return { code: applied.length ? next : code, applied, skipped };
}

/** True when the module looks like the paginator at all; used to decide whether to police it. */
export const isFoliatePaginator = (code: string): boolean =>
  code.includes("class Paginator extends HTMLElement")
  && code.includes("#createView()");