/**
 * Build-time rewrites for regex syntax that Safari 15 cannot even parse.
 *
 * The app links against `MACOSX_DEPLOYMENT_TARGET: "12.0"`, so a macOS 12 machine runs WKWebView
 * 15.x. `build.target: "safari15"` in vite.config.ts transpiles *syntax* (class static blocks,
 * optional chaining, …) but no bundler lowers regular-expression features: a lookbehind group is
 * still a lookbehind after transpilation, and an engine that does not know it rejects the module at
 * parse time. Lowering a regex means rewriting the expression, which is what this module does.
 *
 * Each entry is a documented, behaviour-preserving rewrite. `applySafari15Rewrites` returns the
 * source unchanged when the pattern is absent, and reports which rewrites were skipped so a
 * dependency upgrade that fixes (or moves) the code is visible rather than silent.
 */

export interface Safari15Rewrite {
  /** What the rewrite is for. Shown in the build log when it stops matching. */
  readonly purpose: string;
  /** A regex without lookbehind that consumes the preceding character into group `$1`. */
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * foliate-js `paginator.js`: unlifts `-epub-` prefixed CSS properties before laying the book out.
 * The lookbehind only asserts that the property starts at the beginning of a rule or declaration,
 * so capturing the delimiter and writing it back is the same transformation.
 */
const foliateEpubPrefix: Safari15Rewrite = {
  purpose: "foliate-js paginator: -epub- prefix removal without lookbehind",
  pattern: /\.replace\(\/\(\?<=\[\{\\s;\]\)-epub-\/gi, ''\)/,
  replacement: ".replace(/([{\\s;])-epub-/gi, '$1')",
};

const rewrites: readonly Safari15Rewrite[] = [foliateEpubPrefix];

export interface Safari15RewriteResult {
  code: string;
  applied: string[];
  skipped: string[];
}

/** Pure so the rewrite table can be unit-tested without running a build. */
export function applySafari15Rewrites(code: string): Safari15RewriteResult {
  const applied: string[] = [];
  const skipped: string[] = [];
  let output = code;
  for (const rewrite of rewrites) {
    if (!rewrite.pattern.test(output)) {
      skipped.push(rewrite.purpose);
      continue;
    }
    output = output.replace(rewrite.pattern, rewrite.replacement);
    applied.push(rewrite.purpose);
  }
  return { code: output, applied, skipped };
}

/** True when the text still contains a lookbehind assertion an ES2018-less engine would reject. */
export function hasRegexLookbehind(code: string): boolean {
  return /\(\?<[=!]/.test(code);
}
