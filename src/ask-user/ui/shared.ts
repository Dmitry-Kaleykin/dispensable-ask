import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component, type EditorTheme, Key, type Keybinding,
  type KeybindingsManager, type MarkdownTheme, matchesKey,
  type OverlayHandle, type OverlayOptions,
} from "@earendil-works/pi-tui";
import type { AskDisplayMode } from "../model";

export function safeMarkdownTheme(): MarkdownTheme | undefined {
   try {
      const md = getMarkdownTheme();
      if (!md) return undefined;
      md.bold("");
      return md;
   } catch {
      return undefined;
   }
}

function createSelectListTheme(theme: Theme) {
   return {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
   };
}

export function createEditorTheme(theme: Theme): EditorTheme {
   return {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: createSelectListTheme(theme),
   };
}

export const BOX_BORDER_LEFT = "│ ";
export const BOX_BORDER_RIGHT = " │";
export const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

export class BoxBorderTop implements Component {
   private color: (s: string) => string;
   private title?: string;
   private titleColor?: (s: string) => string;
   constructor(color: (s: string) => string, title?: string, titleColor?: (s: string) => string) {
      this.color = color;
      this.title = title;
      this.titleColor = titleColor;
   }
   invalidate(): void { }
   render(width: number): string[] {
      const inner = Math.max(0, width - 2);
      if (!this.title || inner < this.title.length + 4) {
         return [this.color(`╭${"─".repeat(inner)}╮`)];
      }
      const label = ` ${this.title} `;
      const remaining = inner - 1 - label.length;
      const titleStyle = this.titleColor ?? this.color;
      return [
         this.color("╭─") + titleStyle(label) + this.color("─".repeat(Math.max(0, remaining)) + "╮"),
      ];
   }
}

export class BoxBorderBottom implements Component {
   private color: (s: string) => string;
   private label?: string;
   private labelColor?: (s: string) => string;
   constructor(color: (s: string) => string, label?: string, labelColor?: (s: string) => string) {
      this.color = color;
      this.label = label;
      this.labelColor = labelColor;
   }
   invalidate(): void { }
   render(width: number): string[] {
      const inner = Math.max(0, width - 2);
      if (!this.label || inner < this.label.length + 4) {
         return [this.color(`╰${"─".repeat(inner)}╯`)];
      }
      const tag = ` ${this.label} `;
      const leftDashes = inner - tag.length - 1;
      const style = this.labelColor ?? this.color;
      return [
         this.color("╰" + "─".repeat(Math.max(0, leftDashes))) + style(tag) + this.color("─╯"),
      ];
   }
}

export function formatKeyList(keys: string[]): string {
   return keys.join("/");
}

export function keybindingHint(
   theme: Theme,
   keybindings: KeybindingsManager,
   keybinding: Keybinding,
   description: string,
): string {
   return `${theme.fg("dim", formatKeyList(keybindings.getKeys(keybinding)))}${theme.fg("muted", ` ${description}`)}`;
}

export function literalHint(theme: Theme, key: string, description: string): string {
   return `${theme.fg("dim", key)}${theme.fg("muted", ` ${description}`)}`;
}

export type ResolvedShortcut =
   | { disabled: false; spec: string; matches: (data: string) => boolean }
   | { disabled: true; spec: null; matches: (data: string) => false };

export interface ResolvedAskShortcuts {
   overlayToggle: ResolvedShortcut;
   commentToggle: ResolvedShortcut;
}

const DISABLED_SHORTCUT: ResolvedShortcut = {
   disabled: true,
   spec: null,
   matches: ((_data: string) => false) as (data: string) => false,
};

const SHORTCUT_DISABLE_VALUES = new Set(["off", "none", "disabled", ""]);

function normalizeShortcutSpec(value: string | null | undefined): string | null | undefined {
   if (value === undefined) return undefined;
   if (value === null) return null;
   const trimmed = value.trim().toLowerCase();
   if (SHORTCUT_DISABLE_VALUES.has(trimmed)) return null;
   return trimmed;
}

function isValidShortcutSpec(spec: string): boolean {
   // KeyId is canonical lowercase: modifiers (`ctrl|shift|alt|super`) joined by `+`,
   // plus a base key. We do a light syntactic sanity check; matchesKey() does the rest.
   if (!spec) return false;
   if (!/^[a-z0-9+_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]+$/i.test(spec)) return false;
   if (spec.startsWith("+") || spec.endsWith("+")) return false;
   if (spec.includes("++")) return false;
   return true;
}

function buildShortcut(spec: string): ResolvedShortcut {
   return {
      disabled: false,
      spec,
      matches: (data: string) => matchesKey(data, spec as any),
   };
}

