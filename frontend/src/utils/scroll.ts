export function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = 96): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/**
 * True when a gesture landed on (or inside) a nested scroll container that can
 * still move upward on its own — a long reasoning block, a tool output, a code
 * fence. In that case the outer transcript has not moved yet, so the caller
 * must not read the gesture as "the reader left the tail".
 */
export function nestedScrollerCanGoUp(target: EventTarget | null, outer: Element | null | undefined): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== outer) {
    if (node.scrollTop > 0 && node.scrollHeight - node.clientHeight > 1) return true;
    node = node.parentElement;
  }
  return false;
}
