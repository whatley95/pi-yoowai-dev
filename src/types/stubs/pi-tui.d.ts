declare module "@earendil-works/pi-tui" {
  export type Component = unknown;
  export interface AutocompleteItem {
    label: string;
    value?: string;
    detail?: string;
  }
  export type AutocompleteProvider = (input: string) => AutocompleteItem[] | Promise<AutocompleteItem[]>;
  export interface EditorTheme {
    fg(token: string, text: string): string;
    bg(token: string, text: string): string;
  }
  export type EditorComponent = unknown;
  export type KeyId = string;
  export type OverlayHandle = unknown;
  export interface OverlayOptions {
    width?: number | string;
    height?: number | string;
    x?: number | string;
    y?: number | string;
  }
  export type TUI = unknown;

  export class Text {
    constructor(text?: string, paddingX?: number, paddingY?: number, customBgFn?: (text: string) => string);
    setText(text: string): void;
    setCustomBgFn(customBgFn: (text: string) => string): void;
    invalidate(): void;
    render(width: number): string[];
  }

  export class Box {
    constructor(paddingX?: number, paddingY?: number, bgFn?: (text: string) => string);
    addChild(component: unknown): void;
    removeChild(component: unknown): void;
    clear(): void;
    setBgFn(bgFn: (text: string) => string): void;
    invalidate(): void;
    render(width: number): string[];
  }

  export class Container {
    addChild(component: unknown): void;
    removeChild(component: unknown): void;
    clear(): void;
    invalidate(): void;
    render(width: number): string[];
  }

  export class Image {
    constructor(data: string, mimeType: string, styleOpts?: unknown, displayOpts?: unknown);
    render(width: number): string[];
  }

  export class Spacer {
    constructor(height?: number);
    render(width: number): string[];
  }

  export function getCapabilities(): { images?: "sixel" | "kitty" | "none" };
}
