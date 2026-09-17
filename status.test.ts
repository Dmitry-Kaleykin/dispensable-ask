import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "./src/config/config";
import { AskTimer } from "./src/extension/ask-timer";
import { formatStatusText, renderStatus, STATUS_ICON, STATUS_KEY } from "./src/extension/status";

function createContext(theme?: { fg: (color: string, text: string) => string }): ExtensionContext {
   return {
      mode: "tui",
      hasUI: true,
      ui: {
         setStatus: vi.fn(),
         notify: vi.fn(),
         theme,
      },
   } as unknown as ExtensionContext;
}

describe("footer status", () => {
   it("keeps the icon-first layout of the other footer statuses", () => {
      expect(formatStatusText(false)).toBe(`${STATUS_ICON} ask timer:off`);
      expect(formatStatusText(true)).toBe(`${STATUS_ICON} ask timer:on`);
      expect(formatStatusText(true, 12)).toBe(`${STATUS_ICON} ask timer:on · 12s`);
   });

   it("colours the status with the theme accent", () => {
      const theme = { fg: vi.fn((color: string, text: string) => `\x1b[38;2;38m${text}\x1b[39m`) };
      const ctx = createContext(theme);

      expect(renderStatus(true, 7, ctx)).toBe(`\x1b[38;2;38m${STATUS_ICON} ask timer:on · 7s\x1b[39m`);
      expect(theme.fg).toHaveBeenCalledWith("accent", `${STATUS_ICON} ask timer:on · 7s`);
   });

   it("falls back to plain text when the UI has no theme", () => {
      expect(renderStatus(false, undefined, createContext(undefined))).toBe(`${STATUS_ICON} ask timer:off`);
   });

   it("paints every status written by the timer, including the countdown", () => {
      const theme = { fg: vi.fn((color: string, text: string) => `[${text}]`) };
      const ctx = createContext(theme);
      const timer = new AskTimer(
         { ...DEFAULT_CONFIG },
      );

      timer.refreshStatus(ctx);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, `[${STATUS_ICON} ask timer:off]`);

      timer.showCountdown(ctx, 5);
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, `[${STATUS_ICON} ask timer:on · 5s]`);
   });
});
