/**
 * Back-fills the runtime APIs the PDF engine needs on the oldest WebKit we still support.
 *
 * `MACOSX_DEPLOYMENT_TARGET` stays at 12.0 (build/darwin/Taskfile.yml), so a macOS 12 machine
 * runs WKWebView 15.x. pdf.js 6.x is written for Safari 17.4: it uses `Promise.withResolvers`
 * (17.4), and its bundles contain `static {}` blocks (16.4). The blocks are *syntax*, so no
 * polyfill can help — `build.target: "safari15"` in vite.config.ts transpiles them away. What is
 * left is runtime API, and that is what this module adds.
 *
 * Deliberately small: Safari 15.4 already has `structuredClone`, `Object.hasOwn`, `findLast` and
 * `at`, and macOS 12 ships 15.6 at most. Only the two features 15.x genuinely lacks are
 * unconditional; the rest are guarded so a missing one does not become a second failure.
 *
 * This module is imported *before* pdf.js in the same chunk, so ESM evaluation order guarantees
 * the patches exist by the time the engine module runs.
 */

/**
 * Which of these APIs the *engine* shipped with, captured before any patch below runs.
 *
 * The readers use it for one thing only: choosing the wording when a document still fails to open.
 * It is not a gate — the polyfills are why an older WebKit can usually run the engine anyway, so
 * refusing up front would take away a working reader.
 */
export const nativeCapabilities = {
  promiseWithResolvers: typeof (Promise as { withResolvers?: unknown }).withResolvers === "function",
  structuredClone: typeof globalThis.structuredClone === "function",
};

type WithResolversResult<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

if (typeof (Promise as { withResolvers?: unknown }).withResolvers !== "function") {
  (Promise as unknown as { withResolvers: <T>() => WithResolversResult<T> }).withResolvers = function withResolvers<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

if (typeof Object.hasOwn !== "function") {
  Object.hasOwn = function hasOwn(target: object, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(target, key);
  };
}

const arrayPrototype = Array.prototype as unknown as Record<string, unknown>;
if (typeof arrayPrototype.findLast !== "function") {
  arrayPrototype.findLast = function findLast<T>(
    this: T[],
    predicate: (value: T, index: number, array: T[]) => unknown,
    thisArg?: unknown,
  ): T | undefined {
    for (let index = this.length - 1; index >= 0; index -= 1) {
      if (predicate.call(thisArg, this[index], index, this)) return this[index];
    }
    return undefined;
  };
}
if (typeof arrayPrototype.findLastIndex !== "function") {
  arrayPrototype.findLastIndex = function findLastIndex<T>(
    this: T[],
    predicate: (value: T, index: number, array: T[]) => unknown,
    thisArg?: unknown,
  ): number {
    for (let index = this.length - 1; index >= 0; index -= 1) {
      if (predicate.call(thisArg, this[index], index, this)) return index;
    }
    return -1;
  };
}
if (typeof arrayPrototype.at !== "function") {
  arrayPrototype.at = function at<T>(this: T[], index: number): T | undefined {
    const offset = Math.trunc(index) || 0;
    return offset < 0 ? this[this.length + offset] : this[offset];
  };
}

/**
 * `Map.prototype.getOrInsertComputed` — the TC39 upsert proposal — is used 40 times across
 * `pdf.mjs` and `pdf.worker.mjs` in 6.5.438, and no shipping WebKit has it: the engine's own
 * "Safari 17.4" floor is not the real floor, because `PDFPageProxy.render` calls it through
 * `getOptionalContentConfig` and throws `getOrInsertComputed is not a function` before drawing a
 * single page. Found by rendering a real PDF in WKWebView, not by reading the changelog.
 *
 * `getOrInsert` is the non-callback half of the same proposal; pdf.js only reads through it, but a
 * webview that has one and not the other would be stranger than one missing both.
 */
type UpsertMap<K, V> = {
  has(key: K): boolean;
  get(key: K): V | undefined;
  set(key: K, value: V): unknown;
};

/**
 * Installs the TC39 upsert methods on one collection prototype. `pdf.js` reads through all of them:
 * `#methodPromises` and `#objs` are `Map`s, while `CanvasGraphics.#pathCaches` and
 * `#operatorLists` are `WeakMap`s, so a `Map`-only patch still fails on the first page it draws.
 */
function installUpsert(prototype: Record<string, unknown>) {
  if (typeof prototype.getOrInsert !== "function") {
    prototype.getOrInsert = function getOrInsert<K, V>(
      this: UpsertMap<K, V>,
      key: K,
      value: V,
    ): V {
      if (this.has(key)) return this.get(key) as V;
      this.set(key, value);
      return value;
    };
  }
  if (typeof prototype.getOrInsertComputed !== "function") {
    prototype.getOrInsertComputed = function getOrInsertComputed<K, V>(
      this: UpsertMap<K, V>,
      key: K,
      callback: (key: K) => V,
    ): V {
      if (this.has(key)) return this.get(key) as V;
      const value = callback(key);
      this.set(key, value);
      return value;
    };
  }
}

installUpsert(Map.prototype as unknown as Record<string, unknown>);
installUpsert(WeakMap.prototype as unknown as Record<string, unknown>);

/**
 * A `structuredClone` that keeps binary data intact. A JSON round-trip would turn every
 * `Uint8Array` the engine clones into an object of index keys and corrupt decoded images, so the
 * typed-array views are handled explicitly; the graph walk covers cycles.
 */
if (typeof globalThis.structuredClone !== "function") {
  const cloneValue = (value: unknown, seen: Map<object, unknown>): unknown => {
    if (value === null || typeof value !== "object") return value;
    const known = seen.get(value);
    if (known !== undefined) return known;
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof RegExp) return new RegExp(value.source, value.flags);
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView & { length?: number };
      if (view instanceof DataView) {
        return new DataView((value.buffer as ArrayBuffer).slice(0), view.byteOffset, view.byteLength);
      }
      const length = typeof view.length === "number" ? view.length : 0;
      const copy = new (value.constructor as new (source: ArrayBufferView) => ArrayBufferView)(value);
      void length;
      return copy;
    }
    if (value instanceof Map) {
      const copy = new Map();
      seen.set(value, copy);
      for (const [key, entry] of value) copy.set(cloneValue(key, seen), cloneValue(entry, seen));
      return copy;
    }
    if (value instanceof Set) {
      const copy = new Set();
      seen.set(value, copy);
      for (const entry of value) copy.add(cloneValue(entry, seen));
      return copy;
    }
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      seen.set(value, copy);
      for (const entry of value) copy.push(cloneValue(entry, seen));
      return copy;
    }
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    for (const key of Object.keys(value)) {
      copy[key] = cloneValue((value as Record<string, unknown>)[key], seen);
    }
    return copy;
  };

  globalThis.structuredClone = function structuredClone<T>(value: T): T {
    return cloneValue(value, new Map()) as T;
  };
}

export {};
