import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Key used for ctx.ui.setStatus(); the footer sorts statuses by key. */
export const STATUS_KEY = "dispensable-ask";

/** Leading glyph, matching the icon-first style of the other footer statuses. */
export const STATUS_ICON = "❓";

/** Plain footer text, for example `❓ ask:on` or `❓ ask:on · 12s`. */
export function formatStatusText(enabled: boolean, remainingSeconds?: number): string {
   const state = `ask:${enabled ? "on" : "off"}`;
   const text = remainingSeconds === undefined ? state : `${state} · ${remainingSeconds}s`;
   return `${STATUS_ICON} ${text}`;
}

/**
 * Footer status text coloured with the theme accent, the same cyan-ish colour
 * Pi uses for its own highlights. Pi renders status text verbatim - no
 * markdown, no backtick handling - so the escape codes have to be applied here.
 */
export function renderStatus(
   enabled: boolean,
   remainingSeconds: number | undefined,
   ctx: ExtensionContext,
): string {
   const text = formatStatusText(enabled, remainingSeconds);
   const theme = ctx.ui.theme;
   return theme ? theme.fg("accent", text) : text;
}
