/**
 * A frame recorder that stays on, so an intermittent stutter can be measured instead of described.
 *
 * Why this exists in the shipped app: every investigation of "拖动卡顿" so far had to be armed by
 * hand, in a dev instance, *after* the user saw it - and the gesture that stutters for a person is
 * not the gesture a scripted probe performs (measured 2026-10-03: a synthetic divider drag during
 * real streaming holds 17ms median with 2-3 frames at 37-40ms, which nobody would call a freeze).
 * The only reliable witness is one that is always running and costs nothing while frames are fine.
 *
 * Cost, by construction:
 *  - one `requestAnimationFrame` callback per frame, doing ~4 integer additions;
 *  - four passive listeners (`pointerdown` / `wheel` / `keydown` / `resize`), which fire on input;
 *  - **no** `MutationObserver` and **no** per-frame DOM reads: both are attached only inside a
 *    capture window, which opens on a slow frame or on a drag gesture and closes 1.2s later.
 * Records leave through `POST /perf-lag` (see internal/appservice/perflag.go), which owns the rate
 * limit, the daily cap and the directory trim. A 409/507 answer means "stop", and we do.
 */

const SLOW_MS = 50;
/** A drag is worth a record even at 30ms frames, because that is what "feels sticky" means. The
 * window-move case matters most: `--wails-draggable: drag` hands the gesture to AppKit, whose event
 * tracking mode can starve rAF - a 900ms gap with zero mutations is that, not our JS. */
const DRAG_TRIGGER = ".pane-resizer, .app-menu-drag-region, [data-wails-drag]";
const CAPTURE_MS = 1200;
/** Longer than any real frame, shorter than a lunch break: a gap this big means the page was hidden. */
const STALL_MS = 2000;
const POST_MIN_INTERVAL_MS = 3000;
const MAX_POSTS_PER_SESSION = 40;
const RING = 240;
const ENDPOINT = "/perf-lag";

type Frame = { gap: number; muts: number; nodes: number; chars: number; long: number };

type Capture = {
  until: number;
  reason: string;
  muts: number;
  nodes: number;
  chars: number;
  paths: Record<string, number>;
  long: number[];
  worstGap: number;
  /** How long the document was hidden before this window opened. 0 unless a resume caused it. */
  hiddenMs: number;
};

let started = false;
let ring: Frame[] = [];
let capture: Capture | null = null;
let observer: MutationObserver | null = null;
let lastPost = 0;
let posts = 0;
let stopped = false;
let prev = 0;
let hiddenAt = 0;
const gestures: string[] = [];
const counters = { muts: 0, nodes: 0, chars: 0, long: 0 };

const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);

/** The shortest useful description of a DOM position: three ancestor tags/classes. */
function path(node: EventTarget | Node | null): string {
  let el = node as Element | null;
  // Anything that is not an Element has no `tagName`: a Text (3), a Comment (8) - which is what Vue
  // leaves behind for every `v-if` / `v-for` / Teleport anchor, so it lands in `addedNodes` during
  // ordinary re-renders - and a DocumentFragment (11). `path` also takes `event.target`, which is
  // typed as a bare EventTarget and can be the Document. Walk to the parent instead of throwing:
  // this runs inside the MutationObserver callback, and a throw there aborts the record being built.
  if (el && el.nodeType !== 1) el = el.parentElement;
  const bits: string[] = [];
  while (el && bits.length < 3) {
    const tag = typeof el.tagName === "string" ? el.tagName.toLowerCase() : "";
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean)[0] : "";
    bits.push(tag ? (cls ? `${tag}.${cls}` : tag) : "?");
    el = el.parentElement;
  }
  return bits.join(">") || "?";
}

function openCapture(reason: string, worstGap = 0, hiddenMs = 0) {
  if (!capture) {
    gestures.push(`${reason}@${Math.round(performance.now())}`);
    capture = { until: performance.now() + CAPTURE_MS, reason, muts: 0, nodes: 0, chars: 0, paths: {}, long: [], worstGap, hiddenMs };
  } else {
    capture.worstGap = Math.max(capture.worstGap, worstGap);
    capture.hiddenMs = Math.max(capture.hiddenMs, hiddenMs);
  }
  if (observer) return;
  observer = new MutationObserver((records) => {
    for (const record of records) {
      counters.muts += 1;
      if (capture) capture.muts += 1;
      for (const added of Array.from(record.addedNodes)) {
        const text = added.textContent || "";
        counters.nodes += 1;
        counters.chars += text.length;
        if (!capture) continue;
        capture.nodes += 1;
        capture.chars += text.length;
        const key = path(added.nodeType === 3 ? added.parentElement : added);
        capture.paths[key] = (capture.paths[key] || 0) + 1;
      }
      if (record.type === "characterData") {
        const text = (record.target as Text).data || "";
        counters.chars += text.length;
        if (!capture) continue;
        capture.chars += text.length;
        const key = path(record.target);
        capture.paths[key] = (capture.paths[key] || 0) + 1;
      }
    }
  });
  const root = q("#app");
  if (root) observer.observe(root, { childList: true, subtree: true, characterData: true });
}

