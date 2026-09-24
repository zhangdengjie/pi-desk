import { onBeforeUnmount, ref, watch } from "vue";
import { createStreamPacer } from "../utils/streamPacer";

const STREAM = "stream";

/**
 * A string that arrives on screen one animation frame at a time.
 *
 * The caller keeps owning the authoritative text; this only decides how fast the
 * reader sees it grow. That split matters: search, transcript grouping, changed-file
 * summaries and the store's own tests all read the real value, and a pacer in front of
 * them would make every one of those see yesterday's text.
 *
 * `animate()` is what separates a streamed answer from a file that was simply opened:
 * only growth while the source is live gets revealed gradually. A rewrite (a shorter
 * or diverging string) always lands whole - showing half an edit is worse than a jump.
 */
export function useRevealedText(source: () => string, animate: () => boolean = () => true) {
  const pacer = createStreamPacer();
  const revealed = ref(source());
  const sink = (text: string) => { revealed.value = text; };
  // Seed the stream with what the first render already shows, otherwise the very
  // first growth is treated as a brand-new string and lands whole.
  pacer.prime(STREAM, source(), sink);

  watch(source, (text) => {
    if (!animate()) {
      pacer.reset();
      revealed.value = text;
      pacer.prime(STREAM, text, sink);
      return;
    }
    pacer.reconcile(STREAM, text, sink);
  });
  watch(animate, (live) => {
    if (live) return;
    pacer.reset();
    if (revealed.value !== source()) revealed.value = source();
    pacer.prime(STREAM, source(), sink);
  });
  onBeforeUnmount(() => pacer.reset());

  return revealed;
}
