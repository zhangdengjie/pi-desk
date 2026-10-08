import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The recorder's whole contract is "stay silent while frames are fine, and put one honest record on
 * disk when they are not" - so the test drives the frame clock by hand instead of waiting for the
 * browser to be slow.
 */
let clock = 0;
let queued: ((time: number) => void)[] = [];
let posts: { url: string; body: Record<string, unknown> }[] = [];
let respondWith = 202;

function pump(gapMs: number) {
  clock += gapMs;
  const batch = queued;
  queued = [];
  for (const callback of batch) callback(clock);
}

beforeEach(() => {
  vi.resetModules();
  // The frame clock is driven by hand, but it has to share a base with the browser's own
  // `performance.now()` - the recorder schedules its capture window against that.
  clock = performance.now();
  queued = [];
  posts = [];
  respondWith = 202;
  document.body.innerHTML = `
    <div id="app">
      <div class="timeline"><div class="message-row">one answer</div></div>
      <div class="pane-resizer is-right"></div>
    </div>`;
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
    queued.push(callback);
    return queued.length;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return { status: respondWith } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "visibilityState");
  document.body.innerHTML = "";
});

/** The frame clock and `performance.now()` have to share a base for a resume to be measurable -
 * the handler subtracts one from the other, and the stubbed rAF hands out the fake clock. */
function linkClockToPerformance() {
  vi.spyOn(performance, "now").mockImplementation(() => clock);
}

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function start() {
  const { startLagRecorder } = await import("./lagRecorder");
  startLagRecorder();
  pump(16);
  await Promise.resolve();
}

it("posts nothing while frames are fine", async () => {
  await start();
  for (let i = 0; i < 120; i++) pump(16.7);
  await Promise.resolve();
  expect(posts).toEqual([]);
});

it("records the window around a slow frame, with the shape the Go side expects", async () => {
  await start();
  pump(16);
  pump(140); // the stutter
  await Promise.resolve();
  // MutationObserver work lands in microtasks; let it drain.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const row = document.querySelector(".message-row")!;
  row.textContent = "the answer grew";
  for (let i = 0; i < 90; i++) {
    pump(16);
    await Promise.resolve();
  }
  expect(posts.length).toBe(1);
  const post = posts[0];
  expect(post.url).toBe("/perf-lag");
  expect(post.body.reason).toContain("frame-140ms");
  expect(post.body.maxMs).toBeGreaterThan(100);
  expect(typeof post.body.at).toBe("string");
  expect((post.body.scene as Record<string, unknown>).rows).toBe(1);
});

it("opens a window on a divider drag even when no frame crosses the slow threshold", async () => {
  await start();
  document.querySelector(".pane-resizer")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  for (let i = 0; i < 90; i++) {
    pump(16);
    await Promise.resolve();
  }
  expect(posts.length).toBe(1);
  expect(posts[0].body.reason).toBe("drag");
});

it("stops asking once the Go side says the log is disabled", async () => {
  respondWith = 409;
  await start();
  pump(200);
  for (let i = 0; i < 200; i++) {
    pump(16);
    await Promise.resolve();
  }
  expect(posts.length).toBe(1);
  pump(300);
  for (let i = 0; i < 200; i++) {
    pump(16);
    await Promise.resolve();
  }
  expect(posts.length).toBe(1);
});

it("is idempotent, so a hot reload cannot stack two samplers", async () => {
  const { startLagRecorder } = await import("./lagRecorder");
  startLagRecorder();
  startLagRecorder();
  pump(16);
  pump(300);
  for (let i = 0; i < 200; i++) {
    pump(16);
    await Promise.resolve();
  }
  expect(posts.length).toBe(1);
  // One sampler means one frame per pump; two would have doubled the ring and the gaps.
  expect((posts[0].body.frames as number) ?? 0).toBeGreaterThan(0);
});

it("witnesses the resume after the page comes back from hidden, with the away period out of band", async () => {
  linkClockToPerformance();
  await start();
  pump(16);
  setVisibility("hidden");
  clock += 40_000; // a screen lock: rAF fires zero times while hidden
  setVisibility("visible");
  for (let i = 0; i < 90; i++) {
    pump(16);
    await Promise.resolve();
  }
  expect(posts.length).toBe(1);
  const body = posts[0].body;
  expect(String(body.reason)).toContain("resume-");
  expect(body.hiddenMs as number).toBeGreaterThanOrEqual(40_000);
  // The away period must not be laundered into a frame gap, or every lock reads as a freeze -
  // that is what `nativeStall` was there to say, and a resume is not a stall in that sense.
  expect(body.worstGapMs as number).toBeLessThan(2000);
  expect(body.nativeStall).toBe(false);
  // ...and the frames that follow the resume are the actual answer to "解锁后卡不卡".
  expect(body.maxMs as number).toBeLessThan(33);
});