export function resolveShortcut(
   paramValue: string | null | undefined,
   envValue: string | undefined,
   defaultSpec: string,
): ResolvedShortcut {
   const candidates: Array<string | null | undefined> = [paramValue, envValue, defaultSpec];
   for (const raw of candidates) {
      const normalized = normalizeShortcutSpec(raw);
      if (normalized === undefined) continue; // not provided, fall through
      if (normalized === null) return DISABLED_SHORTCUT; // explicit disable
      if (isValidShortcutSpec(normalized)) return buildShortcut(normalized);
      // Invalid spec: silently fall through to next candidate.
   }
   return DISABLED_SHORTCUT;
}

export type AskMode = "select" | "freeform" | "comment";

export const ASK_OVERLAY_MAX_HEIGHT_RATIO = 0.85;
export const ASK_OVERLAY_MIN_RENDER_LINES = 8;
const ASK_OVERLAY_WIDTH = "92%";
const ASK_OVERLAY_MIN_WIDTH = 40;
export const SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH = 84;
export const SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH = 32;
export const SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH = 28;
export const SINGLE_SELECT_SPLIT_PANE_SEPARATOR = " │ ";
export const FREEFORM_SENTINEL = "\u270f\ufe0f Type custom response...";
export const COMMENT_TOGGLE_LABEL = "Add extra context after selection";
export const DEFAULT_OVERLAY_TOGGLE_KEY = "alt+o";
export const DEFAULT_COMMENT_TOGGLE_KEY = "ctrl+g";
export const CONTEXT_TOGGLE_KEYS = [Key.ctrl("e"), Key.ctrl("x"), Key.ctrl("y")];
export const INLINE_CONTEXT_MAX_ROWS = 3;

// Vim-style aliases for navigating option lists. ctrl+j/k are safe in the
// searchable single-select because they don't collide with fuzzy-search input.
const VIM_SELECT_UP_KEY = Key.ctrl("k");
const VIM_SELECT_DOWN_KEY = Key.ctrl("j");
export const PROMPT_SCROLL_PAGE_UP_KEY = Key.pageUp;
export const PROMPT_SCROLL_PAGE_DOWN_KEY = Key.pageDown;
export const PROMPT_SCROLL_HOME_KEY = Key.home;
export const PROMPT_SCROLL_END_KEY = Key.end;
export const PROMPT_SCROLL_HALF_PAGE_UP_KEY = Key.ctrl("u");
export const PROMPT_SCROLL_HALF_PAGE_DOWN_KEY = Key.ctrl("d");

export function getOverlayMaxRenderLinesForRows(rows: number): number {
   const normalizedRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
   const availableRows = Math.max(1, normalizedRows - 2);
   const ratioRows = Math.max(1, Math.floor(normalizedRows * ASK_OVERLAY_MAX_HEIGHT_RATIO));
   const minimumRows = Math.min(ASK_OVERLAY_MIN_RENDER_LINES, availableRows);
   return Math.min(availableRows, Math.max(minimumRows, ratioRows));
}

export function matchesSelectUp(data: string, keybindings: KeybindingsManager): boolean {
   return (
      keybindings.matches(data, "tui.select.up") ||
      matchesKey(data, Key.shift("tab")) ||
      matchesKey(data, VIM_SELECT_UP_KEY)
   );
}

export function matchesSelectDown(data: string, keybindings: KeybindingsManager): boolean {
   return (
      keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, Key.tab) ||
      matchesKey(data, VIM_SELECT_DOWN_KEY)
   );
}

export function buildCustomUIOptions(
   displayMode: AskDisplayMode,
   onHandle?: (handle: OverlayHandle) => void,
): { overlay?: boolean; overlayOptions?: OverlayOptions; onHandle?: (handle: OverlayHandle) => void } | undefined {
   switch (displayMode) {
      case "inline":
         return undefined;
      case "overlay":
         return {
            overlay: true,
            overlayOptions: {
               anchor: "center" as const,
               width: ASK_OVERLAY_WIDTH,
               minWidth: ASK_OVERLAY_MIN_WIDTH,
               maxHeight: "85%",
               margin: 1,
            },
            ...(onHandle ? { onHandle } : {}),
         };
      default: {
         const _exhaustive: never = displayMode;
         void _exhaustive;
         return {
            overlay: true,
            overlayOptions: {
               anchor: "center" as const,
               width: ASK_OVERLAY_WIDTH,
               minWidth: ASK_OVERLAY_MIN_WIDTH,
               maxHeight: "85%",
               margin: 1,
            },
            ...(onHandle ? { onHandle } : {}),
         };
      }
   }
}
