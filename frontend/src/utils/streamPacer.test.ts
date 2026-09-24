import { describe, expect, it } from "vitest";
import { createStreamPacer } from "./streamPacer";

/** A manual rAF: nothing moves until the test asks for frames. */
function harness(options = {}) {
  const tasks = new Map<number, () => void>();
  let sequence = 0;
  const pacer = createStreamPacer({
    ...options,
    schedule: (run: () => void) => {
      sequence += 1;
      tasks.set(sequence, run);
      return sequence;
    },
    cancel: (handle: number) => {
      tasks.delete(handle);
    },
  });
  return {
    pacer,
    pump(frames = 1) {
      for (let index = 0; index < frames; index += 1) {
        const next = tasks.entries().next();
        if (next.done) return;
        tasks.delete(next.value[0]);
        next.value[1]();
      }
    },
    queued: () => tasks.size,
  };
}

function collector() {
  const writes: string[] = [];
  return { writes, sink: (text: string) => { writes.push(text); } };
}

describe("streamPacer", () => {
  it("holds a burst back and then reveals it frame by frame", () => {
    const { pacer, pump } = harness();
    const view = collector();
    pacer.append("a:text", "alpha beta gamma", view.sink);

    // Nothing lands outside a frame, so a burst cannot stack up mid-frame.
    expect(view.writes).toEqual([]);
    expect(pacer.pending("a:text")).toBe(16);
    expect(pacer.running()).toBe(true);

    pump();
    const first = view.writes.at(-1)!;
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(16);
    expect("alpha beta gamma".startsWith(first)).toBe(true);

    pump(8);
    expect(view.writes.at(-1)).toBe("alpha beta gamma");
    expect(pacer.pending()).toBe(0);
  });

  it("stops scheduling once every stream has drained", () => {
    const { pacer, pump, queued } = harness();
    const view = collector();
    pacer.append("a:thinking", "one two", view.sink);
    pump(6);

    expect(queued()).toBe(0);
    expect(pacer.running()).toBe(false);
    expect(view.writes.at(-1)).toBe("one two");
  });

  it("never cuts a surrogate pair in half", () => {
    const { pacer, pump } = harness({ floor: 3 });
    const view = collector();
    pacer.append("a:text", "ok \ud83d\ude00 next", view.sink);
    pump(12);

    for (const write of view.writes) {
      const trail = write.charCodeAt(write.length - 1);
      expect(trail >= 0xd800 && trail <= 0xdbff).toBe(false);
    }
    expect(view.writes.at(-1)).toBe("ok \ud83d\ude00 next");
  });

  it("releases at most the ceiling per frame so the tail keeps moving", () => {
    const { pacer, pump } = harness({ ceiling: 10 });
    const view = collector();
    pacer.append("a:text", "x".repeat(400), view.sink);
    pump();

    expect(view.writes.at(-1)!.length).toBeLessThanOrEqual(10);
  });

  it("flush lands the whole stream now, for a phase change", () => {
    const { pacer, pump } = harness();
    const view = collector();
    pacer.append("a:thinking", "reasoning that must finish before the answer", view.sink);
    pacer.flush("a:thinking");
    pump(2);

    expect(view.writes).toHaveLength(1);
    expect(view.writes[0]).toBe("reasoning that must finish before the answer");
    expect(pacer.pending("a:thinking")).toBe(0);
  });

  it("reconcile keeps draining when the settled text only extends the stream", () => {
    const { pacer, pump } = harness();
    const view = collector();
    pacer.append("a:text", "partial", view.sink);
    pump();
    const revealed = view.writes.at(-1)!;
    expect(revealed.length).toBeLessThan(7);

    pacer.reconcile("a:text", "partial answer", view.sink);
    pump(8);

    expect(view.writes.at(-1)).toBe("partial answer");
    // The reveal never went backwards.
    expect(view.writes.every((write) => write.startsWith(revealed))).toBe(true);
  });

  it("reconcile lands a rewritten stream at once", () => {
    const { pacer, pump } = harness();
    const view = collector();
    pacer.append("a:text", "the old answer", view.sink);
    pump();

    pacer.reconcile("a:text", "something else entirely", view.sink);
    pump(4);

    expect(view.writes.at(-1)).toBe("something else entirely");
    expect(pacer.pending("a:text")).toBe(0);
  });

  it("reconcile on a quiet stream just states the field", () => {
    const { pacer } = harness();
    const view = collector();
    pacer.reconcile("a:text", "loaded from disk", view.sink);

    expect(view.writes).toEqual(["loaded from disk"]);
    expect(pacer.pending()).toBe(0);
  });

  it("drop hands the field back to the caller", () => {
    const { pacer, pump } = harness();
    const view = collector();
    pacer.append("a:text", "in flight", view.sink);
    pacer.drop("a:text");
    pump(4);

    expect(view.writes).toEqual([]);
  });

  it("reset clears every stream, so a session switch cannot leak text", () => {
    const { pacer, pump } = harness();
    const view = collector();
    pacer.append("a:text", "leftover", view.sink);
    pacer.reset();
    pump(4);

    expect(view.writes).toEqual([]);
    expect(pacer.pending()).toBe(0);
  });
});