it("keeps silent for a blink too short to be a stall", async () => {
  linkClockToPerformance();
  await start();
  setVisibility("hidden");
  clock += 300;
  setVisibility("visible");
  for (let i = 0; i < 90; i++) {
    pump(16);
    await Promise.resolve();
  }
  expect(posts).toEqual([]);
});

it("still reports a real stutter that happens right after a resume", async () => {
  linkClockToPerformance();
  await start();
  pump(16);
  setVisibility("hidden");
  clock += 40_000;
  setVisibility("visible");
  pump(16);
  pump(260); // the re-rasterize / thread-switch cost, now inside the window
  for (let i = 0; i < 90; i++) {
    pump(16);
    await Promise.resolve();
  }
  expect(posts.length).toBe(1);
  expect(posts[0].body.hiddenMs as number).toBeGreaterThanOrEqual(40_000);
  expect(posts[0].body.maxMs as number).toBeGreaterThan(200);
});

it("describes a placeholder comment instead of throwing the record away", async () => {
  await start();
  pump(16);
  pump(140); // open a capture window
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const timeline = document.querySelector(".timeline")!;
  // Vue leaves a Comment node for every false `v-if`, and `addedNodes` hands it over as-is. It has
  // no `tagName`, so `path()` threw inside the MutationObserver callback and the key never reached
  // `capture.paths` - the record landed with an empty `mutationsTop`, i.e. the witness lied.
  timeline.appendChild(document.createComment("v-if"));
  for (let i = 0; i < 90; i++) {
    pump(16);
    await Promise.resolve();
  }
  expect(posts.length).toBe(1);
  const top = (posts[0].body.mutationsTop ?? []) as string[];
  expect(top.join(" ")).toContain("div.timeline");
});

it("counts DOM writes that happened before anything was slow", async () => {
  // The witness used to be created inside `openCapture`, i.e. on the first slow frame. Everything
  // written before that - startup, and the first seconds of a stream - was invisible, while the
  // record still said `mutations: 0` as if the page had done nothing.
  await start();
  const row = document.querySelector(".message-row")!;
  row.innerHTML = "<p>arrived while frames were fine</p>";
  for (let i = 0; i < 5; i++) await Promise.resolve(); // MutationObserver delivers in a microtask
  pump(140);
  for (let i = 0; i < 90; i++) {
    pump(16);
    await Promise.resolve();
  }
  expect(posts.length).toBe(1);
  expect(posts[0].body.witness).toBe("ok");
  expect(posts[0].body.mutations).toBeGreaterThan(0);
});

it("is still watching after a record lands", async () => {
  // `flush()` used to call `observer.disconnect()` and nothing re-attached it (`openCapture` bails on
  // `if (observer) return`), so from the second record on `mutations` was permanently 0 - and
  // `nativeStall`, computed from the same counters, was permanently true. 51 records of
  // lag-2026-10-08.jsonl were produced that way and read as "the page did no DOM work".
  await start();
  pump(140);
  for (let i = 0; i < 90; i++) {
    pump(16);
    await Promise.resolve();
  }
  expect(posts.length).toBe(1);

  // The post throttle is real time, not the pumped clock, so step past POST_MIN_INTERVAL_MS.
  const realNow = Date.now;
  Date.now = () => realNow() + 5_000;
  const row = document.querySelector(".message-row")!;
  row.innerHTML = "<p>the second stream</p><p>and a second paragraph</p>";
  for (let i = 0; i < 5; i++) await Promise.resolve();
  pump(120);
  for (let i = 0; i < 90; i++) {
    pump(16);
    await Promise.resolve();
  }
  Date.now = realNow;

  expect(posts.length).toBe(2);
  expect(posts[1].body.witness).toBe("ok");
  expect(posts[1].body.mutations).toBeGreaterThan(0);
  expect(posts[1].body.addedChars).toBeGreaterThan(0);
});
