/**
 * Conservative percent-decoding, for **display only**.
 *
 * Some tools hand back a stream whose text arrives percent-encoded: an MCP endpoint that
 * proxies an SSE body prints `%E4%BD%A0%E5%A5%BD` where the reader wants 你好, and every
 * `%0A` in it is a line break that never breaks. Rendered verbatim in the tool panel's
 * `<pre>`, one such call fills the screen with 900 columns of hex and nobody can tell
 * whether the call succeeded.
 *
 * This is a *presentation* transform, so it is allowed to be lossy in one direction only:
 * it never runs on what goes back to the model, and the panel's copy button still copies
 * `tool.output` untouched. That is what makes auto-decoding acceptable here instead of
 * hiding it behind a toggle - the raw bytes are one click away at all times.
 *
 * What keeps it from eating legitimate text:
 * 1. only runs of **two or more** `%XX` pairs are touched, so `100% done` and `printf("%d")` survive;
 * 2. a run that decodes to **pure ASCII** is left alone - `%20`, `%2F`, `%3D` are URL punctuation,
 *    and decoding those is the classic way to break a log line that quotes a query string.
 *    The exception is a payload that *is* one encoded blob: when candidate runs cover at least
 *    half the text (`encodeURIComponent` of a whole JSON body), the ASCII escapes are part of
 *    that encoding too, and leaving them quoted would give half-readable garbage;
 * 3. the byte sequence has to be **well-formed UTF-8**: control bytes, lone surrogates, overlong
 *    forms, or a run that is mostly replacement characters all mean "this is binary, not CJK",
 *    and the run stays as it was written.
 *
 * A truncated head (`F%99%E6%A0%87…`, cut mid-sequence by the output cap) still decodes: the
 * bytes that do form a character turn readable, and the orphan is shown as the raw `%XX` it
 * was. Nothing is ever replaced by U+FFFD - a box glyph in the middle of a sentence reads as
 * "this renderer is broken", while `%84` reads as "these bytes were already gone upstream".
 */

const RUN = /(?:%[0-9A-Fa-f]{2}){2,}/g;
// In a whole encoded payload a lone pair is part of the encoding too (`%5E` for `^` sits between
// two digits, so a {2,} run never reaches it). Only used once density says so.
const RUN_SINGLE = /(?:%[0-9A-Fa-f]{2})+/g;
const PAIR = /%([0-9A-Fa-f]{2})/g;

export interface PercentDecoded {
  /** Text to render. Identical to the input when nothing was touched. */
  text: string;
  /** True when at least one run was decoded - the panel shows that, because what is on
   *  screen is no longer byte-for-byte what the tool printed. */
  decoded: boolean;
}

/** Candidate runs covering this much of the text mean "the payload is encoded", not
 *  "the log happens to quote one URL" - see rule 2. */
const WHOLE_PAYLOAD_DENSITY = 0.5;

/** Decode one `%XX` run, or return null when the bytes are not readable text. */
function decodeRun(run: string, aggressive: boolean): string | null {
  const bytes: number[] = [];
  for (const match of run.matchAll(PAIR)) bytes.push(parseInt(match[1]!, 16));
  // The source text of byte k, used whenever that byte cannot be shown as a character.
  const raw = (k: number) => run.slice(k * 3, k * 3 + 3);

  const chars: string[] = [];
  let bad = 0;
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i]!;
    if (lead < 0x80) {
      // C0 controls (other than the ones a log legitimately contains) and DEL are binary tells.
      if (lead < 0x20 && lead !== 0x09 && lead !== 0x0a && lead !== 0x0d) return null;
      if (lead === 0x7f) return null;
      chars.push(String.fromCharCode(lead));
      i += 1;
      continue;
    }
    // 0x80-0xBF is a continuation byte with no lead in front of it (the usual result of a
    // truncated run), and 0xC0/0xC1 are the two overlong-only leads - all invalid.
    let need: number;
    let cp: number;
    if (lead >= 0xc2 && lead <= 0xdf) {
      need = 1;
      cp = lead & 0x1f;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      need = 2;
      cp = lead & 0x0f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      need = 3;
      cp = lead & 0x07;
    } else {
      bad += 1;
      chars.push(raw(i));
      i += 1;
      continue;
    }
    if (i + need > bytes.length - 1) {
      // Truncated tail (streaming frame, or the output cap cut mid-character): show the
      // dangling bytes exactly as written instead of a replacement char, so the reader
      // never sees U+FFFD flicker in place of text that is merely not finished yet.
      chars.push(run.slice(i * 3));
      break;
    }
    let complete = true;
    for (let k = 1; k <= need; k += 1) {
      const cont = bytes[i + k];
      if (cont === undefined || cont < 0x80 || cont > 0xbf) {
        complete = false;
        break;
      }
      cp = (cp << 6) | (cont & 0x3f);
    }
    if (!complete || cp < 0x80 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) {
      bad += 1;
      chars.push(raw(i));
      i += 1;
      continue;
    }
    chars.push(String.fromCodePoint(cp));
    i += need + 1;
  }

  const text = chars.join("");
  if (!text) return null;
  if (!aggressive && !/[^\x00-\x7f]/.test(text)) return null; // rule 2: URL punctuation stays quoted
  if (bad > Math.floor((chars.length + 1) / 4)) return null; // rule 3: mostly garbage = binary
  return text;
}

/**
 * Rewrite every decodable `%XX` run in `input` into the text it stands for.
 * Cheap enough to run per streamed frame: it returns the input untouched (same reference)
 * unless there is at least one candidate run.
 */
export function decodePercentRuns(input: string): PercentDecoded {
  if (!input || !input.includes("%")) return { text: input, decoded: false };
  let escaped = 0;
  for (const run of input.match(RUN) ?? []) escaped += run.length;
  // Density, not per-run luck, is what separates "this blob is percent-encoded" from
  // "this log line happens to quote a URL".
  const aggressive = escaped / input.length >= WHOLE_PAYLOAD_DENSITY;
  if (!input.match(aggressive ? RUN_SINGLE : RUN)) return { text: input, decoded: false };
  let decoded = false;
  const text = input.replace(aggressive ? RUN_SINGLE : RUN, (run) => {
    const out = decodeRun(run, aggressive);
    if (out === null || out === run) return run; // nothing gained - don't claim we decoded
    decoded = true;
    return out;
  });
  if (!decoded) return { text: input, decoded: false };
  return { text, decoded: true };
}
