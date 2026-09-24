/**
 * Frame-aligned reveal for streamed text.
 *
 * Pi delivers a turn in bursts: the provider's SSE chunks arrive every tens of
 * milliseconds and each one is forwarded as its own `message_update` frame, so the
 * transcript gains a whole clause at once and then sits still. Vue also rebuilds the
 * rendered markdown of the message on every one of those writes. Readers experience
 * that as blocks landing, not as text appearing.
 *
 * The pacer keeps the *authoritative* target per stream and hands the UI a growing
 * prefix of it, one step per animation frame, so the tail moves continuously. It is
 * deliberately a pure module with an injected scheduler: the store owns the state and
 * can always take a stream back with `drop`, which is what the reload paths do.
 *
 * Shape of one stream:
 *
 *   target    "the answer as far as we know it" - appended by deltas, replaced by
 *             message_end / a transcript reload
 *   committed the prefix already handed to the UI (always a prefix of target)
 *   sink      writes the committed prefix into the store field this stream owns
 */
export interface StreamPacerOptions {
  /** Defaults to requestAnimationFrame; tests inject a manual pump. */
  schedule?: (run: () => void) => number;
  cancel?: (handle: number) => void;
  /** Backlog is released 1 / split per frame. Smaller is snappier. */
  split?: number;
  /** Never reveal less than this many characters in a frame that has work. */
  floor?: number;
  /** Never reveal more, so a long burst still reads as typing and the scroll pin keeps up. */
  ceiling?: number;
}

interface Stream {
  target: string;
  committed: number;
  sink: (text: string) => void;
}

const DEFAULTS = { split: 5, floor: 2, ceiling: 160 };

export interface StreamPacer {
  /** Grow a stream by one delta. */
  append(key: string, chunk: string, sink: (text: string) => void): void;
  /**
   * Adopt text that is already on screen. A message row can be created with content
   * (`message_start` carries what Pi already has), and a reveal that started from
   * nothing would write that content away.
   */
  prime(key: string, text: string, sink: (text: string) => void): void;
  /**
   * Set the whole authoritative text. A prefix extension keeps the reveal running
   * (that is `message_end` arriving a moment before the tail is on screen); a real
   * divergence lands at once, because a partial edit must never eat the new text.
   */
  reconcile(key: string, text: string, sink: (text: string) => void): void;
  /** Hand over everything that is pending, right now. */
  flush(key: string): void;
  /** Forget a stream without writing it: the caller is about to own the field. */
  drop(key: string): void;
  reset(): void;
  /** Characters waiting to be revealed. 0 means the screen matches what we know. */
  pending(key?: string): number;
  /** True while a frame is scheduled. */
  running(): boolean;
}

export function createStreamPacer(options: StreamPacerOptions = {}): StreamPacer {
  const split = Math.max(2, options.split ?? DEFAULTS.split);
  const floor = Math.max(1, options.floor ?? DEFAULTS.floor);
  const ceiling = Math.max(floor, options.ceiling ?? DEFAULTS.ceiling);
  const schedule = options.schedule
    ?? (typeof requestAnimationFrame === "function" ? (run: () => void) => requestAnimationFrame(run) : (run: () => void) => setTimeout(run, 16) as unknown as number);
  const cancel = options.cancel
    ?? (typeof cancelAnimationFrame === "function" ? (handle: number) => cancelAnimationFrame(handle) : (handle: number) => clearTimeout(handle));

  const streams = new Map<string, Stream>();
  let frame = 0;

  function commit(stream: Stream, to: number) {
    if (to <= stream.committed) return;
    const next = cutOnCodePoint(stream.target, Math.min(to, stream.target.length));
    if (next <= stream.committed) return;
    stream.sink(stream.target.slice(0, next));
    stream.committed = next;
  }

  function write(stream: Stream) {
    stream.sink(stream.target.slice(0, stream.committed));
  }

  function step() {
    frame = 0;
    for (const stream of streams.values()) {
      const backlog = stream.target.length - stream.committed;
      if (backlog <= 0) continue;
      commit(stream, stream.committed + Math.min(Math.max(Math.ceil(backlog / split), floor), ceiling));
    }
    // A drained stream keeps its entry: the next delta has to continue from the
    // prefix already on screen, and dropping the record would make that chunk land
    // whole - exactly the jump this module exists to remove. Only the loop stops.
    if (workPending()) frame = schedule(step);
  }

  function workPending(): boolean {
    for (const stream of streams.values()) {
      if (stream.committed < stream.target.length) return true;
    }
    return false;
  }

  function ensure(key: string, sink: (text: string) => void): Stream {
    const existing = streams.get(key);
    if (existing) {
      existing.sink = sink;
      return existing;
    }
    const stream: Stream = { target: "", committed: 0, sink };
    streams.set(key, stream);
    return stream;
  }

  return {
    append(key, chunk, sink) {
      if (!chunk) return;
      const stream = ensure(key, sink);
      stream.target += chunk;
      if (!frame) frame = schedule(step);
    },
    prime(key, text, sink) {
      if (streams.has(key)) return;
      streams.set(key, { target: text, committed: text.length, sink });
    },
    /** Seed or re-seed a stream with text that is already on screen. */
    reconcile(key, text, sink) {
      const stream = streams.get(key);
      if (!stream) {
        // Nothing in flight: the field is simply the text we are told.
        const fresh: Stream = { target: text, committed: text.length, sink };
        streams.set(key, fresh);
        sink(text);
        streams.delete(key);
        return;
      }
      stream.sink = sink;
      if (text === stream.target) return;
      if (text.startsWith(stream.target.slice(0, stream.committed))) {
        stream.target = text;
        if (!frame) frame = schedule(step);
        return;
      }
      // A rewritten stream lands whole: half an edit is worse than a jump.
      if (frame) {
        cancel(frame);
        frame = 0;
      }
      stream.target = text;
      stream.committed = text.length;
      write(stream);
      streams.delete(key);
    },
    flush(key) {
      const stream = streams.get(key);
      if (!stream) return;
      commit(stream, stream.target.length);
      streams.delete(key);
    },
    drop(key) {
      streams.delete(key);
    },
    reset() {
      streams.clear();
      if (frame) {
        cancel(frame);
        frame = 0;
      }
    },
    pending(key) {
      if (key !== undefined) {
        const stream = streams.get(key);
        return stream ? Math.max(0, stream.target.length - stream.committed) : 0;
      }
      let total = 0;
      for (const stream of streams.values()) total += Math.max(0, stream.target.length - stream.committed);
      return total;
    },
    running() {
      return frame !== 0;
    },
  };
}

/**
 * Never cut inside a surrogate pair: half an emoji renders as a box, and because the
 * reveal is continuous the half would sit on screen until the next frame.
 */
function cutOnCodePoint(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}
