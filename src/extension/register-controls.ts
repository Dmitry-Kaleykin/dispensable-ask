import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
   formatTimeout,
   getConfigPath,
   parseTimeoutSeconds,
   saveConfig,
} from "../config/config";
import { MODEL_TOOL_NAME } from "../ask-user/constants";
import type { AskExposure } from "./ask-exposure";

/** Registers every user-owned control around the model-facing tool. */
export function registerControls(pi: ExtensionAPI, exposure: AskExposure): void {
   pi.registerShortcut(exposure.config.shortcut as any, {
      description: "Toggle ask_user exposure",
      handler: (ctx) => exposure.setFromUser(!exposure.enabled, ctx),
   });

   pi.registerCommand("dispensable-ask", {
      description: "Show, enable, disable, or configure ask_user",
      handler: async (args, ctx) => {
         const parts = args.trim().split(/\s+/).filter(Boolean);
         const action = (parts[0] ?? "status").toLowerCase();

         if (action === "status") {
            ctx.ui.notify(
               `ask_user is ${exposure.enabled ? "enabled" : "disabled"}; timeout ${formatTimeout(exposure.config.timeoutSeconds)}; toggle ${exposure.config.shortcut}; config ${getConfigPath()}`,
               "info",
            );
            return;
         }

         if (action === "on" || action === "enable") {
            exposure.setFromUser(true, ctx);
            return;
         }

         if (action === "off" || action === "disable") {
            exposure.setFromUser(false, ctx);
            return;
         }

         if (action === "toggle") {
            exposure.setFromUser(!exposure.enabled, ctx);
            return;
         }

         if (action === "timeout" && parts.length === 2) {
            const timeoutSeconds = parseTimeoutSeconds(parts[1]!);
            if (timeoutSeconds === null) {
               ctx.ui.notify("Timeout must be between 1s and 24h, for example: 30, 45s, or 2m", "error");
               return;
            }

            const nextConfig = { ...exposure.config, timeoutSeconds };
            try {
               await saveConfig(nextConfig);
               exposure.config = nextConfig;
               exposure.refreshStatus(ctx);
               ctx.ui.notify(`Global ask_user timeout set to ${formatTimeout(timeoutSeconds)}`, "info");
            } catch (error) {
               ctx.ui.notify(`Could not save ask_user config: ${String(error)}`, "error");
            }
            return;
         }

         ctx.ui.notify(
            "Usage: /dispensable-ask [status|on|off|toggle|timeout <30|45s|2m>]",
            "error",
         );
      },
   });

   pi.on("session_start", (_event, ctx) => {
      exposure.activeAsk = false;
      exposure.apply(false);
      exposure.refreshStatus(ctx);
   });

   // A model request already in flight may still hold the old schema. This
   // guard makes user-initiated disabling effective for that stale call too.
   pi.on("tool_call", (event) => {
      if (event.toolName === MODEL_TOOL_NAME && !exposure.enabled) {
         return {
            block: true,
            reason: "ask_user is disabled for this session; continue without asking the user",
         };
      }
   });
}