function topPaths(paths: Record<string, number>, n: number) {
  return Object.entries(paths)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, value]) => `${key}×${value}`);
}

/** The elements a pane drag actually has to re-lay-out. Read only when a record is being written
 * (at most one every 3s), never per frame: these are forced-layout reads.
 *
 * Why this is in the record at all: measured 2026-10-03, a 9,298px mounted row dragged smooth
 * (max 21ms) in a dev instance, while the desktop's own record of the same gesture at a 20,665px
 * row dropped 7 frames - so *height* is not the variable. The remaining suspects are the ones
 * counted here: an auto-layout markdown table (WebKit measures every cell), a long `pre`, the
 * collapsed `details` blocks, and xterm, which re-measures its grid on every width change. */
const SUSPECT_SELECTOR = ".message-content table, .message-content pre, .message-content details, .message-content > *, .tool-section, .thinking-body";
const MAX_SUSPECTS = 220;

function suspects() {
  const out: { sel: string; px: number; cells: number; lines: number }[] = [];
  let tables = 0;
  let cells = 0;
  let scanned = 0;
  for (const row of Array.from(document.querySelectorAll<HTMLElement>(".virtual-message-row, .message-row"))) {
    for (const block of Array.from(row.querySelectorAll<HTMLElement>(SUSPECT_SELECTOR))) {
      if (scanned++ > MAX_SUSPECTS) break;
      if (block.tagName === "TABLE") {
        tables += 1;
        cells += block.querySelectorAll("td,th").length;
      }
      out.push({
        sel: `${block.tagName.toLowerCase()}.${(typeof block.className === "string" ? block.className.split(/\s+/).filter(Boolean)[0] : "") || "-"}`,
        px: block.scrollHeight,
        cells: block.tagName === "TABLE" ? block.querySelectorAll("td,th").length : 0,
        lines: block.tagName === "PRE" ? (block.textContent || "").split("\n").length : 0,
      });
    }
  }
  out.sort((a, b) => b.px - a.px || b.cells - a.cells);
  return { tables, cells, worst: out.slice(0, 4) };
}

function scene() {
  let tallest = 0;
  for (const row of Array.from(document.querySelectorAll<HTMLElement>(".virtual-message-row, .message-row"))) {
    if (row.scrollHeight > tallest) tallest = row.scrollHeight;
  }
  const terminal = q<HTMLElement>(".xterm");
  const inspector = q<HTMLElement>(".inspector");
  return {
    dom: document.querySelectorAll("*").length,
    rows: document.querySelectorAll(".virtual-message-row, .message-row").length,
    tallestRowPx: tallest,
    scrollHeightPx: q(".timeline")?.scrollHeight ?? 0,
    inspectorPx: inspector ? Math.round(inspector.getBoundingClientRect().width) : 0,
    sidebarPx: Math.round(q(".sidebar")?.getBoundingClientRect().width ?? 0),
    terminalVisible: !!terminal && terminal.offsetParent !== null,
    terminalRows: document.querySelectorAll(".xterm-rows > div").length,
    tabs: Array.from(document.querySelectorAll<HTMLElement>(".panel-tab [role='tab']")).map(
      (tab) => `${(tab.textContent || "").trim().slice(0, 14)}${tab.getAttribute("aria-selected") === "true" ? "*" : ""}`,
    ),
    visibility: document.visibilityState,
    ...suspects(),
  };
}

function summarise(frames: Frame[]) {
  const gaps = frames.map((f) => f.gap).sort((a, b) => a - b);
  const pick = (p: number) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] ?? 0;
  const sum = (key: keyof Frame) => frames.reduce((total, f) => total + f[key], 0);
  return {
    frames: frames.length,
    medianMs: Math.round(pick(0.5) * 10) / 10,
    p95Ms: Math.round(pick(0.95) * 10) / 10,
    maxMs: Math.round((gaps[gaps.length - 1] ?? 0) * 10) / 10,
    over33: gaps.filter((g) => g > 33).length,
    over50: gaps.filter((g) => g > SLOW_MS).length,
    mutations: sum("muts"),
    addedChars: sum("chars"),
    longtaskMs: sum("long"),
  };
}

async function flush(frames: Frame[]) {
  const captureState = capture;
  capture = null;
  observer?.disconnect();
  const now = Date.now();
  if (posts >= MAX_POSTS_PER_SESSION || now - lastPost < POST_MIN_INTERVAL_MS) return;
  const body = {
    at: new Date().toISOString(),
    reason: captureState?.reason ?? "window",
    worstGapMs: Math.round(captureState?.worstGap ?? 0),
    /** Set on a resume window: the away period, kept out of `worstGapMs`/`maxMs` on purpose so a
     * 40-minute lock is never read as a 40-minute freeze. */
    hiddenMs: Math.round(captureState?.hiddenMs ?? 0),
    /** A gap over STALL_MS with no work in it is the native event loop or a hidden page. */
    nativeStall: (captureState?.worstGap ?? 0) > STALL_MS && (captureState?.muts ?? 0) < 5,
    ...summarise(frames),
    ...(captureState ? { mutationsTop: topPaths(captureState.paths, 6), longtaskPeaks: captureState.long.slice(-6) } : {}),
    gestures: gestures.slice(-12),
    scene: scene(),
    dev: !!import.meta.env?.DEV,
    ua: navigator.userAgent.slice(0, 90),
  };
  lastPost = now;
  posts += 1;
  try {
    const response = await fetch(ENDPOINT, { method: "POST", body: JSON.stringify(body), keepalive: true });
    // 409 = disabled by PI_DESK_LAG_LOG, 507 = the log is at its cap. Both mean "do not ask again".
    if (response.status === 409 || response.status === 507) stopped = true;
  } catch {
    stopped = true; // no asset server (unit tests, odd origins): never retry, never throw
  }
}

