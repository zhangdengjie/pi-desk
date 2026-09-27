/**
 * WebKit can lose the mouseup that ends a selection drag - released outside the window,
 * or swallowed by a native gesture session. The engine then believes the primary button
 * is still held and keeps extending the selection as the pointer moves: text paints
 * selected although nobody is pressing anything (the "selection appears on its own"
 * reports), and a range that grows across the shell costs a full selection repaint on
 * every frame, which is the whole-interface freeze.
 *
 * A selection that changes while no button is actually down *and* the pointer is moving
 * is that ghost. Keyboard selection (shift+arrows) changes the range without pointer
 * movement, and a finished mouse selection stops firing selectionchange, so neither is
 * touched. Returns the disposer.
 */
export function installGhostSelectionGuard(): () => void {
  let buttons = 0;
  let lastPointerMoveAt = -Infinity;
  let lastKeyboardSelectAt = -Infinity;

  const onPointerMove = (event: PointerEvent) => {
    buttons = event.buttons;
    if (!buttons) lastPointerMoveAt = performance.now();
  };
  const onPointerDown = (event: PointerEvent) => {
    buttons = event.buttons;
  };
  const onPointerUp = (event: PointerEvent) => {
    buttons = event.buttons;
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (!event.shiftKey) return;
    if (
      event.key.startsWith("Arrow")
      || event.key === "Home"
      || event.key === "End"
      || event.key === "PageUp"
      || event.key === "PageDown"
    ) {
      lastKeyboardSelectAt = performance.now();
    }
  };
  const onSelectionChange = () => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) return;
    if (buttons !== 0) return;
    const now = performance.now();
    if (now - lastKeyboardSelectAt < 250) return;
    if (now - lastPointerMoveAt > 80) return;
    selection.removeAllRanges();
  };

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerdown", onPointerDown, { passive: true });
  window.addEventListener("pointerup", onPointerUp, { passive: true });
  window.addEventListener("keydown", onKeydown, true);
  document.addEventListener("selectionchange", onSelectionChange);
  return () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("selectionchange", onSelectionChange);
  };
}
