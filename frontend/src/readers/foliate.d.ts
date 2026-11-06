/**
 * foliate-js is published as plain ES modules with no type declarations (`"exports": { "./*.js": … }`
 * and no `.d.ts`). Only the surface this app touches is declared here; the reader never reaches
 * into the renderers directly, so the rest stays implicit.
 */
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

  export class FoliateView extends HTMLElement {
    book?: { toc?: FoliateTocItem[]; metadata?: { title?: unknown; language?: unknown } };
    renderer?: { setStyles?: (styles: string | [string, string]) => void; next?: () => unknown; prev?: () => unknown };
    open(source: Blob | string): Promise<void>;
    init(options: { lastLocation?: string; showTextStart?: boolean }): Promise<void>;
    goTo(target: number | string): Promise<unknown>;
    prev(): Promise<unknown>;
    next(): Promise<unknown>;
    close(): void;
  }
}

declare module "pdfjs-dist/build/pdf.worker.mjs";