function tick(time: number) {
  if (stopped) return;
  const gap = prev ? time - prev : 0;
  prev = time;
  if (gap > 0) {
    ring.push({ gap, muts: counters.muts, nodes: counters.nodes, chars: counters.chars, long: counters.long });
    if (ring.length > RING) ring.shift();
    counters.muts = 0;
    counters.nodes = 0;
    counters.chars = 0;
    counters.long = 0;
  }
  if (capture && time > capture.until) {
    const tail = ring.slice(-90);
    void flush(tail);
    ring = ring.slice(-60);
  }
  // A stall this long is the page being hidden or the machine asleep, not a dropped frame. Only
  // report it when the document still claims to be visible, and label it so nobody reads it as UI.
  if (gap > STALL_MS && document.visibilityState === "visible") {
    openCapture(`stall-${Math.round(gap)}ms`, gap);
  } else if (gap > SLOW_MS) {
    openCapture(`frame-${Math.round(gap)}ms`, gap);
  }
  requestAnimationFrame(tick);
}

function onGesture(type: string) {
  return (event: Event) => {
    if (stopped) return;
    const target = event.target as Element | null;
    gestures.push(`${type} ${path(target)}`.slice(0, 90));
    if (gestures.length > 40) gestures.shift();
    if (type === "pointerdown" && target?.closest?.(DRAG_TRIGGER)) openCapture("drag", 0);
  };
}

/**
 * Attaches the recorder. Idempotent, and deliberately unable to break the app: every path is
 * guarded, and the whole body is wrapped so a missing API (no rAF in a test runner, no
 * MutationObserver in an old shell) just means no records.
 */
export function startLagRecorder(): void {
  if (started || typeof window === "undefined" || typeof requestAnimationFrame !== "function") return;
  started = true;
  try {
    if (typeof PerformanceObserver === "function") {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          counters.long += entry.duration;
          capture?.long.push(Math.round(entry.duration));
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    }
  } catch {
    // longtask is not universal; the frame gaps carry the argument anyway
  }
  for (const type of ["pointerdown", "wheel", "keydown", "resize"] as const) {
    window.addEventListener(type, onGesture(type), { passive: true, capture: true });
  }
  // Resume is the one case the frame clock cannot see, and it used to be thrown away on purpose.
  // Why that was wrong (2026-10-08, iot "文档整理优化" thread): a user-reported post-unlock stutter
  // produced no `lag-2026-10-08.jsonl` at all. Both reasons are structural - `tick()` only reports
  // an over-STALL_MS gap while the document still claims to be visible, and the old handler reset
  // `prev` on resume, so the enormous first frame never reached the ring either.
  // Kept: the baseline reset, because the away gap genuinely is not a dropped frame. Added: a
  // capture window over the frames that *follow* the resume, with the away period carried out of
  // band as `hiddenMs`. Whether a screen lock fires `visibilitychange` at all (rather than only
  // freezing rAF) is settled by the `reason` / `scene.visibility` pair on the record.
  document.addEventListener("visibilitychange", () => {
    gestures.push(`visibility ${document.visibilityState}`);
    if (stopped) return;
    if (document.visibilityState === "hidden") {
      hiddenAt = performance.now();
      return;
    }
    const awayMs = hiddenAt ? Math.round(performance.now() - hiddenAt) : 0;
    hiddenAt = 0;
    // rAF never fires while hidden, so `prev` is still the last frame before the page went away:
    // this difference is the away period plus whatever the resume itself cost.
    const gapMs = prev ? Math.round(performance.now() - prev) : awayMs;
    prev = 0;
    if (Math.max(gapMs, awayMs) <= STALL_MS) return;
    // `worstGap` stays 0 on purpose - the away period is explained by `hiddenMs`, and the number
    // we actually want is the worst frame the next CAPTURE_MS produces.
    openCapture(`resume-${gapMs}ms`, 0, awayMs);
  });
  requestAnimationFrame(tick);
  (window as unknown as { __pideskLag?: unknown }).__pideskLag = {
    stop: () => (stopped = true),
    stats: () => summarise(ring.slice(-60)),
    dump: () => ({ ...summarise(ring.slice(-90)), gestures: gestures.slice(-20), scene: scene() }),
    /** Force a record (Safari Web Inspector, or a dev probe verifying the /perf-lag route). */
    capture: (reason = "manual") => openCapture(reason, 0),
  };
}
