import { onBeforeUnmount, ref, watch } from "vue";
import { createStreamPacer } from "../utils/streamPacer";
import { streamTuning } from "../utils/streamTuning";

const STREAM = "stream";

/**
 * Live reveals waiting for the screen to come back. One document listener for all of them:
 * every `MarkdownBody` and `ToolCallPanel` instance owns its own pacer, so a long answer with
 * dozens of tool panels would otherwise stack dozens of listeners on `document`.
 */
const waiting = new Set<() => void>();
let listenerInstalled = false;
let wasHidden = false;

function installListener(): void {
  if (listenerInstalled || typeof document === "undefined") return;
  listenerInstalled = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      wasHidden = true;
      return;
    }
    // Only a real round trip counts. A stray `visible` event must not dump a backlog that the
    // reader is still watching character by character.
    if (!wasHidden) return;
    wasHidden = false;
    for (const reveal of Array.from(waiting)) reveal();
  });
}

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
 *
 * A hidden screen also lands whole, on the way back. rAF stalls while the document is hidden, so
 * the reveal freezes while Pi keeps appending - and replaying 30 seconds of backlog at
 * `reveal.ceiling` characters a frame is a run of dropped frames for text nobody was watching,
 * each one replacing the block's whole `v-html`. Measured 2026-10-08 against an idle thread: an
 * idle resume holds 17ms frames (`resume-38067ms`, `mutations=0`), a streaming one is what users
 * report as "解锁后掉帧卡顿". So on resume the pending backlog is committed in one write.
 */
export function useRevealedText(source: () => string, animate: () => boolean = () => true) {
  // Taken when the component is created: a config edit mid-answer would otherwise
  // change the speed of text that is already moving.
  const pacer = createStreamPacer({ ...streamTuning.reveal });
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

  // `catchUp`, not `flush`: the run may still be going, and dropping the record would make the
  // next delta restart the reveal from nothing - the answer on screen would collapse and retype.
  const revealBacklog = () => pacer.catchUp(STREAM);
  waiting.add(revealBacklog);
  installListener();

  onBeforeUnmount(() => {
    pacer.reset();
    waiting.delete(revealBacklog);
  });

  return revealed;
}
