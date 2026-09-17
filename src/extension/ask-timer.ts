import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatTimeout, type DispensableAskConfig } from "../config/config";
import { renderStatus, STATUS_KEY } from "./status";

/** Owns session-local timer state; global configuration is injected. */
export class AskTimer {
   public activeAsk = false;
   public enabled = false;

   public constructor(
      public config: DispensableAskConfig,
   ) {}

   public refreshStatus(ctx: ExtensionContext): void {
      ctx.ui.setStatus(STATUS_KEY, renderStatus(this.enabled, undefined, ctx));
   }

   public showCountdown(ctx: ExtensionContext, remainingSeconds: number): void {
      ctx.ui.setStatus(STATUS_KEY, renderStatus(true, remainingSeconds, ctx));
   }

   public apply(nextEnabled: boolean): void {
      this.enabled = nextEnabled;
   }

   public setFromUser(nextEnabled: boolean, ctx: ExtensionContext): void {
      if (this.activeAsk) {
         ctx.ui.notify("ask_user is waiting for an answer; its timer state was not changed", "warning");
         return;
      }

      this.apply(nextEnabled);
      this.refreshStatus(ctx);
      ctx.ui.notify(
         `ask_user timer ${nextEnabled ? "enabled" : "disabled (waits indefinitely)"} for this session`,
         "info",
      );
   }

   public notifyTimeout(ctx: ExtensionContext): void {
      this.refreshStatus(ctx);
      ctx.ui.notify(
         `ask_user timed out after ${formatTimeout(this.config.timeoutSeconds)} of inactivity`,
         "warning",
      );
   }
}
