import { onBeforeUnmount, onMounted } from "vue";

/**
 * Closes a floating panel when a press lands anywhere outside it.
 *
 * Listened for on `document` in the **bubble** phase on purpose. A capture listener would run before
 * the button inside the panel, close the panel first, and the click would then land on nothing — the
 * classic "clicking a search result does nothing" bug. In the bubble phase the panel's own handler
 * runs first and the dismiss only sees presses that missed every keep-open target.
 */
export function useDismiss(
  isOpen: () => boolean,
  keepOpenTargets: () => (Element | null | undefined)[],
  close: () => void,
): void {
  const onPointerDown = (event: Event) => {
    if (!isOpen()) return;
    const node = event.target as Node | null;
    if (!node) return;
    for (const target of keepOpenTargets()) {
      if (target?.contains(node)) return;
    }
    close();
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !isOpen()) return;
    event.preventDefault();
    close();
  };

  onMounted(() => {
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeydown);
  });
  onBeforeUnmount(() => {
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("keydown", onKeydown);
  });
}
