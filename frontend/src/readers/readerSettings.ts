import { reactive, watch } from "vue";

/**
 * Reader preferences — typography and paging — shared by the PDF and EPUB views.
 *
 * Stored in `localStorage` rather than `domain.Preferences` on purpose. Preferences travel through
 * the Go side and are exposed as a generated binding struct, so every field added there needs the
 * bindings regenerated; these are three numbers, a colour and three switches owned by one panel,
 * and AGENTS.md §1.5 asks for UI state to ride an opaque blob instead of growing the RPC surface.
 * `localStorage` is that blob, with no schema migration owed to the backend. If these ever need to
 * follow the user across machines, moving them into `Preferences.reader` is a one-file change here.
 */
export type ReaderTheme = "light" | "sepia" | "dark";

export interface ReaderSettings {
  theme: ReaderTheme;
  /** Empty means "keep the book's own font", which is what most publishers designed for. */
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  /** EPUB: wheel turns a page instead of scrolling a column. */
  wheelPaging: boolean;
  /** EPUB: slide between pages instead of jumping. */
  animateTurns: boolean;
}

const STORAGE_KEY = "pidesk.reader.settings";

export const FONT_CHOICES: { value: string; label: string }[] = [
  { value: "", label: "book" },
  { value: "-apple-system, 'PingFang SC', 'Helvetica Neue', sans-serif", label: "system" },
  { value: "'Songti SC', 'Noto Serif CJK SC', serif", label: "serif" },
  { value: "'Kaiti SC', 'STKaiti', serif", label: "kai" },
];

export const THEMES: ReaderTheme[] = ["light", "sepia", "dark"];

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  theme: "light",
  fontFamily: "",
  fontSize: 18,
  lineHeight: 1.6,
  wheelPaging: true,
  animateTurns: true,
};

const BOUNDS = {
  fontSize: [12, 30],
  lineHeight: [1.2, 2.4],
} as const;

function clamp(value: number, [low, high]: readonly [number, number]): number {
  return Math.min(high, Math.max(low, Math.round(value * 100) / 100));
}

/** Tolerates anything: a hand-edited or stale blob degrades to the defaults, field by field. */
export function normalizeReaderSettings(input: unknown): ReaderSettings {
  const source = (input ?? {}) as Partial<Record<keyof ReaderSettings, unknown>>;
  const theme = THEMES.includes(source.theme as ReaderTheme) ? (source.theme as ReaderTheme) : DEFAULT_READER_SETTINGS.theme;
  return {
    theme,
    fontFamily: typeof source.fontFamily === "string" ? source.fontFamily : DEFAULT_READER_SETTINGS.fontFamily,
    fontSize: clamp(Number(source.fontSize) || DEFAULT_READER_SETTINGS.fontSize, BOUNDS.fontSize),
    lineHeight: clamp(Number(source.lineHeight) || DEFAULT_READER_SETTINGS.lineHeight, BOUNDS.lineHeight),
    wheelPaging: typeof source.wheelPaging === "boolean" ? source.wheelPaging : DEFAULT_READER_SETTINGS.wheelPaging,
    animateTurns: typeof source.animateTurns === "boolean" ? source.animateTurns : DEFAULT_READER_SETTINGS.animateTurns,
  };
}

function load(): ReaderSettings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_READER_SETTINGS };
  try {
    return normalizeReaderSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    return { ...DEFAULT_READER_SETTINGS };
  }
}

/** Reactive and shared: changing the font in one reader is visible the next time either opens. */
export const readerSettings = reactive<ReaderSettings>(load());

watch(readerSettings, (value) => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* Private mode or a full quota: the session keeps working with the in-memory copy. */
  }
}, { deep: true });

/** Partial update with the same clamping a UI control would have applied. */
export function updateReaderSettings(patch: Partial<ReaderSettings>): void {
  if (patch.fontSize !== undefined) patch.fontSize = clamp(patch.fontSize, BOUNDS.fontSize);
  if (patch.lineHeight !== undefined) patch.lineHeight = clamp(patch.lineHeight, BOUNDS.lineHeight);
  Object.assign(readerSettings, patch);
}

/** Sepia is the one palette a book page needs beyond black-on-white and dark mode. */
export const THEME_COLORS: Record<ReaderTheme, { page: string; ink: string; muted: string }> = {
  light: { page: "#ffffff", ink: "#1d1d1f", muted: "#6b6b70" },
  sepia: { page: "#f4ecd8", ink: "#3b3228", muted: "#7a6a55" },
  dark: { page: "#16181c", ink: "#d8d8dc", muted: "#8e9096" },
};
