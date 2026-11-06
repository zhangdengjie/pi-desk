/**
 * foliate-js is published as plain ES modules with no type declarations (`"exports": { "./*.js": … }`
 * and no `.d.ts`). Only the surface this app touches is declared here; the reader never reaches
 * into the renderers directly, so the rest stays implicit.
 */
declare module "foliate-js/search.js" {
  export function searchMatcher(
    walker: unknown,
    options: Record<string, unknown>,
  ): (doc: Document, query: string) => Iterable<{ range: Range; excerpt?: unknown }>;
}

declare module "foliate-js/text-walker.js" {
  export function textWalker(node: Node, accept: (node: Node) => number): NodeIterator;
}

declare module "foliate-js/view.js" {
  export interface FoliateTocItem {
    label: string;
    href: string;
    subitems?: FoliateTocItem[] | null;
  }

  export interface FoliateLocation {
    fraction?: number;
    index?: number;
    cfi?: string;
    tocItem?: { label?: string };
    pageItem?: { label?: string };
  }

  export interface FoliateSearchExcerpt {
    pre?: string;
    match?: string;
    post?: string;
  }

  export interface FoliateSearchYield {
    progress?: number;
    index?: number;
    label?: string;
    subitems?: { cfi: string; excerpt?: FoliateSearchExcerpt }[];
  }

  export interface FoliateSection {
    id: string;
    linear?: string;
    /** Builds and caches the section's blob URL; calling it early is what warms the next turn. */
    load?: () => Promise<string | undefined>;
    createDocument?: () => Promise<Document>;
  }

  export class FoliateView extends HTMLElement {
    book?: {
      toc?: FoliateTocItem[];
      metadata?: { title?: unknown; language?: unknown };
      sections?: FoliateSection[];
      /** Absent on some builds; guarded before use. */
      resolveHref?: (href: string) => { index: number; anchor: (doc: Document) => unknown } | null;
    };
    renderer?: {
      setStyles?: (styles: string | [string, string]) => void;
      getContents?: () => { index?: number; doc?: Document; overlayer?: unknown }[];
      goTo?: (target: { index: number; anchor?: number | ((doc: Document) => number) }) => Promise<unknown>;
      scrollToAnchor?: (anchor: unknown, select?: boolean) => Promise<unknown>;
      page?: number;
      pages?: number;
      atEnd?: boolean;
      atStart?: boolean;
      hasAttribute?: (name: string) => boolean;
    };
    open(source: Blob | string): Promise<void>;
    init(options: { lastLocation?: string; showTextStart?: boolean }): Promise<void>;
    goTo(target: number | string): Promise<unknown>;
    getCFI(index: number, range: Range | null): string;
    resolveCFI(cfi: string): { index: number; anchor: (doc: Document) => unknown };
    language?: unknown;
    goLeft(): Promise<unknown>;
    goRight(): Promise<unknown>;
    /** Async generator: `{progress}`, then `{index, subitems}` per section, then the string "done". */
    search(options: Record<string, unknown>): AsyncGenerator<FoliateSearchYield | "done">;
    clearSearch(): void;
    prev(): Promise<unknown>;
    next(): Promise<unknown>;
    close(): void;
  }
}

declare module "pdfjs-dist/build/pdf.worker.mjs";
