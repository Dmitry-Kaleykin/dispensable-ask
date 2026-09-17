import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
   formatTimeout,
   getConfigPath,
   parseTimeoutSeconds,
   saveConfig,
} from "../config/config";
import type { AskTimer } from "./ask-timer";

/** Registers every user-owned control around the model-facing tool. */
export function registerControls(pi: ExtensionAPI, timer: AskTimer): void {
   pi.registerShortcut(timer.config.shortcut as any, {
      description: "Toggle ask_user timer",
      handler: (ctx) => timer.setFromUser(!timer.enabled, ctx),
   });

   pi.registerCommand("dispensable-ask", {
      description: "Show, enable, disable, or configure the ask_user timer",
      handler: async (args, ctx) => {
         const parts = args.trim().split(/\s+/).filter(Boolean);
         const action = (parts[0] ?? "status").toLowerCase();

         if (action === "status") {
            ctx.ui.notify(
               `ask_user timer is ${timer.enabled ? "enabled" : "disabled (waits indefinitely)"}; timeout ${formatTimeout(timer.config.timeoutSeconds)}; toggle ${timer.config.shortcut}; config ${getConfigPath()}`,
               "info",
            );
            return;
         }

         if (action === "on" || action === "enable") {
            timer.setFromUser(true, ctx);
            return;
         }

         if (action === "off" || action === "disable") {
            timer.setFromUser(false, ctx);
            return;
         }

         if (action === "toggle") {
            timer.setFromUser(!timer.enabled, ctx);
            return;
         }

         if (action === "timeout" && parts.length === 2) {
            const timeoutSeconds = parseTimeoutSeconds(parts[1]!);
            if (timeoutSeconds === null) {
               ctx.ui.notify("Timeout must be between 1s and 24h, for example: 30, 45s, or 2m", "error");
               return;
            }

            const nextConfig = { ...timer.config, timeoutSeconds };
            try {
               await saveConfig(nextConfig);
               timer.config = nextConfig;
               timer.refreshStatus(ctx);
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
      timer.activeAsk = false;
      timer.apply(false);
      timer.refreshStatus(ctx);
   });
}
